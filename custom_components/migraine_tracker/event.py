"""Event platform for the Migraine Tracker integration."""

from homeassistant.components.event import EventEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import MigraineTrackerConfigEntry
from .coordinator import (
    ENDED_EVENT,
    STARTED_EVENT,
    STATUS_CHANGED_EVENT,
    MigraineTrackerCoordinator,
    MigraineTrackerEntity,
)

PARALLEL_UPDATES = 0


class MigraineAttackEvent(MigraineTrackerEntity, EventEntity):
    """Attack start, end, and day status transitions seen while polling.

    Restoring the last event state on startup does not re-trigger an event: the
    event entity restores its own state in async_internal_added_to_hass and the
    coordinator's first poll only establishes the baseline.
    """

    _attr_event_types = [STARTED_EVENT, ENDED_EVENT, STATUS_CHANGED_EVENT]
    _attr_translation_key = "attack_event"

    def __init__(
        self,
        coordinator: MigraineTrackerCoordinator,
        entry: MigraineTrackerConfigEntry,
    ) -> None:
        """Initialize the event entity."""
        super().__init__(coordinator, entry, "attack_event")

    @callback
    def _handle_coordinator_update(self) -> None:
        """Publish every event detected by this poll."""
        events = self.coordinator.drain_events()
        if not events:
            super()._handle_coordinator_update()
            return
        for event_type, event_data in events:
            self._trigger_event(event_type, event_data)
            # The event base class does not write a state per triggered event,
            # and one poll can produce several; publish each one individually.
            self.async_write_ha_state()


async def async_setup_entry(
    hass: HomeAssistant,
    entry: MigraineTrackerConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the Migraine Tracker event entity."""
    async_add_entities([MigraineAttackEvent(entry.runtime_data, entry)])
