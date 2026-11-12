# Home Assistant integration

Status: `GET /api/status` (apiVersion 1) and the Home Assistant custom
integration in this repository (`custom_components/migraine_tracker`) are
implemented. The integration is tested against Home Assistant 2026.10.4;
installation on the live Home Assistant instance is still pending.

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

`daysSinceLastAttackStart` keeps its start-based API meaning. The integration's
`sensor.migraine_tracker_days_since_last_attack` (display name **Days since
last attack ended**) does not use it. The sensor is a presentation rule built
from `lastAttack.end`: it is `0` while `activeAttack` is not null, and
otherwise the whole calendar days between the local date of `lastAttack.end`
(the end instant converted to the document's top-level `timeZone`) and
`today.day`, clamped to `>= 0`. The `timeZone` name is matched
case-insensitively against the platform's canonical IANA names (exact name
first, then the canonical spelling, then UTC), so a producer name such as
`america/new_york` still dates the end locally rather than in UTC. It is `None`
→ `unknown` when there is no attack, no end, an unparseable end, a
timezone-naive end, an end instant the local zone cannot represent (an extreme
year at the edge of the datetime domain), or no parseable `today.day`. It never
falls back to `lastAttack.start` or to `history.daysSinceLastAttackStart`.

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

Consequence for the custom integration's event entity: closing the earliest
ongoing attack while a later one continues reports only `attack_started` for
the newly revealed id and never a fabricated end (the integration compares
attack ids; see the event rules below).

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
- The `Migraine days since last attack` template reports the start-based API
  field (`history.daysSinceLastAttackStart`); Path A does not implement the
  integration's end-based rule. To match it, compute the days yourself from
  `lastAttack.end` converted to the document's `timeZone`, report `0` while
  `activeAttack` is not null, and clamp the result to `>= 0`.
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

## Path B: custom integration (implemented)

The custom integration is implemented in this repository at
`custom_components/migraine_tracker/`, with tests under
`tests/homeassistant/`. It is read-only: one `GET {base}/api/status` per scan
interval, no writes, and no authentication required (an optional proxy
`Authorization` header is supported).

Reference material (Home Assistant changes quickly; check the release you run):

- Data fetching and coordinators:
  https://contributors.home-assistant.io/docs/integration_fetching_data/
- `manifest.json`:
  https://developers.home-assistant.io/docs/creating_integration_manifest/
- Event entity:
  https://developers.home-assistant.io/docs/core/entity/event/
- Sensor entity:
  https://developers.home-assistant.io/docs/core/entity/sensor/
- Options flow:
  https://developers.home-assistant.io/docs/config_entries_options_flow_handler/
- RESTful sensor (for YAML/Path A):
  https://www.home-assistant.io/integrations/rest/

### Layout and installation

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
hacs.json                        # repo root; HACS reads it
requirements-homeassistant-dev.txt
tests/homeassistant/
pyproject.toml
```

There is **no tagged release yet**, so HACS cannot install the component from a
release. Copy `custom_components/migraine_tracker/` into the Home Assistant
config directory's `custom_components/`, restart Home Assistant, then add
**Migraine Tracker** under Settings → Devices & services. The layout is
HACS-compatible for a future release, but nothing has been published to the
HACS default repository or the Home Assistant Marketplace.

`hacs.json` is exactly:

```json
{
  "name": "Migraine Tracker",
  "homeassistant": "2025.8.0"
}
```

The `2025.8.0` floor is an **API-compatibility claim by inspection**, not a
tested matrix: the integration needs `OptionsFlowWithReload`, which exists in
that release. Development and CI test Home Assistant 2026.10.4 (the version
pinned by the test plugin); the live instance is 2026.11.1. See
[Testing and verification](#testing-and-verification-for-the-integration-session).

### `manifest.json`

```json
{
  "domain": "migraine_tracker",
  "name": "Migraine Tracker",
  "codeowners": ["@BradyBrenot"],
  "config_flow": true,
  "documentation": "https://github.com/BradyBrenot/migraine-tracker",
  "integration_type": "service",
  "iot_class": "local_polling",
  "issue_tracker": "https://github.com/BradyBrenot/migraine-tracker/issues",
  "requirements": [],
  "single_config_entry": true,
  "version": "0.1.1"
}
```

`single_config_entry: true` is correct here: one tracker, one status document.
`iot_class: local_polling` matches the REST sensor's classification and the
fact that no cloud account exists. There are no Python requirements to install.

### Config flow

- One step asks for the base URL (`http://tracker:8097`, a reverse-proxy base
  path is allowed) and an optional `Authorization` header value.
