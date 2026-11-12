# Home Assistant custom integration and live rollout

Status: architecture reviewed and revised; ready for implementation. Live tracker update requires a green CI image and the user's NAS update.

## Goal and observable behavior

Implement the Path B custom integration specified in `docs/home-assistant.md`, keep it HACS-layout-compatible for manual installation, test it in CI, install it on the user's Home Assistant OS instance, and configure it against the real tracker after the user updates the tracker image.

The result must provide:

- one UI-configured, read-only connection to `GET /api/status` (API v1);
- a shared Migraine Tracker device with current status, active-attack, last-attack,
  history-count, and Nurtec entities;
- `attack_started`, `attack_ended`, and `status_changed` event-entity transitions
  with the exact dedupe/baseline rules in the handoff;
- polling every 60 seconds by default, configurable from 15 to 3600 seconds;
- reconfiguration, safe diagnostics, and clean unload/reload behavior;
- no write entities, write services, tracker schema changes, or frontend changes.

The binding product/API/entity/event contract is `docs/home-assistant.md`,
especially Path B. The API semantics implemented by commit `958430b` must not be
reimplemented in Python. Explicit corrections to the handoff's illustrative code
are listed below; they preserve the tracker API, entity values, and event
semantics while fixing lifecycle/identity issues, extending the config-flow
surface, and tightening client validation. Update `docs/home-assistant.md` in
the same commit so its Path B code, testing guidance, and this plan cannot drift
back to the superseded patterns.

## Current state and deployment constraints

- Tracker source and `origin/main` began at `958430b`; `/api/status` and its tests
  already exist. The local checkout was clean before this plan.
- The real tracker at `https://migraine.crustaceansoup.com` and direct port 8097
  still return 404 for `/api/status`; the running image predates the API.
- Tracker CI run 43122083172 passed all functional checks and the Docker build,
  but publication was blocked by `npm audit --omit=dev --prefix server`.
  The reproduced audit has three moderate advisories in the `@fastify/static`
  dependency chain (`glob` and `minimatch`) and reports a non-forced
  `npm audit fix` remedy.
- The user explicitly approved repairing CI and pushing this work. Do not use
  NAS shell access. After CI publishes the image, ask the user to update the
  tracker on the NAS; only then perform live HA configuration.
- Home Assistant is Core 2026.11.1 at `192.168.2.226` (Tailscale
  `100.70.169.80`). It has Terminal & SSH and File editor apps but no configured
  HACS integration and no existing Migraine Tracker config entry.
- The HA configuration mirror intentionally ignores `custom_components/`.
  Integration source belongs in this tracker repository. UI-managed HA entry
  metadata must be exported into the HA mirror after installation; real health
  state, credentials, `.storage`, and runtime files must not be committed.
- The HA mirror has unrelated untracked plans `0004-voice-music-targeting.md`
  and `0008-light-word-order.md`; do not include them in commits.

## Required implementation contract

### Files and packaging

Use the handoff's integration layout:

- `custom_components/migraine_tracker/__init__.py`
- `binary_sensor.py`, `config_flow.py`, `const.py`, `coordinator.py`,
  `diagnostics.py`, `event.py`, `manifest.json`, `sensor.py`, `strings.json`,
  `translations/en.json`
- root `hacs.json`

Manifest: domain `migraine_tracker`, name `Migraine Tracker`, version `0.1.0`,
codeowner `@BradyBrenot`, `config_flow: true`, `integration_type: service`,
`iot_class: local_polling`, no runtime requirements, and
`single_config_entry: true`. Documentation and issue links point to this real
GitHub repository. Keep manifest keys in hassfest order.

`hacs.json` needs only `name` and `homeassistant`; omit the handoff's inert
legacy `render_readme` display key. The minimum is HA **2025.8.0**, raised from the
handoff example because implementation uses `OptionsFlowWithReload` (introduced
in 2025.8) to avoid the update-listener/reconfigure incompatibility scheduled to
become an error in HA 2026.12. CI installs
`requirements-homeassistant-dev.txt`, whose
`pytest-homeassistant-custom-component==0.13.375` pin tests Home Assistant
**2026.10.4** — one minor behind the live 2026.11.1 (the deployed series) — so CI
does not test the deployed 2026.11 series; the 2025.8 floor is an
API-compatibility claim by inspection, not a second tested runtime, and
documentation must say so.

