# Home Assistant integration interface

Status: implemented; see the implementation notes at the end.

## Goal

Make this tracker usable from Home Assistant without writing the Home Assistant
integration in this session:

- show current migraine status on a dashboard;
- let Home Assistant automations react to attack start/end and day-status
  changes;
- keep the tracker itself read-only from Home Assistant's perspective;
- define a stable, documented interface another session can build against.

The Home Assistant custom component (config flow, coordinator, entities) is a
separate deliverable. This repo delivers the server-side interface plus the
handoff documentation.

## What exists today

- A REST API with CRUD for attacks, meds, refills, workouts, day states, stock
  baselines, settings, a Nurtec inventory calculation, weather status, export,
  import, restore, reset, and health.
- No authentication. The documented deployment boundary is a private Tailscale
  network.
- Attack start/end alerts are already pushed through ntfy when
  `NTFY_ATTACK_URL` is configured (`server/reminders.js`). Home Assistant's
  official `ntfy` integration (2025.5+) subscribes to a topic and creates an
  event entity per topic, so real-time attack events already have a push path
  that needs no new tracker code. It is best-effort, not a complete event log;
  see the ntfy section below.
- The derived semantics a dashboard needs already exist as pure shared code:
  - an ongoing attack is `attack.end === null` (the writer UI's `activeAttack`);
  - a local "migraine day" is the 08:00-to-08:00 window
    (`shared/attackstats.ts`, authority:
    `docs/plans/2026-11-02-migraine-day-0800-rule.md`);
  - the effective day status is an explicit day record, else `off` when the day
    counts as an attack day (`shared/daystate.ts`);
  - Nurtec stock is computed by `shared/inventory.ts` and already exposed
    authoritatively at `GET /api/inventory/nurtec`.
- The raw `/api/attacks` + `/api/day-states` endpoints are technically enough,
  but Home Assistant would have to reimplement the 08:00 rule, timezone
  handling, inventory scoping, and precedence rules. That drift is the main
  reason for a purpose-built endpoint.

## Decision

Add one read-only, versioned, derived endpoint: `GET /api/status`.

- It is a projection, not a new source of truth: no schema change, no new
  persistent state, no frontend change, no new environment variable.
- It is computed server-side from existing rows and the existing shared pure
  modules, so the browser, reminders, and Home Assistant use the same rules.
- It is the single poll target for a Home Assistant coordinator or a YAML
  `rest` sensor.
- Real-time attack events are documented through the existing ntfy attack
  topic. Polling covers day-status changes, attack edits, and the 08:00
  boundary.
- No write interface is added. The API remains unauthenticated and the
  documented deployment boundary remains a private network.

Rejected alternatives:

- **Document `/api/export` only**: forces Home Assistant to duplicate domain
  rules and pull all history every poll.
- **MQTT**: adds a broker, credentials, and a new persistence/config surface
  for no requirement in this task.
- **Server-push webhook/SSE now**: the existing ntfy push already covers the
  only truly time-sensitive events (attack start/end). A webhook would add
  outbound retries, secret handling, and failure policy. Deferred and
  documented as an optional phase 2.
- **Write entities in Home Assistant**: the writer UI keeps an optimistic
  localStorage cache and conflict/diverged handling; a second writer bypasses
  that. Read-only avoids a second source of writes.

## Interface contract, `GET /api/status`

- Method: `GET`. No query parameters in v1.
- Auth: none, same as the rest of the API. Only for a private network.
- Response: `200 application/json`, `Cache-Control: no-store` (health data must
  not be cached by proxies).
- Unknown fields must be ignored by clients. Additive fields are allowed
  without an `apiVersion` bump; renaming, removing, or changing the meaning of
  a field requires a bump.
- All instants in the response are canonical UTC ISO-8601 strings with
  milliseconds (`Date#toISOString`, e.g. `2026-11-11T15:05:00.000Z`), or `null`
  when the stored value cannot be parsed. Raw stored strings remain available
  at `GET /api/attacks`; they are not exposed here because the API accepts any
  non-empty string and Home Assistant timestamp sensors require
  timezone-aware datetimes.
- `generatedAt` changes on every request. It must not be copied into entity
  attributes and the custom integration must strip it from the data it stores
  in `DataUpdateCoordinator.data`, or `always_update=False` can never suppress
  redundant state writes.

### Shape

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
  "today": {
    "day": "2026-11-11",
    "status": "off",
    "source": "inferred"
  },
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

### Field semantics

Top level:

| Field | Type | Meaning |
| --- | --- | --- |
| `apiVersion` | integer | Contract version. v1 now. |
| `generatedAt` | ISO instant | Server clock at response time. Debug/observability only. |
| `timeZone` | IANA id | The configured settings timezone, or `UTC` when missing/invalid. All day keys and the 08:00 rule use this zone. It can differ from Home Assistant's zone and from a writer browser's system zone when no timezone setting exists (the writer falls back to the browser zone). |
| `state` | enum | Display status: `attack`, `off`, `well`, or `no_data`. Precedence below. |
| `activeAttack` | object or null | The ongoing attack, or null. |
| `today` | object | Today's local day bucket. |
| `lastAttack` | object or null | Most recent attack with a parseable start, ongoing or finished. |
| `history` | object | Precomputed counts. |
| `inventory` | object | Currently Nurtec only, mirroring `GET /api/inventory/nurtec`. |

`state` uses `no_data`, not `unknown`: Home Assistant reserves `unknown` for a
missing/unavailable state, so a literal `unknown` would be indistinguishable
from a dead sensor and would confuse recorder history and edge detection.

`state` precedence (documented, deterministic):

1. `"attack"` when an ongoing attack exists (`end === null`), regardless of the
   day record. This matches the app: the screens that know about an active
   attack show Attack.
2. Otherwise the effective status for today's local day:
   - an explicit `day_states` record always wins (`well`, `off`, or legacy
     `attack`; `today.source = "explicit"`);
   - with no record, a day that counts as an attack day (an attack overlaps the
     local 08:00-to-08:00 window) is `"off"` with
     `today.source = "inferred"`;
   - otherwise `"no_data"` and `today.status = null`,
     `today.source = "none"`.
3. `state` is a display convenience, not the activeness signal. A legacy
   explicit `day_states.status = "attack"` with no ongoing attack yields
   `state: "attack"` but `activeAttack: null`. Automations and the
   `binary_sensor.migraine_active` entity must use `activeAttack`, never
   `state == "attack"`.

All day/history calculations and `generatedAt` use one captured `nowMs` per
request, so a response cannot straddle local midnight.

`activeAttack`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable attack id, for transition dedupe. |
| `start` | ISO instant or null | Normalized stored start, or null when unparseable. |
| `peakPain` | integer or null | Stored cached peak 0-10; stored `-1` (unknown) becomes null. |
| `latestPain` | `{ts, level}` or null | Valid pain-log entry with the greatest parsed `ts`; `ts` normalized. Ties keep the later array element. |
| `aura` | boolean or null | Stored aura. |

Deliberately excluded from `activeAttack`: `notes` (free text), the full
`painLog` (history-sized), and `symptoms`/`triggers`. This is minimalism and
attribute/recorder stability, not a new authorization boundary: `/api/export`
already returns every field on the private network. Consumers that need detail
can call `GET /api/attacks`.

An ongoing attack is `end === null`, exactly like the client's `activeAttack`
and `parseAttackInterval`'s `ongoing` flag. A legacy empty-string `end` is not
treated as ongoing; it degrades to a finished attack with an unusable end, like
the shared parser. If multiple rows have `end === null` (the writer really does
offer "Log another attack", so this is reachable), report the first in the
canonical order below. Only one is reported; the response does not enumerate
all ongoing attacks.

Canonical attack ordering, used consistently:

- ascending by parsed start instant, then ascending by `id`;
- attacks with unparseable starts sort last (ascending by `id` among
  themselves);
- the reported `activeAttack` is the first ongoing attack in that order;
- `lastAttack` is the last attack **with a parseable start** in that order;
  null when no attack has a parseable start.

This matches `GET /api/attacks ORDER BY start` for distinct canonical
client-written ISO starts; the id tie-break makes it deterministic where the
SQL order is not.

`today`:

| Field | Type | Meaning |
| --- | --- | --- |
| `day` | `YYYY-MM-DD` | Today in `timeZone`. |
| `status` | `well` \| `off` \| `attack` \| null | Stored/effective day status, not the display `state`. |
| `source` | `explicit` \| `inferred` \| `none` | Where `status` came from. |

`lastAttack`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Attack id. |
| `start` | ISO instant | Normalized start. Always parseable because `lastAttack` requires one. |
| `end` | ISO instant or null | Normalized end; null when ongoing or when the stored end is unparseable. |
| `ongoing` | boolean | `end === null` in the stored row. |
| `durationMinutes` | integer or null | `Math.round` elapsed minutes when `end` parses and is >= start; null when ongoing or unusable. |
| `peakPain` | integer or null | Same normalization as above. |

`lastAttack` may be the active attack.

`history`:

| Field | Type | Meaning |
| --- | --- | --- |
| `daysSinceLastAttackStart` | integer or null | `today` minus the local day key of `lastAttack.start`, clamped to >= 0. Null when there is no parseable attack start or the resulting key is outside the 4-digit day-key domain. Based on the start day, not the 08:00 attack-day rule. |
| `attacksStartedLast30Days` | integer | Attack records whose start local day key is in the 30 local days ending today (today-29..today), including ongoing. Start-day anchored; this intentionally differs from the Reports "attacks" count, which counts any attack overlapping the period. |
| `attackDaysLast7Days` | integer | Distinct local day keys in today-6..today where at least one attack counts as an attack day under the 08:00 rule. |
| `attackDaysLast30Days` | integer | Same over today-29..today. |

Attack-day counts use only attack records; an explicit `day_states` record of
`attack` does not add to them. This matches the Reports day rule. An early
morning attack (e.g. 01:00-02:00 today) counts yesterday, not today. Days are
enumerated with calendar arithmetic, so DST transitions cannot skip or repeat
a day. The status request scans all attacks for these windows; a personal
dataset is small, and the existing `attackCountsAsAttackDay` coarse filter
rejects far-away attacks before resolving timezone boundaries.

`inventory.nurtec`:

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | `known` \| `unknown` | Whether an applicable baseline exists. |
| `quantity` | integer or null | Tablets on hand; may be negative; null when unknown. |
| `level` | `unknown` \| `ok` \| `low` \| `negative` | Same classification as the inventory route. |
| `low` | boolean | `quantity !== null && quantity <= threshold`. |
| `negative` | boolean | `quantity !== null && quantity < 0`. |
| `threshold` | integer | Configured low-stock threshold, or the shared default 2. |

Inventory stays Nurtec-only exactly like the existing route. Extract one
internal `computeNurtecStock(db, nowMs)` in `app/server/app.js` and use it for
both `GET /api/inventory/nurtec` and `/api/status`, so the two cannot diverge.
The route's `baselineId`, `baselineEffectiveAt`, `timeZone`, and `computedAt`
are not duplicated into the status document; `timeZone` is already top-level.

### Edge cases and failure behavior

- Invalid/missing settings timezone → `UTC`, matching the inventory route and
  reminder engine fallback. Document the writer-browser-zone caveat above.
- Unparseable timestamps/ends never throw; they degrade to null/absent fields.
  **This includes parseable but out-of-domain instants**: a stored start such
  as `+275760-09-13T00:00:00.000Z` parses, but `localDayKey` produces a
  non-4-digit key and `diffDayKeys` would throw `RangeError`. Guard day-key
  consumers with the same `^\d{4}-\d{2}-\d{2}$`/`isValidDayKey` check used in
  `shared/attackstats.ts`; never let a stored row turn the poll target into a
  permanent 500.
- Future attack start: an ongoing future attack still makes `state = "attack"`
  (it is an explicit user record); no negative durations are emitted.
- Multiple ongoing attacks: deterministic first as described above. The Home
  Assistant event entity can emit a spurious started/ended pair when the
  earliest ongoing attack is closed while a later one continues; document this
  limitation in the handoff.
- Empty database: `state: "no_data"`, `activeAttack: null`,
  `today.status: null`, `lastAttack: null`, history zeros/nulls, inventory
  `unknown`/null.
- A database/query failure returns the normal Fastify 500; no partial body.
- This is a read endpoint. The existing cross-origin guard does not affect GET,
  and Home Assistant server-to-server requests have no Origin header. No CORS
  change is needed.
- No new export/backup/reset behavior: the endpoint derives from data already
  covered by those paths.

## Home Assistant consumption paths (documented, not implemented here)

### Path A: YAML `rest` sensor plus templates

Works with no custom component. One poll per `scan_interval`; expose only
`activeAttack`, `today`, `lastAttack`, `history`, and `inventory` as JSON
attributes (not `generatedAt`).

Provide ready-to-paste YAML for:

- `sensor.migraine_status`: plain string state from `value_json.state`. Do
  **not** set `device_class: enum` on a REST sensor: the enum device class
  requires an `options` capability, and the REST sensor has no `options` config
  key. (A YAML template sensor can set `attributes: {options: [...]}`, but that
  is unnecessary for Path A.) Reserve enum-with-options for the custom
  integration (Path B).
- `binary_sensor.migraine_active`: based on `activeAttack is not none`, with an
  `availability` template so it becomes unavailable rather than `off` when the
  REST sensor is unavailable.
- `sensor.migraine_last_attack_started`: `device_class: timestamp` using
  `lastAttack.start` (already a canonical offset-bearing instant), with an
  `availability` template because `lastAttack` can be null.
- `sensor.migraine_days_since_last_attack`: from `history`.
- Nurtec quantity and a low-stock binary sensor. Prefer the boolean
  `inventory.nurtec.low`/`negative` values for entity state; do not expose the
  inventory `status`/`level` strings as entity states, because `unknown` is a
  reserved Home Assistant state.

Document that state-based template entities update when the referenced REST
sensor updates, not on an independent schedule, and that a template reading a
nested JSON attribute returns a dict/list. Ready-to-paste templates must guard
legitimate nulls (`state_attr(..., 'lastAttack') or {}`) so a missing attack
renders as `false`/`unknown` instead of an automation error.

### Path B: custom integration (handoff)

Document, with official Home Assistant developer-doc links:

- `manifest.json` for a custom integration (`domain`, `name`, `version`,
  `config_flow: true`, `iot_class: "local_polling"`,
  `integration_type: "service"`, `single_config_entry: true`,
  `documentation`, `issue_tracker`).
- Config flow: base URL; validate with `GET /api/status`; reject non-200,
  non-JSON, and `apiVersion != 1` with distinct errors; options flow for the
  scan interval (15-3600 s, default 60); reconfigure step.
- `DataUpdateCoordinator` with `update_interval`, `always_update=False`,
  `UpdateFailed` on connection/non-200/invalid JSON; first refresh in
  `async_setup_entry`. Strip `generatedAt` before storing `coordinator.data`
  so equality-based update suppression works.
- Entity mapping: binary sensor, status enum sensor
  (`SensorDeviceClass.ENUM`, `options=[attack, off, well, no_data]`), last-start
  timestamp sensor, days-since and attack-day sensors, Nurtec sensors, and one
  event entity with `attack_started`, `attack_ended`, `status_changed`.
- Event entity edge detection across polls: initialize from the first refresh
  without firing; fire `attack_started` when the active id appears,
  `attack_ended` only when that same id is now finished (not deleted), and
  `status_changed` when `state` changes. Do not fire on restart. Polling cannot
  observe an attack that starts and ends entirely between two polls; the ntfy
  path covers that case when configured.
- Unique IDs, `has_entity_name`, device info, `PARALLEL_UPDATES = 0`,
  diagnostics with no health payload and no unnecessary URL detail.
- Testing with `pytest-homeassistant-custom-component` and `aioresponses`;
  fixture payloads copied from this document.
- HACS packaging layout.

### Real-time attack events via ntfy

- The tracker's `NTFY_ATTACK_URL` is a full topic URL (for example
  `https://ntfy.sh/my-secret-topic`). Home Assistant's `ntfy` integration asks
  for the service URL and the topic separately; document that mapping.
