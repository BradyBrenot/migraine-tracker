"""Options flow tests: scan interval clamping and the Authorization header."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntryState
from homeassistant.data_entry_flow import FlowResultType
import pytest

from custom_components.migraine_tracker.const import (
    CONF_AUTHORIZATION,
    CONF_CLEAR_AUTHORIZATION,
    CONF_SCAN_INTERVAL,
)

from .helpers import (
    ACTIVE_ATTACK,
    AUTHORIZATION,
    request_headers,
    setup_mocked_entry,
)

REPLACEMENT_AUTHORIZATION = "Bearer replacement"


@pytest.mark.parametrize(
    ("submitted", "stored"),
    [
        pytest.param(14, 15, id="clamped_up_to_minimum"),
        pytest.param(15, 15, id="minimum_unchanged"),
        pytest.param(3600, 3600, id="maximum_unchanged"),
        pytest.param(3601, 3600, id="clamped_down_to_maximum"),
        pytest.param(0, 15, id="zero_clamped_up"),
        pytest.param(99999, 3600, id="huge_clamped_down"),
    ],
)
async def test_options_clamp_scan_interval(
    hass, enable_custom_integrations, aioclient_mock, submitted, stored
) -> None:
    """Out-of-range intervals are corrected instead of rejected."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)

    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {CONF_SCAN_INTERVAL: submitted}
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options == {CONF_SCAN_INTERVAL: stored}
    assert entry.state is ConfigEntryState.LOADED
    assert entry.runtime_data.update_interval.total_seconds() == stored


