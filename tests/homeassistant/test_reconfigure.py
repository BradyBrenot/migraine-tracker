"""Reconfigure flow tests: URL/unique-ID updates and device identity."""

from __future__ import annotations

from homeassistant.config_entries import SOURCE_RECONFIGURE, ConfigEntryState
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from custom_components.migraine_tracker.const import (
    CONF_AUTHORIZATION,
    CONF_URL,
    DOMAIN,
)

from .helpers import (
    ACTIVE_ATTACK,
    AUTHORIZATION,
    BASE_URL,
    NEW_BASE_URL,
    NEW_STATUS_URL,
    STATUS_URL,
    request_headers,
    setup_mocked_entry,
)

NEW_AUTHORIZATION = "Bearer reconfigured"


async def _start_reconfigure(hass, entry):
    """Start the reconfigure flow through the flow manager."""
    return await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": SOURCE_RECONFIGURE, "entry_id": entry.entry_id},
    )


def _assert_requests(calls, expected_urls: list[str]) -> None:
    """Every request is a GET of one of the expected status URLs, in order."""
    assert all(call[0].lower() == "get" for call in calls)
    assert [str(call[1]) for call in calls] == expected_urls


async def test_reconfigure_updates_url_unique_id_and_keeps_device(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Reconfigure keeps one device and stable entity-to-device links."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)
    device_registry = dr.async_get(hass)
    entity_registry = er.async_get(hass)

    device_before = dr.async_entries_for_config_entry(device_registry, entry.entry_id)[
        0
    ]
    entities_before = {
        item.entity_id: (item.unique_id, item.device_id)
        for item in er.async_entries_for_config_entry(entity_registry, entry.entry_id)
    }
    assert len(entities_before) == 11

    aioclient_mock.get(NEW_STATUS_URL, json=ACTIVE_ATTACK)

    result = await _start_reconfigure(hass, entry)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "reconfigure"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: "HTTP://NewTracker:8097/"}
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reconfigure_successful"
    assert entry.unique_id == NEW_BASE_URL
    assert entry.data[CONF_URL] == NEW_BASE_URL
    assert entry.state is ConfigEntryState.LOADED
    # Reconfigure uses HA's update-and-reload helper, which would raise if an
    # options update listener were registered.
    assert entry.update_listeners == []
    assert entry.runtime_data.config_entry is entry

    devices_after = dr.async_entries_for_config_entry(device_registry, entry.entry_id)
    assert len(devices_after) == 1
    assert devices_after[0].id == device_before.id
    assert devices_after[0].configuration_url == NEW_BASE_URL

    entities_after = {
        item.entity_id: (item.unique_id, item.device_id)
        for item in er.async_entries_for_config_entry(entity_registry, entry.entry_id)
    }
    assert entities_after == entities_before

    _assert_requests(
        aioclient_mock.mock_calls,
        # setup poll, reconfigure validation, then the reload's first poll
        [STATUS_URL, NEW_STATUS_URL, NEW_STATUS_URL],
    )


async def test_reconfigure_failure_keeps_entry_unchanged(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A failing validation leaves URL, unique ID, and device untouched."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)
    device_registry = dr.async_get(hass)
    device_before = dr.async_entries_for_config_entry(device_registry, entry.entry_id)[
        0
    ]

    aioclient_mock.get(NEW_STATUS_URL, status=500)

    result = await _start_reconfigure(hass, entry)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: NEW_BASE_URL}
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_response"}
    assert entry.unique_id == BASE_URL
    assert entry.data[CONF_URL] == BASE_URL
    assert entry.state is ConfigEntryState.LOADED

    devices_after = dr.async_entries_for_config_entry(device_registry, entry.entry_id)
    assert len(devices_after) == 1
    assert devices_after[0].id == device_before.id
    assert devices_after[0].configuration_url == BASE_URL
    _assert_requests(aioclient_mock.mock_calls, [STATUS_URL, NEW_STATUS_URL])


