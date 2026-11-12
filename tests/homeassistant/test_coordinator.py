"""Coordinator tests: fetching, failures, equality, and event baselines."""

from __future__ import annotations

import logging

from aiohttp import ClientConnectionError
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.helpers.update_coordinator import UpdateFailed
import pytest
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_capture_events,
)

from custom_components.migraine_tracker.const import (
    CONF_AUTHORIZATION,
    CONF_SCAN_INTERVAL,
    CONF_URL,
    DOMAIN,
)
from custom_components.migraine_tracker.coordinator import (
    CannotConnectError,
    InvalidAuthorizationError,
    InvalidResponseError,
    MigraineTrackerCoordinator,
    UnauthorizedError,
    UnsupportedApiVersionError,
    async_fetch_status,
    clamp_scan_interval,
    scan_interval_seconds,
)

from .helpers import (
    ACTIVE_ATTACK,
    AUTHORIZATION,
    BASE_URL,
    EMPTY_DB,
    LEGACY_ATTACK_DAY,
    STATUS_URL,
    FakeResponse,
    FakeSession,
    assert_only_status_gets,
    attack,
    document,
    make_entry,
    mock_status_queue,
    with_generated_at,
)

LATER_GENERATED_AT = "2026-11-11T18:31:00.000Z"


def _stored(payload: dict) -> dict:
    """Return the document as the coordinator stores it (no generatedAt)."""
    expected = document(payload)
    expected.pop("generatedAt")
    return expected


def _entry(hass):
    """Return a config entry added to hass."""
    entry = make_entry()
    entry.add_to_hass(hass)
    return entry


async def test_fetch_strips_generated_at(hass) -> None:
    """The fetch helper strips generatedAt and issues exactly one status GET."""
    session = FakeSession(FakeResponse(200, ACTIVE_ATTACK))

    data = await async_fetch_status(session, BASE_URL, AUTHORIZATION)

    assert "generatedAt" not in data
    assert data["state"] == "attack"
    assert data["apiVersion"] == 1
    assert_only_status_gets(session.requests, count=1)
    assert session.requests[0][3]["Authorization"] == AUTHORIZATION


@pytest.mark.parametrize(
    ("response", "error"),
    [
        pytest.param(FakeResponse(401, {}), UnauthorizedError, id="401"),
        pytest.param(FakeResponse(403, {}), UnauthorizedError, id="403"),
        pytest.param(
            FakeResponse(500, {"error": "boom"}), InvalidResponseError, id="500"
        ),
        pytest.param(FakeResponse(body="<html>"), InvalidResponseError, id="non_json"),
        pytest.param(FakeResponse(200, [1, 2]), InvalidResponseError, id="non_object"),
        pytest.param(
            FakeResponse(200, {**ACTIVE_ATTACK, "state": "unknown"}),
            InvalidResponseError,
            id="unexpected_state",
        ),
        pytest.param(
            FakeResponse(
                200,
                {
                    key: value
                    for key, value in ACTIVE_ATTACK.items()
                    if key != "apiVersion"
                },
            ),
            UnsupportedApiVersionError,
            id="missing_api_version",
        ),
        pytest.param(
            FakeResponse(200, {**ACTIVE_ATTACK, "apiVersion": 2}),
            UnsupportedApiVersionError,
            id="api_version_2",
        ),
        pytest.param(
            FakeResponse(200, {**ACTIVE_ATTACK, "apiVersion": True}),
            UnsupportedApiVersionError,
            id="api_version_true",
        ),
        pytest.param(
            FakeResponse(200, {**ACTIVE_ATTACK, "apiVersion": 1.0}),
            UnsupportedApiVersionError,
            id="api_version_float",
        ),
        pytest.param(
            FakeResponse(200, {**ACTIVE_ATTACK, "apiVersion": "1"}),
            UnsupportedApiVersionError,
            id="api_version_string",
        ),
        pytest.param(
            FakeResponse(200, {**ACTIVE_ATTACK, "apiVersion": None}),
            UnsupportedApiVersionError,
            id="api_version_null",
        ),
        pytest.param(
            FakeResponse(302, {}), InvalidResponseError, id="redirect_not_followed"
        ),
        pytest.param(
            FakeResponse(exc=TimeoutError()), CannotConnectError, id="timeout"
        ),
        pytest.param(
            FakeResponse(exc=ClientConnectionError("down")),
            CannotConnectError,
            id="connection_error",
        ),
    ],
)
async def test_fetch_error_classification(hass, response, error) -> None:
    """Every fetch failure maps to its dedicated error type."""
    session = FakeSession(response)

    with pytest.raises(error):
        await async_fetch_status(session, BASE_URL)

    assert_only_status_gets(session.requests, count=1)


