"""Event entity tests: baseline, start, end, status, and suppression rules."""

from __future__ import annotations

from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import HomeAssistant, State
from homeassistant.helpers import entity_registry as er
import pytest
from pytest_homeassistant_custom_component.common import (
    async_capture_events,
    mock_restore_cache_with_extra_data,
)

from custom_components.migraine_tracker.const import DOMAIN

from .helpers import (
    ACTIVE_ATTACK,
    EMPTY_DB,
    FINISHED_WELL,
    LEGACY_ATTACK_DAY,
    STATUS_URL,
    FakeResponse,
    attack,
    document,
    event_sequence,
    make_entry,
    mock_status_queue,
)

END = "2026-11-11T16:00:00.000Z"
OLDER_ATTACK = attack(
    "older",
    start="2026-11-01T00:00:00.000Z",
    end="2026-11-01T01:00:00.000Z",
    ongoing=False,
    duration_minutes=60,
)
EXPLICIT_ATTACK_DAY = {
    "day": "2026-11-11",
    "status": "attack",
    "source": "explicit",
}


def _response(payload: dict) -> FakeResponse:
    """Return a 200 response for a status document."""
    return FakeResponse(200, payload)


def _finished_same_attack() -> dict:
    """Return a document where the active attack finished and the day is explicit."""
    return document(
        ACTIVE_ATTACK,
        activeAttack=None,
        lastAttack=attack("abc123", end=END, ongoing=False, duration_minutes=55),
        today=EXPLICIT_ATTACK_DAY,
    )


async def _setup_entry(hass: HomeAssistant, aioclient_mock, *payloads: dict):
    """Set up an entry whose poll responses come from a queue."""
    queue = mock_status_queue(aioclient_mock, *[_response(item) for item in payloads])
    entry = make_entry()
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry, queue


async def _poll(hass: HomeAssistant, entry) -> None:
    """Run one coordinator poll and wait for entity writes."""
    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()


def _event_entity_id(hass: HomeAssistant, entry) -> str:
    """Return the event entity ID for the entry."""
    entity_id = er.async_get(hass).async_get_entity_id(
        "event", DOMAIN, f"{entry.entry_id}_attack_event"
    )
    assert entity_id is not None
    return entity_id