This task delivers a manual-install, HACS-layout-compatible repository. A tagged
HACS release, brand submission/assets, Marketplace publication, and HACS
installation itself are explicitly deferred. Do not claim those are complete.

Tests and local/CI Python configuration live under `tests/homeassistant/` plus
clearly named root Python test configuration/dependency files. Add a dedicated
CI job for the component; keep all GitHub Actions pinned to full commit SHAs,
consistent with the existing workflow. Run hassfest where practical. HACS
publication validation is not required while release/brand packaging is deferred.

### HTTP, setup, and options

- Accept only an HTTP(S) base URL. Lowercase scheme/host for normalization and
  unique ID, preserve the path case-sensitively, and normalize trailing slashes.
  Reject malformed URLs, embedded credentials, query strings, and fragments.
  A reverse-proxy base path is allowed, but a path ending in `/api/status` gets a
  dedicated `invalid_url` form error telling the user to enter the base URL;
  never silently append a second `/api/status`. Do not log credentials.
- Config flow validates one `GET {base}/api/status` with a 10-second timeout.
  Distinguish `cannot_connect`, `invalid_response`,
  `unsupported_api_version`, and `unauthorized` (401/403). JSON without
  `apiVersion == 1` is unsupported. Ignore unknown response fields. Reject a
  display `state` outside the four v1 values as an invalid response rather than
  silently creating an HA `unknown` enum state.
- The tracker itself has no auth. To make the handoff's authenticating-proxy
  option actually usable, accept an optional proxy `Authorization` header in the
  initial flow as well as options (an options-only header could never be reached
  after a 401). Use a password selector, store it in `entry.options`, preserve it
  when only the scan interval changes, and never print/commit/export it.
  Reconfigure may retain the current header; options can change or clear it.
- Unique ID is the normalized base URL, as explicitly required by the handoff.
  Re-entering the same normalized URL must abort at the unique-ID check with
  `already_configured`; entering a different URL while the single entry exists
  must abort with `single_instance_allowed`. Translate and test both cases.
  Reconfigure revalidates and updates URL and unique ID while preserving the
  config entry.
- Options store `scan_interval`, default 60; clamp integer input to 15–3600.
  Use `OptionsFlowWithReload` with a no-argument constructor and the
  framework-provided `self.config_entry`; do not assign `self.config_entry`, use
  legacy `OptionsFlowWithConfigEntry`, or use removed `self.options`.
  **Do not register an options update listener.** Reconfigure uses HA's normal
  update-and-reload helper, so it also must not encounter an update listener.
- Setup uses HA's shared aiohttp session, stores the coordinator in
  `entry.runtime_data`, passes `config_entry=entry` to `DataUpdateCoordinator`,
  awaits `async_config_entry_first_refresh()`, forwards `binary_sensor`,
  `sensor`, and `event`, and supports unload. Platforms set
  `PARALLEL_UPDATES = 0` and issue no requests of their own.

### Coordinator and event safety

- One coordinator poll per interval; `always_update=False`.
- Runtime non-200, non-JSON, timeout/connection, unsupported-version, and invalid
  display-state cases become `UpdateFailed`; entities become unavailable. A
  successful recovery compares against the last successful document.
- Fixtures include `generatedAt`; remove it before storing data so identical
  documents suppress entity writes. A second document differing only in
  `generatedAt` must produce no listener/state writes. Never expose it.
- First successful refresh only establishes the event baseline. Setup, HA
  restart, options reload, and reconfigure must not synthesize new transitions.
  The event entity may restore its last historical event state through HA's
  `RestoreEntity`; that is not a new event and must not call `_trigger_event`.
- Compare consecutive successful documents:
  - active ID present and different -> `attack_started` for the new ID;
  - previous active ID -> no active ID, with the same ID now `lastAttack` and
    `ongoing is False` -> `attack_ended`;
  - a deleted/missing/replaced last-attack row fires no end event;
  - display `state` change -> `status_changed`.
- If closing the earliest of multiple ongoing attacks reveals another active ID,
  emit only the documented start for the remaining ID, not a fabricated end.
  If an active attack has an unparseable start, closing it can likewise suppress
  the end event when `lastAttack` is an older/different row; document this API
  limitation instead of weakening the same-ID guard.