async def test_coordinator_stores_data_and_entry_identity(hass) -> None:
    """The coordinator stores the document and is bound to the entry."""
    entry = _entry(hass)
    session = FakeSession(FakeResponse(200, ACTIVE_ATTACK))
    coordinator = MigraineTrackerCoordinator(hass, session, entry)

    assert coordinator.config_entry is entry
    assert coordinator.always_update is False
    assert coordinator.update_interval.total_seconds() == 60

    await coordinator.async_refresh()

    assert coordinator.last_update_success is True
    assert coordinator.data == _stored(ACTIVE_ATTACK)
    assert "generatedAt" not in coordinator.data
    assert_only_status_gets(session.requests, count=1)


@pytest.mark.parametrize(
    "response",
    [
        pytest.param(FakeResponse(500, {"error": "boom"}), id="non_200"),
        pytest.param(FakeResponse(body="not json"), id="non_json"),
        pytest.param(FakeResponse(exc=TimeoutError()), id="timeout"),
        pytest.param(
            FakeResponse(exc=ClientConnectionError("down")), id="connection_error"
        ),
        pytest.param(
            FakeResponse(200, {**ACTIVE_ATTACK, "apiVersion": 2}),
            id="unsupported_version",
        ),
        pytest.param(
            FakeResponse(200, {**ACTIVE_ATTACK, "state": "weird"}),
            id="unexpected_state",
        ),
        pytest.param(FakeResponse(401, {}), id="unauthorized"),
    ],
)
async def test_poll_failures_raise_update_failed(hass, response) -> None:
    """Every poll failure becomes UpdateFailed and stores no data."""
    entry = _entry(hass)
    session = FakeSession(response)
    coordinator = MigraineTrackerCoordinator(hass, session, entry)

    await coordinator.async_refresh()

    assert coordinator.last_update_success is False
    assert isinstance(coordinator.last_exception, UpdateFailed)
    assert coordinator.data is None
    assert_only_status_gets(session.requests, count=1)


async def test_failed_poll_keeps_last_data(hass) -> None:
    """A failed poll leaves the previous document in place."""
    entry = _entry(hass)
    session = FakeSession(FakeResponse(200, ACTIVE_ATTACK), FakeResponse(500, {}))
    coordinator = MigraineTrackerCoordinator(hass, session, entry)

    await coordinator.async_refresh()
    await coordinator.async_refresh()

    assert coordinator.last_update_success is False
    assert coordinator.data == _stored(ACTIVE_ATTACK)
    assert_only_status_gets(session.requests, count=2)


async def test_generated_at_only_change_notifies_nothing(hass) -> None:
    """A poll that differs only in generatedAt produces no listener calls."""
    entry = _entry(hass)
    session = FakeSession(
        FakeResponse(200, ACTIVE_ATTACK),
        FakeResponse(200, with_generated_at(ACTIVE_ATTACK, LATER_GENERATED_AT)),
    )
    coordinator = MigraineTrackerCoordinator(hass, session, entry)
    calls: list[int] = []
    coordinator.async_add_listener(lambda: calls.append(1))

    await coordinator.async_refresh()
    assert calls == [1]
    assert coordinator.pending_events == []

    calls.clear()
    await coordinator.async_refresh()

    assert calls == []
    assert coordinator.pending_events == []
    assert coordinator.data == _stored(ACTIVE_ATTACK)
    assert_only_status_gets(session.requests, count=2)


async def test_generated_at_only_change_writes_no_entity_state(
    hass, enable_custom_integrations, aioclient_mock
) -> None:
    """Entity states are not written when only generatedAt changed."""
    queue = mock_status_queue(
        aioclient_mock,
        FakeResponse(200, ACTIVE_ATTACK),
        FakeResponse(200, with_generated_at(ACTIVE_ATTACK, LATER_GENERATED_AT)),
    )
    entry = make_entry()
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    captured = async_capture_events(hass, EVENT_STATE_CHANGED)
    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()

    assert captured == []
    assert [url for _method, url in queue.calls] == [STATUS_URL, STATUS_URL]


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(ACTIVE_ATTACK, id="active_attack"),
        pytest.param(EMPTY_DB, id="empty_db"),
        pytest.param(LEGACY_ATTACK_DAY, id="legacy_attack_day"),
    ],
)
async def test_first_poll_only_establishes_the_baseline(hass, payload) -> None:
    """The first successful poll never emits transitions."""
    entry = _entry(hass)
    session = FakeSession(FakeResponse(200, payload))
    coordinator = MigraineTrackerCoordinator(hass, session, entry)

    await coordinator.async_refresh()

    assert coordinator.pending_events == []
    assert_only_status_gets(session.requests, count=1)