async def test_options_save_reloads_without_update_listener(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """OptionsFlowWithReload reloads the entry and registers no update listener."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)
    first_coordinator = entry.runtime_data

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {CONF_SCAN_INTERVAL: 120}
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.state is ConfigEntryState.LOADED
    assert entry.update_listeners == []
    assert entry.runtime_data is not first_coordinator
    assert entry.runtime_data.update_interval.total_seconds() == 120
    assert entry.runtime_data.config_entry is entry
    assert len(aioclient_mock.mock_calls) == 2


async def test_options_form_suggests_interval_and_hides_header(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The form suggests the interval but never the stored header."""
    entry = await setup_mocked_entry(
        hass,
        aioclient_mock,
        ACTIVE_ATTACK,
        options={CONF_SCAN_INTERVAL: 90, CONF_AUTHORIZATION: AUTHORIZATION},
    )

    result = await hass.config_entries.options.async_init(entry.entry_id)

    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "init"
    schema = dict(result["data_schema"].schema)
    assert set(schema) == {
        CONF_SCAN_INTERVAL,
        CONF_AUTHORIZATION,
        CONF_CLEAR_AUTHORIZATION,
    }
    assert AUTHORIZATION not in repr(schema)
    # Suggested values live on the schema markers, and never on the header field.
    scan_key = next(key for key in schema if key == CONF_SCAN_INTERVAL)
    auth_key = next(key for key in schema if key == CONF_AUTHORIZATION)
    assert scan_key.description == {"suggested_value": 90}
    assert auth_key.description is None


async def test_interval_only_save_preserves_authorization(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Changing only the interval keeps the stored header and still sends it."""
    entry = await setup_mocked_entry(
        hass,
        aioclient_mock,
        ACTIVE_ATTACK,
        options={CONF_SCAN_INTERVAL: 60, CONF_AUTHORIZATION: AUTHORIZATION},
    )
    assert request_headers(aioclient_mock.mock_calls)[0]["Authorization"] == (
        AUTHORIZATION
    )

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {CONF_SCAN_INTERVAL: 90}
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options == {
        CONF_SCAN_INTERVAL: 90,
        CONF_AUTHORIZATION: AUTHORIZATION,
    }
    assert len(aioclient_mock.mock_calls) == 2
    assert request_headers(aioclient_mock.mock_calls)[1]["Authorization"] == (
        AUTHORIZATION
    )


async def test_options_replace_authorization(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Entering a new header replaces the stored one on the wire."""
    entry = await setup_mocked_entry(
        hass,
        aioclient_mock,
        ACTIVE_ATTACK,
        options={CONF_SCAN_INTERVAL: 60, CONF_AUTHORIZATION: AUTHORIZATION},
    )

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {CONF_SCAN_INTERVAL: 60, CONF_AUTHORIZATION: REPLACEMENT_AUTHORIZATION},
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options[CONF_AUTHORIZATION] == REPLACEMENT_AUTHORIZATION
    assert request_headers(aioclient_mock.mock_calls)[-1]["Authorization"] == (
        REPLACEMENT_AUTHORIZATION
    )


async def test_options_clear_authorization(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The deliberate clear toggle removes the header from options and requests."""
    entry = await setup_mocked_entry(
        hass,
        aioclient_mock,
        ACTIVE_ATTACK,
        options={CONF_SCAN_INTERVAL: 60, CONF_AUTHORIZATION: AUTHORIZATION},
    )

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {CONF_SCAN_INTERVAL: 60, CONF_CLEAR_AUTHORIZATION: True},
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options == {CONF_SCAN_INTERVAL: 60}
    assert CONF_AUTHORIZATION not in entry.options
    assert "Authorization" not in request_headers(aioclient_mock.mock_calls)[-1]
    assert entry.state is ConfigEntryState.LOADED


async def test_options_clear_wins_over_replacement(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The clear toggle takes precedence over a header entered in the same save."""
    entry = await setup_mocked_entry(
        hass,
        aioclient_mock,
        ACTIVE_ATTACK,
        options={CONF_SCAN_INTERVAL: 60, CONF_AUTHORIZATION: AUTHORIZATION},
    )

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            CONF_SCAN_INTERVAL: 60,
            CONF_AUTHORIZATION: REPLACEMENT_AUTHORIZATION,
            CONF_CLEAR_AUTHORIZATION: True,
        },
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options == {CONF_SCAN_INTERVAL: 60}


UNSAFE_AUTHORIZATION = "Bearer bad\r\nX-Injected: 1"


async def test_options_reject_unsafe_authorization_without_saving_or_reloading(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The form errors, keeps options, and never reloads or hits the network."""
    entry = await setup_mocked_entry(
        hass,
        aioclient_mock,
        ACTIVE_ATTACK,
        options={CONF_SCAN_INTERVAL: 60, CONF_AUTHORIZATION: AUTHORIZATION},
    )
    coordinator = entry.runtime_data

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            CONF_SCAN_INTERVAL: 90,
            CONF_AUTHORIZATION: UNSAFE_AUTHORIZATION,
            CONF_CLEAR_AUTHORIZATION: True,
        },
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "init"
    assert result["errors"] == {"base": "invalid_authorization"}
    assert entry.options == {
        CONF_SCAN_INTERVAL: 60,
        CONF_AUTHORIZATION: AUTHORIZATION,
    }
    assert entry.state is ConfigEntryState.LOADED
    # No reload: the coordinator instance and the request count are unchanged.
    assert entry.runtime_data is coordinator
    assert len(aioclient_mock.mock_calls) == 1
    # The submitted interval is preserved and the header is never echoed back.
    schema = dict(result["data_schema"].schema)
    scan_key = next(key for key in schema if key == CONF_SCAN_INTERVAL)
    assert scan_key.description == {"suggested_value": 90}
    assert AUTHORIZATION not in repr(schema)
    assert "X-Injected" not in repr(schema)


@pytest.mark.parametrize(
    ("authorization", "forbidden"),
    [
        pytest.param("Bearer a\U0001f600b", "\U0001f600", id="emoji"),
        pytest.param("Bearer a\u20acb", "\u20ac", id="euro_sign"),
    ],
)
async def test_options_reject_non_latin1_authorization_without_saving_or_reloading(
    hass, enable_custom_integrations, aioclient_mock, authorization, forbidden
) -> None:
    """A value aiohttp cannot encode as Latin-1 errors instead of crashing."""
    entry = await setup_mocked_entry(
        hass,
        aioclient_mock,
        ACTIVE_ATTACK,
        options={CONF_SCAN_INTERVAL: 60, CONF_AUTHORIZATION: AUTHORIZATION},
    )
    coordinator = entry.runtime_data

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            CONF_SCAN_INTERVAL: 90,
            CONF_AUTHORIZATION: authorization,
            CONF_CLEAR_AUTHORIZATION: True,
        },
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "init"
    assert result["errors"] == {"base": "invalid_authorization"}
    assert entry.options == {
        CONF_SCAN_INTERVAL: 60,
        CONF_AUTHORIZATION: AUTHORIZATION,
    }
    assert entry.state is ConfigEntryState.LOADED
    # No reload and no extra request: nothing ran with the rejected value.
    assert entry.runtime_data is coordinator
    assert len(aioclient_mock.mock_calls) == 1
    # The submitted interval is preserved and the header is never echoed back.
    schema = dict(result["data_schema"].schema)
    scan_key = next(key for key in schema if key == CONF_SCAN_INTERVAL)
    assert scan_key.description == {"suggested_value": 90}
    assert forbidden not in repr(schema)


async def test_options_accept_unsafe_looking_but_sendable_values(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Spaces, tabs, and non-ASCII values are stored, not rejected."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)
    value = "Bearer tab\tseparated"

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {CONF_SCAN_INTERVAL: 60, CONF_AUTHORIZATION: value}
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert entry.options == {CONF_SCAN_INTERVAL: 60, CONF_AUTHORIZATION: value}
    assert request_headers(aioclient_mock.mock_calls)[-1]["Authorization"] == value