- The HA subscription needs its own read access. Do not assume the tracker's
  `NTFY_ATTACK_TOKEN` (used for publishing) grants subscription access; ntfy
  tokens can be scoped per topic and action.
- Each message fires the per-topic event entity. `event_type` is
  `"<title>: <message>"` (dynamic, includes the event time), and the integration
  rewrites `event_types` to the latest value, so automations must not match
  `event_type`/`event_types` exactly. Use a state trigger on the event entity
  plus a condition on the notification `title`
  (`Attack started` / `Attack ended`). The same topic cannot be added twice to
  get two title-filtered entities (the topic is the subentry unique id), and
  "Filter by title" accepts one exact value; the other topic filters
  (priority/tags/message) also cannot distinguish start from end here.
- The tracker publishes alerts only for fresh, parseable start/end transitions
  on direct POST/PATCH writes. Backfills, imports, bulk restores, and late
  corrections do not produce alerts; undelivered alerts expire after 24 hours.
  Configure the HA `ntfy` topic without replay assumptions: the integration
  does not replay messages missed while HA was down, and ntfy may cache
  messages for reconnecting subscribers, so a stale event can re-fire.
- ntfy messages carry no attack id, so exact event-to-attack correlation is
  impossible. Gate start automations on the polled status showing
  `activeAttack` (optionally with a start near the notification time), and end
  automations on `activeAttack === null` plus `lastAttack.ongoing === false`
  and an `end` near the notification time. If the polled state contradicts the
  notification, trust the poll. Polling remains the source of truth.

