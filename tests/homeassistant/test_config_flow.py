"""Config flow tests: validation, URL normalization, and duplicate aborts."""

from __future__ import annotations

from aiohttp import ClientConnectionError
from homeassistant.config_entries import SOURCE_USER
from homeassistant.data_entry_flow import AbortFlow, FlowResultType
import pytest

from custom_components.migraine_tracker import config_flow as cf
from custom_components.migraine_tracker.const import (
    CONF_AUTHORIZATION,
    CONF_SCAN_INTERVAL,
    CONF_URL,
    DOMAIN,
)

from .helpers import (
    ACTIVE_ATTACK,
    AUTHORIZATION,
    BASE_URL,
    OTHER_BASE_URL,
    STATUS_URL,
    assert_only_status_gets,
    make_entry,
)


async def _start_user_flow(hass):
    """Start the user flow through the config entry flow manager."""
    return await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_USER}
    )


def _direct_flow(hass) -> cf.MigraineTrackerConfigFlow:
    """Return a config flow instance that is not owned by the flow manager."""
    flow = cf.MigraineTrackerConfigFlow()
    flow.hass = hass
    flow.handler = DOMAIN
    # Set the context the manager would set, so the step never reads an unset
    # one (for example when resolving a source-dependent abort reason).
    flow.context = {"source": SOURCE_USER}
    return flow


async def test_user_flow_normalizes_url_and_creates_entry(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Success lowercases scheme/host, keeps path case, and drops the slash."""
    normalized = "http://tracker:8097/Base/Path"
    aioclient_mock.get(f"{normalized}/api/status", json=ACTIVE_ATTACK)

    result = await _start_user_flow(hass)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: "HTTP://Tracker:8097/Base/Path/"}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Migraine Tracker"
    assert result["data"] == {CONF_URL: normalized}
    assert result["options"] == {CONF_SCAN_INTERVAL: 60}

    entry = result["result"]
    assert entry.unique_id == normalized
    assert entry.data == {CONF_URL: normalized}
    assert entry.options == {CONF_SCAN_INTERVAL: 60}
    # One GET validates the flow, then the new entry's first refresh polls once.
    assert_only_status_gets(aioclient_mock.mock_calls, base_url=normalized, count=2)


async def test_user_flow_stores_authorization_header(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The optional proxy header is stored in options, not entry data."""
    aioclient_mock.get(STATUS_URL, json=ACTIVE_ATTACK)

    result = await _start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_URL: f"{BASE_URL}/", CONF_AUTHORIZATION: f" {AUTHORIZATION} "},
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["options"] == {
        CONF_SCAN_INTERVAL: 60,
        CONF_AUTHORIZATION: AUTHORIZATION,
    }
    assert CONF_AUTHORIZATION not in result["data"]
    assert_only_status_gets(aioclient_mock.mock_calls, count=2)
    # Validation and the entry's first refresh both send the configured header.
    assert [call[3]["Authorization"] for call in aioclient_mock.mock_calls] == [
        AUTHORIZATION,
        AUTHORIZATION,
    ]


