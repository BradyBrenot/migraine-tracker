"""Data fetching and event detection for the Migraine Tracker integration."""

import asyncio
from datetime import timedelta
import logging
from typing import Any, Final

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import (
    CoordinatorEntity,
    DataUpdateCoordinator,
    UpdateFailed,
)

from .const import (
    API_STATUS_PATH,
    ATTR_ACTIVE_ATTACK,
    ATTR_API_VERSION,
    ATTR_GENERATED_AT,
    ATTR_LAST_ATTACK,
    ATTR_STATE,
    CONF_AUTHORIZATION,
    CONF_SCAN_INTERVAL,
    CONF_URL,
    DEFAULT_NAME,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    EXPECTED_API_VERSION,
    MANUFACTURER,
    MAX_SCAN_INTERVAL,
    MIN_SCAN_INTERVAL,
    REQUEST_TIMEOUT,
    UNAUTHORIZED_STATUSES,
    VALID_DISPLAY_STATES,
)

_LOGGER = logging.getLogger(__name__)

type StatusData = dict[str, Any]
type StatusEvent = tuple[str, dict[str, Any]]

STARTED_EVENT: Final = "attack_started"
ENDED_EVENT: Final = "attack_ended"
STATUS_CHANGED_EVENT: Final = "status_changed"


class MigraineTrackerError(Exception):
    """Base error for talking to the tracker."""


class CannotConnectError(MigraineTrackerError):
    """Raised when the tracker cannot be reached."""


class InvalidResponseError(MigraineTrackerError):
    """Raised when the tracker returns something that is not a v1 document."""


class UnsupportedApiVersionError(MigraineTrackerError):
    """Raised when the tracker does not report apiVersion 1."""


class UnauthorizedError(MigraineTrackerError):
    """Raised when the tracker or its proxy rejects the credentials."""


class InvalidAuthorizationError(MigraineTrackerError):
    """Raised when an Authorization header value cannot be sent.

    The message never contains the value: the header may come from storage and
    must not leak into logs or diagnostics through an exception.
    """


# An HTTP field value may contain visible ASCII, space, horizontal tab, and
# obs-text (non-ASCII). Every other control character, notably CR, LF, NUL, and
# DEL, would break the request line or allow a value to inject extra headers.
# aiohttp encodes header values as Latin-1, so anything above U+00FF cannot be
# sent either: encode the whole value to fail here instead of mid-request.
_ALLOWED_CONTROL_CHARACTERS: Final = frozenset({"\t"})

_UNSENDABLE_CHARACTER_MESSAGE: Final = (
    "The Authorization header contains a character that cannot be sent"
    " in an HTTP header"
)


def clean_authorization(value: Any) -> str | None:
    """Return the header value to send, or None when no header is sent.

    Empty and whitespace-only values mean "no header". Any control character
    other than a horizontal tab, and any character that Latin-1 cannot encode
    (above U+00FF, such as an emoji), is rejected with
    InvalidAuthorizationError before a request is attempted.
    """
    if not isinstance(value, str):
        return None
    for character in value:
        if character in _ALLOWED_CONTROL_CHARACTERS:
            continue
        if ord(character) < 0x20 or ord(character) == 0x7F:
            raise InvalidAuthorizationError(_UNSENDABLE_CHARACTER_MESSAGE)
    try:
        value.encode("latin-1")
    except UnicodeEncodeError as err:
        raise InvalidAuthorizationError(_UNSENDABLE_CHARACTER_MESSAGE) from err
    return value.strip() or None


def clamp_scan_interval(value: int) -> int:
    """Clamp a scan interval to the supported range."""
    return max(MIN_SCAN_INTERVAL, min(MAX_SCAN_INTERVAL, value))


def scan_interval_seconds(entry: ConfigEntry) -> int:
    """Return the effective scan interval for a config entry."""
    return clamp_scan_interval(
        int(entry.options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL))
    )


def as_dict(value: Any) -> dict[str, Any]:
    """Return value if it is a mapping, otherwise an empty mapping."""
    return value if isinstance(value, dict) else {}


