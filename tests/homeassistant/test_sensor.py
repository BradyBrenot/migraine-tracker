"""Sensor platform tests: values, types, and null-versus-zero semantics."""

from __future__ import annotations

from datetime import datetime

from homeassistant.helpers import entity_registry as er
import pytest

from custom_components.migraine_tracker.coordinator import (
    MigraineTrackerCoordinator,
)
from custom_components.migraine_tracker.sensor import (
    SENSOR_DESCRIPTIONS,
    MigraineTrackerSensor,
)

from .helpers import (
    ACTIVE_ATTACK,
    DOCS_PAYLOADS,
    EMPTY_DB,
    FINISHED_WELL,
    FakeResponse,
    FakeSession,
    document,
    make_coordinator,
    make_entry,
    setup_mocked_entry,
    state_for,
    with_nurtec,
)

SENSOR_KEYS = {description.key for description in SENSOR_DESCRIPTIONS}

EXPECTED_STATES = {
    "active_attack": {
        "status": "attack",
        "last_attack_started": "2026-11-11T15:05:00+00:00",
        "days_since_last_attack": "0",
        "attack_days_last_7_days": "1",
        "attack_days_last_30_days": "4",
        "attacks_started_last_30_days": "3",
        "nurtec_tablets": "4",
    },
    "finished_well": {
        "status": "well",
        "last_attack_started": "2026-11-09T09:00:00+00:00",
        "days_since_last_attack": "2",
        "attack_days_last_7_days": "1",
        "attack_days_last_30_days": "1",
        "attacks_started_last_30_days": "1",
        "nurtec_tablets": "unknown",
    },
    "empty_db": {
        "status": "no_data",
        "last_attack_started": "unknown",
        "days_since_last_attack": "unknown",
        "attack_days_last_7_days": "0",
        "attack_days_last_30_days": "0",
        "attacks_started_last_30_days": "0",
        "nurtec_tablets": "unknown",
    },
    "legacy_attack_day": {
        "status": "attack",
        "last_attack_started": "unknown",
        "days_since_last_attack": "unknown",
        "attack_days_last_7_days": "0",
        "attack_days_last_30_days": "0",
        "attacks_started_last_30_days": "0",
        "nurtec_tablets": "unknown",
    },
}


@pytest.mark.parametrize("payload_name", list(DOCS_PAYLOADS))
async def test_sensor_values_from_docs_examples(
    hass, enable_custom_integrations, aioclient_mock, payload_name
) -> None:
    """Every sensor matches the documented value of each example document."""
    entry = await setup_mocked_entry(hass, aioclient_mock, DOCS_PAYLOADS[payload_name])

    for key, expected in EXPECTED_STATES[payload_name].items():
        assert state_for(hass, entry, "sensor", key).state == expected, key