- Replace pending events at the start of every poll rather than accumulating
  across polls. The single event entity drains only the latest successful poll's
  events. If that entity is disabled/not listening, those events are discarded,
  never replayed as a burst when it is re-enabled. Queue memory is bounded.
- One poll can produce multiple event-entity events; publish every event with
  `_trigger_event` followed by `async_write_ha_state()`. Tests must capture the
  individual state changes, not just the final timestamp state.
- Polling cannot observe a start+end wholly inside one interval. `status_changed`
  follows display `state`, not every nested `today.status` edit with unchanged
  display state. Document both limitations.

### Entities, naming, and privacy

Use stable entity unique IDs `entry.entry_id + suffix` and
`_attr_has_entity_name = True`. **Correction to the handoff's illustrative
`DeviceInfo`:** use `identifiers={(DOMAIN, entry.entry_id)}`, not the mutable URL
unique ID, so reconfigure cannot create an orphan device. `configuration_url`
contains the current base URL. A reconfigure test must prove one device and
unchanged entity-to-device links. Do not assert literal generated entity IDs
from the handoff tables; assert unique IDs and stability across reload.

Availability is coordinator availability. All ordinary entities read
`coordinator.data` in properties so they are populated immediately after setup;
only the event entity overrides `_handle_coordinator_update` for event draining.

- Active binary sensor: `activeAttack is not None`, never `state == 'attack'`;
  expose only the documented active attack ID attribute.
- Status enum options exactly `attack`, `off`, `well`, `no_data`; `no_data` is a
  valid state, not HA `unknown`.
- Last-attack-start timestamp sensor returns a timezone-aware Python `datetime`
  (or `None`), not a raw string, as required by `SensorDeviceClass.TIMESTAMP`.
- Days-since, attacks-started-30d, attack-days-7d, and attack-days-30d preserve
  integer/null semantics. Do not opt sensitive rolling history into unnecessary
  long-term statistics.
- Nurtec quantity preserves `None` for unknown (never substitutes zero), permits
  negative values, and low/negative binary sensors use the supplied booleans.
  Do not expose inventory `status`/`level` strings as entity states.
- Event entity supports exactly `attack_started`, `attack_ended`,
  `status_changed` and the documented payloads. Its state is an event timestamp,
  not the event type; event type is an attribute.
- Keep attributes minimal; do not dump the raw status document, notes, pain log,
  symptoms, triggers, timezone, or `generatedAt` into recorder-backed entities.
- Diagnostics contain only scan interval, last-update-success, and API version.
  No URL, authorization header, health data, timezone, attack ID, inventory, or
  raw response body.

Translations must cover config/reconfigure/options fields and descriptions,
errors/aborts (including both duplicate reasons), all entity names, status enum
display states, and event names.

## Automated test definition of done

Use `pytest-homeassistant-custom-component` with `aioresponses` or a local
aiohttp test server and synthetic payloads copied from the handoff. Resolve and
record the exact plugin + HA + interpreter triple locally **before writing CI**;
use the interpreter required by that HA package's `Requires-Python`, not an
assumed Python minor. The currently available plugin `0.13.375` requires Python
>=3.14 and pins `homeassistant==2026.10.4`, while live HA 2026.11.1 requires
Python >=3.14.2. Use that locally verified latest-plugin/HA pair unless a newer
matching release appears, and explicitly record the test-vs-live version gap. If
no compatible released plugin existed, the fallback would be the closest
available HA/plugin pair plus live verification, never an unsatisfiable publish
gate. No real health data or credentials in fixtures.

Cover at minimum:

1. Config flow success and URL normalization; actual duplicate abort reason.
2. Connection error, timeout, non-200, non-JSON, missing/unsupported API version,
   malformed URL, and 401/403 behavior.
3. Reconfigure success/failure, unique-ID update, exactly one device, stable
   entity-device links, and options clamps 14->15 and 3601->3600.
4. Authorization header sent when configured, preserved by an interval-only
   options save, clearable deliberately, and absent from diagnostics/logs.
5. First refresh/setup, clean unload/reload, options/reconfigure reload with no
   update listener registered, and `coordinator.config_entry is entry`.
6. Coordinator fixtures include `generatedAt` but stored data excludes it;
   500/non-JSON/timeout/unsupported-version/unexpected-state failures; recovery;
   and a generatedAt-only difference suppresses listener/state writes.
7. Every entity's value, unique ID/device association, translation metadata, and
   availability; entities are populated immediately without a second poll.
