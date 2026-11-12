"""Binary sensor platform tests: activeness source and Nurtec stock flags."""

from __future__ import annotations

from homeassistant.helpers import entity_registry as er
import pytest

from custom_components.migraine_tracker.binary_sensor import (
    BINARY_SENSOR_DESCRIPTIONS,
)

from .helpers import (
    ACTIVE_ATTACK,
    EMPTY_DB,
    FINISHED_WELL,
    LEGACY_ATTACK_DAY,
    setup_mocked_entry,
    state_for,
    with_nurtec,
)

BINARY_SENSOR_KEYS = {description.key for description in BINARY_SENSOR_DESCRIPTIONS}


async def test_active_sensor_uses_active_attack(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The active sensor is on when activeAttack is present."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)

    state = state_for(hass, entry, "binary_sensor", "active")
    assert state.state == "on"
    assert state.attributes["active_attack_id"] == "abc123"
    # A migraine is not a device problem, so there is no device class.
    assert "device_class" not in state.attributes


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(FINISHED_WELL, id="finished_attack"),
        pytest.param(EMPTY_DB, id="empty_database"),
        pytest.param(LEGACY_ATTACK_DAY, id="legacy_attack_day"),
    ],
)
async def test_active_sensor_off_without_active_attack(
    hass, enable_custom_integrations, aioclient_mock, payload
) -> None:
    """No activeAttack means off, even for a legacy explicit attack day."""
    entry = await setup_mocked_entry(hass, aioclient_mock, payload)

    state = state_for(hass, entry, "binary_sensor", "active")
    assert state.state == "off"
    assert state.attributes["active_attack_id"] is None


async def test_legacy_attack_day_is_not_an_active_attack(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A legacy day record says ``attack`` while no attack is ongoing."""
    entry = await setup_mocked_entry(hass, aioclient_mock, LEGACY_ATTACK_DAY)

    assert state_for(hass, entry, "sensor", "status").state == "attack"
    assert state_for(hass, entry, "binary_sensor", "active").state == "off"


async def test_nurtec_low_stock_sensor(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Low stock comes from the API boolean and uses the problem device class."""
    entry = await setup_mocked_entry(
        hass, aioclient_mock, with_nurtec(ACTIVE_ATTACK, quantity=2, low=True)
    )

    state = state_for(hass, entry, "binary_sensor", "nurtec_low")
    assert state.state == "on"
    assert state.attributes["device_class"] == "problem"

    assert state_for(hass, entry, "binary_sensor", "nurtec_negative").state == "off"


async def test_nurtec_sensors_off_when_stock_is_unknown(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Unknown stock is neither low nor negative."""
    entry = await setup_mocked_entry(hass, aioclient_mock, EMPTY_DB)

    assert state_for(hass, entry, "binary_sensor", "nurtec_low").state == "off"
    assert state_for(hass, entry, "binary_sensor", "nurtec_negative").state == "off"


async def test_nurtec_negative_stock_sensor(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Negative stock comes from the API boolean."""
    entry = await setup_mocked_entry(
        hass, aioclient_mock, with_nurtec(ACTIVE_ATTACK, quantity=-1, negative=True)
    )

    state = state_for(hass, entry, "binary_sensor", "nurtec_negative")
    assert state.state == "on"
    # Only the low-stock sensor is documented as a problem device class.
    assert "device_class" not in state.attributes
    assert state_for(hass, entry, "sensor", "nurtec_tablets").state == "-1"


async def test_binary_sensor_unique_ids_and_device_association(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Unique IDs are stable and every sensor belongs to the single device."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)
    registry = er.async_get(hass)

    entries = [
        item
        for item in er.async_entries_for_config_entry(registry, entry.entry_id)
        if item.domain == "binary_sensor"
    ]
    assert {item.unique_id for item in entries} == {
        f"{entry.entry_id}_{key}" for key in BINARY_SENSOR_KEYS
    }
    assert len({item.device_id for item in entries}) == 1