async def test_user_flow_without_authorization_omits_option(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A blank header is not stored."""
    aioclient_mock.get(STATUS_URL, json=ACTIVE_ATTACK)

    result = await _start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: BASE_URL, CONF_AUTHORIZATION: "   "}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["options"] == {CONF_SCAN_INTERVAL: 60}
    assert aioclient_mock.mock_calls[0][3].get("Authorization") is None


@pytest.mark.parametrize(
    ("mock_kwargs", "error"),
    [
        pytest.param(
            {"exc": ClientConnectionError("cannot connect")},
            "cannot_connect",
            id="connection_error",
        ),
        pytest.param({"exc": TimeoutError()}, "cannot_connect", id="timeout"),
        pytest.param(
            {"status": 500, "json": {"error": "boom"}},
            "invalid_response",
            id="non_200",
        ),
        pytest.param(
            {"text": "<html>not json</html>"}, "invalid_response", id="non_json_body"
        ),
        pytest.param({"json": [1, 2, 3]}, "invalid_response", id="non_object_json"),
        pytest.param(
            {
                "json": {
                    key: value
                    for key, value in ACTIVE_ATTACK.items()
                    if key != "apiVersion"
                }
            },
            "unsupported_api_version",
            id="missing_api_version",
        ),
        pytest.param(
            {"json": {**ACTIVE_ATTACK, "apiVersion": 2}},
            "unsupported_api_version",
            id="api_version_2",
        ),
        pytest.param(
            {"json": {**ACTIVE_ATTACK, "apiVersion": True}},
            "unsupported_api_version",
            id="api_version_true",
        ),
        pytest.param(
            {"json": {**ACTIVE_ATTACK, "apiVersion": 1.0}},
            "unsupported_api_version",
            id="api_version_float",
        ),
        pytest.param(
            {"json": {**ACTIVE_ATTACK, "apiVersion": "1"}},
            "unsupported_api_version",
            id="api_version_string",
        ),
        pytest.param(
            {"json": {**ACTIVE_ATTACK, "apiVersion": None}},
            "unsupported_api_version",
            id="api_version_null",
        ),
        pytest.param(
            {"json": {**ACTIVE_ATTACK, "state": "unknown"}},
            "invalid_response",
            id="invalid_display_state",
        ),
        pytest.param(
            {
                "json": {
                    key: value for key, value in ACTIVE_ATTACK.items() if key != "state"
                }
            },
            "invalid_response",
            id="missing_display_state",
        ),
        pytest.param({"status": 401}, "unauthorized", id="unauthorized_401"),
        pytest.param({"status": 403}, "unauthorized", id="unauthorized_403"),
    ],
)
async def test_user_flow_reports_distinct_errors(
    hass, enable_custom_integrations, aioclient_mock, mock_kwargs, error
) -> None:
    """Every failure mode maps to its documented form error and creates no entry."""
    aioclient_mock.get(STATUS_URL, **mock_kwargs)

    result = await _start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: BASE_URL}
    )

    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"
    assert result["errors"] == {"base": error}
    assert hass.config_entries.async_entries(DOMAIN) == []
    assert_only_status_gets(aioclient_mock.mock_calls, count=1)


async def test_unauthorized_is_not_reported_as_invalid_response(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """401/403 are authentication failures, not a malformed document."""
    aioclient_mock.get(STATUS_URL, status=403)

    result = await _start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: BASE_URL}
    )

    assert result["errors"] == {"base": "unauthorized"}
    assert result["errors"] != {"base": "invalid_response"}
    assert hass.config_entries.async_entries(DOMAIN) == []


@pytest.mark.parametrize(
    "raw_url",
    [
        pytest.param("ftp://tracker:8097", id="ftp_scheme"),
        pytest.param("http://user:pass@tracker:8097", id="embedded_credentials"),
        pytest.param("http://tracker:8097/?x=1", id="query_string"),
        pytest.param("http://tracker:8097/#frag", id="fragment"),
        pytest.param("http://tracker:8097/api/status", id="status_path"),
        pytest.param("http://tracker:8097/API/Status/", id="status_path_case"),
        pytest.param("tracker:8097", id="missing_scheme"),
        pytest.param("http:///nohost", id="missing_host"),
        pytest.param("http://tracker:99999", id="port_out_of_range"),
        pytest.param("http://tracker:abc", id="port_not_numeric"),
        pytest.param("   ", id="blank"),
    ],
)
async def test_user_flow_rejects_malformed_url_without_request(
    hass, enable_custom_integrations, aioclient_mock, raw_url
) -> None:
    """Malformed URLs fail locally as invalid_url and never hit the network."""
    result = await _start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: raw_url}
    )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_url"}
    assert aioclient_mock.mock_calls == []


@pytest.mark.parametrize(
    ("raw_url", "expected"),
    [
        ("http://tracker:8097", "http://tracker:8097"),
        ("http://tracker:8097/", "http://tracker:8097"),
        ("HTTP://TRACKER:8097", "http://tracker:8097"),
        ("https://Tracker.example.com:8443", "https://tracker.example.com:8443"),
        ("http://tracker:8097/Base/Path/", "http://tracker:8097/Base/Path"),
        ("  http://tracker:8097  ", "http://tracker:8097"),
        ("http://10.0.0.5:8097/tracker", "http://10.0.0.5:8097/tracker"),
    ],
)
def test_normalize_base_url(raw_url: str, expected: str) -> None:
    """Normalization lowercases scheme/host and preserves path case."""
    assert cf.normalize_base_url(raw_url) == expected


@pytest.mark.parametrize(
    "raw_url",
    [
        "ftp://tracker:8097",
        "tracker:8097",
        "http://user:pw@tracker:8097",
        "http://tracker:8097/?x=1",
        "http://tracker:8097/#frag",
        "http://tracker:8097/api/status",
        "http://tracker:8097/API/Status/",
        "http://tracker:8097/base/api/status",
        "http:///nohost",
        "http://tracker:99999",
        "http://tracker:abc",
        "",
    ],
)
def test_normalize_base_url_rejects(raw_url: str) -> None:
    """Malformed URLs raise InvalidUrlError."""
    with pytest.raises(cf.InvalidUrlError):
        cf.normalize_base_url(raw_url)


async def test_duplicate_entry_aborts_single_instance_via_manager(
    hass, enable_custom_integrations
) -> None:
    """With an entry present, core aborts a new flow at single_config_entry."""
    make_entry().add_to_hass(hass)

    result = await _start_user_flow(hass)

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1


async def test_same_url_aborts_already_configured(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Submitting the configured URL aborts at the unique-ID check."""
    make_entry().add_to_hass(hass)
    aioclient_mock.get(STATUS_URL, json=ACTIVE_ATTACK)

    flow = _direct_flow(hass)
    with pytest.raises(AbortFlow) as abort:
        await flow.async_step_user({CONF_URL: BASE_URL})

    assert abort.value.reason == "already_configured"
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1
    assert_only_status_gets(aioclient_mock.mock_calls, count=1)


async def test_different_url_aborts_single_instance_from_step(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The step itself also refuses a second entry for a different URL."""
    make_entry().add_to_hass(hass)
    aioclient_mock.get(f"{OTHER_BASE_URL}/api/status", json=ACTIVE_ATTACK)

    flow = _direct_flow(hass)
    result = await flow.async_step_user({CONF_URL: OTHER_BASE_URL})

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1
    assert_only_status_gets(aioclient_mock.mock_calls, base_url=OTHER_BASE_URL, count=1)


async def test_flow_form_never_echoes_authorization(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The stored/entered header is not suggested back into the form."""
    aioclient_mock.get(STATUS_URL, status=500)

    result = await _start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: BASE_URL, CONF_AUTHORIZATION: AUTHORIZATION}
    )

    assert result["type"] is FlowResultType.FORM
    assert AUTHORIZATION not in repr(dict(result["data_schema"].schema))


