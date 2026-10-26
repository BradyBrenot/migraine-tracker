# Wellness tracking, installable app, inventory, and reminders

## Goal and user-visible behavior

Extend the existing migraine tracker without weakening its dark, low-friction mobile UI:

- Log **Well / Off / Attack** as a broad daily state. Off intentionally covers prodrome-like feelings, poor sleep, recovery, and other reduced days; no predictor or diagnosis.
- Log **Strength / Cardio** with **Low / Medium / Hard** effort in two taps. Off-day mobility may be tracked separately. Weekly goals are **2 strength and at least 3 cardio**, Sunday through Saturday in the configured timezone.
- Show user-centered exercise guidance based on the agreed routine: Well = normal session; Off = 10-minute light walk or mobility; Attack = rest and no exercise nagging. This is not medical recommendation logic.
- Install the app from mobile Chrome at `https://migraine.crustaceansoup.com` using a manifest and icons. The first PWA version is online-only and needs no service worker.
- Track Nurtec tablets on hand using an explicit starting/correction count, new dose tablet counts (default 1), and refill quantities (default pack of 8). Show remaining stock next to the existing rolling-use badge.
- Send server-side ntfy reminders for preventive doses, low stock, daily state check-in, and behind-goal exercise. Support configured timezone and waking hours, initially 09:00-21:00. Redeliver missed reminders when still relevant without duplicate or stale spam.
- Keep five bottom-navigation tabs, preserve quick attack/med logging, and put historical/detail workflows in History, Calendar day details, and Settings rather than adding charts or more primary controls to Home.

## Existing context and constraints

- `app/`: React 19, TypeScript, Vite 7, Tailwind/shadcn; no frontend test runner currently.
- `app/server/`: plain ESM JavaScript, Fastify, Node 24 `node:sqlite`; separate package and lockfile; no test script currently.
- `app/src/lib/store.tsx`: central client state, localStorage cache, initial hydration, and fire-and-forget API writes. Offline local records can currently be overwritten by a later nonempty server snapshot. Some writes rely on eager execution of React state updaters.
- `app/server/index.js`: all DDL, routes, mappers, backup, static serving, and startup. Existing DBs have no `PRAGMA user_version` migration history. API bodies are largely unvalidated.
- `app/src/lib/format.ts`, `store.tsx`, `CalendarPage.tsx`, and `Reports.tsx`: local-day and UTC-day calculations are inconsistent; fixed 24-hour arithmetic is not suitable for local reminder/week boundaries.
- `app/src/pages/Home.tsx`: already dense. New quick actions must be compact and preserve existing actions, including Past attack and Past med.
- `app/src/pages/History.tsx`: existing Attacks / Medications / Rx pickups tabs; workout history belongs here without changing bottom navigation.
- `app/src/pages/CalendarPage.tsx`: preventive due-date logic is currently client-only and must be shared with server reminders rather than duplicated.
- Existing refills have date and free-text notes only; existing med doses are free text. Historical quantities are unknowable and must not be inferred.
- Existing backup/export/import/reset/hydration paths hardcode attacks, meds, refills, and settings. Every new persistent record type must be handled deliberately in all applicable paths.
- API is unauthenticated by design and must remain Tailscale-only. ntfy URL/token are server secrets and must never enter client settings, exports, backups, logs, or browser code.
- Root `AGENTS.md` commands and data-safety rules apply. Use disposable `DATA_DIR` values outside the repo. Do not access production data or send real notifications.
- Existing `DEPLOY.md` and Docker/Compose deployment remain the operational source; update them for the HTTPS hostname and new environment configuration.

## Architecture

Keep React + Fastify + SQLite and one container. Make targeted module boundaries rather than rewriting:

- Server: separate database/migrations, app/route construction, backup, domain services, and process startup enough to support Fastify `inject()` tests without opening a port.
- Shared logic: small pure modules usable by both Vite and Node 24 for local-day/week, preventive due dates, workout targets, and inventory calculations. If using shared TypeScript, use only erasable syntax supported by Node 24 and include/copy it in both tsconfig and Docker inputs; plain JS plus types is also acceptable.
- Frontend: retain `useStore()` as the public interface while splitting domain helpers/components as needed. Do not introduce a second state framework.
- Validation: validate existing and new server write bodies with Fastify schemas or a small explicit validation layer. Preserve valid legacy payloads.
- Tests: add Node's built-in runner for server/shared behavior and Vitest for frontend pure logic. React component/E2E infrastructure is not required unless a builder identifies a high-value focused use.
- PWA: static manifest/icons only in the initial version. Do not cache `/api`; no service worker, Web Push, background sync, or automatic mid-form reload.
- Reminders: scheduler logic must be pure/testable with injected clock and ntfy transport. Runtime may use a minute interval and built-in `fetch`; no external cron service is needed.

