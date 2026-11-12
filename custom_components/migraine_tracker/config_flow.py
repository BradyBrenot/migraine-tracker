"""Config flow for the Migraine Tracker integration."""

from typing import Any
from urllib.parse import urlsplit

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlowWithReload,
)
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    BooleanSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

# HA core replaced voluptuous with probatio as its validation engine but keeps
# `import voluptuous` working through probatio.compat.install_as_voluptuous()
# (see homeassistant/__init__.py). Importing voluptuous — after homeassistant —
# therefore works on both the tested HA and the declared 2025.8 minimum, where
# voluptuous is the real engine.
import voluptuous as vol  # noqa: E402

from .const import (
    API_STATUS_PATH,
    CONF_AUTHORIZATION,
    CONF_CLEAR_AUTHORIZATION,
    CONF_SCAN_INTERVAL,
    CONF_URL,
    DEFAULT_NAME,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
)
from .coordinator import (
    CannotConnectError,
    InvalidAuthorizationError,
    InvalidResponseError,
    UnauthorizedError,
    UnsupportedApiVersionError,
    async_fetch_status,
    clamp_scan_interval,
    clean_authorization,
)

HTTP_SCHEMES = {"http", "https"}

AUTHORIZATION_SELECTOR = TextSelector(
    TextSelectorConfig(type=TextSelectorType.PASSWORD)
)

CONFIG_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_URL): TextSelector(
            TextSelectorConfig(type=TextSelectorType.URL)
        ),
        vol.Optional(CONF_AUTHORIZATION): AUTHORIZATION_SELECTOR,
    }
)

# The scan interval is clamped in the options handler instead of being bounded
# by the selector, so an out-of-range value is corrected rather than rejected.
OPTIONS_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_SCAN_INTERVAL, default=DEFAULT_SCAN_INTERVAL): vol.All(
            NumberSelector(NumberSelectorConfig(mode=NumberSelectorMode.BOX)),
            vol.Coerce(int),
        ),
        vol.Optional(CONF_AUTHORIZATION): AUTHORIZATION_SELECTOR,
        vol.Optional(CONF_CLEAR_AUTHORIZATION, default=False): BooleanSelector(),
    }
)


class InvalidUrlError(ValueError):
    """Raised when the entered URL is not an acceptable base URL."""


def normalize_base_url(raw_url: str) -> str:
    """Return the normalized base URL, or raise InvalidUrlError.

    The scheme and host are lowercased and trailing slashes removed; the path is
    kept case-sensitively so a reverse-proxy base path survives.
    """
    value = raw_url.strip()
    try:
        parsed = urlsplit(value)
    except ValueError as err:
        raise InvalidUrlError("Unparseable URL") from err

    if parsed.scheme.lower() not in HTTP_SCHEMES:
        raise InvalidUrlError("Only http and https URLs are supported")
    if not parsed.netloc or parsed.hostname is None:
        raise InvalidUrlError("The URL has no host")
    # urlsplit accepts any text after the colon but evaluating .port raises
    # ValueError for a non-numeric or out-of-range port.
    try:
        _port = parsed.port
    except ValueError as err:
        raise InvalidUrlError("The URL has an invalid port") from err
    if parsed.username is not None or parsed.password is not None:
        raise InvalidUrlError("The URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise InvalidUrlError("The URL must not contain a query or fragment")

    path = parsed.path.rstrip("/")
    if path.lower().endswith(API_STATUS_PATH):
        raise InvalidUrlError("Enter the base URL, not the status endpoint")

    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}{path}"