8. Empty DB, explicit-well, legacy explicit attack day, active attack, unknown
   stock, low stock, negative stock, and active attack with `start: null` plus an
   older finished attack. Timestamp type/timezone and numeric null versus zero.
9. Event baseline silence; start; same-ID finish; deleted-ID suppression; display
   status change; multiple events in one poll; multiple ongoing attacks; null
   start suppression; restart/reload silence despite state restoration; disabled
   event entity across transitions does not replay on re-enable; failed polls do
   not move the baseline and recovery emits only the latest real transition.
10. Diagnostics contains exactly the operational allowlist.
11. All HTTP mocks prove the integration only performs GET requests.

Also run formatting/lint/static syntax checks, JSON validation, and hassfest
where available, plus the complete existing tracker suite so the CI repair cannot
regress the app.

## CI audit repair and image smoke coverage

Make the minimal dependency-lock update needed for the reproduced non-forced
`npm audit fix` in `app/server`. Inspect resulting versions and diff; do not use
`--force`, add unrelated upgrades, disable/skip the audit, or suppress an
advisory without explicit review. Re-run server tests, both production audits,
and the full existing verification commands.

Strengthen the existing image smoke test before publication:

- GET `/api/status` from the disposable container and assert HTTP 200,
  `"apiVersion":1`, and `Cache-Control: no-store`;
- extract a built `/assets/*.js` URL from the writer HTML and assert it returns a
  non-empty 200 response, covering the `@fastify/static`/glob upgrade path;
- retain existing health, writer, and partner checks and cleanup traps.

The new Home Assistant CI job must pass before `Publish image` runs
(`publish.needs` includes it), so the single accepted CI run proves both the
image and component. Keep the existing app verification job intact.

## Verification commands

Feature Lead must run applicable commands from the repository root or specified
working directory and report exact results:

- Python environment setup from pinned development requirements, then
  `python -m pytest tests/homeassistant -q`.
- Configured Python formatter/linter checks, plus
  `python -m compileall -q custom_components/migraine_tracker`.
- JSON parse checks for manifest, strings, translations, and `hacs.json`.
- Hassfest command actually available; report unavailable checks rather than
  claiming success.
- From `app/`: `npm test`, `npm run lint`, `npm run build`,
  `npm run validate:pwa`, `npm run build:demo`, `npm run validate:demo`,
  `node --check server/index.js`, `npm test --prefix server`,
  `npm audit --omit=dev`, and `npm audit --omit=dev --prefix server`.

After independent review and coordinator acceptance, commit approved files.
**First push a feature branch** as explicitly authorized and watch the new job
and existing verification job; `publish`/`pages` are main-gated, so this proves
the new Python environment and workflow wiring without stranding the image.
Only after that branch run is green, fast-forward/push `main` and watch the full
run. The root Python job must override the workflow's existing `app` working
directory for checkout-root commands. Do not claim image publication until
`Publish image` succeeds.

## Live rollout and acceptance

1. Ask the user to update the NAS only after the complete CI run is green and
   `Publish image` succeeds.
2. From the **Home Assistant host** (Terminal & SSH, not NAS shell), verify DNS,
   route, HTTP 200, `apiVersion: 1`, and `Cache-Control: no-store` for the chosen
   tailnet tracker URL. A laptop-only success is not proof HA can reach it.
   Record the URL form used. Do not call any write endpoint against real data.
   If an independent off-tailnet probe is available, also verify the unauthenticated
   endpoint is not publicly reachable; if public exposure is found, stop and
   escalate. Do not claim an off-tailnet check that the environment cannot perform.
3. Install exactly the reviewed `custom_components/migraine_tracker` files on HA
   through Terminal & SSH, with a targeted rollback copy if any prior component
   unexpectedly exists. Record source commit and installed file hashes. Do not
   alter other custom components or HA YAML.
4. Run HA config check before the required HA restart. Restart only after the
   reviewed component is staged; verify HA returns cleanly and inspect component
   errors. No safe-mode restart and no Core/OS/app upgrade.
5. Add `migraine_tracker` through its actual UI config flow using the verified
   base URL and default 60-second interval. Verify loaded entry/device/entities,
   values against a sanitized status projection, immediate initial values,
   diagnostics, and logs.