### Recorder and privacy

- Home Assistant's recorder will persist the status attributes. Document
  `recorder.exclude` / `entity_globs` for the migraine entities and note that
  ntfy.sh public topics are guessable unless reserved/protected.
- `/api/status` is server truth, not the phone's live state. The writer keeps
  an optimistic localStorage cache and can be in a failed/unconfirmed/diverged
  state, so HA can legitimately show no active attack while the phone shows
  one. That is a sync-conflict situation, not an integration bug.
- The endpoint is unauthenticated like the rest of the API. Keep the tracker on
  the private network; never expose it publicly without an authenticating
  reverse proxy.

### Optional phase 2, explicitly not implemented

A server-push webhook (`HA_WEBHOOK_URL`, environment-only secret) could reuse
the existing attack occurrence queue for lower latency and would also cover
day-status changes. It requires outbound retries, a new configuration surface,
and secret handling. Not required for this task, because ntfy already covers
attack start/end and 60-second polling covers everything else.

## Implementation plan (worker)

Goal: add the versioned read-only `GET /api/status` endpoint, its shared pure
builder, tests, and the Home Assistant handoff documentation. No schema,
frontend, auth, CORS, reminder, or Docker/CI changes.

Allowed paths (exact allow-list):

- `app/shared/status.ts` (new)
- `app/shared/status.test.ts` (new)
- `app/server/app.js` (add the route and extract the shared Nurtec helper)
- `app/server/test/status.test.js` (new)
- `docs/home-assistant.md` (new)
- `docs/plans/2026-11-11-home-assistant-integration.md` (add implementation
  notes after acceptance)
