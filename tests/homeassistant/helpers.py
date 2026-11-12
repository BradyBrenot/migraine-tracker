"""Shared fixtures and helpers for the Home Assistant integration tests.

Every payload here is synthetic and copied or adapted from the four example
documents in ``docs/home-assistant.md``. No real health data is used.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
import copy
from typing import Any

from homeassistant.core import Event, HomeAssistant, State
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.migraine_tracker.const import (
    API_STATUS_PATH,
    CONF_URL,
    DOMAIN,
)

BASE_URL = "http://tracker:8097"
STATUS_URL = f"{BASE_URL}{API_STATUS_PATH}"
OTHER_BASE_URL = "http://other:8097"
NEW_BASE_URL = "http://newtracker:8097"
NEW_STATUS_URL = f"{NEW_BASE_URL}{API_STATUS_PATH}"
AUTHORIZATION = "Bearer test-token"
GENERATED_AT = "2026-11-11T18:30:00.000Z"
# A field name the apiVersion 1 contract does not define; clients must ignore it.
UNKNOWN_FIELD = "unexpectedFutureField"

# Example document: active attack, inferred off day, known Nurtec stock.
ACTIVE_ATTACK: dict[str, Any] = {
    "apiVersion": 1,
    "generatedAt": GENERATED_AT,
    "timeZone": "America/New_York",
    "state": "attack",
    "activeAttack": {
        "id": "abc123",
        "start": "2026-11-11T15:05:00.000Z",
        "peakPain": 7,
        "latestPain": {"ts": "2026-11-11T18:10:00.000Z", "level": 4},
        "aura": True,
    },
    "today": {"day": "2026-11-11", "status": "off", "source": "inferred"},
    "lastAttack": {
        "id": "abc123",
        "start": "2026-11-11T15:05:00.000Z",
        "end": None,
        "ongoing": True,
        "durationMinutes": None,
        "peakPain": 7,
    },
    "history": {
        "daysSinceLastAttackStart": 0,
        "attacksStartedLast30Days": 3,
        "attackDaysLast7Days": 1,
        "attackDaysLast30Days": 4,
    },
    "inventory": {
        "nurtec": {
            "status": "known",
            "quantity": 4,
            "level": "ok",
            "low": False,
            "negative": False,
            "threshold": 2,
        }
    },
}

# Example document: finished attack, explicit well day, unknown Nurtec stock.
FINISHED_WELL: dict[str, Any] = {
    "apiVersion": 1,
    "generatedAt": GENERATED_AT,
    "timeZone": "UTC",
    "state": "well",
    "activeAttack": None,
    "today": {"day": "2026-11-11", "status": "well", "source": "explicit"},
    "lastAttack": {
        "id": "a1",
        "start": "2026-11-09T09:00:00.000Z",
        "end": "2026-11-09T13:00:00.000Z",
        "ongoing": False,
        "durationMinutes": 240,
        "peakPain": 6,
    },
    "history": {
        "daysSinceLastAttackStart": 2,
        "attacksStartedLast30Days": 1,
        "attackDaysLast7Days": 1,
        "attackDaysLast30Days": 1,
    },
    "inventory": {
        "nurtec": {
            "status": "unknown",
            "quantity": None,
            "level": "unknown",
            "low": False,
            "negative": False,
            "threshold": 2,
        }
    },
}

# Example document: empty database.
EMPTY_DB: dict[str, Any] = {
    "apiVersion": 1,
    "generatedAt": GENERATED_AT,
    "timeZone": "UTC",
    "state": "no_data",
    "activeAttack": None,
    "today": {"day": "2026-11-11", "status": None, "source": "none"},
    "lastAttack": None,
    "history": {
        "daysSinceLastAttackStart": None,
        "attacksStartedLast30Days": 0,
        "attackDaysLast7Days": 0,
        "attackDaysLast30Days": 0,
    },
    "inventory": {
        "nurtec": {
            "status": "unknown",
            "quantity": None,
            "level": "unknown",
            "low": False,
            "negative": False,
            "threshold": 2,
        }
    },
}

# Example document: legacy explicit attack day with no ongoing attack.
LEGACY_ATTACK_DAY: dict[str, Any] = {
    "apiVersion": 1,
    "generatedAt": GENERATED_AT,
    "timeZone": "America/New_York",
    "state": "attack",
    "activeAttack": None,
    "today": {"day": "2026-11-11", "status": "attack", "source": "explicit"},
    "lastAttack": None,
    "history": {
        "daysSinceLastAttackStart": None,
        "attacksStartedLast30Days": 0,
        "attackDaysLast7Days": 0,
        "attackDaysLast30Days": 0,
    },
    "inventory": {
        "nurtec": {
            "status": "unknown",
            "quantity": None,
            "level": "unknown",
            "low": False,
            "negative": False,
            "threshold": 2,
        }
    },
}

DOCS_PAYLOADS: dict[str, dict[str, Any]] = {
    "active_attack": ACTIVE_ATTACK,
    "finished_well": FINISHED_WELL,
    "empty_db": EMPTY_DB,
    "legacy_attack_day": LEGACY_ATTACK_DAY,
}


def document(payload: dict[str, Any], **changes: Any) -> dict[str, Any]:
    """Return a deep copy of a fixture document with top-level fields replaced."""
    doc = copy.deepcopy(payload)
    doc.update(changes)
    return doc


def with_generated_at(payload: dict[str, Any], generated_at: str) -> dict[str, Any]:
    """Return a copy that only differs in ``generatedAt``."""
    return document(payload, generatedAt=generated_at)


def with_nurtec(payload: dict[str, Any], **changes: Any) -> dict[str, Any]:
    """Return a copy with a modified Nurtec inventory section."""
    doc = copy.deepcopy(payload)
    doc["inventory"]["nurtec"].update(changes)
    return doc


def with_extra_fields(payload: dict[str, Any]) -> dict[str, Any]:
    """Return a copy carrying unknown, additive fields in every section.

    The contract says clients must ignore unknown fields and that additive
    fields do not bump ``apiVersion``.
    """
    doc = copy.deepcopy(payload)
    doc[UNKNOWN_FIELD] = {"nested": ["ignored", 1, None]}
    for section in ("activeAttack", "lastAttack", "today", "history"):
        if isinstance(doc.get(section), dict):
            doc[section][UNKNOWN_FIELD] = "ignored"
    inventory = doc.get("inventory")
    if isinstance(inventory, dict):
        inventory[UNKNOWN_FIELD] = [1, 2, 3]
        if isinstance(inventory.get("nurtec"), dict):
            inventory["nurtec"][UNKNOWN_FIELD] = 42
    return doc


def attack(
    attack_id: str,
    *,
    start: str | None = "2026-11-11T15:05:00.000Z",
    end: str | None = None,
    ongoing: bool = True,
    duration_minutes: int | None = None,
) -> dict[str, Any]:
    """Return a ``lastAttack`` section."""
    return {
        "id": attack_id,
        "start": start,
        "end": end,
        "ongoing": ongoing,
        "durationMinutes": duration_minutes,
        "peakPain": 5,
    }


class FakeResponse:
    """Minimal stand-in for an ``aiohttp.ClientResponse``."""

    def __init__(
        self,
        status: int = 200,
        payload: Any = None,
        *,
        body: str | None = None,
        exc: BaseException | None = None,
    ) -> None:
        """Initialize the response."""
        self.status = status
        self._payload = payload
        self._body = body
        self.exc = exc

    async def json(self, content_type: str | None = None) -> Any:
        """Return the decoded body or raise like aiohttp does for invalid JSON.

        A fresh copy is returned so the integration cannot mutate a fixture
        document, exactly like decoding a new HTTP body would behave.
        """
        if self._body is not None:
            raise ValueError("Response body is not JSON")
        return copy.deepcopy(self._payload)

    async def __aenter__(self) -> FakeResponse:
        """Enter the response context manager."""
        return self

    async def __aexit__(self, *args: Any) -> bool:
        """Exit the response context manager."""
        return False

    def release(self) -> None:
        """Release the response."""

    def close(self) -> None:
        """Close the response."""

    async def wait_for_close(self) -> None:
        """Wait for the response to close."""


class FakeSession:
    """Minimal aiohttp session that records every request it receives.

    Each ``get`` consumes one queued response. Any other HTTP method is
    recorded and fails the test, so a test can prove the integration only ever
    issues ``GET {base}/api/status``.
    """

    def __init__(self, *responses: FakeResponse) -> None:
        """Initialize the session with queued responses."""
        self._responses = list(responses)
        # (method, url, data, headers) - same shape as aioclient_mock.mock_calls.
        self.requests: list[tuple[str, str, Any, dict[str, str]]] = []

    def get(self, url: str, *, headers: dict[str, str] | None = None, **kwargs: Any):
        """Record a GET and return the next queued response."""
        assert str(url).endswith(API_STATUS_PATH), f"unexpected URL {url}"
        # A redirect would forward the Authorization header to another host.
        assert kwargs.get("allow_redirects") is False, "redirects must not be followed"
        self.requests.append(("get", str(url), None, dict(headers or {})))
        if not self._responses:
            raise AssertionError(f"Unexpected extra request to {url}")
        response = self._responses.pop(0)
        if response.exc is not None:
            raise response.exc
        return response

    def __getattr__(self, name: str):
        """Record and fail any request that is not a GET."""
        if name.startswith("_"):
            raise AttributeError(name)

        def _record(url: Any = "", *args: Any, **kwargs: Any) -> None:
            self.requests.append(
                (name, str(url), None, dict(kwargs.get("headers") or {}))
            )
            raise AssertionError(f"Unexpected {name.upper()} request to {url}")

        return _record


class StatusResponseQueue:
    """Queue of responses for an ``aioclient_mock`` ``side_effect``.

    Registering the queue with ``aioclient_mock.get(url, side_effect=queue)``
    lets a test vary the payload between polls of a real set-up config entry.
    """

    def __init__(self, *responses: FakeResponse) -> None:
        """Initialize the queue."""
        self._responses = list(responses)
        # (method, url) of every request the integration made through the queue.
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, method: str, url: Any, data: Any) -> FakeResponse:
        """Return the next queued response for a matching request."""
        self.calls.append((method, str(url)))
        if not self._responses:
            raise AssertionError(f"Unexpected extra request to {url}")
        response = self._responses.pop(0)
        if response.exc is not None:
            raise response.exc
        return response


def mock_status_queue(
    aioclient_mock, *responses: FakeResponse, url: str = STATUS_URL
) -> StatusResponseQueue:
    """Register a queue of status responses and return it."""
    queue = StatusResponseQueue(*responses)
    aioclient_mock.get(url, side_effect=queue)
    return queue


def make_entry(
    *,
    url: str = BASE_URL,
    options: dict[str, Any] | None = None,
    unique_id: str | None = None,
) -> MockConfigEntry:
    """Return a config entry for the tracker."""
    return MockConfigEntry(
        domain=DOMAIN,
        data={CONF_URL: url},
        options=options or {},
        unique_id=unique_id or url,
    )


def make_coordinator(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    *responses: FakeResponse,
):
    """Return a coordinator backed by a recording fake session."""
    from custom_components.migraine_tracker.coordinator import (
        MigraineTrackerCoordinator,
    )

    return MigraineTrackerCoordinator(hass, FakeSession(*responses), entry)


async def setup_mocked_entry(
    hass: HomeAssistant,
    aioclient_mock,
    payload: dict[str, Any],
    *,
    url: str = BASE_URL,
    options: dict[str, Any] | None = None,
    unique_id: str | None = None,
) -> MockConfigEntry:
    """Register one status response, add the entry, and set it up."""
    aioclient_mock.get(f"{url}{API_STATUS_PATH}", json=payload)
    entry = make_entry(url=url, options=options, unique_id=unique_id)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def assert_only_status_gets(
    requests: Iterable[tuple[str, Any, Any, Any]],
    *,
    base_url: str = BASE_URL,
    count: int | None = None,
) -> None:
    """Fail unless every recorded request is ``GET {base_url}/api/status``."""
    recorded = list(requests)
    for method, url, _data, _headers in recorded:
        assert method.lower() == "get", f"unexpected {method.upper()} request"
        assert str(url) == f"{base_url}{API_STATUS_PATH}"
    if count is not None:
        assert len(recorded) == count


def request_headers(
    requests: Iterable[tuple[str, Any, Any, Any]],
) -> list[dict[str, Any]]:
    """Return the headers of every recorded request."""
    return [dict(headers or {}) for _method, _url, _data, headers in requests]


def entity_id_for(hass: HomeAssistant, entry: MockConfigEntry, platform: str, key: str):
    """Return the entity id registered for ``entry``'s entity key."""
    return er.async_get(hass).async_get_entity_id(
        platform, DOMAIN, f"{entry.entry_id}_{key}"
    )