REDIRECT_LOCATION = "http://elsewhere:8097/api/status"

UNSAFE_AUTHORIZATIONS = [
    pytest.param("Bearer a\rb", id="carriage_return"),
    pytest.param("Bearer a\nb", id="line_feed"),
    pytest.param("Bearer a\r\nX-Injected: 1", id="header_injection"),
    pytest.param("Bearer a\x00b", id="nul"),
    pytest.param("Bearer a\x7fb", id="delete"),
    pytest.param("Bearer \x01", id="other_control_character"),
    # aiohttp encodes header values as Latin-1, so anything above U+00FF would
    # raise UnicodeEncodeError mid-request instead of a clean form error.
    pytest.param("Bearer a\U0001f600b", id="emoji"),
    pytest.param("Bearer a\u20acb", id="euro_sign"),
]


async def test_user_flow_rejects_redirect_without_following_it(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A 3xx is an invalid response; the redirect target is never requested."""
    aioclient_mock.get(STATUS_URL, status=302, headers={"Location": REDIRECT_LOCATION})

    result = await _start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: BASE_URL, CONF_AUTHORIZATION: AUTHORIZATION}
    )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_response"}
    assert hass.config_entries.async_entries(DOMAIN) == []
    # Exactly one request: the tracker itself. Following the redirect would
    # record a second one and forward the Authorization header to it.
    assert_only_status_gets(aioclient_mock.mock_calls, count=1)
    assert str(aioclient_mock.mock_calls[0][1]) == STATUS_URL


@pytest.mark.parametrize("authorization", UNSAFE_AUTHORIZATIONS)
async def test_user_flow_rejects_unsafe_authorization_without_request(
    hass, enable_custom_integrations, aioclient_mock, authorization
) -> None:
    """A value that cannot be sent in an HTTP header fails before any request."""
    result = await _start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_URL: BASE_URL, CONF_AUTHORIZATION: authorization},
    )

    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"
    assert result["errors"] == {"base": "invalid_authorization"}
    assert hass.config_entries.async_entries(DOMAIN) == []
    assert aioclient_mock.mock_calls == []
    # The other input is preserved and the bad value is never echoed back.
    schema = dict(result["data_schema"].schema)
    url_key = next(key for key in schema if key == CONF_URL)
    assert url_key.description == {"suggested_value": BASE_URL}
    assert authorization not in repr(schema)


@pytest.mark.parametrize(
    ("submitted", "stored"),
    [
        pytest.param("  Bearer spaced  ", "Bearer spaced", id="spaces_trimmed"),
        pytest.param("Bearer tab\tseparated", "Bearer tab\tseparated", id="tab_kept"),
        pytest.param("Bearer caf\xe9", "Bearer caf\xe9", id="non_ascii_kept"),
        pytest.param("   ", None, id="whitespace_only_is_no_header"),
        pytest.param("\t", None, id="tab_only_is_no_header"),
    ],
)
async def test_user_flow_accepts_sendable_authorization(
    hass, enable_custom_integrations, aioclient_mock, submitted, stored
) -> None:
    """Spaces, horizontal tabs, and non-ASCII values are valid header values."""
    aioclient_mock.get(STATUS_URL, json=ACTIVE_ATTACK)

    result = await _start_user_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: BASE_URL, CONF_AUTHORIZATION: submitted}
    )

    assert result["type"] is FlowResultType.CREATE_ENTRY
    if stored is None:
        assert result["options"] == {CONF_SCAN_INTERVAL: 60}
    else:
        assert result["options"][CONF_AUTHORIZATION] == stored
    assert_only_status_gets(aioclient_mock.mock_calls, count=2)