- root `AGENTS.md` (architecture/API bullet)
- root `README.md` (short Home Assistant section linking to the doc)

Out of scope / deny-list:

- `app/server/migrations.js`, `app/server/db.js`, `app/server/snapshot.js`,
  `app/server/backup.js`, `app/server/reminders.js`, `app/server/ntfy.js`,
  `app/server/reminder-config.js`, `app/server/validate.js`,
  `app/server/index.js`
- `app/src/**`, `app/index.html`, `app/view.html`
- `app/Dockerfile`, `.github/**`, `DEPLOY.md`, lockfiles
- No new dependencies; no write endpoints; no auth/CORS changes.

Constraints:

- `shared/status.ts` is erasable TypeScript only (no enums, namespaces,
  parameter properties), uses explicit `.ts` imports, and imports only types
  from `src/` (`import type`), because the Docker runtime copies `shared/` but
  not `src/`.
- Reuse `shared/attackstats.ts` and `shared/daystate.ts`; do not reimplement
  the 08:00 rule or day-key arithmetic.
- Guard every `diffDayKeys`/day-key consumer with a 4-digit ISO key check, or
  skip the field, so pathological parseable instants cannot throw.
- Capture one `nowMs` per request; use it for `generatedAt`, `today`, history,
  and inventory.
