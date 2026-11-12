"""Sensor platform for the Migraine Tracker integration."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.typing import StateType
from homeassistant.util import dt as dt_util

from . import MigraineTrackerConfigEntry
from .const import (
    ATTR_HISTORY,
    ATTR_INVENTORY,
    ATTR_LAST_ATTACK,
    ATTR_NURTEC,
    ATTR_STATE,
    STATUS_OPTIONS,
)
from .coordinator import (
    MigraineTrackerCoordinator,
    MigraineTrackerEntity,
    StatusData,
    as_dict,
)

PARALLEL_UPDATES = 0


def _as_int(value: Any) -> int | None:
    """Return an integer value, or None for anything else."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _history(data: StatusData) -> dict[str, Any]:
    """Return the history section of a status document."""
    return as_dict(data.get(ATTR_HISTORY))


def _nurtec(data: StatusData) -> dict[str, Any]:
    """Return the Nurtec inventory section of a status document."""
    return as_dict(as_dict(data.get(ATTR_INVENTORY)).get(ATTR_NURTEC))


def _last_attack_started(data: StatusData) -> datetime | None:
    """Return the last attack start as a timezone-aware datetime."""
    start = as_dict(data.get(ATTR_LAST_ATTACK)).get("start")
    if not isinstance(start, str) or not start:
        return None
    parsed = dt_util.parse_datetime(start)
    if parsed is None or parsed.tzinfo is None:
        return None
    return parsed


@dataclass(frozen=True, kw_only=True)
class MigraineTrackerSensorEntityDescription(SensorEntityDescription):
    """Describes a Migraine Tracker sensor."""

    value_fn: Callable[[StatusData], StateType]


SENSOR_DESCRIPTIONS: tuple[MigraineTrackerSensorEntityDescription, ...] = (
    MigraineTrackerSensorEntityDescription(
        key="status",
        translation_key="status",
        device_class=SensorDeviceClass.ENUM,
        options=list(STATUS_OPTIONS),
        value_fn=lambda data: data.get(ATTR_STATE),
    ),
    MigraineTrackerSensorEntityDescription(
        key="last_attack_started",
        translation_key="last_attack_started",
        device_class=SensorDeviceClass.TIMESTAMP,
        value_fn=_last_attack_started,
    ),
    MigraineTrackerSensorEntityDescription(
        key="days_since_last_attack",
        translation_key="days_since_last_attack",
        value_fn=lambda data: _as_int(_history(data).get("daysSinceLastAttackStart")),
    ),
    MigraineTrackerSensorEntityDescription(
        key="attack_days_last_7_days",
        translation_key="attack_days_last_7_days",
        value_fn=lambda data: _as_int(_history(data).get("attackDaysLast7Days")),
    ),
    MigraineTrackerSensorEntityDescription(
        key="attack_days_last_30_days",
        translation_key="attack_days_last_30_days",
        value_fn=lambda data: _as_int(_history(data).get("attackDaysLast30Days")),
    ),
    MigraineTrackerSensorEntityDescription(
        key="attacks_started_last_30_days",
        translation_key="attacks_started_last_30_days",
        value_fn=lambda data: _as_int(_history(data).get("attacksStartedLast30Days")),
    ),
    MigraineTrackerSensorEntityDescription(
        key="nurtec_tablets",
        translation_key="nurtec_tablets",
        value_fn=lambda data: _as_int(_nurtec(data).get("quantity")),
    ),
)


class MigraineTrackerSensor(MigraineTrackerEntity, SensorEntity):
    """A Migraine Tracker sensor."""

    entity_description: MigraineTrackerSensorEntityDescription

    def __init__(
        self,
        coordinator: MigraineTrackerCoordinator,
        entry: MigraineTrackerConfigEntry,
        description: MigraineTrackerSensorEntityDescription,
    ) -> None:
        """Initialize the sensor."""
        super().__init__(coordinator, entry, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> StateType:
        """Return the sensor value."""
        return self.entity_description.value_fn(self.status_data)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: MigraineTrackerConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the Migraine Tracker sensors."""
    coordinator = entry.runtime_data
    async_add_entities(
        MigraineTrackerSensor(coordinator, entry, description)
        for description in SENSOR_DESCRIPTIONS
    )
