"""Entity metadata and translation tests for the integration."""

from __future__ import annotations

from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.translation import async_get_translations

from custom_components.migraine_tracker.const import (
    CONF_AUTHORIZATION,
    CONF_CLEAR_AUTHORIZATION,
    CONF_SCAN_INTERVAL,
    CONF_URL,
    DOMAIN,
)

from .helpers import ACTIVE_ATTACK, setup_mocked_entry

ENTITY_UNIQUE_ID_KEYS = {
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

# ``DeviceInfo.name`` is "Migraine Tracker", so each entity name is relative to
# it: the friendly name is "Migraine Tracker <name>" and the entity id is the
# slug of that whole name. The Nurtec names stay self-describing.
ENTITY_DISPLAY_NAMES = {
    "sensor": {
        "status": ("Status", "sensor.migraine_tracker_status"),
        "last_attack_started": (
            "Last attack started",
            "sensor.migraine_tracker_last_attack_started",
        ),
        "days_since_last_attack": (
            "Days since last attack",
            "sensor.migraine_tracker_days_since_last_attack",
        ),
        "attack_days_last_7_days": (
            "Attack days last 7 days",
            "sensor.migraine_tracker_attack_days_last_7_days",
        ),
        "attack_days_last_30_days": (
            "Attack days last 30 days",
            "sensor.migraine_tracker_attack_days_last_30_days",
        ),
        "attacks_started_last_30_days": (
            "Attacks started last 30 days",
            "sensor.migraine_tracker_attacks_started_last_30_days",
        ),
        "nurtec_tablets": ("Nurtec tablets", "sensor.migraine_tracker_nurtec_tablets"),
    },
    "binary_sensor": {
        "active": ("Active attack", "binary_sensor.migraine_tracker_active_attack"),
        "nurtec_low": (
            "Nurtec low stock",
            "binary_sensor.migraine_tracker_nurtec_low_stock",
        ),
        "nurtec_negative": (
            "Nurtec stock negative",
            "binary_sensor.migraine_tracker_nurtec_stock_negative",
        ),
    },
    "event": {
        "attack_event": ("Attack event", "event.migraine_tracker_attack_event"),
    },
}


async def test_entity_unique_ids_and_device_links(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Every entity uses ``entry.entry_id + key`` and one shared device."""
    entry = await setup_mocked_entry(
        hass, aioclient_mock, ACTIVE_ATTACK, options={CONF_AUTHORIZATION: "token"}
    )
    registry = er.async_get(hass)
    entries = er.async_entries_for_config_entry(registry, entry.entry_id)

    assert len(entries) == 11
    expected = {
        f"{entry.entry_id}_{key}"
        for keys in ENTITY_UNIQUE_ID_KEYS.values()
        for key in keys
    }
    assert {item.unique_id for item in entries} == expected

    device_entries = dr.async_entries_for_config_entry(
        dr.async_get(hass), entry.entry_id
    )
    assert len(device_entries) == 1
    device = device_entries[0]
    assert {item.device_id for item in entries} == {device.id}
    assert device.identifiers == {(DOMAIN, entry.entry_id)}
    assert device.configuration_url == entry.data[CONF_URL]


async def test_entity_names_and_enum_states_are_translated(
    hass, enable_custom_integrations
) -> None:
    """Translation keys exist for every entity name and enum display state."""
    translations = await async_get_translations(hass, "en", "entity", [DOMAIN])

    expected_names = (
        {
            f"component.{DOMAIN}.entity.sensor.{key}.name"
            for key in ENTITY_UNIQUE_ID_KEYS["sensor"]
        }
        | {
            f"component.{DOMAIN}.entity.binary_sensor.{key}.name"
            for key in ENTITY_UNIQUE_ID_KEYS["binary_sensor"]
        }
        | {
            f"component.{DOMAIN}.entity.event.attack_event.name",
        }
    )
    for key in sorted(expected_names):
        assert translations.get(key), key

    for platform, names in ENTITY_DISPLAY_NAMES.items():
        for key, (name, _entity_id) in names.items():
            assert translations[f"component.{DOMAIN}.entity.{platform}.{key}.name"] == (
                name
            )

    for state in ("attack", "off", "well", "no_data"):
        key = f"component.{DOMAIN}.entity.sensor.status.state.{state}"
        assert translations.get(key), key


async def test_config_and_options_translations_resolve(
    hass, enable_custom_integrations
) -> None:
    """Every config/reconfigure/options string and error used by the flow exists."""
    config = await async_get_translations(hass, "en", "config", [DOMAIN])

    expected = [
        f"component.{DOMAIN}.config.step.user.title",
        f"component.{DOMAIN}.config.step.user.description",
        f"component.{DOMAIN}.config.step.user.data.{CONF_URL}",
        f"component.{DOMAIN}.config.step.user.data.{CONF_AUTHORIZATION}",
        f"component.{DOMAIN}.config.step.user.data_description.{CONF_AUTHORIZATION}",
        f"component.{DOMAIN}.config.step.reconfigure.title",
        f"component.{DOMAIN}.config.step.reconfigure.data.{CONF_URL}",
        f"component.{DOMAIN}.config.error.cannot_connect",
        f"component.{DOMAIN}.config.error.invalid_response",
        f"component.{DOMAIN}.config.error.unsupported_api_version",
        f"component.{DOMAIN}.config.error.unauthorized",
        f"component.{DOMAIN}.config.error.invalid_url",
        f"component.{DOMAIN}.config.error.invalid_authorization",
        f"component.{DOMAIN}.config.abort.already_configured",
        f"component.{DOMAIN}.config.abort.single_instance_allowed",
        f"component.{DOMAIN}.config.abort.reconfigure_successful",
    ]
    for key in expected:
        assert config.get(key), key

    options = await async_get_translations(hass, "en", "options", [DOMAIN])
    expected_options = [
        f"component.{DOMAIN}.options.step.init.title",
        f"component.{DOMAIN}.options.step.init.data.{CONF_SCAN_INTERVAL}",
        f"component.{DOMAIN}.options.step.init.data.{CONF_AUTHORIZATION}",
        f"component.{DOMAIN}.options.step.init.data.{CONF_CLEAR_AUTHORIZATION}",
        f"component.{DOMAIN}.options.error.invalid_authorization",
    ]
    for key in expected_options:
        assert options.get(key), key


async def test_entities_use_translated_friendly_names(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Friendly names and entity ids come from the device and entity names."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)
    registry = er.async_get(hass)

    for platform, names in ENTITY_DISPLAY_NAMES.items():
        for key, (name, expected_entity_id) in names.items():
            entity_id = registry.async_get_entity_id(
                platform, DOMAIN, f"{entry.entry_id}_{key}"
            )
            assert entity_id == expected_entity_id
            state = hass.states.get(entity_id)
            assert state is not None, entity_id
            assert state.attributes["friendly_name"] == f"Migraine Tracker {name}"
            # The name is relative to the device, so it is not repeated in the
            # entity id ("…_migraine_status" would be redundant).
            assert "migraine_tracker_migraine" not in entity_id


async def test_entity_names_do_not_repeat_the_device_name(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """No display name starts with "Migraine ": the device already says it."""
    translations = await async_get_translations(hass, "en", "entity", [DOMAIN])

    for platform, names in ENTITY_DISPLAY_NAMES.items():
        for key, (name, _entity_id) in names.items():
            translated = translations[
                f"component.{DOMAIN}.entity.{platform}.{key}.name"
            ]
            assert not translated.startswith("Migraine"), translated
            assert translated == name
