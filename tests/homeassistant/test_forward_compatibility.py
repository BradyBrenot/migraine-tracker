"""Forward compatibility: unknown additive document fields are ignored.

The apiVersion 1 contract says clients must ignore unknown fields and that
adding fields never bumps ``apiVersion``.
"""

from __future__ import annotations

from homeassistant.config_entries import SOURCE_USER, ConfigEntryState
from homeassistant.data_entry_flow import FlowResultType

from custom_components.migraine_tracker.const import CONF_URL, DOMAIN

from .helpers import (
    ACTIVE_ATTACK,
    BASE_URL,
    STATUS_URL,
    assert_only_status_gets,
    state_for,
    with_extra_fields,
)

DOCUMENT_WITH_UNKNOWN_FIELDS = with_extra_fields(ACTIVE_ATTACK)


async def test_unknown_fields_survive_flow_validation_polling_and_entities(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Extra keys anywhere in the document are accepted and change no value."""
    aioclient_mock.get(STATUS_URL, json=DOCUMENT_WITH_UNKNOWN_FIELDS)

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: BASE_URL}
    )

    # Config-flow validation accepted the unknown fields.
    assert result["type"] is FlowResultType.CREATE_ENTRY
    entry = result["result"]
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED

    # Entity values are the documented ones, unaffected by the extra keys.
    assert state_for(hass, entry, "sensor", "status").state == "attack"
    assert state_for(hass, entry, "binary_sensor", "active").state == "on"
    assert state_for(hass, entry, "sensor", "last_attack_started").state == (
        "2026-11-11T15:05:00+00:00"
    )
    assert state_for(hass, entry, "sensor", "days_since_last_attack").state == "0"
    assert state_for(hass, entry, "sensor", "nurtec_tablets").state == "4"
    assert state_for(hass, entry, "sensor", "attack_days_last_7_days").state == "1"
    assert state_for(hass, entry, "sensor", "attack_days_last_30_days").state == "4"
    assert state_for(hass, entry, "sensor", "attacks_started_last_30_days").state == "3"
    assert state_for(hass, entry, "binary_sensor", "nurtec_low").state == "off"
    assert state_for(hass, entry, "binary_sensor", "nurtec_negative").state == "off"

    # Polling keeps working and keeps going through one status GET.
    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()
    assert entry.runtime_data.last_update_success is True
    assert entry.runtime_data.pending_events == []
    assert_only_status_gets(aioclient_mock.mock_calls, count=3)