async def test_recovery_compares_against_last_successful_document(hass) -> None:
    """A failed poll does not move the baseline used by the next success."""
    entry = _entry(hass)
    finished_same_attack = document(
        ACTIVE_ATTACK,
        state="well",
        activeAttack=None,
        lastAttack=attack(
            "abc123",
            end="2026-11-11T16:00:00.000Z",
            ongoing=False,
            duration_minutes=55,
        ),
        today={"day": "2026-11-11", "status": "well", "source": "explicit"},
    )
    session = FakeSession(
        FakeResponse(200, ACTIVE_ATTACK),
        FakeResponse(500, {}),
        FakeResponse(200, finished_same_attack),
    )
    coordinator = MigraineTrackerCoordinator(hass, session, entry)

    await coordinator.async_refresh()
    assert coordinator.pending_events == []

    await coordinator.async_refresh()
    assert coordinator.last_update_success is False
    assert coordinator.pending_events == []

    await coordinator.async_refresh()
    assert coordinator.last_update_success is True
    assert coordinator.pending_events == [
        ("attack_ended", {"attack_id": "abc123"}),
        ("status_changed", {"state": "well"}),
    ]
    assert_only_status_gets(session.requests, count=3)


async def test_recovery_with_identical_document_emits_nothing(hass) -> None:
    """Recovery to the last known document is not a transition."""
    entry = _entry(hass)
    session = FakeSession(
        FakeResponse(200, ACTIVE_ATTACK),
        FakeResponse(body="not json"),
        FakeResponse(200, with_generated_at(ACTIVE_ATTACK, LATER_GENERATED_AT)),
    )
    coordinator = MigraineTrackerCoordinator(hass, session, entry)

    await coordinator.async_refresh()
    await coordinator.async_refresh()
    await coordinator.async_refresh()

    assert coordinator.last_update_success is True
    assert coordinator.pending_events == []
    assert_only_status_gets(session.requests, count=3)


async def test_pending_events_are_replaced_each_poll(hass) -> None:
    """Undrained events never accumulate across polls."""
    entry = _entry(hass)
    second = document(
        ACTIVE_ATTACK,
        activeAttack={**ACTIVE_ATTACK["activeAttack"], "id": "def456"},
    )
    third = document(
        second,
        activeAttack={**ACTIVE_ATTACK["activeAttack"], "id": "ghi789"},
        state="off",
    )
    session = FakeSession(
        FakeResponse(200, ACTIVE_ATTACK),
        FakeResponse(200, second),
        FakeResponse(200, third),
    )
    coordinator = MigraineTrackerCoordinator(hass, session, entry)

    await coordinator.async_refresh()
    await coordinator.async_refresh()
    # One start happened; the pending list holds only that poll's events.
    assert coordinator.pending_events == [("attack_started", {"attack_id": "def456"})]

    await coordinator.async_refresh()
    assert coordinator.pending_events == [
        ("attack_started", {"attack_id": "ghi789"}),
        ("status_changed", {"state": "off"}),
    ]
    assert_only_status_gets(session.requests, count=3)


@pytest.mark.parametrize(
    ("options", "expected"),
    [
        pytest.param({}, 60, id="default"),
        pytest.param({CONF_SCAN_INTERVAL: 5}, 15, id="clamped_up"),
        pytest.param({CONF_SCAN_INTERVAL: 14}, 15, id="14_to_15"),
        pytest.param({CONF_SCAN_INTERVAL: 120}, 120, id="in_range"),
        pytest.param({CONF_SCAN_INTERVAL: 3601}, 3600, id="3601_to_3600"),
        pytest.param({CONF_SCAN_INTERVAL: "45"}, 45, id="string_coerced"),
    ],
)
def test_scan_interval_helpers_clamp(options, expected) -> None:
    """The stored interval is always clamped to the supported range."""
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_URL: BASE_URL}, options=options)

    assert scan_interval_seconds(entry) == expected
    assert clamp_scan_interval(expected) == expected