async def async_fetch_status(
    session: aiohttp.ClientSession,
    base_url: str,
    authorization: str | None = None,
) -> StatusData:
    """Fetch and validate the tracker's status document.

    Performs exactly one GET of ``{base_url}/api/status`` and never follows a
    redirect, so the optional Authorization header is never forwarded to
    another host. Raises a ``MigraineTrackerError`` subclass so callers can map
    the failure to a config flow error or an ``UpdateFailed``.
    """
    header = clean_authorization(authorization)
    headers = {"Authorization": header} if header is not None else {}
    try:
        async with asyncio.timeout(REQUEST_TIMEOUT):
            async with session.get(
                f"{base_url}{API_STATUS_PATH}",
                headers=headers,
                allow_redirects=False,
            ) as response:
                if response.status in UNAUTHORIZED_STATUSES:
                    raise UnauthorizedError(
                        f"The tracker rejected the request ({response.status})"
                    )
                if response.status != 200:
                    # A 3xx lands here too: redirects are deliberately not
                    # followed, so a proxy redirect is an invalid response.
                    raise InvalidResponseError(
                        f"Unexpected response status {response.status}"
                    )
                try:
                    payload = await response.json(content_type=None)
                except ValueError as err:  # Includes json.JSONDecodeError
                    raise InvalidResponseError(
                        "The tracker did not return JSON"
                    ) from err
    except (TimeoutError, aiohttp.ClientError) as err:
        raise CannotConnectError("Could not reach the tracker") from err

    if not isinstance(payload, dict):
        raise InvalidResponseError("The tracker did not return a JSON object")
    version = payload.get(ATTR_API_VERSION)
    # bool is a subclass of int and 1.0 == 1, so only the exact JSON integer 1
    # is accepted: true, 1.0, "1", and a missing field are all unsupported.
    if type(version) is not int or version != EXPECTED_API_VERSION:
        raise UnsupportedApiVersionError("The tracker does not report apiVersion 1")
    if payload.get(ATTR_STATE) not in VALID_DISPLAY_STATES:
        raise InvalidResponseError("The tracker reported an unknown display state")

    # generatedAt changes on every request; keeping it would defeat
    # always_update=False and write entity states on every poll.
    payload.pop(ATTR_GENERATED_AT, None)
    return payload


class MigraineTrackerCoordinator(DataUpdateCoordinator[StatusData]):
    """Poll the tracker's status endpoint once per scan interval."""

    def __init__(
        self,
        hass: HomeAssistant,
        session: aiohttp.ClientSession,
        entry: ConfigEntry,
    ) -> None:
        """Initialize the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=DOMAIN,
            update_interval=timedelta(seconds=scan_interval_seconds(entry)),
            always_update=False,
        )
        self._session = session
        self._base_url: str = entry.data[CONF_URL]
        self._authorization: str | None = entry.options.get(CONF_AUTHORIZATION)
        self._baselined = False
        self._last_active_id: str | None = None
        self._last_state: str | None = None
        self.pending_events: list[StatusEvent] = []

    async def _async_update_data(self) -> StatusData:
        """Fetch one status document and detect transitions against the last one."""
        try:
            data = await async_fetch_status(
                self._session, self._base_url, self._authorization
            )
        except InvalidAuthorizationError as err:
            raise UpdateFailed(
                "The stored Authorization header contains a character that"
                " cannot be sent in an HTTP header; clear or replace it in the"
                " integration options"
            ) from err
        except CannotConnectError as err:
            raise UpdateFailed("Cannot connect to the Migraine Tracker") from err
        except UnauthorizedError as err:
            raise UpdateFailed("The Migraine Tracker rejected the request") from err
        except UnsupportedApiVersionError as err:
            raise UpdateFailed(
                "The Migraine Tracker does not support apiVersion 1"
            ) from err
        except InvalidResponseError as err:
            raise UpdateFailed(
                "The Migraine Tracker returned an invalid response"
            ) from err

        self._diff(data)
        return data

    def _diff(self, data: StatusData) -> None:
        """Compare a successful document with the previous successful one."""
        active = as_dict(data.get(ATTR_ACTIVE_ATTACK))
        last = as_dict(data.get(ATTR_LAST_ATTACK))
        active_id: str | None = active.get("id")
        state: str | None = data.get(ATTR_STATE)

        # Events belong to a single poll. Replacing the list bounds memory and
        # means a disabled event entity can never replay stale events later.
        self.pending_events = []

        if not self._baselined:
            # The first successful poll only establishes the baseline, so setup,
            # a restart, or a reload with an attack already running fires nothing.
            self._baselined = True
        else:
            if active_id is not None and active_id != self._last_active_id:
                self.pending_events.append((STARTED_EVENT, {"attack_id": active_id}))
            elif (
                self._last_active_id is not None
                and active_id is None
                and last.get("id") == self._last_active_id
                and last.get("ongoing") is False
            ):
                # Only the same attack finishing counts as an end. A deleted or
                # replaced last-attack row keeps a different id and fires nothing.
                self.pending_events.append(
                    (ENDED_EVENT, {"attack_id": self._last_active_id})
                )
            if state != self._last_state:
                self.pending_events.append((STATUS_CHANGED_EVENT, {"state": state}))

        self._last_active_id = active_id
        self._last_state = state

    def drain_events(self) -> list[StatusEvent]:
        """Return and clear the events detected by the latest successful poll."""
        events, self.pending_events = self.pending_events, []
        return events


class MigraineTrackerEntity(CoordinatorEntity[MigraineTrackerCoordinator]):
    """Base entity for the single Migraine Tracker device."""

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: MigraineTrackerCoordinator,
        entry: ConfigEntry,
        key: str,
    ) -> None:
        """Initialize the entity."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        # entry_id identifies the device, never the mutable URL, so a
        # reconfigure cannot orphan the device or its entities.
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=DEFAULT_NAME,
            manufacturer=MANUFACTURER,
            configuration_url=entry.data.get(CONF_URL),
        )

    @property
    def status_data(self) -> StatusData:
        """Return the latest status document."""
        return self.coordinator.data