- Reuse/extract the inventory computation; do not fork the stock rules.
- Keep the public response exactly to the contract above; no raw notes,
  painLog, symptoms, triggers, or stored strings.
- `Cache-Control: no-store`.

Steps:

1. Add `shared/status.ts` with the pure builder and `STATUS_API_VERSION = 1`.
   Export the status types for tests/docs.
2. Add `GET /api/status` in `app/server/app.js`; extract
   `computeNurtecStock(db, nowMs)` and use it in both routes; set the cache
   header. The existing `/api/inventory/nurtec` tests must pass unchanged as the
   regression guard for that extraction.
3. Add shared unit tests for the semantics and edge cases below.
4. Add server route tests via `inject()`.
5. Write `docs/home-assistant.md` as the complete handoff contract: endpoint
   reference, semantics, version policy, YAML quickstart, ntfy event path,
   custom-integration blueprint with official doc URLs, recorder/privacy,
   security/deployment, and testing guidance.
6. Update `AGENTS.md` and `README.md`.
7. Run the full verification suite.

Return contract for the worker:

- Summary of behavior and any deviations.
- Exact files changed.
- Exact commands run and their results (do not claim unrun checks).
- Test names added and which behavior each covers.
- Doc URLs cited.
- Remaining risks, especially any unresolved data edge case.
- `needs-user` with a precise question if a product decision is genuinely
  ambiguous; do not guess.