6. Exercise options and safe coordinator recovery. Reconfigure may be tested only
   with the same valid normalized URL unless a separate disposable endpoint is
   explicitly set up; never point production at an unverified endpoint. The final
   report must explicitly say URL-change device identity and reconfigure behavior
   are automated-test-only, not live-verified. Do not create, edit, or end a real
   attack merely to manufacture an event; transition behavior is proven by
   automated HA fixture tests and disposable tracker.
7. Export UI-managed metadata into `homeassistant/exports/` using supported MCP
   read tools, never `.storage`. Use an explicit allowlist: domain, title, source,
   entry version/state, device/entity names, platforms, generated entity IDs, and
   entity unique-ID **suffixes** only. Omit entry `data`, `options`, URL unique
   IDs, authorization values, device configuration URL, health states, and
   attributes. If a safe field cannot be read, say so rather than dumping storage.
8. Document the rollout and privacy limitation (HA recorder retains states/event
   attributes unless the user later chooses exclusions), sync mirrored files,
   review the diff, and commit only intended files in the HA mirror. Commit
   source/docs separately in the tracker repository.
9. Report any unperformed live check explicitly. Do not add dashboards,
   automations, ntfy subscriptions, recorder exclusions, or unrelated HA changes.

## Explicit out of scope

- Changes to API semantics, schema, writer frontend, reminders, weather, ntfy,
  deployment architecture, or the tracker's private-network security model.
- A server-push webhook, extra raw-history endpoints, write actions, dashboards,
  notification automations, or recorder policy changes.
- Tagged HACS releases, brand/Marketplace publication, HACS installation,
  Core/OS upgrades, unrelated dependency upgrades, unrelated HA fixes, or real
  tracker data mutations.
- NAS shell access (explicitly declined by the user).

## Review-derived corrections to the handoff examples

- `OptionsFlowWithReload` replaces the handoff's update listener, avoiding the
  reconfigure/update-listener warning and HA 2026.12 breakage.
- `config_entry=entry` is passed to the coordinator explicitly.
- Device identity uses `entry.entry_id`, not the mutable URL unique ID.
- Optional proxy authorization is available during initial setup as well as
  options, because otherwise a 401 prevents entry creation.
- Pending events are per-poll, not an unbounded cross-poll queue.
- Unexpected display-state values fail the poll instead of silently becoming HA
  `unknown`.
- HACS metadata uses current keys; release/brand publication is not claimed.

## Rollback and risks

- Tracker image rollback follows `DEPLOY.md`; the API change has no schema
  migration. The user controls the NAS update/rollback.
- HA component rollback is remove/disable the config entry, restore/remove only
  `custom_components/migraine_tracker`, config-check, and restart. No YAML or
  shared component is changed.
- Poll-based transitions can miss an attack starting and ending between polls;
  existing ntfy remains optional and unchanged.
- Multiple ongoing attacks expose only the canonical active one; event behavior
  follows the handoff rather than pretending to reconstruct the full set. An
  active attack with null start can suppress its later end event by design.
- Health states are sensitive. HA recorder retains entity states and event
  attributes by default. Keep logs, diagnostics, exports, fixtures, commits, and
  reporting minimal and free of real attack details.

## Implementation notes (2026-11-12, post-verification)

Implemented and locally verified. Commit/push and the feature-branch-first
rollout remain with the coordinator per this plan's verification section; these
notes record implementation state, not a publication claim.

- **Resolved toolchain (verified against PyPI and a live install):**
  pytest-homeassistant-custom-component 0.13.375 (latest; Requires-Python
  >=3.14) pins homeassistant==2026.10.4 (Requires-Python >=3.14.2); local and
  CI interpreter is Python 3.14.x; ruff 0.17.4. No HTTP mock library is pinned:
  `aioresponses` was removed in the correction pass because it is broken
  against the aiohttp 3.14.5 the plugin pins, and nothing imports it; HTTP is
  mocked with the plugin's own `aioclient_mock`. **Recorded gap: tests run HA
  2026.10.4, live instance is 2026.11.1** (no plugin release pins 2026.11.x
  yet). The HA test harness is POSIX-only (`homeassistant.runner` imports
  `fcntl`), so pytest cannot run on native Windows; local runs used a Linux
  container with the pinned requirements and CI runs `ubuntu-latest`.