## Persistence and compatibility requirements

- Add `PRAGMA user_version` migrations. Existing installations start at version 0 and must migrate non-destructively. Test upgrades from a representative current-schema DB, not only fresh databases.
- Version export/backup envelopes while accepting legacy unversioned imports. Existing `/api/import` remains additive and `INSERT OR IGNORE`; do not silently turn it into replace/upsert.
- Include workouts, day states, inventory counts/quantities, reminder-safe settings, and any other user data in export/import/nightly backup/client hydration/reset as applicable. Secret config and delivery bookkeeping are not user backup content.
- Preserve existing attacks, meds, refills, rules, doses, planned dates, localStorage data, CSV import, and current route behavior.
- Update `DEPLOY.md` with accurate backup/restore instructions; do not claim the CSV UI restores JSON. A new JSON-restore UI is optional and not required by this plan.
- Use full ISO timestamps for instants and local `YYYY-MM-DD` only for day-level records. Store an IANA timezone in non-secret settings; initialize it from the browser when absent and allow editing in Settings.

## Feature details and edge cases

### 1. Reliability and tests

- Make failed backend writes visible as an unsynced state; remove console-only failure handling.
- Persist enough dirty/divergence state to avoid silently replacing unsynced local changes on hydration. When safety is uncertain, preserve local data and require an explicit choice; offer local JSON export before replacing it with server data.
- Do not implement a naive merge by IDs: deletions have no tombstones and records would be resurrected. Full offline outbox/tombstones is explicitly deferred.
- Compute backend payloads outside React state-updater callbacks; do not depend on eager updater execution.
- Add canonical local-day and Sunday-week helpers and use them for new behavior. Correct existing UTC/local usage-day disagreement where practical without unrelated report rewrites.
- Test migrations, legacy import compatibility, backup/export inclusion, validation, sync divergence helpers, and date boundaries.

### 2. Installable mobile shell

- Manifest: `id`/`start_url`/`scope` `/`, name/short name, `display: standalone`, dark background/theme, 192 and 512 PNG icons plus maskable artwork.
- Add matching HTML theme metadata and dark launch colors. Preserve root hosting and Fastify SPA fallback through Caddy.
- Add bottom-nav safe-area padding and reduced-motion handling for ping/pulse animations.
- Verify production-built manifest/icons/deep links through the real server with disposable data. On-device Chrome installation remains a deployment acceptance check.

### 3. Workouts and day state

- Workout fields: id, performed-at timestamp, kind (`strength`, `cardio`, `mobility`), effort (`low`, `medium`, `hard`), optional duration minutes/notes/source. Mobility does not count as strength or cardio.
- Day state: one upserted record per local date with `well | off | attack`, optional notes, and updated-at timestamp. An attack day may default to Attack from existing attack records; explicit day-state changes must remain possible.
- Home: compact day check-in that collapses after selection; compact Strength/Cardio buttons with Sunday-week counts. Type then effort logs immediately and supports Undo. Do not require duration, date, or notes.
- Guidance text: Well = normal routine; Off = light walk/mobility and counts as following the plan; Attack = rest and no exercise prompt. Light walking counts as low-effort cardio; mobility counts only as mobility/plan adherence.
- History: add/edit/delete past workouts, including optional details. Calendar day details: show day state and textual workout/effort information. Do not add a sixth main tab or Home charts.
- Handle DST, backdated entries, edits/deletions crossing weeks, explicit Off/Attack on the same day, and empty weeks.

### 4. Nurtec inventory

- Add nullable structured quantities; do not parse historical free text. New Nurtec doses default to 1 tablet and new Nurtec refills to 8, both editable. Other medication behavior remains unchanged.
- Add dated absolute stock baseline/correction records. Before a baseline, display `stock not set`, never zero.
- Current stock = latest applicable baseline + later known refill quantities - later known dose quantities. Define effective-time behavior so backdated events before the baseline do not decrement/increment current stock. Same-day corrections and backfills must be documented and covered by tests.
- Recompute after editing/deleting post-baseline doses/refills. Server calculation is authoritative; client may update optimistically.
- Allow negative calculated stock as a reconciliation warning and provide a manual correction workflow; never clamp to zero.
- Default low-stock threshold is 2 tablets, editable. Alert once when crossing into low stock and re-arm only after replenishment above the threshold/reset condition.
- Keep existing refill-cadence reporting and additive imports intact.