class MigraineTrackerOptionsFlow(OptionsFlowWithReload):
    """Handle Migraine Tracker options.

    OptionsFlowWithReload reloads the entry on save, so the integration must not
    register an update listener.
    """

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manage the scan interval and the optional Authorization header."""
        entry = self.config_entry
        errors: dict[str, str] = {}
        submitted_interval: Any = None

        if user_input is not None:
            submitted_interval = user_input[CONF_SCAN_INTERVAL]
            try:
                authorization = clean_authorization(user_input.get(CONF_AUTHORIZATION))
            except InvalidAuthorizationError:
                # Nothing is saved and no reload happens; the form comes back
                # with the error and the submitted interval.
                errors = {"base": "invalid_authorization"}
            else:
                options = {
                    CONF_SCAN_INTERVAL: clamp_scan_interval(int(submitted_interval))
                }
                if user_input.get(CONF_CLEAR_AUTHORIZATION):
                    # Deliberate removal; it takes precedence over the field.
                    pass
                elif authorization is not None:
                    options[CONF_AUTHORIZATION] = authorization
                elif (current := entry.options.get(CONF_AUTHORIZATION)) is not None:
                    # An interval-only save keeps the stored header.
                    options[CONF_AUTHORIZATION] = current
                return self.async_create_entry(data=options)

        interval = (
            entry.options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL)
            if submitted_interval is None
            else submitted_interval
        )
        return self.async_show_form(
            step_id="init",
            # The stored header is not shown, only kept unless replaced or cleared.
            data_schema=self.add_suggested_values_to_schema(
                OPTIONS_SCHEMA, {CONF_SCAN_INTERVAL: interval}
            ),
            errors=errors,
        )


class MigraineTrackerConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the Migraine Tracker config flow."""

    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: ConfigEntry,
    ) -> MigraineTrackerOptionsFlow:
        """Return the options flow."""
        return MigraineTrackerOptionsFlow()

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Configure a tracker by its base URL."""
        errors: dict[str, str] = {}
        suggested_url: str | None = None

        if user_input is not None:
            suggested_url = user_input.get(CONF_URL)
            try:
                authorization = clean_authorization(user_input.get(CONF_AUTHORIZATION))
            except InvalidAuthorizationError:
                # A value that cannot be sent is rejected before any request.
                errors = {"base": "invalid_authorization"}
            else:
                errors, base_url = await self._async_validate(
                    suggested_url, authorization
                )
                if not errors:
                    await self.async_set_unique_id(base_url)
                    # Re-entering the same tracker aborts here with already_configured.
                    self._abort_if_unique_id_configured()
                    if self._async_current_entries(include_ignore=False):
                        # A different URL while the single entry exists. Core also
                        # enforces single_config_entry before reaching this step.
                        return self.async_abort(reason="single_instance_allowed")
                    options: dict[str, Any] = {
                        CONF_SCAN_INTERVAL: DEFAULT_SCAN_INTERVAL
                    }
                    if authorization is not None:
                        options[CONF_AUTHORIZATION] = authorization
                    return self.async_create_entry(
                        title=DEFAULT_NAME,
                        data={CONF_URL: base_url},
                        options=options,
                    )

        return self.async_show_form(
            step_id="user",
            # The Authorization header is never echoed back as a form default.
            data_schema=self.add_suggested_values_to_schema(
                CONFIG_SCHEMA, {CONF_URL: suggested_url} if suggested_url else None
            ),
            errors=errors,
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Reconfigure the tracker URL, keeping the stored Authorization header."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        suggested_url = entry.data[CONF_URL]

        if user_input is not None:
            if url := user_input.get(CONF_URL):
                suggested_url = url
            try:
                submitted = clean_authorization(user_input.get(CONF_AUTHORIZATION))
            except InvalidAuthorizationError:
                errors = {"base": "invalid_authorization"}
            else:
                # A blank field keeps the stored header; it is never shown again.
                authorization = submitted or entry.options.get(CONF_AUTHORIZATION)
                errors, base_url = await self._async_validate(url, authorization)
                if not errors:
                    options = dict(entry.options)
                    if authorization is not None:
                        options[CONF_AUTHORIZATION] = authorization
                    return self.async_update_reload_and_abort(
                        entry,
                        unique_id=base_url,
                        data_updates={CONF_URL: base_url},
                        options=options,
                        reason="reconfigure_successful",
                    )

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=self.add_suggested_values_to_schema(
                CONFIG_SCHEMA, {CONF_URL: suggested_url}
            ),
            errors=errors,
        )

    async def _async_validate(
        self, raw_url: Any, authorization: str | None
    ) -> tuple[dict[str, str], str]:
        """Normalize the URL and validate it with exactly one status request."""
        if not isinstance(raw_url, str):
            return {"base": "invalid_url"}, ""
        try:
            base_url = normalize_base_url(raw_url)
        except InvalidUrlError:
            return {"base": "invalid_url"}, ""

        try:
            await async_fetch_status(
                async_get_clientsession(self.hass), base_url, authorization
            )
        except InvalidAuthorizationError:
            # A stored value that cannot be sent never reaches the network.
            return {"base": "invalid_authorization"}, base_url
        except UnauthorizedError:
            return {"base": "unauthorized"}, base_url
        except UnsupportedApiVersionError:
            return {"base": "unsupported_api_version"}, base_url
        except InvalidResponseError:
            return {"base": "invalid_response"}, base_url
        except CannotConnectError:
            return {"base": "cannot_connect"}, base_url

        return {}, base_url