def state_for(
    hass: HomeAssistant, entry: MockConfigEntry, platform: str, key: str
) -> State:
    """Return the current state of ``entry``'s entity key."""
    entity_id = entity_id_for(hass, entry, platform, key)
    assert entity_id is not None, f"missing {platform} entity {key}"
    state = hass.states.get(entity_id)
    assert state is not None, f"missing state for {entity_id}"
    return state


FRAMEWORK_EVENT_ATTRIBUTES = frozenset(
    {"event_type", "event_types", "friendly_name", "device_class", "icon"}
)


def event_sequence(
    captured: Sequence[Event], entity_id: str
) -> list[tuple[str, dict[str, Any]]]:
    """Return the individual event-entity events in the order they fired.

    A triggered event always advances the entity state (a strictly increasing
    timestamp), so writes that do not carry a new event are filtered out.
    """
    sequence: list[tuple[str, dict[str, Any]]] = []
    for event in captured:
        data = event.data
        if data.get("entity_id") != entity_id:
            continue
        new_state: State | None = data.get("new_state")
        old_state: State | None = data.get("old_state")
        if new_state is None:
            continue
        event_type = new_state.attributes.get("event_type")
        if event_type is None:
            continue
        old = old_state.state if old_state is not None else None
        if new_state.state == old:
            continue
        payload = {
            key: value
            for key, value in new_state.attributes.items()
            if key not in FRAMEWORK_EVENT_ATTRIBUTES
        }
        sequence.append((event_type, payload))
    return sequence