- URL normalization: the scheme and host are lowercased, the path keeps its
  case, and trailing slashes are stripped. The flow rejects non-`http(s)`
  schemes, a missing host, embedded credentials, a query string, a fragment, an
  invalid, non-numeric, or out-of-range port, and any base path ending in
  `/api/status` (people paste the endpoint by mistake). All of those produce the
  dedicated `invalid_url` field error before any request is made.
- Validation is exactly one `GET {base}/api/status` with a 10-second timeout and
  `allow_redirects=False`. Error mapping:

  | Error key | Cause |
  | --- | --- |
  | `cannot_connect` | DNS failure, refused connection, timeout |
  | `invalid_response` | any non-200 status (including a 3xx, which is never followed), non-JSON, not a JSON object, or an unknown display state |
  | `unsupported_api_version` | `apiVersion` is missing or is not the exact JSON integer `1` (`true`, `1.0`, and `"1"` are all rejected) |
  | `unauthorized` | the tracker or its proxy returned 401/403 |
  | `invalid_url` | normalization rejected the URL before any request |
  | `invalid_authorization` | the `Authorization` value contains a character that cannot be sent in an HTTP header (a control character, or anything above U+00FF that Latin-1 cannot encode), checked before any request |

- An `invalid_url` or `invalid_authorization` result performs no request and does
  not create, change, or reload the entry; the form is shown again with that
  error.

- The unique ID is the normalized base URL, so the same tracker cannot be added
  twice. `single_config_entry: true` means Home Assistant aborts a new flow with
  `single_instance_allowed` before the user step; should the step be reached
  directly, the same URL still aborts `already_configured` and a different URL
  aborts `single_instance_allowed`.
- Reconfigure validates the new URL, then updates the entry's URL and unique ID
  with `async_update_reload_and_abort`. The config entry survives, so the
  device and every entity-to-device link survive too. That works because the
  device identity is `(DOMAIN, entry.entry_id)` — **never the URL**; keying the
  device or unique IDs on the URL would orphan them on every reconfigure.

### Optional `Authorization` header

The tracker itself has no authentication. But when it sits behind an
authenticating reverse proxy, a missing or wrong header yields 401/403, which
would otherwise be indistinguishable from a broken tracker. The header is
therefore supported in **both** the initial setup form and the options form:

- It is stored in `entry.options["authorization"]`, not entry data, so it is
  not part of the entry identity and is not shown as a form default.
- It is sent as the `Authorization` header on every status GET; leading and
  trailing whitespace is trimmed, so an all-whitespace value means "no header".
- It is never logged by the integration, never prefilled into a form, and never
  exported in diagnostics.
- The value is validated before it is sent: CR, LF, NUL, DEL, and the other
  control characters (everything below 0x20 except horizontal tab) are rejected
  with `invalid_authorization` in the setup, reconfigure, and options forms.
  Horizontal tab and ordinary spaces are allowed, and non-ASCII obs-text
  (U+0080–U+00FF) values are allowed. Characters that aiohttp cannot encode as
  Latin-1 (anything above U+00FF, such as an emoji or the euro sign) are
  rejected the same way, before any request, instead of raising
  `UnicodeEncodeError` mid-request. A rejected value performs no request and
  does not create, change, or reload the entry.
