"""Binary sensor platform for the Migraine Tracker integration."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import MigraineTrackerConfigEntry
from .const import ATTR_ACTIVE_ATTACK, ATTR_INVENTORY, ATTR_NURTEC
from .coordinator import (
    MigraineTrackerCoordinator,
    MigraineTrackerEntity,
    StatusData,
    as_dict,
)

PARALLEL_UPDATES = 0


def _nurtec(data: StatusData) -> dict[str, Any]:
    """Return the Nurtec inventory section of a status document."""
    return as_dict(as_dict(data.get(ATTR_INVENTORY)).get(ATTR_NURTEC))


def _active_attack_id(data: StatusData) -> str | None:
    """Return the active attack id, if an attack is ongoing."""
    return as_dict(data.get(ATTR_ACTIVE_ATTACK)).get("id")


@dataclass(frozen=True, kw_only=True)
class MigraineTrackerBinarySensorEntityDescription(BinarySensorEntityDescription):
    """Describes a Migraine Tracker binary sensor."""

    value_fn: Callable[[StatusData], bool]
    extra_attributes_fn: Callable[[StatusData], Mapping[str, Any]] | None = None


BINARY_SENSOR_DESCRIPTIONS: tuple[MigraineTrackerBinarySensorEntityDescription, ...] = (
    MigraineTrackerBinarySensorEntityDescription(
        key="active",
        translation_key="active",
        # Activeness is activeAttack, never state == "attack": a legacy explicit
        # attack day reports state "attack" with no ongoing attack.
        value_fn=lambda data: data.get(ATTR_ACTIVE_ATTACK) is not None,
        extra_attributes_fn=lambda data: {"active_attack_id": _active_attack_id(data)},
    ),
    MigraineTrackerBinarySensorEntityDescription(
        key="nurtec_low",
        translation_key="nurtec_low",
        device_class=BinarySensorDeviceClass.PROBLEM,
        value_fn=lambda data: _nurtec(data).get("low") is True,
    ),
    MigraineTrackerBinarySensorEntityDescription(
        key="nurtec_negative",
        translation_key="nurtec_negative",
        value_fn=lambda data: _nurtec(data).get("negative") is True,
    ),
)


class MigraineTrackerBinarySensor(MigraineTrackerEntity, BinarySensorEntity):
    """A Migraine Tracker binary sensor."""

    entity_description: MigraineTrackerBinarySensorEntityDescription

    def __init__(
        self,
        coordinator: MigraineTrackerCoordinator,
        entry: MigraineTrackerConfigEntry,
        description: MigraineTrackerBinarySensorEntityDescription,
    ) -> None:
        """Initialize the binary sensor."""
        super().__init__(coordinator, entry, description.key)
        self.entity_description = description

    @property
    def is_on(self) -> bool:
        """Return the binary sensor state."""
        return self.entity_description.value_fn(self.status_data)

    @property
    def extra_state_attributes(self) -> Mapping[str, Any] | None:
        """Return the entity specific state attributes."""
        if (extra_attributes_fn := self.entity_description.extra_attributes_fn) is None:
            return None
        return extra_attributes_fn(self.status_data)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: MigraineTrackerConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the Migraine Tracker binary sensors."""
    coordinator = entry.runtime_data
    async_add_entities(
        MigraineTrackerBinarySensor(coordinator, entry, description)
        for description in BINARY_SENSOR_DESCRIPTIONS
    )