### 5. ntfy reminders

- Environment only: `NTFY_URL` (full topic publish URL), optional `NTFY_TOKEN`, and public app URL for click links. Never expose or back up these values. Tests use fake transport only.
- Non-secret Settings: IANA timezone, waking start/end, reminder enable toggles/times, and low-stock threshold. Initially waking 09:00-21:00, daily/exercise grace about 2 hours, low-stock 2.
- Reminder types: planned/automatic Emgality/Botox due; low Nurtec stock; daily missing day-state check-in; behind-goal Sunday-week exercise. Attack suppresses exercise prompts; Off gets gentle light-option wording. Met goals suppress exercise prompts.
- Persistent occurrence/delivery records prevent duplicates across restarts. Failed sends retry with backoff. If a transient daily/exercise occurrence is beyond its grace period, mark it skipped. Persistent conditions such as low stock/overdue preventive remain eligible until one successful send, only during waking hours.
- Do not send reminders while outside waking hours. Resume at the next valid waking time if still relevant. Test DST, midnight/week rollover, downtime, restart, failed fetch, non-2xx response, and condition disappearing before retry.
- ntfy delivery is not proof the phone displayed a message; status wording must not claim end-to-end acknowledgment.

## Explicit out of scope

- Native apps, Web Push, service-worker offline support, durable outbox/tombstone sync, multi-user auth, or changing the Tailscale security model.
- Migraine/prodrome prediction, automated medical advice, Train As One integration, or causal exercise claims. Next-day correlation reports are deferred.
- Production deployment, production-data migration, real ntfy credentials/messages, Cloudflare/Caddy changes, and on-device installation performed from this checkout.
- Broad UI redesign, framework/database replacement, pagination/performance rewrites, and unrelated template cleanup.

## Implementation checkpoints

1. **Server/test foundation:** app factory, migrations, validation, versioned export/backup compatibility, Node tests.
2. **Frontend reliability/date foundation:** Vitest, sync failure/divergence protection, shared date helpers, existing API compatibility.
3. **Installable shell:** manifest/icons/theme/safe-area/reduced-motion and production smoke coverage.
4. **Workouts/day state:** migrations, routes, export/backup/reset, store, two-tap Home, History/Calendar, unit/API tests.
5. **Nurtec inventory:** structured quantities, baseline/corrections, calculation/UI/tests.
6. **Reminders:** shared rules, settings UI, persistent scheduler/delivery state, fake-ntfy tests, deployment docs.
7. **Final review:** independent security/persistence/concurrency review, full verification, actual diff audit, and documented manual deployment acceptance steps.

Checkpoints are sequential. Each must pass its focused checks and coordinator diff review before dependent work begins. Small test/documentation corrections may be included in the relevant checkpoint; do not expand scope silently.

## Definition of done

From a clean install in `app/` and `app/server/`, all applicable commands must pass:

```sh
cd app
npm ci
npm ci --prefix server
npm run lint
npm run build
npm test
node --check server/index.js

cd server
npm test
```

Also required:

- Focused server tests run against temporary/disposable databases and cover upgrade from the pre-migration schema.
- Production-build smoke test serves SPA deep link, manifest/icons, health, and affected APIs without real data.
- No test starts a persistent server on a fixed port, writes under `app/server/data`, or sends real ntfy traffic.
- `git status` shows only intentional source/docs/config changes and no databases/backups/exports.
- Final independent review findings are resolved or explicitly reported.
- Manual deployment acceptance notes cover HTTPS mobile-Chrome installation, Tailscale-only access, a real database backup before migration, ntfy configuration, and one controlled notification test by the user.

## Required builder return contract

Every implementation builder must return:

1. **Status:** completed or blocked, with exact reasons.
2. **Goal/scope covered:** intended behavior and files changed.
3. **Implementation notes:** interfaces/migrations/compatibility decisions and any deviations.
4. **Verification:** exact commands actually run and their observed results; distinguish unit, build, lint, typecheck, and smoke checks. Never claim unrun checks.
5. **Focused test evidence:** important edge cases covered and outputs.
6. **Remaining risks/questions:** unresolved behavior and recommended follow-up.
7. **Working-tree note:** intentional files and any unexpected/pre-existing changes left untouched.