- **Integration** lives at `custom_components/migraine_tracker/` (package plus
  `translations/en.json`) plus root `hacs.json`, per this plan's layout and
  manifest/hacs contracts. One deviation in mechanism, not behavior: HA 2026.10
  replaced voluptuous with probatio but keeps `import voluptuous` aliased
  (`probatio.compat.install_as_voluptuous`), so the config flow imports
  `voluptuous` *after* homeassistant — valid on both the declared 2025.8 floor
  and the tested 2026.10 — instead of importing probatio directly.
- **Tests** (`tests/homeassistant/`): 205 tests, all passing, covering all 11
  categories of the test definition of done. Read-only coverage is layered: root
  `conftest.py` declares `pytest_plugins` so the bare `python -m pytest -q`
  collects the suite from the repository root; an autouse guard in
  `tests/homeassistant/conftest.py` rejects any non-GET or non-status URL
  recorded by `aioclient_mock`; and tests that drive a recording fake session
  assert the method and URL of every recorded call.
- **Final-review corrections applied in this pass:** root conftest/bare
  `python -m pytest -q`; `aioresponses` removed from
  `requirements-homeassistant-dev.txt`; entity display names shortened to
  Status, Active attack, Last attack started, Days since last attack, Attack
  days last 7/30 days, Attacks started last 30 days, Attack event (Nurtec names
  unchanged); `apiVersion` must be the exact JSON integer `1` (`true`, `1.0`,
  `"1"`, and missing are rejected); new `invalid_authorization` validation and
  translations for config, reconfigure, and options (control characters and
  characters that cannot be encoded as Latin-1 — anything above U+00FF, e.g. an
  emoji — rejected; tab, spaces, and Latin-1 obs-text allowed; no request,
  no entry change or reload); invalid/non-numeric/out-of-range port rejected as
  `invalid_url` before any request; `allow_redirects=False` with a 3xx treated
  as `invalid_response`; JSON `ValueError` handling narrowed to
  `response.json()`; options flow no longer passes `title=""`; diagnostics
  tolerate a missing `runtime_data` after unload and report the retained failed
  coordinator during setup retry (same three keys,
  `last_update_success: false`, `api_version: null`); a corrupt stored
  header becomes an `UpdateFailed` about the invalid stored authorization
  without logging the value; and new tests cover same-normalized-URL
  reconfigure, unknown additive fields, and the A-ends/B-starts-between-polls
  limitation (only `attack_started` for B).
- **Verification run by the Feature Lead on the final tree:** pytest 205 passed;
  ruff check + format --check clean; compileall clean; manifest/strings/
  translations/hacs JSON parse clean; hassfest green via the official
  digest-pinned container (`ghcr.io/home-assistant/hassfest`, `Integrations: 1,
  Invalid: 0` — hassfest is not on PyPI and not shipped in the homeassistant
  wheel); from `app/`: npm test (765), lint, build, validate:pwa, build:demo,
  validate:demo, node --check, server tests (228), and both production audits
  (0 vulnerabilities) all exit 0.
- **CI audit repair (lockfile-only, non-forced):** @fastify/static 10.1.7 →
  10.1.10, glob 13.0.6 → 14.0.5, minimatch 10.2.6 → 11.0.8 (plus @fastify/send
  4.2.1, path-scurry 3.0.0, brace-expansion 5.0.13); `app/server/package.json`
  unchanged.
- **CI:** new `homeassistant` job runs from the checkout root (bare
  `python -m pytest -q`, ruff check/format, compileall, JSON validation,
  hassfest); `Publish image` needs `verify` + `homeassistant`; the publish smoke
  test additionally asserts `/api/status` 200 + `"apiVersion":1` +
  `Cache-Control: no-store` and serves a non-empty built `/assets/*.js` from the
  writer HTML. Verification triggers are `push` to `main` and `feature/**`,
  `pull_request` to `main`, and `workflow_dispatch`; a feature-branch push runs
  `verify` + `homeassistant` without publishing, while `publish` and `pages`
  still require `refs/heads/main`. actionlint reports one pre-existing finding
  (`queue: max`) also present at HEAD.
- **Docs:** `docs/home-assistant.md` Path B rewritten as implemented (no
  superseded lifecycle/device/event patterns), README Home Assistant section and
  AGENTS.md Python workflow added, including the version gap and limitations
  (null-start end suppression, multiple ongoing attacks, in-one-interval misses,
  `status_changed` display-state semantics, recorder sensitivity).