- A corrupt value already stored in options (for example from a hand-edited
  `.storage`) makes the coordinator raise `UpdateFailed` explaining that the
  stored authorization is invalid until it is cleared or replaced in options.
  The value itself is never logged.
- Status requests use `allow_redirects=False`, so a 3xx is an
  `invalid_response` and the header is never forwarded to another host.
- Saving options for the interval alone keeps the stored header. Entering a new
  value replaces it; a dedicated **Remove the stored Authorization header**
  toggle deliberately clears it (the toggle wins over a value entered in the
  same save). Reconfigure keeps the stored header when its field is left empty.

### Options

The options flow uses `OptionsFlowWithReload` (framework-supplied
`self.config_entry`, no-argument constructor). It exposes the scan interval in
seconds, default **60**, clamped to **15–3600**; out-of-range values are
corrected rather than rejected. The interval and the header both live in
`entry.options`.

Do **not** register an update listener for options: `OptionsFlowWithReload`
reloads the entry itself, and the integration keeps `entry.update_listeners`
empty. Home Assistant 2026.12 makes the update-listener/reconfigure combination
an error, so this is also forward-compatible.

### Coordinator

- `DataUpdateCoordinator` constructed with `config_entry=entry`, the shared HA
  `aiohttp` session, and `always_update=False`; one GET per interval, a
  10-second timeout, and the optional `Authorization` header.
- `generatedAt` is stripped before the document is stored. With equality-based
  suppression, a poll that differs only in `generatedAt` produces no listener
  notification and no entity state writes.
- Every failure becomes `UpdateFailed`: non-200 (including a 3xx, because
  redirects are never followed), non-JSON, unsupported `apiVersion`, an invalid
  display state (anything outside `attack`/`off`/`well`/`no_data`),
  connection/timeout, and 401/403. Only a `ValueError` from `response.json()`
  is treated as a non-JSON body; unrelated value errors are not swallowed. A bad
  document therefore marks the entities unavailable and retries; it is never
  silently mapped onto Home Assistant's `unknown`.
- The status GET always uses `allow_redirects=False`, so the optional
  `Authorization` header is never forwarded to a redirect target.
- The first successful poll only establishes the event baseline. A restart or
  reload with an attack already running never synthesizes a transition, and
  the event entity's restored state is not a new event. A failed poll does not
  move the baseline, so the next success is diffed against the last good one.
