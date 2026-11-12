# Home Assistant integration

Status: interface implemented (`GET /api/status`, apiVersion 1). The Home
Assistant integration itself is a separate deliverable; this document is the
complete handoff for building it.

## Why this endpoint exists

Home Assistant needs four things from this tracker:

- the current migraine status, for dashboards;
- transitions (attack started, attack ended, day status changed), for
  automations;
- a Nurtec stock level;
- read-only access — Home Assistant must never write.

The raw API (`GET /api/attacks`, `GET /api/day-states`,
`GET /api/inventory/nurtec`) technically contains everything, but a consumer
would have to reimplement the tracker's domain rules:

- the **08:00-to-08:00 local migraine day** (an attack from 01:00 to 02:00
  counts the *previous* day; an attack crossing 08:00 counts both days; an end
  exactly at 08:00 counts only the previous day);
- the **effective day status** precedence (an explicit day record always wins,
  otherwise an attack day infers `off`);
- the **ongoing attack** rule (`end === null`), including canonical ordering
  when several rows are open;
- timezone resolution and its `UTC` fallback;
- Nurtec stock, which depends on baselines, refills, doses, and a threshold.

`GET /api/status` is a **projection** computed server-side from the same rows
and the same shared pure modules (`app/shared/attackstats.ts`,
`app/shared/daystate.ts`, `app/shared/inventory.ts`) that the writer UI uses.
There is no new table, no new source of truth, and no new configuration.

### How it differs from the other read endpoints

| Endpoint | Purpose | Shape |
| --- | --- | --- |
| `GET /api/health` | Liveness plus whether notification transports are configured. No health data. | `{ ok, notifications }` |
| `GET /api/export` | Full backup: every record and every setting. Large, contains notes and free text. | Versioned envelope |
| `GET /api/status` | Small, derived, versioned status document for dashboards and automations. No notes, no pain log, no symptoms/triggers, no settings. | `apiVersion: 1` document |

`/api/status` is the only endpoint Home Assistant needs to poll. `/api/export`
remains the backup and migration interface; do not poll it from Home Assistant.

## Endpoint reference, `GET /api/status`

