"""Diagnostics support for the Migraine Tracker integration."""

from typing import Any

from homeassistant.core import HomeAssistant

from . import MigraineTrackerConfigEntry
from .const import ATTR_API_VERSION
from .coordinator import scan_interval_seconds


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: MigraineTrackerConfigEntry
) -> dict[str, Any]:
    """Return operational diagnostics only.

    No URL, Authorization header, health data, attack ids, or raw document:
    diagnostics are attached to public issue reports.
    """
    coordinator = getattr(entry, "runtime_data", None)
    if coordinator is None:
        # Fallback for an unloaded entry, or whenever runtime_data is otherwise
        # absent. Setup retry keeps the failed coordinator instead. Diagnostics
        # must still be downloadable.
        return {
            "scan_interval": scan_interval_seconds(entry),
            "last_update_success": False,
            "api_version": None,
        }
    return {
        "scan_interval": scan_interval_seconds(entry),
        "last_update_success": coordinator.last_update_success,
        "api_version": (coordinator.data or {}).get(ATTR_API_VERSION),
    }
