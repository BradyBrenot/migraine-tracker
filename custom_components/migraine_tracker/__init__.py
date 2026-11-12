"""The Migraine Tracker integration."""

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .coordinator import MigraineTrackerCoordinator

PLATFORMS: list[Platform] = [
    Platform.BINARY_SENSOR,
    Platform.SENSOR,
    Platform.EVENT,
]

type MigraineTrackerConfigEntry = ConfigEntry[MigraineTrackerCoordinator]


async def async_setup_entry(
    hass: HomeAssistant, entry: MigraineTrackerConfigEntry
) -> bool:
    """Set up Migraine Tracker from a config entry."""
    coordinator = MigraineTrackerCoordinator(hass, async_get_clientsession(hass), entry)
    entry.runtime_data = coordinator

    # Raises ConfigEntryNotReady when the first poll fails.
    await coordinator.async_config_entry_first_refresh()

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: MigraineTrackerConfigEntry
) -> bool:
    """Unload a Migraine Tracker config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