- Method `GET`. No query parameters in v1. No authentication, exactly like the
  rest of the API (see
  [Recorder, privacy, and security](#recorder-privacy-and-security)).
- `200 application/json` with `Cache-Control: no-store`.
- All instants are canonical UTC ISO-8601 strings with milliseconds
  (`2026-11-11T15:05:00.000Z`, i.e. `Date#toISOString()`), or `null` when a
  stored value cannot be parsed. Raw stored strings remain available only at
  `GET /api/attacks`, because Home Assistant timestamp sensors require
  timezone-aware datetimes and the API accepts any non-empty string for an
  attack start.
- Unknown fields must be ignored by clients. Additive fields do not bump
  `apiVersion`; renaming, removing, or changing the meaning of a field does.
- A database failure returns the normal Fastify `500` with no partial body.
  Nothing else is expected to fail: every stored row is tolerated (see
  [Robustness](#robustness-stored-data-can-never-break-the-endpoint)).

### Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `apiVersion` | integer | Contract version. `1` now. |
| `generatedAt` | ISO instant | Server clock at response time. Debugging only — never store it or expose it as an entity attribute (it changes every poll). |
| `timeZone` | IANA id | The configured settings timezone, or `UTC` when missing/invalid. All day keys and the 08:00 rule use this zone. |
| `state` | `attack` \| `off` \| `well` \| `no_data` | Display status. Precedence below. |
| `activeAttack` | object \| null | The ongoing attack, or null. **The only activeness signal.** |
| `today` | object | Today's local day bucket. |
| `lastAttack` | object \| null | Most recent attack with a parseable start, ongoing or finished. |
| `history` | object | Precomputed counts. |
| `inventory` | object | Nurtec stock, mirroring `GET /api/inventory/nurtec`. |

`state` is `no_data`, never `unknown`: Home Assistant reserves `unknown` for a
missing/unavailable entity state, so a literal `unknown` would be
indistinguishable from a dead sensor and would corrupt recorder history and
edge detection.

### `activeAttack`

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable attack id, for transition dedupe. |
| `start` | ISO instant \| null | Normalized stored start; null only when the stored start is unparseable. |
| `peakPain` | integer \| null | Cached peak 0-10; the stored `-1` ("not recorded") becomes null. |
| `latestPain` | `{ ts, level }` \| null | Pain-log entry with the greatest **parsed** `ts`; `ts` is normalized. Exact ties keep the later array element. |
| `aura` | boolean \| null | Stored aura. |

Deliberately excluded: `notes`, the full `painLog`, `symptoms`, `triggers`.
This keeps attributes small and recorder-friendly. It is not an authorization
boundary — `/api/export` already returns everything on the private network.
Consumers that need detail call `GET /api/attacks`.

### `today`

| Field | Type | Meaning |
| --- | --- | --- |
| `day` | `YYYY-MM-DD` | Today in `timeZone`. |
| `status` | `well` \| `off` \| `attack` \| null | Stored/effective day status, **not** the display `state`. |
| `source` | `explicit` \| `inferred` \| `none` | Where `status` came from. |

`today.status` can be `attack` only for a legacy explicit day record;
`source: inferred` always means `status: off` (the 08:00 rule), and `none`
always means `status: null`.

### `lastAttack`

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Attack id. |
| `start` | ISO instant | Normalized start (always parseable: `lastAttack` requires one). |
| `end` | ISO instant \| null | Normalized end; null while ongoing or when the stored end is unusable. |
| `ongoing` | boolean | Stored `end === null`. An empty-string end is **not** ongoing. |
| `durationMinutes` | integer \| null | `Math.round` elapsed minutes when the end parses and is at or after the start; null otherwise. |
| `peakPain` | integer \| null | Same normalization as above. |

`lastAttack` may be the active attack.

### `history`

| Field | Type | Meaning |
| --- | --- | --- |
| `daysSinceLastAttackStart` | integer \| null | Today minus the local day key of `lastAttack.start`, clamped to `>= 0`. Null with no parseable attack start, or when that key leaves the 4-digit day-key domain. Uses the start day, not the 08:00 rule. |
| `attacksStartedLast30Days` | integer | Attack records whose **start** local day is in `today-29..today`, including ongoing. |
| `attackDaysLast7Days` | integer | Distinct local days in `today-6..today` where an attack overlaps that day's 08:00-to-08:00 window. |
| `attackDaysLast30Days` | integer | Same over `today-29..today`. |

`attacksStartedLast30Days` is start-day anchored; it intentionally differs from
the app's Reports "attacks" count, which counts any attack overlapping the
period. Attack-day counts use attack records only — an explicit `attack` day
record never adds to them. Days are enumerated with calendar arithmetic, so DST
transitions cannot skip or repeat a day.

### `inventory.nurtec`

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | `known` \| `unknown` | Whether an applicable stock baseline exists. |
| `quantity` | integer \| null | Tablets on hand; may be negative; null when unknown. |
| `level` | `unknown` \| `ok` \| `low` \| `negative` | Same classification as the inventory route. |
| `low` | boolean | `quantity !== null && quantity <= threshold`. |
| `negative` | boolean | `quantity !== null && quantity < 0`. |
| `threshold` | integer | Configured low-stock threshold, or the shared default `2`. |

The status document does not duplicate the inventory route's `baselineId`,
`baselineEffectiveAt`, `timeZone`, or `computedAt` (the zone is top-level).
Both routes are computed by one extracted helper
(`computeNurtecStock(db, nowMs)` in `app/server/app.js`), so they cannot
disagree.

## Semantics

### Local day and the 08:00 rule

A "migraine day" runs from **08:00 local to 08:00 the next local day**, in
`timeZone`. An attack counts for a day when it overlaps that half-open window:

- an attack from 01:00 to 02:00 today counts **yesterday**, not today;
- an attack that ended at 06:00 today does not mark today;
- an attack crossing 08:00 counts **both** adjacent days;
- an attack ending exactly at 08:00 counts only the previous day (half-open).

This is the same rule the Calendar, Reports, and reminder code use; it is not a
user setting.

### `state` precedence

1. `attack` when `activeAttack` is not null — regardless of the day record.
2. Otherwise the effective status of today's local day:
   - an explicit day record always wins (`well`, `off`, or legacy `attack`),
     `today.source = "explicit"`;
   - with no record, an attack-day (08:00 rule) is `off`,
     `today.source = "inferred"`;
   - otherwise `no_data`, `today.status = null`, `today.source = "none"`.

`state` is a display convenience. A legacy explicit `day_states.status =
"attack"` with no ongoing attack yields `state: "attack"` **and**
`activeAttack: null`. Automations and the active binary sensor must use
`activeAttack`; never `state == "attack"`.

### Multiple ongoing attacks

The writer offers "Log another attack", so several rows with `end === null` are
reachable. Canonical order is: parsed start ascending, then `id` ascending;
attacks with an unparseable start sort last. `activeAttack` is the first
*ongoing* attack in that order, and `lastAttack` is the last attack **with a
parseable start** in that order. Only one ongoing attack is reported; the
document does not enumerate the rest.

Consequence for a custom integration's event entity: closing the earliest
ongoing attack while a later one continues produces a spurious
started/ended-looking pair unless the integration compares attack ids (see the
event mapping below).

### Timezone fallback and the writer caveat

`timeZone` is the saved `timezone` setting, or `UTC` when it is missing or
invalid. The writer app falls back to the **browser's** zone when no setting
exists, so a writer browser in another zone can disagree with this document
about "today" until a valid timezone is saved in Settings. Save the timezone
once and both sides agree.

### `no_data` versus `unknown`

- `state: "no_data"` = the tracker has no record for today and no ongoing
  attack. This is a real, informative answer.
- Home Assistant `unknown`/`unavailable` = the entity has no state (startup) or
  cannot reach the tracker. Never map `no_data` onto `unknown`.

### Robustness: stored data can never break the endpoint

The API accepts any non-empty string as an attack start/end, and old/imported
rows may be dirty. Unparseable instants degrade to `null`/absent fields, and
parseable-but-out-of-domain instants (for example
`+275760-09-13T00:00:00.000Z`, whose local day key is not 4 digits) are guarded
the same way. No stored row may turn the poll target into a permanent `500`.

## Example payloads

Unknown Nurtec stock (`status: "unknown"`, `quantity: null`) is the state before
any stock baseline exists; it appears in the empty-database and explicit-well
examples below. It is never reported as `quantity: 0`.

### Active attack, inferred off day, known stock

```json
{
  "apiVersion": 1,
  "generatedAt": "2026-11-11T18:30:00.000Z",
  "timeZone": "America/New_York",
  "state": "attack",
  "activeAttack": {
    "id": "abc123",
    "start": "2026-11-11T15:05:00.000Z",
    "peakPain": 7,
    "latestPain": { "ts": "2026-11-11T18:10:00.000Z", "level": 4 },
    "aura": true
  },
  "today": { "day": "2026-11-11", "status": "off", "source": "inferred" },
  "lastAttack": {
    "id": "abc123",
    "start": "2026-11-11T15:05:00.000Z",
    "end": null,
    "ongoing": true,
    "durationMinutes": null,
    "peakPain": 7
  },
  "history": {
    "daysSinceLastAttackStart": 0,
    "attacksStartedLast30Days": 3,
    "attackDaysLast7Days": 1,
    "attackDaysLast30Days": 4
  },
  "inventory": {
    "nurtec": {
      "status": "known",
      "quantity": 4,
      "level": "ok",
      "low": false,
      "negative": false,
      "threshold": 2
    }
  }
}
```

### Finished attack, explicit well day

```json
{
  "apiVersion": 1,
  "generatedAt": "2026-11-11T18:30:00.000Z",
  "timeZone": "UTC",
  "state": "well",
  "activeAttack": null,
  "today": { "day": "2026-11-11", "status": "well", "source": "explicit" },
  "lastAttack": {
    "id": "a1",
    "start": "2026-11-09T09:00:00.000Z",
    "end": "2026-11-09T13:00:00.000Z",
    "ongoing": false,
    "durationMinutes": 240,
    "peakPain": 6
  },
  "history": {
    "daysSinceLastAttackStart": 2,
    "attacksStartedLast30Days": 1,
    "attackDaysLast7Days": 1,
    "attackDaysLast30Days": 1
  },
  "inventory": { "nurtec": { "status": "unknown", "quantity": null, "level": "unknown", "low": false, "negative": false, "threshold": 2 } }
}
```

### Empty database

```json
{
  "apiVersion": 1,
  "generatedAt": "2026-11-11T18:30:00.000Z",
  "timeZone": "UTC",
  "state": "no_data",
  "activeAttack": null,
  "today": { "day": "2026-11-11", "status": null, "source": "none" },
  "lastAttack": null,
  "history": {
    "daysSinceLastAttackStart": null,
    "attacksStartedLast30Days": 0,
    "attackDaysLast7Days": 0,
    "attackDaysLast30Days": 0
  },
  "inventory": { "nurtec": { "status": "unknown", "quantity": null, "level": "unknown", "low": false, "negative": false, "threshold": 2 } }
}
```

### Legacy explicit attack day with no ongoing attack

```json
{
  "apiVersion": 1,
  "generatedAt": "2026-11-11T18:30:00.000Z",
  "timeZone": "America/New_York",
  "state": "attack",
  "activeAttack": null,
  "today": { "day": "2026-11-11", "status": "attack", "source": "explicit" },
  "lastAttack": null,
  "history": { "daysSinceLastAttackStart": null, "attacksStartedLast30Days": 0, "attackDaysLast7Days": 0, "attackDaysLast30Days": 0 },
  "inventory": { "nurtec": { "status": "unknown", "quantity": null, "level": "unknown", "low": false, "negative": false, "threshold": 2 } }
}
```

## Path A: YAML `rest` integration plus templates

No custom component. One HTTP poll per `scan_interval` feeds every entity; the
remaining entities are templates that re-render when that sensor updates.

Prerequisite: Home Assistant can reach the tracker, e.g.
`http://migraine-tracker.tailnet-name.ts.net:8097` (Compose maps host port
`8097` to container port `3000`; see `DEPLOY.md`).

### The REST sensor

```yaml
# configuration.yaml
rest:
  - resource: http://migraine-tracker.tailnet-name.ts.net:8097/api/status
    scan_interval: 60
    timeout: 10
    sensor:
      - name: Migraine status
        unique_id: migraine_tracker_status
        value_template: "{{ value_json.state }}"
        json_attributes:
          - activeAttack
          - today
          - lastAttack
          - history
          - inventory
```

Notes:

- `rest:` (plural block) polls the endpoint **once** and creates all listed
  sensors from that response; do not add a second `rest:` entry for the same
  URL.
- `generatedAt` is deliberately not exposed as an attribute: it changes every
  poll and would cause needless recorder rows and state-change events.
- A connection error or timeout makes the REST entity `unavailable` (the
  platform's documented behavior); treat any other failed update the same way.
  The templates below inherit availability from it via `has_value()`.
- Do **not** set `device_class: enum` on a REST sensor. The enum device class
  requires an `options` capability, and the RESTful sensor has no `options`
  configuration key. Reserve `SensorDeviceClass.ENUM` with explicit options for
  Path B (custom integration).

### Template binary sensors and sensors

Template entities update whenever the REST sensor updates (state-based, no
independent schedule). Jinja reading a nested JSON attribute returns a dict, so
guard legitimate nulls with `or {}` / `or none` — otherwise a missing attack
raises in the template and the entity logs an error.

```yaml
template:
  - binary_sensor:
      - name: Migraine active
        unique_id: migraine_active
        state: "{{ (state_attr('sensor.migraine_status', 'activeAttack') or none) is not none }}"
        availability: "{{ has_value('sensor.migraine_status') }}"
        attributes:
          active_attack_id: "{{ (state_attr('sensor.migraine_status', 'activeAttack') or {}).get('id', '') }}"

      - name: Nurtec low stock
        unique_id: nurtec_low_stock
        state: >-
          {% set nurtec = (state_attr('sensor.migraine_status', 'inventory') or {}).get('nurtec', {}) %}
          {{ nurtec.get('low', false) }}
        availability: "{{ has_value('sensor.migraine_status') }}"
        device_class: problem

      - name: Nurtec stock negative
        unique_id: nurtec_negative
        state: >-
          {% set nurtec = (state_attr('sensor.migraine_status', 'inventory') or {}).get('nurtec', {}) %}
          {{ nurtec.get('negative', false) }}
        availability: "{{ has_value('sensor.migraine_status') }}"
        device_class: problem

  - sensor:
      - name: Migraine last attack started
        unique_id: migraine_last_attack_started
        device_class: timestamp
        state: >-
          {{ (state_attr('sensor.migraine_status', 'lastAttack') or {}).get('start') }}
        availability: >-
          {{ has_value('sensor.migraine_status')
             and (state_attr('sensor.migraine_status', 'lastAttack') or {}).get('start') is not none }}

      - name: Migraine days since last attack
        unique_id: migraine_days_since_last_attack
        state: >-
          {% set days = (state_attr('sensor.migraine_status', 'history') or {}).get('daysSinceLastAttackStart') %}
          {{ days if days is not none else 0 }}
        availability: >-
          {{ has_value('sensor.migraine_status')
             and (state_attr('sensor.migraine_status', 'history') or {}).get('daysSinceLastAttackStart') is not none }}

      - name: Migraine attack days last 7 days
        unique_id: migraine_attack_days_7d
        state: >-
          {{ (state_attr('sensor.migraine_status', 'history') or {}).get('attackDaysLast7Days', 0) }}
        availability: "{{ has_value('sensor.migraine_status') }}"

      - name: Nurtec tablets
        unique_id: nurtec_tablets
        state: >-
          {% set nurtec = (state_attr('sensor.migraine_status', 'inventory') or {}).get('nurtec', {}) %}
          {{ nurtec.quantity if nurtec.quantity is not none else 0 }}
        availability: >-
          {% set nurtec = (state_attr('sensor.migraine_status', 'inventory') or {}).get('nurtec', {}) %}
          {{ has_value('sensor.migraine_status') and nurtec.quantity is not none }}
```

Why the availability guards:

- `sensor.migraine_last_attack_started` must not render an empty/invalid
  timestamp: with no attack yet the entity is `unavailable`, not `unknown`.
- `sensor.migraine_days_since_last_attack` and `sensor.nurtec_tablets` are
  numeric-ish, so their state templates always render a number and availability
  is reported separately. Never expose the inventory `status`/`level` strings as
  entity states; `unknown` is a reserved Home Assistant state.
- `activeAttack` is the activeness signal. Do not derive it from
  `state == 'attack'` (a legacy day record can produce that with no attack).

`device_class: problem` on the low-stock binary sensor turns on when stock is
at or below the threshold, and is the intended dashboard signal. Automations
should trigger on `off` → `on`.

### Automations

Attack started (uses the polled state, and works even if ntfy is not
configured):

```yaml
automation:
  - alias: Migraine attack started
    triggers:
      - trigger: state
        entity_id: binary_sensor.migraine_active
        from: "off"
        to: "on"
    conditions:
      - condition: template
        value_template: "{{ state_attr('sensor.migraine_status', 'activeAttack') is not none }}"
    actions:
      - action: notify.persistent_notification
        data:
          title: Migraine attack started
          message: >-
            Started {{ (state_attr('sensor.migraine_status', 'activeAttack') or {}).get('start', 'unknown') }}
            (peak pain {{ (state_attr('sensor.migraine_status', 'activeAttack') or {}).get('peakPain') }})
```

Attack ended (guarded on the **same** attack being finished, so an integration
restart or a deleted row does not fake an end). The active binary sensor keeps
the previous attack id as an attribute; compare it with `lastAttack.id`:

```yaml
automation:
  - alias: Migraine attack ended
    triggers:
      - trigger: state
        entity_id: binary_sensor.migraine_active
        from: "on"
        to: "off"
    conditions:
      - condition: template
        value_template: >-
          {% set last = state_attr('sensor.migraine_status', 'lastAttack') or {} %}
          {% set previous = trigger.from_state.attributes.get('active_attack_id') %}
          {{ previous is not none and last.id == previous and last.ongoing is sameas false }}
    actions:
      - action: notify.persistent_notification
        data:
          title: Migraine attack ended
          message: >-
            Ended {{ (state_attr('sensor.migraine_status', 'lastAttack') or {}).get('end', 'unknown') }}
            after {{ (state_attr('sensor.migraine_status', 'lastAttack') or {}).get('durationMinutes') }} minutes
```

Day status changed (includes the 08:00 boundary and explicit check-ins). A state
trigger without `from`/`to` also fires when only attributes change, which is
what this uses: the REST sensor's state can stay `off` while `today` changes,
so the condition compares both the display state and `today.status`.

```yaml
automation:
  - alias: Migraine day status changed
    triggers:
      - trigger: state
        entity_id: sensor.migraine_status
    conditions:
      - condition: template
        value_template: >-
          {{ trigger.from_state is not none and trigger.to_state is not none
             and (trigger.from_state.state != trigger.to_state.state
                  or (trigger.from_state.attributes.today or {}).get('status')
                     != (trigger.to_state.attributes.today or {}).get('status')) }}
    actions:
      - action: notify.persistent_notification
        data:
          title: Migraine day status changed
          message: >-
            {{ (trigger.from_state.attributes.today or {}).get('status') }} →
            {{ (trigger.to_state.attributes.today or {}).get('status') }}
            (display state {{ trigger.to_state.state }})
```

Force a refresh from an automation with
`action: homeassistant.update_entity` targeting `sensor.migraine_status`.

## Path B: custom integration blueprint

This section is a build plan, not code to copy verbatim. Re-read the official
docs before starting:

- Data fetching and coordinators:
  https://contributors.home-assistant.io/docs/integration_fetching_data/
- `manifest.json`:
  https://developers.home-assistant.io/docs/creating_integration_manifest/
- Event entity:
  https://developers.home-assistant.io/docs/core/entity/event/
- Sensor entity:
  https://developers.home-assistant.io/docs/core/entity/sensor/
- RESTful sensor (for YAML/Path A):
  https://www.home-assistant.io/integrations/rest/

### Layout (HACS-compatible)

```text
custom_components/migraine_tracker/
  __init__.py
  binary_sensor.py
  config_flow.py
  const.py
  coordinator.py
  diagnostics.py
  event.py
  manifest.json
  sensor.py
  strings.json
  translations/en.json
hacs.json                     # repo root; HACS reads it
README.md
```

`hacs.json` for a YAML-free custom repository:

```json
{
  "name": "Migraine Tracker",
  "render_readme": true,
  "homeassistant": "2025.5.0"
}
```

(HACS installs the `custom_components/migraine_tracker` directory. Publish at
least one tagged GitHub release; HACS normally installs a release rather than a
moving branch.)

### `manifest.json`

```json
{
  "domain": "migraine_tracker",
  "name": "Migraine Tracker",
  "codeowners": ["@your-handle"],
  "config_flow": true,
  "documentation": "https://github.com/you/migraine-tracker-ha",
  "integration_type": "service",
  "iot_class": "local_polling",
  "issue_tracker": "https://github.com/you/migraine-tracker-ha/issues",
  "requirements": [],
  "single_config_entry": true,
  "version": "0.1.0"
}
```

`single_config_entry: true` is correct here: one tracker, one status document.
`iot_class: local_polling` matches the REST sensor's classification and the
fact that no cloud account exists.

### Config flow

- Step 1 asks for the base URL (`http://tracker:8097`, trailing slash
  normalized away). Validate by calling `GET {base}/api/status`.
- Distinct error keys, so the UI can explain the failure:
  - `cannot_connect`: DNS/timeout/connection error;
  - `invalid_response`: non-200 or not JSON;
  - `unsupported_api_version`: JSON without `apiVersion == 1` (the field may be
    missing entirely; treat that as unsupported).
- Do not accept credentials: the tracker has no authentication. If someone
  fronts it with an authenticating proxy, allow an optional
  `Authorization` header in the options flow rather than storing a password.
- Options flow: scan interval, integer seconds, clamp to **15–3600**, default
  **60**. Store it in `entry.options["scan_interval"]` and reload the entry on
  change.
- Provide a reconfigure step (`async_step_reconfigure`) that re-validates the
  URL and updates `entry.data["url"]`.
- Unique ID: the normalized base URL, so the same tracker cannot be added
  twice.

```python
class MigraineTrackerConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors = {}
        if user_input is not None:
            url = user_input[CONF_URL].rstrip("/")
            try:
                await self._async_fetch_status(url)  # GET {url}/api/status + checks
            except CannotConnectError:
                errors["base"] = "cannot_connect"
            except InvalidResponseError:
                errors["base"] = "invalid_response"
            except UnsupportedVersionError:
                errors["base"] = "unsupported_api_version"
            else:
                await self.async_set_unique_id(url)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title="Migraine Tracker", data={CONF_URL: url}
                )
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_URL): str}),
            errors=errors,
        )
```

### Coordinator

The snippet omits imports, `DOMAIN`, `_LOGGER`, and the URL-validation helpers
introduced by the config flow (`CannotConnectError`, `InvalidResponseError`,
`UnsupportedVersionError`, and an `async_fetch_status` helper that performs the
same GET/parse/version checks).

```python
from datetime import timedelta

from homeassistant.helpers.update_coordinator import (
    CoordinatorEntity,
    DataUpdateCoordinator,
    UpdateFailed,
)

DEFAULT_SCAN_INTERVAL = 60


class MigraineTrackerCoordinator(DataUpdateCoordinator[dict]):
    def __init__(self, hass, session, url: str, scan_interval: int):
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=scan_interval),
            # Equality-based suppression: with generatedAt stripped below,
            # an unchanged document produces no state writes at all.
            always_update=False,
        )
        self._session = session
        self._url = f"{url}/api/status"
        self._baselined = False
        self._last_active_id: str | None = None
        self._last_state: str | None = None
        self.pending_events: list[tuple[str, dict]] = []

    async def _async_update_data(self) -> dict:
        try:
            async with asyncio.timeout(10):
                resp = await self._session.get(self._url)
                if resp.status != 200:
                    raise UpdateFailed(f"unexpected status {resp.status}")
                data = await resp.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError) as err:
            raise UpdateFailed("cannot reach the tracker") from err
        except ValueError as err:  # non-JSON body
            raise UpdateFailed("invalid JSON from the tracker") from err

        if not isinstance(data, dict) or data.get("apiVersion") != 1:
            raise UpdateFailed("unsupported apiVersion")

        # generatedAt changes on every request. Storing it would defeat
        # always_update=False and write a state change on every poll.
        data.pop("generatedAt", None)
        self._diff(data)
        return data

    def _diff(self, data: dict) -> None:
        active_id = (data.get("activeAttack") or {}).get("id")
        last = data.get("lastAttack") or {}
        state = data.get("state")

        if not self._baselined:
            # First successful poll only establishes the baseline: a restart
            # with an attack already running must not fire attack_started.
            self._baselined = True
        else:
            if active_id is not None and active_id != self._last_active_id:
                self.pending_events.append(("attack_started", {"attack_id": active_id}))
            if (
                self._last_active_id is not None
                and active_id is None
                and last.get("id") == self._last_active_id
                and last.get("ongoing") is False
            ):
                # Only the SAME attack finishing counts as an end; a deleted
                # row (lastAttack moves on/back) fires nothing.
                self.pending_events.append(
                    ("attack_ended", {"attack_id": self._last_active_id})
                )
            if state != self._last_state:
                self.pending_events.append(("status_changed", {"state": state}))

        self._last_active_id = active_id
        self._last_state = state

    def drain_events(self) -> list[tuple[str, dict]]:
        events, self.pending_events = self.pending_events, []
        return events
```

`async_setup_entry` creates the session (or requests a shared one), builds the
coordinator, stores it on `entry.runtime_data`, awaits
`async_config_entry_first_refresh()` (it already converts a first-refresh
`UpdateFailed` into `ConfigEntryNotReady`), forwards the platform setups, and
registers `entry.async_on_unload(entry.add_update_listener(...))` to reload on
options changes.

`PARALLEL_UPDATES = 0` in each platform module: the coordinator already
single-flights the fetch, so entities must not issue their own requests.

### Entity mapping

| Platform | Entity | Notes |
| --- | --- | --- |
| `binary_sensor` | `migraine_active` | `activeAttack is not None`; no `device_class` (a migraine is not a device problem). Exposes `active_attack_id` for the ended-attack guard. |
| `sensor` | `migraine_status` | `SensorDeviceClass.ENUM` with `options=["attack", "off", "well", "no_data"]`; `translation_key`/`entity_id` stable. |
| `sensor` | `migraine_last_attack_started` | `SensorDeviceClass.TIMESTAMP`, value `lastAttack.start` (already offset-bearing), `None` when absent. |
| `sensor` | `migraine_days_since_last_attack` | `None` when `daysSinceLastAttackStart` is null. |
| `sensor` | `migraine_attack_days_last_7_days` / `_last_30_days` | Counts, `state_class=MEASUREMENT` optional. |
| `sensor` | `migraine_attacks_started_last_30_days` | Start-day anchored count. |
| `sensor` | `nurtec_tablets` | `None` when unknown; never report `0` for unknown. |
| `binary_sensor` | `nurtec_low` / `nurtec_negative` | From the booleans; `device_class=PROBLEM` for low. |
| `event` | `migraine_attack_event` | `attack_started`, `attack_ended`, `status_changed`. |

Do not expose the inventory `status`/`level` strings as entity states: their
literal `unknown` value collides with Home Assistant's reserved state. Use the
`nurtec_tablets` quantity plus the `low`/`negative` booleans.

All entities: `_attr_has_entity_name = True`, a shared `DeviceInfo`
(`identifiers={(DOMAIN, entry.unique_id)}`, `name="Migraine Tracker"`,
`manufacturer="migraine-tracker"`, `configuration_url=base_url`) and stable
`unique_id`s (`f"{entry.entry_id}_{suffix}"`). `available` follows
`coordinator.last_update_success`.

### Event entity and edge detection

`EventEntity.event_types` is the set of values the entity can emit; the
integration adds its own event names, and Home Assistant records the last event
on the entity.

```python
class MigraineAttackEvent(CoordinatorEntity, EventEntity):
    _attr_event_types = ["attack_started", "attack_ended", "status_changed"]
    _attr_translation_key = "attack_event"

    def _handle_coordinator_update(self) -> None:
        events = self.coordinator.drain_events()
        for event_type, event_data in events:
            self._trigger_event(event_type, event_data)
            # The base class does NOT write state for us; one poll can produce
            # attack_started + status_changed, and each must be published.
            self.async_write_ha_state()
        if not events:
            super()._handle_coordinator_update()
```

Edge rules (implemented in `_diff` above), comparing the previous successful
poll with the new one:

- `attack_started` when `activeAttack.id` is present and differs from the last
  seen active id;
- `attack_ended` only when `activeAttack` is now null, the last seen active id
  is still the `lastAttack.id`, and that row has `ongoing: false`. A deleted row
  fires nothing (the id no longer matches);
- `status_changed` when `state` differs (this covers `well` → `off` → `no_data`
  and the 08:00 boundary);
- the first refresh only establishes the baseline, so a restart never fires an
  event;
- polling cannot observe an attack that starts and ends entirely between two
  polls. The ntfy path below covers that case when configured.

Because only one ongoing attack is reported, closing the earliest of two
ongoing attacks while a later one continues yields `attack_started` for the
remaining id (the end is suppressed because the id changed, not finished).
Document that limitation; do not try to reconstruct the full set from this
endpoint.

### Diagnostics

```python
async def async_get_config_entry_diagnostics(hass, entry):
    coordinator = entry.runtime_data
    # Operational data only: no URL, health state, time zone, attack ids, or
    # inventory. Diagnostics are attached to public issue reports.
    return {
        "scan_interval": entry.options.get(CONF_SCAN_INTERVAL),
        "last_update_success": coordinator.last_update_success,
        "api_version": (coordinator.data or {}).get("apiVersion"),
    }
```

Never dump the raw response body wholesale: it is small today, but diagnostics
are shared in issue reports.

### Testing

Use `pytest-homeassistant-custom-component` for the HA fixture, and
`aioresponses` (or an `aiohttp` test server) for the tracker:

- config flow: success, connection error, non-JSON body, `apiVersion: 2`
  rejected, duplicate URL aborted, options clamp 14 → 15 and 3601 → 3600;
- coordinator: 200 → data stored without `generatedAt`; 500/non-JSON/timeout →
  `UpdateFailed`; unchanged payload → no entity state write;
- entities: enum options, timestamp value and `None`, unknown quantity remains
  `None`, availability mirrors `last_update_success`;
- event entity: first refresh fires nothing; id change fires `attack_started`;
  finished same id fires `attack_ended`; deleted id fires nothing;
  `state` change fires `status_changed`; reload fires nothing.

Fixture payloads: copy the examples from this document. Prefer two fixtures
(active attack, inferred off day) plus one explicit-well and one empty.
Deterministic clocks: pass `generatedAt` in the fixture but assert it is absent
from `coordinator.data`.

### `strings.json` / translations

At minimum: `config.step.user.title/data/description`, the three error keys,
`config.abort.already_configured`, the options step, and entity names for the
status/level enums and the event entity.

## Real-time attack events via ntfy

The tracker already publishes attack start/end alerts when
`NTFY_ATTACK_URL` is configured (`app/server/reminders.js`). Home Assistant's
own `ntfy` integration (2025.5+) subscribes to a topic and exposes an event
entity per topic, so this is a push path with no extra tracker code.
https://www.home-assistant.io/integrations/ntfy/

### Mapping the tracker's configuration onto Home Assistant

- The tracker's `NTFY_ATTACK_URL` is a **full topic URL**, e.g.
  `https://ntfy.sh/my-secret-attack-topic`.
- Home Assistant asks for the **service URL** (`https://ntfy.sh`) and the
  **topic** (`my-secret-attack-topic`) separately. Split the tracker URL at the
  last path segment.
- The Home Assistant subscription needs its **own read access**. Do not assume
  `NTFY_ATTACK_TOKEN` (used by the tracker to publish) grants subscribe rights:
  ntfy tokens are scoped per topic and action.
- Do not add the same topic twice (for example once per filter): the topic is
  the subentry's unique id. "Filter by title" also accepts only one exact value
  per topic.

### What the messages look like

- Each message fires the topic's event entity. `event_type` is
  `"<title>: <message>"` and includes the event time, so it is **dynamic**; the
  integration rewrites the entity's `event_types` to the latest value.
  Automations must therefore **not** match `event_type`/`event_types` exactly.
- Filter with a **state trigger** on the event entity plus a condition on the
  notification title (`Attack started` / `Attack ended`). The other topic
  filters (priority, tags, message content) cannot distinguish start from end.
- Messages contain no attack id, so exact event-to-attack correlation is
  impossible.

The notification content is exposed as attributes of the event entity (the
attribute names come from the ntfy integration — check the entity in Developer
Tools → States before trusting a template). The example below assumes
`title`/`message`.

```yaml
automation:
  - alias: Migraine ntfy attack started
    triggers:
      - trigger: state
        entity_id: event.migraine_attack_topic
    conditions:
      - condition: template
        value_template: "{{ trigger.to_state.attributes.title == 'Attack started' }}"
      - condition: template
        value_template: "{{ state_attr('sensor.migraine_status', 'activeAttack') is not none }}"
    actions:
      - action: notify.persistent_notification
        data:
          title: Migraine attack (push)
          message: "{{ trigger.to_state.attributes.message }}"
```

### Freshness, replay, and authority

- The tracker publishes alerts only for fresh, parseable start/end transitions
  on direct `POST`/`PATCH` attack writes. Backfills, imports, bulk restores,
  and late corrections produce no alert, and undelivered alerts expire after
  24 hours.
- Home Assistant's ntfy integration does not replay messages missed while HA
  was down, but ntfy itself may cache messages for reconnecting subscribers, so
  a stale event can re-fire. Gate start automations on the polled
  `activeAttack`, and end automations on `activeAttack == null` **and**
  `lastAttack.ongoing == false` with an `end` near the notification time.
- If the polled state contradicts the notification, trust the poll. Polling is
  the source of truth; ntfy is a low-latency notification path only.

## Recorder, privacy, and security

- The recorder persists every state and attribute. The REST sensor's
  `activeAttack`/`lastAttack`/`history`/`inventory` attributes are written on
  each change, and `history`/`activeAttack` are health data. Exclude the
  migraine entities from the recorder if history churn or attribute retention
  is unwanted:

  ```yaml
  recorder:
    exclude:
      entity_globs:
        - sensor.migraine_*
        - binary_sensor.migraine_*
        - sensor.nurtec_*
        - binary_sensor.nurtec_*
        - event.migraine_*
  ```

  Excluding from the recorder also removes them from history and statistics;
  automations still work, they just lose the timeline.

- `/api/status` is **server truth**, not the phone's live state. The writer
  keeps an optimistic localStorage cache, so it can be failed/unconfirmed or in
  the `diverged` conflict state. Home Assistant legitimately showing no active
  attack while the phone shows one is a sync conflict, not an integration bug;
  resolve it in the app's Settings.
- The API has **no authentication**. Keep the tracker on the private network
  (Tailscale or equivalent). Never expose it publicly without an authenticating
  reverse proxy. The endpoint adds no CORS or auth behavior of its own.
- ntfy.sh public topics are guessable: reserve/protect the attack topic, and
  remember it is a health signal readable by anyone who learns the topic name.
- `Cache-Control: no-store` is set by the tracker; do not add a caching proxy
  in front of `/api/status`.

## Testing and verification for the integration session

- `curl http://<tracker>:8097/api/status` must return the documented v1 shape
  with `Cache-Control: no-store`. Use the sample payloads above as fixtures.
- With YAML: restart Home Assistant, then check `sensor.migraine_status` and
  that `binary_sensor.migraine_active` follows a logged attack within one
  `scan_interval`.
- With the custom integration: run `pytest` (config flow, coordinator, entity
  and event tests) and `hassfest`/`hacs validate` if available.
- Edge cases worth an explicit check: empty database (`no_data`), a legacy
  explicit `attack` day (`state: attack` with `activeAttack: null`), a finished
  attack ending exactly at 08:00, multiple ongoing attacks, and a restart with
  an attack already active (no `attack_started` event).
- The tracker side is covered by `app/shared/status.test.ts` and
  `app/server/test/status.test.js`; run those before changing either side.