- Pending events are **replaced** on every successful poll (bounded to one
  poll's events). A disabled event entity therefore never replays events it
  missed when it is re-enabled.

`async_setup_entry` builds the coordinator, stores it on `entry.runtime_data`,
awaits `async_config_entry_first_refresh()` (which converts a first-refresh
`UpdateFailed` into `ConfigEntryNotReady`), and forwards the platform setups.
There is no update listener; unloading forwards platform unloads.

`PARALLEL_UPDATES = 0` in each platform module: the coordinator already
single-flights the fetch, so entities must not issue their own requests.

### Entity mapping

Eleven entities share one device and use `_attr_has_entity_name = True`, so
Home Assistant combines the translated entity name below with the device name
(**Migraine Tracker**) for the friendly name and derives entity IDs from it
(for example `sensor.migraine_tracker_status`,
`binary_sensor.migraine_tracker_active_attack`,
`binary_sensor.migraine_tracker_nurtec_low_stock`, and
`event.migraine_tracker_attack_event`).

| Platform | Key (unique ID suffix) | Name | Behavior |
| --- | --- | --- | --- |
| `binary_sensor` | `active` | Active attack | on when `activeAttack is not None` (never `state == "attack"`); no device class; only extra attribute `active_attack_id` |
| `binary_sensor` | `nurtec_low` | Nurtec low stock | `inventory.nurtec.low`; `device_class: problem` |
| `binary_sensor` | `nurtec_negative` | Nurtec stock negative | `inventory.nurtec.negative`; no device class |
| `sensor` | `status` | Status | enum with options exactly `attack`, `off`, `well`, `no_data`; state names translated |
| `sensor` | `last_attack_started` | Last attack started | timestamp; timezone-aware datetime from `lastAttack.start`, `None` when absent or unparseable |
| `sensor` | `days_since_last_attack` | Days since last attack ended | `0` while `activeAttack is not None`; otherwise whole calendar days from the local `lastAttack.end` date (document `timeZone`, matched case-insensitively) to `today.day`, clamped `>= 0`; `None` → `unknown` also for an unparseable, naive, or unrepresentable end; never start-based or history-based |
| `sensor` | `attack_days_last_7_days` | Attack days last 7 days | integer count |
| `sensor` | `attack_days_last_30_days` | Attack days last 30 days | integer count |
| `sensor` | `attacks_started_last_30_days` | Attacks started last 30 days | start-day anchored count |
| `sensor` | `nurtec_tablets` | Nurtec tablets | integer or `None`; unknown stays `None`, never `0`; negatives are preserved |
| `event` | `attack_event` | Attack event | `attack_started`, `attack_ended`, `status_changed` |

Do not expose the inventory `status`/`level` strings as entity states: their
literal `unknown` value collides with Home Assistant's reserved state. Use the
`nurtec_tablets` quantity plus the `low`/`negative` booleans.

Entity details:

- Unique IDs are `f"{entry.entry_id}_{key}"`, so a reconfigure cannot change
  them; `entry.entry_id` is also the device identifier.
- The `days_since_last_attack` key remains the unique-ID suffix and translation
  key after its display name changed to **Days since last attack ended**, so an
  existing install keeps its entity, its
  `sensor.migraine_tracker_days_since_last_attack` entity ID, and its recorder
  history. A fresh install derives
  `sensor.migraine_tracker_days_since_last_attack_ended` from the new name;
  rename it in the UI if you want the shorter old ID.
- The device is one `DeviceInfo` with `name="Migraine Tracker"`,
  `manufacturer="migraine-tracker"`, and `configuration_url` set to the current
  base URL.
- All value entities are populated from the first refresh before the platforms
  are forwarded, so setup never exposes a transient `unknown`. A sensor whose
  value is legitimately `None` (for example days since last attack with no
  attack end) reports `unknown`, which is its real value, not a loading state.
  The event entity is the exception: it starts `unknown` and stays there until
  its first event.
- `available` follows `coordinator.last_update_success`: a failed poll makes
  every entity `unavailable` until the next success.
- No entity sets `state_class`. That keeps attack counts, days since the last
  attack, and Nurtec stock out of long-term statistics; the values remain
  normal recorder-tracked states (exclude them from the recorder if that
  history is unwanted).
- Because of `_attr_has_entity_name`, Home Assistant derives the default entity
  IDs from the device and translated entity names, for example
  `sensor.migraine_tracker_status`,
  `binary_sensor.migraine_tracker_active_attack`,
  `sensor.migraine_tracker_nurtec_tablets`, and
  `event.migraine_tracker_attack_event`. Renaming in the UI changes the
  entity ID; use the IDs your instance actually shows.

### Event entity and edge rules

The event entity advertises `attack_started`, `attack_ended`, and
`status_changed`. Its state is the timestamp of the last event; the event type
is the `event_type` attribute, and the payload is the remaining attributes:

| Event type | Payload |
| --- | --- |
| `attack_started` | `{"attack_id": "<id>"}` |
| `attack_ended` | `{"attack_id": "<id>"}` |
| `status_changed` | `{"state": "attack" \| "off" \| "well" \| "no_data"}` |

A poll can produce several events (for example `attack_started` and
`status_changed`); each is published as its own state change, so automations see
one event per transition.

Edge rules, comparing the previous successful poll with the new one:

- `attack_started` when `activeAttack.id` is present and differs from the last
  seen active id.
- `attack_ended` only when `activeAttack` is now null, the last seen active id
  is still `lastAttack.id`, and that row has `ongoing: false`. A deleted or
  replaced row fires nothing.
- `status_changed` when the display `state` differs. This follows `state`, not
  `today.status`: editing a day record without changing the display state (for
  example setting `today.status` while an attack keeps `state: "attack"`) fires
  nothing.
- The first successful poll only establishes the baseline, so a restart, a
  reload, or a restored event entity never fires an event.
- `attack_started` and `attack_ended` carry the attack id, so consumers can
  correlate start/end pairs without guessing.

Known limitations (document these; do not try to reconstruct data the endpoint
does not expose):

- **Multiple ongoing attacks.** Only `activeAttack` (the earliest ongoing row)
  is reported. Closing the earliest of two ongoing attacks while a later one
  continues yields only `attack_started` for the newly revealed id — no
  fabricated `attack_ended` for the closed one.
- **Replacement between two polls.** If attack A ends and attack B starts
  between two polls, only `attack_started(B)` is emitted and no
  `attack_ended(A)`: the active-id guard cannot prove the replacement, because
  the last seen active id A is not a finished `lastAttack` row.
- **Active attack with an unparseable start.** `attack_ended` requires
  `lastAttack.id` to match the last seen active id. If the active row's start is
  null, `lastAttack` can point at a different row, so the later end event is
  suppressed (API limitation).
- **Starts and ends inside one interval.** Polling cannot observe an attack that
  starts and ends entirely between two polls. The ntfy push path below covers
  that case when configured.
- **Event history is not replayed.** Pending events are replaced each poll, so a
  disabled event entity misses transitions that happen while it is disabled.

### Diagnostics

Diagnostics return exactly three keys:

```json
{
  "scan_interval": 60,
  "last_update_success": true,
  "api_version": 1
}
```

`scan_interval` is the effective (clamped) options value. There is no URL,
`Authorization` header, health data, time zone, attack id, or raw document:
diagnostics are attached to public issue reports.

Two distinct not-loaded cases are covered. After the entry has been unloaded
there is no `runtime_data`, so a fallback returns `scan_interval` from the entry
options, `last_update_success: false`, and `api_version: null`. During
`SETUP_RETRY` after a failed first refresh, Home Assistant retains the failed
coordinator in `runtime_data`, so diagnostics read the coordinator rather than
the fallback; it reports `last_update_success: false` and `api_version: null`
because no successful poll ever populated its data. In both cases diagnostics
still return exactly the same three keys, the download never fails just because
the integration is not currently loaded, and the key set never changes.

### Testing

The pytest suite is `tests/homeassistant/`: 224 tests (config flow 67,
coordinator 54, events 18, sensors 33, options 16, binary sensors 9,
reconfigure 7, init/setup 6, diagnostics 5, entity metadata 6, forward
compatibility 2, smoke 1). Read-only coverage is layered: an autouse fixture
inspects the `aioclient_mock` calls of every test that uses that plugin
fixture and fails on anything except `GET {base}/api/status`; tests that drive
a recording fake session assert the method and URL of every recorded call
directly. Root `conftest.py` declares `pytest_plugins`, so the bare
`python -m pytest -q` from the repository root collects the whole suite.

Commands, the POSIX harness caveat, the test-vs-live version gap, and manual
checks are in
[Testing and verification for the integration session](#testing-and-verification-for-the-integration-session).

### `strings.json` / translations

`strings.json` and `translations/en.json` cover the config and reconfigure
steps, all six config error keys (`cannot_connect`, `invalid_response`,
`unsupported_api_version`, `unauthorized`, `invalid_url`,
`invalid_authorization`) plus the options `invalid_authorization` key,
`already_configured`/`single_instance_allowed`/`reconfigure_successful`, the
options step (including the clear-header toggle), every entity name, the four
translated status state names, and the event name. Tests assert the
translations resolve.

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

- The recorder persists every state and attribute. Path A's status sensor
  carries `activeAttack`/`lastAttack`/`history`/`inventory` as attributes,
  written on each change; `history`/`activeAttack` are health data. Path B's
  entities are individual states with no `state_class` (so no long-term
  statistics), but their state history — and every attack event — is still
  recorder data. Exclude the migraine entities from the recorder if history
  churn or attribute retention is unwanted:

  ```yaml
  recorder:
    exclude:
      entity_globs:
        # Both paths match: Path B entity IDs are device-prefixed, e.g.
        # sensor.migraine_tracker_status, which still starts with
        # "migraine_".
        - sensor.migraine_*
        - binary_sensor.migraine_*
        - event.migraine_*
        # Path A only; Path B's Nurtec entities match the globs above.
        - sensor.nurtec_*
        - binary_sensor.nurtec_*
  ```

  Excluding from the recorder also removes them from history and statistics;
  automations still work, they just lose the timeline.

- Recorder samples for `sensor.migraine_tracker_days_since_last_attack` written
  before integration version `0.1.1` used the start-based
  `history.daysSinceLastAttackStart`, possibly with no special handling while an
  attack was active. Expect a step change in that entity's recorder history at
  the `0.1.1` upgrade, and do not compare samples across it.

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

The Python commands run from the repository root (unlike the `app/` npm
commands):

```sh
python -m venv .venv
. .venv/bin/activate                 # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements-homeassistant-dev.txt

python -m pytest -q                  # full suite, from the repository root
# python -m pytest tests/homeassistant -q   # focused alternative
python -m ruff check custom_components/migraine_tracker tests/homeassistant
python -m ruff format --check custom_components/migraine_tracker tests/homeassistant
python -m compileall -q custom_components/migraine_tracker
python -c "import json; [json.load(open(p, encoding='utf-8')) for p in ('custom_components/migraine_tracker/manifest.json','custom_components/migraine_tracker/strings.json','custom_components/migraine_tracker/translations/en.json','hacs.json')]"

# hassfest is not on PyPI and is not shipped in the homeassistant wheel.
docker run --rm -v "$PWD:/github/workspace" ghcr.io/home-assistant/hassfest@sha256:da6522993280166fe072704989a2b4c33e639e8ceb69c8ab6ad7ec5045c1a1e3
```

Caveats:

- The HA test harness is **POSIX-only**: `pytest-homeassistant-custom-component`
  imports `homeassistant.runner`, which imports `fcntl`. `pytest` therefore does
  not run on native Windows — use Linux, WSL, or a container. `ruff` and
  `compileall` work on any OS.
- The toolchain is pinned by `pytest-homeassistant-custom-component==0.13.375`,
  which pins `homeassistant==2026.10.4` and requires Python >= 3.14.2 (local and
  CI run Python 3.14.x). The live Home Assistant instance is 2026.11.1:
  **tests run one minor release behind live**, and the gap is recorded rather
  than papered over by forcing versions.
- CI runs the same steps (pytest, ruff check, ruff format --check, compileall,
  JSON validation, and a digest-pinned hassfest image) in the `homeassistant`
  job on `ubuntu-latest`.
- `hacs validate` is not run: there is no release or HACS repository entry to
  validate yet.

Manual checks against a running tracker:

- `curl http://<tracker>:8097/api/status` must return the documented v1 shape
  with `Cache-Control: no-store`. Use the sample payloads above as fixtures.
- With YAML, restart Home Assistant, then check `sensor.migraine_status` and
  that `binary_sensor.migraine_active` follows a logged attack within one
  `scan_interval`.
- With the custom integration, add it, then confirm the value entities (and the
  Nurtec entities) have values immediately. The event entity legitimately stays
  `unknown` until the first transition it observes; an attack start/end then
  shows up within one scan interval.
- Edge cases worth an explicit check: empty database (`no_data`), a legacy
  explicit `attack` day (`state: attack` with `activeAttack: null`), a finished
  attack ending exactly at 08:00, multiple ongoing attacks, and a restart with
  an attack already active (no `attack_started` event).
- The tracker side is covered by `app/shared/status.test.ts` and
  `app/server/test/status.test.js`; run those before changing either side.