## Test plan (must be in the change)

Shared `app/shared/status.test.ts` with a fixed `now`:

- empty inputs → `no_data`, nulls, zero counts;
- explicit today record wins over an inferred attack day and over a finished
  attack;
- ongoing attack → `attack`, even when today is explicitly `well` or `off`;
- ended attack after 08:00 today → today `off` inferred;
- attack 01:00-02:00 today → counts yesterday, not today (08:00 rule);
- attack crossing 08:00 → both adjacent days count;
- finished attack exactly at 08:00 → previous day only (half-open);
- future ongoing attack → `attack`; no negative duration;
- unparseable start/end → no throw, nulls;
- parseable but out-of-day-key-domain start (e.g.
  `+275760-09-13T00:00:00.000Z`) → no throw, null/absent fields;
- multiple ongoing attacks → deterministic earliest parsed start;
- `lastAttack` chooses the latest parseable start, ongoing or finished, with
  the documented tie-break;
- `daysSinceLastAttackStart` clamps at 0 and is null with no attacks;
- 7/30-day attack-day counts and 30-day started-attack count over the expected
  windows, with multiple attacks deduplicated on one attack day;
- exact window edges (today-6 vs today-7, today-29 vs today-30);
- DST transition inside the 7/30-day windows in a non-UTC zone;
- local-midnight rollover (`23:59:59.999` vs `00:00:00.000` local);
- `peakPain: -1` → null;
- `latestPain` uses the greatest parsed `ts`, normalizes it, and ignores
  malformed entries (this intentionally differs from PartnerHome's raw string
  sort; max parsed time is deterministic);
- naive and offset-bearing attack `start`/`end` inputs normalize to the
  expected canonical UTC instants, with the expected durations. A naive string
  is parsed in the server process's local zone, so derive the expected value
  from `new Date(input).toISOString()` (or pin `TZ`) rather than hard-coding a
  UTC instant, or the test can pass locally and fail on CI;
- `lastAttack` ignores an attack whose start is unparseable and falls back to
  the latest parseable-start attack (null only when none exists);
- lineage: explicit legacy `today.status = "attack"` with no active attack →
  `state: "attack"`, `activeAttack: null`, `today.source: "explicit"`.

Server `app/server/test/status.test.js` via `inject()` and disposable DBs:

- happy-path shape and `apiVersion`;
- empty DB (including `state: "no_data"` and unknown inventory);
- saved `timezone` used; missing/invalid → `UTC` (insert the corrupt setting
  directly, because the PUT route rejects invalid zones);
