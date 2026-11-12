"""Diagnostics tests: the operational allowlist only."""

from __future__ import annotations

import json

from homeassistant.config_entries import ConfigEntryState
from homeassistant.helpers.update_coordinator import UpdateFailed

from custom_components.migraine_tracker.const import (
    CONF_AUTHORIZATION,
    CONF_SCAN_INTERVAL,
)
from custom_components.migraine_tracker.diagnostics import (
    async_get_config_entry_diagnostics,
)

from .helpers import (
    ACTIVE_ATTACK,
    AUTHORIZATION,
    STATUS_URL,
    make_entry,
    setup_mocked_entry,
)

ALLOWED_KEYS = {"scan_interval", "last_update_success", "api_version"}


async def test_diagnostics_contains_exactly_the_allowlist(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Diagnostics expose scan interval, success flag, and API version only."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)

    result = await async_get_config_entry_diagnostics(hass, entry)

    assert set(result) == ALLOWED_KEYS
    assert result == {
        "scan_interval": 60,
        "last_update_success": True,
        "api_version": 1,
    }
    dumped = json.dumps(result)
    for forbidden in ("http", "abc123", "Bearer", "timeZone", "nurtec"):
        assert forbidden not in dumped


async def test_diagnostics_excludes_the_authorization_header(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The proxy header never appears in diagnostics."""
    entry = await setup_mocked_entry(
        hass,
        aioclient_mock,
        ACTIVE_ATTACK,
        options={CONF_AUTHORIZATION: AUTHORIZATION, CONF_SCAN_INTERVAL: 5},
    )

    result = await async_get_config_entry_diagnostics(hass, entry)

    assert set(result) == ALLOWED_KEYS
    assert result["scan_interval"] == 15
    assert AUTHORIZATION not in json.dumps(result)


async def test_diagnostics_reports_failed_updates(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A failed poll is visible as last_update_success false."""
    entry = await setup_mocked_entry(hass, aioclient_mock, ACTIVE_ATTACK)

    entry.runtime_data.async_set_update_error(UpdateFailed("boom"))
    await hass.async_block_till_done()

    result = await async_get_config_entry_diagnostics(hass, entry)

    assert set(result) == ALLOWED_KEYS
    assert result["last_update_success"] is False
    assert result["api_version"] == 1


async def test_diagnostics_work_after_unloading_the_entry(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """After an unload there is no runtime_data, and diagnostics still work."""
    entry = await setup_mocked_entry(
        hass,
        aioclient_mock,
        ACTIVE_ATTACK,
        options={CONF_SCAN_INTERVAL: 120},
    )
    assert entry.runtime_data is not None

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED

    result = await async_get_config_entry_diagnostics(hass, entry)

    assert set(result) == ALLOWED_KEYS
    assert result == {
        "scan_interval": 120,
        "last_update_success": False,
        "api_version": None,
    }


async def test_diagnostics_work_during_setup_retry(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A failed first refresh leaves the failed coordinator in runtime_data."""
    aioclient_mock.get(STATUS_URL, status=500)
    entry = make_entry()
    entry.add_to_hass(hass)

    assert await hass.config_entries.async_setup(entry.entry_id) is False
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert entry.runtime_data is not None

    result = await async_get_config_entry_diagnostics(hass, entry)

    assert set(result) == ALLOWED_KEYS
    assert result["scan_interval"] == 60
    assert result["last_update_success"] is False
    assert result["api_version"] is None