async def test_status_sensor_is_an_enum_with_the_four_v1_states(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The display state is a real enum, never a silent HA ``unknown``."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)

    state = state_for(hass, entry, "sensor", "status")
    assert state.attributes["device_class"] == "enum"
    assert state.attributes["options"] == ["attack", "off", "well", "no_data"]


async def test_last_attack_started_is_a_timezone_aware_datetime(hass) -> None:
    """The timestamp sensor exposes a datetime, not the raw string."""
    entry = make_entry()
    entry.add_to_hass(hass)
    coordinator = make_coordinator(
        hass, entry, FakeResponse(200, ACTIVE_ATTACK), FakeResponse(200, EMPTY_DB)
    )
    description = next(
        item for item in SENSOR_DESCRIPTIONS if item.key == "last_attack_started"
    )

    await coordinator.async_refresh()
    entity = MigraineTrackerSensor(coordinator, entry, description)
    value = entity.native_value
    assert isinstance(value, datetime)
    assert value.tzinfo is not None
    assert value.isoformat() == "2026-11-11T15:05:00+00:00"
    assert entity.device_class == "timestamp"

    await coordinator.async_refresh()
    assert MigraineTrackerSensor(coordinator, entry, description).native_value is None


async def test_unknown_nurtec_stock_is_none_not_zero(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Unknown stock never becomes a zero tablet count."""
    entry = await setup_mocked_entry(hass, aioclient_mock, EMPTY_DB)
    description = next(
        item for item in SENSOR_DESCRIPTIONS if item.key == "nurtec_tablets"
    )
    entity = MigraineTrackerSensor(entry.runtime_data, entry, description)

    assert entity.native_value is None
    assert state_for(hass, entry, "sensor", "nurtec_tablets").state == "unknown"


async def test_low_stock_quantity_is_reported(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A low-but-known quantity keeps its integer value."""
    entry = await setup_mocked_entry(
        hass, aioclient_mock, with_nurtec(ACTIVE_ATTACK, quantity=2, low=True)
    )

    assert state_for(hass, entry, "sensor", "nurtec_tablets").state == "2"


async def test_negative_stock_quantity_is_preserved(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Negative stock is a valid value and is not clamped."""
    entry = await setup_mocked_entry(
        hass, aioclient_mock, with_nurtec(ACTIVE_ATTACK, quantity=-3, negative=True)
    )

    assert state_for(hass, entry, "sensor", "nurtec_tablets").state == "-3"


async def test_history_nulls_stay_null_while_counts_stay_zero(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Null rolling values are not turned into zero, and zero counts stay zero."""
    entry = await setup_mocked_entry(hass, aioclient_mock, EMPTY_DB)

    assert state_for(hass, entry, "sensor", "days_since_last_attack").state == "unknown"
    for key in (
        "attack_days_last_7_days",
        "attack_days_last_30_days",
        "attacks_started_last_30_days",
    ):
        assert state_for(hass, entry, "sensor", key).state == "0"


async def test_finished_attack_uses_last_attack_start(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The timestamp sensor follows ``lastAttack.start`` for finished attacks."""
    entry = await setup_mocked_entry(hass, aioclient_mock, FINISHED_WELL)

    assert state_for(hass, entry, "sensor", "last_attack_started").state == (
        "2026-11-09T09:00:00+00:00"
    )


async def test_active_attack_with_null_start_falls_back_to_last_attack(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A null active start means lastAttack only contains the older finished row.

    ``lastAttack`` requires a parseable start, so the active attack with
    ``start: null`` is not it; the documented behavior is that the timestamp
    sensor reports the older finished attack.
    """
    payload = document(
        ACTIVE_ATTACK,
        activeAttack={
            "id": "abc123",
            "start": None,
            "peakPain": None,
            "latestPain": None,
            "aura": None,
        },
        lastAttack={
            "id": "older",
            "start": "2026-11-01T00:00:00.000Z",
            "end": "2026-11-01T01:00:00.000Z",
            "ongoing": False,
            "durationMinutes": 60,
            "peakPain": 3,
        },
    )
    entry = await setup_mocked_entry(hass, aioclient_mock, payload)

    assert state_for(hass, entry, "binary_sensor", "active").state == "on"
    assert state_for(hass, entry, "sensor", "last_attack_started").state == (
        "2026-11-01T00:00:00+00:00"
    )


async def test_sensors_do_not_enable_long_term_statistics(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Sensitive rolling history is not opted into long-term statistics."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)

    for key in SENSOR_KEYS:
        attributes = state_for(hass, entry, "sensor", key).attributes
        assert "state_class" not in attributes, key


async def test_sensor_unique_ids(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Unique IDs are the entry ID plus the stable entity key."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)
    registry = er.async_get(hass)

    entries = [
        item
        for item in er.async_entries_for_config_entry(registry, entry.entry_id)
        if item.domain == "sensor"
    ]
    assert {item.unique_id for item in entries} == {
        f"{entry.entry_id}_{key}" for key in SENSOR_KEYS
    }


async def test_sensor_reads_latest_document_without_a_second_entity(hass) -> None:
    """Each sensor reads ``coordinator.data`` in its properties."""
    entry = make_entry()
    entry.add_to_hass(hass)
    coordinator = MigraineTrackerCoordinator(
        hass,
        FakeSession(FakeResponse(200, EMPTY_DB), FakeResponse(200, ACTIVE_ATTACK)),
        entry,
    )
    description = next(item for item in SENSOR_DESCRIPTIONS if item.key == "status")
    await coordinator.async_refresh()
    entity = MigraineTrackerSensor(coordinator, entry, description)
    assert entity.native_value == "no_data"

    await coordinator.async_refresh()
    assert entity.native_value == "attack"
    assert entity.available is True
    assert entity.unique_id == f"{entry.entry_id}_status"