- non-UTC attribution near local midnight;
- POST ongoing attack → `activeAttack`/`state`/`lastAttack`;
- PATCH end → no `activeAttack`, stable `durationMinutes`, `ongoing: false`;
- empty-string `end` via POST → not ongoing, null duration;
- PUT day state → `today.source = "explicit"`;
- legacy explicit `attack` day state with no active attack → `state: "attack"`,
  `activeAttack: null`;
- multiple ongoing attacks → deterministic pick;
- Nurtec baseline/refill/dose affect inventory, and the overlapping fields
  equal a live `GET /api/inventory/nurtec`;
- response JSON contains no attack `notes`, no `painLog` key/text, and no
  day-state `notes` text;
- `Cache-Control: no-store`;
- GET still works with an `Origin` header (the mutating guard is not involved).

## Verification commands

From `app/`:

```sh
npm test -- shared/status.test.ts
npm test
npm run lint
npm run build
npm run validate:pwa
npm run build:demo
npm run validate:demo
node --check server/index.js
npm test --prefix server
```

Focused server test, from `app/server/`:

```sh
node --test test/status.test.js
```

Backend behavior also needs a disposable-data smoke test per `AGENTS.md`:

- start the server with a fresh `DATA_DIR` and `PORT` outside the repo;
- `POST /api/attacks` an ongoing attack, `GET /api/status`, and verify the
  active/derived fields;
- stop the server and delete the disposable data directory (Windows: close the
  SQLite handle first).

## Definition of done

- `GET /api/status` returns the documented v1 shape and headers.
- All semantics above are enforced by tests, including the 08:00 rule,
  non-UTC/DST handling, pathological instants, and privacy exclusions.
- `docs/home-assistant.md` is sufficient for another session to build the
  Home Assistant integration without asking product questions, and cites
  official Home Assistant docs.
- Full verification passes.
- `AGENTS.md`/`README.md` are accurate and the plan contains final
  implementation notes.
- Independent review completed.

## Risks and open questions for reviewers

- Is the minimal projection (no symptoms/triggers/notes/painLog) the right
  default for a v1 dashboard contract, with `/api/attacks` available for
  detail?
- Is 60-second polling plus the existing ntfy attack topic genuinely sufficient
  for "react to migraine status events", or is a webhook required in phase 1?
- `state == "attack"` can be true with `activeAttack: null` for a legacy
  explicit day record; is the documented "use `activeAttack`" guidance
  sufficient, or should the field be renamed to avoid misuse?
- Does `lastAttack` including an ongoing attack make `daysSinceLastAttackStart`
  less useful than a separate "last ended attack" field? No concrete need has
  been identified; adding it later is additive.
- Home Assistant recorder churn: `generatedAt` is stripped from coordinator
  data, and no per-poll duration field is exposed. Is any further guidance
  needed for Path A/YAML users?

## Implementation notes

Implemented as specified below; no contract field, semantic, or edge case
changed during implementation.

- `app/shared/status.ts` exports `STATUS_API_VERSION = 1`, the document types,
  and the pure `buildStatus(input)` builder. It reads only
  `nowMs`/`timeZone`/attacks/day states/the Nurtec aggregate, imports
  `DayStateStatus` from `src/types` with `import type` only, and is
  erasable-syntax only (the Docker image still needs just `shared/`).
- Reuse, not reimplementation: today's inference calls
  `effectiveDayState` (`shared/daystate.ts`) and `attackCountsAsAttackDay`
  (`shared/attackstats.ts`); the trailing 7/30-day windows are enumerated with
  `addDays`, so DST cannot skip or repeat a day, and only attacks whose parsed
  start exists contribute to `attacksStartedLast30Days` (future starts are
  excluded by the `diff >= 0` bound). `attackCountsAsAttackDay`'s coarse window
  keeps the 30-day scan cheap for normal histories.
- Guarding: `safeLocalDayKey` wraps `localDayKey` and rejects keys outside the
  4-digit domain, so a stored `+275760-09-13T00:00:00.000Z` yields null
  `daysSinceLastAttackStart` and zero counts instead of a `RangeError`.
  `trailingDayKeys` stops (rather than throwing) at the edge of the day-key
  domain. Canonical ordering (parsed start, then id, unparseable starts last)
  is applied once and reused for `activeAttack`, `lastAttack`, and history.