UNSAFE_AUTHORIZATIONS = [
    pytest.param("Bearer a\rb", id="carriage_return"),
    pytest.param("Bearer a\nb", id="line_feed"),
    pytest.param("Bearer a\r\nX-Injected: 1", id="header_injection"),
    pytest.param("Bearer a\x00b", id="nul"),
    pytest.param("Bearer a\x7fb", id="delete"),
    pytest.param("Bearer \x01", id="other_control_character"),
    # aiohttp encodes header values as Latin-1: values above U+00FF must be
    # rejected here rather than raising UnicodeEncodeError mid-request.
    pytest.param("Bearer a\U0001f600b", id="emoji"),
    pytest.param("Bearer a\u20acb", id="euro_sign"),
]


@pytest.mark.parametrize("authorization", UNSAFE_AUTHORIZATIONS)
async def test_fetch_rejects_unsafe_authorization_without_request(
    hass, authorization
) -> None:
    """A value that cannot be sent fails before the request is even started."""
    session = FakeSession(FakeResponse(200, ACTIVE_ATTACK))

    with pytest.raises(InvalidAuthorizationError):
        await async_fetch_status(session, BASE_URL, authorization)

    assert session.requests == []


@pytest.mark.parametrize(
    "authorization",
    [
        pytest.param(AUTHORIZATION, id="token"),
        pytest.param("  Bearer spaced  ", id="spaces"),
        pytest.param("Bearer tab\tseparated", id="horizontal_tab"),
        pytest.param("Bearer caf\xe9", id="non_ascii"),
    ],
)
async def test_fetch_sends_sendable_authorization(hass, authorization) -> None:
    """Spaces, tabs, and non-ASCII (obs-text) values are sent as the header."""
    session = FakeSession(FakeResponse(200, ACTIVE_ATTACK))

    await async_fetch_status(session, BASE_URL, authorization)

    assert session.requests[0][3]["Authorization"] == authorization.strip()


async def test_corrupt_stored_authorization_raises_update_failed_without_leaking(
    hass, caplog
) -> None:
    """A corrupt stored header fails the poll and never reaches the logs."""
    caplog.set_level(logging.DEBUG)
    marker = "s3cr3t-marker"
    entry = make_entry(options={CONF_AUTHORIZATION: f"Bearer {marker}\r\nX-Leak: 1"})
    entry.add_to_hass(hass)
    session = FakeSession()

    coordinator = MigraineTrackerCoordinator(hass, session, entry)
    await coordinator.async_refresh()

    assert coordinator.last_update_success is False
    assert isinstance(coordinator.last_exception, UpdateFailed)
    message = str(coordinator.last_exception)
    assert "stored Authorization header" in message
    assert "contains a character that cannot be sent in an HTTP header" in message, (
        message
    )
    assert "control character" not in message
    assert marker not in message
    # The value is rejected before any request is made, and it never reaches
    # the log (which is attached to public issue reports).
    assert session.requests == []
    # The failure was logged (so the assertions below are not vacuous), and the
    # value itself never reached the log: logs ride along with issue reports.
    assert caplog.records
    assert marker not in caplog.text
    assert "X-Leak" not in caplog.text


@pytest.mark.parametrize(
    ("authorization", "forbidden"),
    [
        pytest.param("Bearer s3cr3t-marker\U0001f600", "\U0001f600", id="emoji"),
        pytest.param("Bearer s3cr3t-marker\u20ac", "\u20ac", id="euro_sign"),
    ],
)
async def test_corrupt_stored_non_latin1_authorization_raises_update_failed(
    hass, caplog, authorization, forbidden
) -> None:
    """A stored value above U+00FF fails the poll before the request and never logs."""
    caplog.set_level(logging.DEBUG)
    marker = "s3cr3t-marker"
    entry = make_entry(options={CONF_AUTHORIZATION: authorization})
    entry.add_to_hass(hass)
    session = FakeSession()

    coordinator = MigraineTrackerCoordinator(hass, session, entry)
    await coordinator.async_refresh()

    assert coordinator.last_update_success is False
    assert isinstance(coordinator.last_exception, UpdateFailed)
    message = str(coordinator.last_exception)
    assert "contains a character that cannot be sent in an HTTP header" in message, (
        message
    )
    assert "control character" not in message
    assert marker not in message
    assert forbidden not in message
    # Rejected before any request: aiohttp would raise UnicodeEncodeError here.
    assert session.requests == []
    # Non-vacuity: the failure was logged, but neither the value nor its
    # unsupported character reached the log (logs ride along with reports).
    assert caplog.records
    assert marker not in caplog.text
    assert forbidden not in caplog.text