async def test_reconfigure_rejects_malformed_url(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Reconfigure uses the same URL validation as the initial flow."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)

    result = await _start_reconfigure(hass, entry)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: f"{NEW_BASE_URL}/api/status"}
    )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_url"}
    assert entry.unique_id == BASE_URL
    _assert_requests(aioclient_mock.mock_calls, [STATUS_URL])


async def test_reconfigure_keeps_stored_authorization(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A blank reconfigure header keeps the stored one and still sends it."""
    entry = await setup_mocked_entry(
        hass,
        aioclient_mock,
        ACTIVE_ATTACK,
        options={CONF_AUTHORIZATION: AUTHORIZATION},
    )
    aioclient_mock.get(NEW_STATUS_URL, json=ACTIVE_ATTACK)

    result = await _start_reconfigure(hass, entry)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: NEW_BASE_URL}
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.ABORT
    assert entry.options[CONF_AUTHORIZATION] == AUTHORIZATION
    assert [
        headers.get("Authorization")
        for headers in request_headers(aioclient_mock.mock_calls)
    ] == [AUTHORIZATION, AUTHORIZATION, AUTHORIZATION]


async def test_reconfigure_replaces_authorization(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A new reconfigure header replaces the stored one."""
    entry = await setup_mocked_entry(
        hass,
        aioclient_mock,
        ACTIVE_ATTACK,
        options={CONF_AUTHORIZATION: AUTHORIZATION},
    )
    aioclient_mock.get(NEW_STATUS_URL, json=ACTIVE_ATTACK)

    result = await _start_reconfigure(hass, entry)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_URL: NEW_BASE_URL, CONF_AUTHORIZATION: NEW_AUTHORIZATION},
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.ABORT
    assert entry.options[CONF_AUTHORIZATION] == NEW_AUTHORIZATION
    assert request_headers(aioclient_mock.mock_calls)[-1]["Authorization"] == (
        NEW_AUTHORIZATION
    )


async def test_reconfigure_rejects_unsafe_authorization_without_request(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A value that cannot be sent fails the form and leaves the entry alone."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)
    coordinator = entry.runtime_data

    result = await _start_reconfigure(hass, entry)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_URL: NEW_BASE_URL, CONF_AUTHORIZATION: "Bearer bad\nX-Injected: 1"},
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "reconfigure"
    assert result["errors"] == {"base": "invalid_authorization"}
    assert entry.unique_id == BASE_URL
    assert entry.data[CONF_URL] == BASE_URL
    assert entry.options == {}
    assert entry.state is ConfigEntryState.LOADED
    assert entry.runtime_data is coordinator
    _assert_requests(aioclient_mock.mock_calls, [STATUS_URL])
    # The submitted URL is kept as the suggestion; the header never is.
    schema = dict(result["data_schema"].schema)
    url_key = next(key for key in schema if key == CONF_URL)
    assert url_key.description == {"suggested_value": NEW_BASE_URL}


async def test_reconfigure_to_the_same_normalized_url_succeeds(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The live-rollout form (same URL, different casing/slash) is accepted."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)
    device_registry = dr.async_get(hass)
    entity_registry = er.async_get(hass)
    device_before = dr.async_entries_for_config_entry(device_registry, entry.entry_id)[
        0
    ]
    entities_before = {
        item.entity_id: (item.unique_id, item.device_id)
        for item in er.async_entries_for_config_entry(entity_registry, entry.entry_id)
    }

    result = await _start_reconfigure(hass, entry)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: "HTTP://TRACKER:8097/"}
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reconfigure_successful"
    assert entry.unique_id == BASE_URL
    assert entry.data[CONF_URL] == BASE_URL
    assert entry.state is ConfigEntryState.LOADED

    # Still exactly one device, the same one, with unchanged entity links.
    devices_after = dr.async_entries_for_config_entry(device_registry, entry.entry_id)
    assert len(devices_after) == 1
    assert devices_after[0].id == device_before.id
    entities_after = {
        item.entity_id: (item.unique_id, item.device_id)
        for item in er.async_entries_for_config_entry(entity_registry, entry.entry_id)
    }
    assert entities_after == entities_before
    _assert_requests(aioclient_mock.mock_calls, [STATUS_URL] * 3)