- `activeAttack.latestPain` picks the greatest **parsed** timestamp (`>=` keeps
  the later array element on an exact tie) and normalizes it; malformed entries
  (non-string ts, non-finite level, unparseable ts) are skipped.
- `lastAttack` reports `end: null` while ongoing and never uses the
  `nowMs`-substituted end, so no per-poll duration is exposed and
  `durationMinutes` stays null for ongoing/negative/unparseable ends.
- Inventory: the inline body of `GET /api/inventory/nurtec` was extracted into
  an internal `computeNurtecStock(db, nowMs)` (same queries, same shared
  `currentStock`/`classifyStock` calls, same response fields); both routes call
  it with one captured clock read, so `/api/status` and
  `/api/inventory/nurtec` cannot disagree. The existing inventory tests pass
  unchanged. `buildStatus` reports only the documented six fields and derives
  `level`/`low`/`negative` with the shared `classifyStock` plus the documented
  comparisons, so a future route field cannot leak into the status document.
- Route: `GET /api/status` reads all attacks and day states (the dataset is
  personal-scale), calls `computeNurtecStock`, sets
  `Cache-Control: no-store`, and returns the builder output. It is registered
  next to the inventory route, adds no schema/setting/write path, and is a
  plain `GET` so the existing cross-origin guard does not apply.
- Defensive choices not spelled out in the contract: a stored day status
  outside `well`/`off`/`attack` is ignored (treated as no record) so the
  document only ever exposes the documented enum; a non-finite `nowMs` falls
  back to the epoch and a non-IANA `timeZone` to `UTC` so the builder cannot
  throw on bad input.
- Tests: `app/shared/status.test.ts` covers the empty document, precedence
  (explicit over inferred/finished, ongoing over explicit, legacy `attack`),
  the 08:00 rule (01:00-02:00, crossing 08:00, exact 08:00, night tail), future
  starts, unparseable/empty and out-of-domain instants, multiple ongoing and
  ordering tie-breaks, `lastAttack` selection, peak/normalization, latestPain
  ties and junk, window edges (`today-6/7`, `today-29/30`), DST, local-midnight
  rollover, naive/offset instants, and unknown/garbage inventory.
  `app/server/test/status.test.js` covers shape/apiVersion/header, empty DB,
  saved/corrupt/UTC timezone, non-UTC near-midnight attribution with a pinned
  clock, ongoing POST, ended PATCH, empty-string end, PUT and legacy day states,
  multiple ongoing rows, inventory equality with the live route, privacy
  (notes/symptoms/triggers/painLog absent), pathological instants, and GET with
  an `Origin` header.
- Documentation: `docs/home-assistant.md` is the complete handoff (endpoint
  reference and example payloads, semantics, Path A YAML with availability and
  null-safe lookups, Path B blueprint with official developer-doc links, the
  ntfy event path and its caveats, recorder/privacy/security guidance, and
  testing notes). `AGENTS.md` gained one architecture bullet and `README.md` a
  short Home Assistant section.
- Verification: the full suite from `app/` plus the focused server test and a
  disposable-`DATA_DIR` HTTP smoke test (POST an ongoing attack, GET
  `/api/status`, verify, stop, delete) passed. The suite initially exposed a
  pre-existing test-only bug in `src/pages/CalendarPage.test.tsx`
  (`getByText('—')` matched both the day-state and attack-duration em dashes);
  the test now anchors its future attack at 14:00 local so the only em dash is
  the duration, and the product assertion is unchanged. No product code
  changed. Full suite: 53 files / 765 tests passed. The disposable smoke
  returned HTTP 200, `Cache-Control: no-store`, apiVersion 1, state `attack`,
  and the posted id.
- Final review fixes: a parseable end before the start is still reported as
  `lastAttack.end` (only `durationMinutes` is suppressed); the HA event-entity
  snippet writes state after every `_trigger_event`; diagnostics carry no URL
  or health state; the ended-attack YAML compares the previous active id.
- Not implemented (per scope): the Home Assistant custom component itself, any
  write endpoint, MQTT, a server-push webhook, auth/CORS changes, and any
  schema, frontend, reminder, Docker, or CI change.
