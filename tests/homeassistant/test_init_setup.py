"""Setup, unload, reload, and availability tests for the config entry."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntryState
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.update_coordinator import UpdateFailed

from custom_components.migraine_tracker import binary_sensor, sensor
from custom_components.migraine_tracker.const import CONF_AUTHORIZATION
from custom_components.migraine_tracker.event import PARALLEL_UPDATES as EVENT_PARALLEL

from .helpers import (
    ACTIVE_ATTACK,
    AUTHORIZATION,
    STATUS_URL,
    assert_only_status_gets,
    entity_id_for,
    make_entry,
    request_headers,
    setup_mocked_entry,
    state_for,
)

EXPECTED_ENTITY_KEYS = {
    "sensor": {
        "status",
        "last_attack_started",
        "days_since_last_attack",
        "attack_days_last_7_days",
        "attack_days_last_30_days",
        "attacks_started_last_30_days",
        "nurtec_tablets",
    },
    "binary_sensor": {"active", "nurtec_low", "nurtec_negative"},
    "event": {"attack_event"},
}


async def test_setup_populates_entities_from_first_refresh(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Setup polls once and every entity already has its value."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)

    assert entry.state is ConfigEntryState.LOADED
    assert entry.runtime_data.config_entry is entry
    assert entry.update_listeners == []

    # Values are populated from the first refresh: no second poll happened.
    assert_only_status_gets(aioclient_mock.mock_calls, count=1)
    assert state_for(hass, entry, "sensor", "status").state == "attack"
    assert state_for(hass, entry, "binary_sensor", "active").state == "on"
    assert state_for(hass, entry, "sensor", "nurtec_tablets").state == "4"

    registry = er.async_get(hass)
    entries = er.async_entries_for_config_entry(registry, entry.entry_id)
    assert len(entries) == 11
    found = {
        platform: {
            item.unique_id.removeprefix(f"{entry.entry_id}_")
            for item in entries
            if item.domain == platform
        }
        for platform in EXPECTED_ENTITY_KEYS
    }
    assert found == EXPECTED_ENTITY_KEYS

    devices = dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)
    assert len(devices) == 1
    device = devices[0]
    assert device.name == "Migraine Tracker"
    assert device.manufacturer == "migraine-tracker"
    assert device.configuration_url == entry.data["url"]
    assert all(item.device_id == device.id for item in entries)


async def test_setup_retries_when_first_poll_fails(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A failing first refresh leaves the entry in setup-retry, not loaded."""
    aioclient_mock.get(STATUS_URL, status=500)
    entry = make_entry()
    entry.add_to_hass(hass)

    assert await hass.config_entries.async_setup(entry.entry_id) is False
    await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert entry.update_listeners == []
    registry = er.async_get(hass)
    assert er.async_entries_for_config_entry(registry, entry.entry_id) == []
    assert_only_status_gets(aioclient_mock.mock_calls, count=1)


async def test_unload_then_reload(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Unload removes entities; reload rebuilds them from one fresh poll."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)
    status_entity_id = entity_id_for(hass, entry, "sensor", "status")
    assert status_entity_id is not None

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.NOT_LOADED
    status_state = hass.states.get(status_entity_id)
    assert status_state is not None
    assert status_state.state == "unavailable"

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.LOADED
    assert hass.states.get(status_entity_id).state == "attack"
    assert_only_status_gets(aioclient_mock.mock_calls, count=2)


async def test_availability_follows_last_update_success(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Every entity is unavailable while the coordinator is failing."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)
    coordinator = entry.runtime_data

    coordinator.async_set_update_error(UpdateFailed("boom"))
    await hass.async_block_till_done()

    for platform, keys in EXPECTED_ENTITY_KEYS.items():
        for key in keys:
            assert state_for(hass, entry, platform, key).state == "unavailable"

    coordinator.async_set_updated_data(coordinator.data)
    await hass.async_block_till_done()

    for platform, keys in EXPECTED_ENTITY_KEYS.items():
        for key in keys:
            assert state_for(hass, entry, platform, key).state != "unavailable"


async def test_setup_sends_configured_authorization_header(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The stored proxy header is sent on the setup poll."""
    entry = await setup_mocked_entry(
        hass,
        aioclient_mock,
        ACTIVE_ATTACK,
        options={CONF_AUTHORIZATION: AUTHORIZATION},
    )

    assert entry.state is ConfigEntryState.LOADED
    assert request_headers(aioclient_mock.mock_calls) == [
        {"Authorization": AUTHORIZATION}
    ]


def test_platforms_issue_no_parallel_requests() -> None:
    """Platforms rely on the coordinator and never request data themselves."""
    assert sensor.PARALLEL_UPDATES == 0
    assert binary_sensor.PARALLEL_UPDATES == 0
    assert EVENT_PARALLEL == 0