async def test_event_entity_metadata(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The event entity exposes exactly the three documented event types."""
    entry, _queue = await _setup_entry(hass, aioclient_mock, ACTIVE_ATTACK)

    state = hass.states.get(_event_entity_id(hass, entry))
    assert state is not None
    assert state.attributes["event_types"] == [
        "attack_started",
        "attack_ended",
        "status_changed",
    ]
    # Baseline only: no event has been triggered yet.
    assert state.attributes["event_type"] is None
    assert state.state == "unknown"


async def test_first_refresh_fires_nothing(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A fresh setup with an attack already active establishes the baseline."""
    queue = mock_status_queue(aioclient_mock, _response(ACTIVE_ATTACK))
    entry = make_entry()
    entry.add_to_hass(hass)
    captured = async_capture_events(hass, EVENT_STATE_CHANGED)

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert event_sequence(captured, _event_entity_id(hass, entry)) == []
    assert [url for _method, url in queue.calls] == [STATUS_URL]


async def test_new_active_id_fires_attack_started(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A new active id produces one attack_started with the attack id."""
    entry, _queue = await _setup_entry(
        hass, aioclient_mock, LEGACY_ATTACK_DAY, ACTIVE_ATTACK
    )
    entity_id = _event_entity_id(hass, entry)
    captured = async_capture_events(hass, EVENT_STATE_CHANGED)

    await _poll(hass, entry)

    assert event_sequence(captured, entity_id) == [
        ("attack_started", {"attack_id": "abc123"})
    ]


async def test_same_attack_finishing_fires_attack_ended(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The same id finishing produces exactly one attack_ended."""
    entry, _queue = await _setup_entry(
        hass, aioclient_mock, ACTIVE_ATTACK, _finished_same_attack()
    )
    entity_id = _event_entity_id(hass, entry)
    captured = async_capture_events(hass, EVENT_STATE_CHANGED)

    await _poll(hass, entry)

    assert event_sequence(captured, entity_id) == [
        ("attack_ended", {"attack_id": "abc123"})
    ]


async def test_deleted_attack_row_fires_no_end_event(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A deleted row moves lastAttack elsewhere and must not fake an end."""
    deleted = document(
        ACTIVE_ATTACK,
        activeAttack=None,
        lastAttack=OLDER_ATTACK,
        today=EXPLICIT_ATTACK_DAY,
    )
    entry, _queue = await _setup_entry(hass, aioclient_mock, ACTIVE_ATTACK, deleted)
    entity_id = _event_entity_id(hass, entry)
    captured = async_capture_events(hass, EVENT_STATE_CHANGED)

    await _poll(hass, entry)

    assert event_sequence(captured, entity_id) == []


async def test_display_state_change_fires_status_changed(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """The display state change carries the new state in its payload."""
    entry, _queue = await _setup_entry(hass, aioclient_mock, EMPTY_DB, FINISHED_WELL)
    entity_id = _event_entity_id(hass, entry)
    captured = async_capture_events(hass, EVENT_STATE_CHANGED)

    await _poll(hass, entry)

    assert event_sequence(captured, entity_id) == [
        ("status_changed", {"state": "well"})
    ]


async def test_one_poll_publishes_each_event_separately(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """A single poll can produce attack_started and status_changed as two events."""
    entry, _queue = await _setup_entry(hass, aioclient_mock, EMPTY_DB, ACTIVE_ATTACK)
    entity_id = _event_entity_id(hass, entry)
    captured = async_capture_events(hass, EVENT_STATE_CHANGED)

    await _poll(hass, entry)

    assert event_sequence(captured, entity_id) == [
        ("attack_started", {"attack_id": "abc123"}),
        ("status_changed", {"state": "attack"}),
    ]


async def test_closing_earliest_of_two_ongoing_attacks(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Closing the earliest ongoing attack only reports the remaining start."""
    early = attack("early", start="2026-11-11T10:00:00.000Z")
    late = attack("late", start="2026-11-11T12:00:00.000Z")
    baseline = document(
        ACTIVE_ATTACK,
        activeAttack={
            **ACTIVE_ATTACK["activeAttack"],
            "id": "early",
            "start": early["start"],
        },
        lastAttack=late,
    )
    after_close = document(
        baseline,
        activeAttack={
            **ACTIVE_ATTACK["activeAttack"],
            "id": "late",
            "start": late["start"],
        },
        lastAttack=late,
    )
    entry, _queue = await _setup_entry(hass, aioclient_mock, baseline, after_close)
    entity_id = _event_entity_id(hass, entry)
    captured = async_capture_events(hass, EVENT_STATE_CHANGED)

    await _poll(hass, entry)

    # No fabricated end for "early": only the documented start of "late".
    assert event_sequence(captured, entity_id) == [
        ("attack_started", {"attack_id": "late"})
    ]


async def test_null_start_active_attack_suppresses_end(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """An active attack with no parseable start cannot produce a same-id end."""
    baseline = document(
        ACTIVE_ATTACK,
        activeAttack={
            "id": "abc123",
            "start": None,
            "peakPain": None,
            "latestPain": None,
            "aura": None,
        },
        lastAttack=OLDER_ATTACK,
    )
    after_close = document(
        baseline,
        activeAttack=None,
        today=EXPLICIT_ATTACK_DAY,
    )
    entry, _queue = await _setup_entry(hass, aioclient_mock, baseline, after_close)
    entity_id = _event_entity_id(hass, entry)
    captured = async_capture_events(hass, EVENT_STATE_CHANGED)

    await _poll(hass, entry)

    # Documented API limitation: lastAttack is the older row, so no end event.
    assert event_sequence(captured, entity_id) == []
    assert entry.runtime_data.pending_events == []


async def test_one_poll_ending_one_attack_and_starting_another_reports_only_start(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Documented limitation: the active-id guard suppresses the end of A.

    When attack A ends and attack B is already active by the next poll, the
    endpoint only exposes B as activeAttack. The integration cannot prove A
    finished (lastAttack no longer points at A), so it emits only the start of
    B and never a fabricated end for A.
    """
    after_swap = document(
        ACTIVE_ATTACK,
        activeAttack={**ACTIVE_ATTACK["activeAttack"], "id": "def456"},
        lastAttack=attack("def456"),
    )
    entry, _queue = await _setup_entry(hass, aioclient_mock, ACTIVE_ATTACK, after_swap)
    entity_id = _event_entity_id(hass, entry)
    captured = async_capture_events(hass, EVENT_STATE_CHANGED)

    await _poll(hass, entry)

    assert event_sequence(captured, entity_id) == [
        ("attack_started", {"attack_id": "def456"})
    ]


async def test_reload_with_active_attack_is_silent(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Reloading with an attack already active fires no event."""
    entry, _queue = await _setup_entry(
        hass, aioclient_mock, ACTIVE_ATTACK, ACTIVE_ATTACK
    )
    captured = async_capture_events(hass, EVENT_STATE_CHANGED)

    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()

    entity_id = _event_entity_id(hass, entry)
    assert event_sequence(captured, entity_id) == []
    state = hass.states.get(entity_id)
    assert state is not None
    assert state.attributes["event_type"] is None


async def test_disabled_event_entity_does_not_replay_on_enable(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Events that happened while the entity was disabled are never replayed."""
    registry = er.async_get(hass)
    entry = make_entry()
    entry.add_to_hass(hass)
    entity_id = registry.async_get_or_create(
        "event",
        DOMAIN,
        f"{entry.entry_id}_attack_event",
        config_entry=entry,
        suggested_object_id="migraine_tracker_attack_event",
        disabled_by=er.RegistryEntryDisabler.USER,
    ).entity_id

    finished = _finished_same_attack()
    queue = mock_status_queue(
        aioclient_mock,
        _response(ACTIVE_ATTACK),
        _response(finished),
        _response(finished),
        _response(finished),
    )
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    # The event entity is disabled: the platform does not add it.
    assert hass.states.get(entity_id) is None

    await _poll(hass, entry)
    assert entry.runtime_data.pending_events == [
        ("attack_ended", {"attack_id": "abc123"})
    ]

    # A later poll replaces the pending list instead of accumulating events.
    await _poll(hass, entry)
    assert entry.runtime_data.pending_events == []

    captured = async_capture_events(hass, EVENT_STATE_CHANGED)
    registry.async_update_entity(entity_id, disabled_by=None)
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()

    assert event_sequence(captured, entity_id) == []
    state = hass.states.get(entity_id)
    assert state is not None
    assert state.attributes["event_type"] is None
    assert [url for _method, url in queue.calls] == [STATUS_URL] * 4


async def test_restored_event_state_is_not_a_new_event(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Restoring the last event state never re-triggers an event."""
    restored_state = "2026-11-11T12:00:00.500+00:00"
    entry = make_entry()
    entry.add_to_hass(hass)
    entity_id = (
        er.async_get(hass)
        .async_get_or_create(
            "event",
            DOMAIN,
            f"{entry.entry_id}_attack_event",
            config_entry=entry,
            suggested_object_id="migraine_tracker_attack_event",
        )
        .entity_id
    )
    mock_restore_cache_with_extra_data(
        hass,
        [
            (
                State(
                    entity_id,
                    restored_state,
                    {"event_type": "attack_started", "attack_id": "older-attack"},
                ),
                {
                    "last_event_type": "attack_started",
                    "last_event_attributes": {"attack_id": "older-attack"},
                },
            )
        ],
    )
    mock_status_queue(aioclient_mock, _response(ACTIVE_ATTACK))
    captured = async_capture_events(hass, EVENT_STATE_CHANGED)

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    state = hass.states.get(entity_id)
    assert state is not None
    # The restored event is visible, but its timestamp never advanced, so no
    # new event was triggered while an attack is already active.
    assert state.state == restored_state
    assert state.attributes["event_type"] == "attack_started"
    assert state.attributes["attack_id"] == "older-attack"
    writes = [
        event.data["new_state"].state
        for event in captured
        if event.data.get("entity_id") == entity_id
        and event.data.get("new_state") is not None
    ]
    assert writes == [restored_state]


async def test_failed_poll_does_not_move_the_baseline(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """After failures, only the latest real transition is emitted."""
    queue = mock_status_queue(
        aioclient_mock,
        _response(ACTIVE_ATTACK),
        FakeResponse(500, {}),
        FakeResponse(body="not json"),
        _response(_finished_same_attack()),
    )
    entry = make_entry()
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    entity_id = _event_entity_id(hass, entry)
    captured = async_capture_events(hass, EVENT_STATE_CHANGED)

    await _poll(hass, entry)
    assert event_sequence(captured, entity_id) == []
    assert hass.states.get(entity_id).state == "unavailable"
    status_entity_id = er.async_get(hass).async_get_entity_id(
        "sensor", DOMAIN, f"{entry.entry_id}_status"
    )
    assert hass.states.get(status_entity_id).state == "unavailable"

    await _poll(hass, entry)
    assert event_sequence(captured, entity_id) == []

    await _poll(hass, entry)

    # The baseline was still the active attack, so recovery emits its end once.
    assert event_sequence(captured, entity_id) == [
        ("attack_ended", {"attack_id": "abc123"})
    ]
    assert len(queue.calls) == 4


@pytest.mark.parametrize(
    ("payload", "expected_state"),
    [
        pytest.param(ACTIVE_ATTACK, "attack", id="active_attack"),
        pytest.param(FINISHED_WELL, "well", id="finished_well"),
        pytest.param(EMPTY_DB, "no_data", id="empty_database"),
        pytest.param(LEGACY_ATTACK_DAY, "attack", id="legacy_attack_day"),
    ],
)
async def test_event_state_is_a_timestamp_and_status_is_separate(
    hass, enable_custom_integrations, aioclient_mock, payload, expected_state
) -> None:
    """The event entity state is a timestamp; the status sensor holds the state."""
    entry, _queue = await _setup_entry(hass, aioclient_mock, payload, payload)

    await _poll(hass, entry)

    entity_state = hass.states.get(_event_entity_id(hass, entry))
    assert entity_state is not None
    assert entity_state.state == "unknown"

    status_entity_id = er.async_get(hass).async_get_entity_id(
        "sensor", DOMAIN, f"{entry.entry_id}_status"
    )
    assert hass.states.get(status_entity_id).state == expected_state
    assert [method.lower() for method, _url in _queue.calls] == ["get", "get"]
    assert [url for _method, url in _queue.calls] == [STATUS_URL] * 2
