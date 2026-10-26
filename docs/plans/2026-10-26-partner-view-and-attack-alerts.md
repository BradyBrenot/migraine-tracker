# Partner read-only view and attack alerts

## Goals and binding product decisions

1. A partner-facing read-only interface at `/view` with four tabs: Now, Calendar, Reports, and History. It shows current state and automatically refreshes. Settings, imports/exports, editing, deletion, quick logging, and other mutations are absent.
2. The read-only view is accidental-edit protection within the existing private Tailscale deployment, not authentication or authorization. The unauthenticated API and tailnet security boundary remain explicitly documented.
3. Immediate ntfy notifications for attack start and attack end on a separate attack-alert topic. Existing personal reminders stay on their existing topic. End alerts include duration when valid. No pain, medication, notes, symptoms, or other details are included.
4. Commit the read-only view and attack alerts as separate accepted checkpoints.

## Current state

- `StoreProvider` owns local optimistic mutations, first-contact upload, sync writes, and localStorage persistence. It is not safe to reuse unchanged for a viewer.
- Existing Calendar/Reports/History computations are useful, but those pages also contain mutation affordances.
- The server has persistent `reminder_occurrences` delivery bookkeeping, bounded retries, startup recovery, a one-minute scheduler, and a secret-safe ntfy transport. Current delivery is gated by personal reminder settings and waking hours.
- Attack routes currently only write records. There is no attack-event notification path.
- The API is intentionally unauthenticated and intended only for a private Tailscale network.

## Checkpoint 1: read-only partner view

### Architecture

- Add a dedicated `ReadOnlyStoreProvider` compatible with the existing `useStore()` consumer contract. It starts from empty in-memory state, fetches `/api/export`, maps the snapshot with the existing snapshot conversion, and refreshes periodically without overlapping requests.
- It must never read/write the normal localStorage cache or sync metadata, perform first-contact upload, enqueue mutations, or change settings. Mutation methods defensively reject if a missed UI path invokes them.
- The normal provider must not mount around `/view`; route provider composition must ensure only the read-only provider is active there.
- Add a PartnerLayout with Now/Calendar/Reports/History and a visible Read only indicator. No Settings link.
- Add a dedicated read-only Now page for current attack/day/workout/med state. It has no mutation controls.
- Reuse Calendar/Reports/History where practical, with `readOnly` exposed through the store contract and mutation controls/dialogs omitted. Navigation, date selection, tabs, and report period selection that only change local presentation may remain; download/export actions are omitted.

### Safety and edge cases

- A fresh browser with existing normal-app local data must not upload or mutate it from `/view`.
- Refresh replaces viewer state with the canonical server snapshot; viewer failures show stale/unavailable state without dirty/diverged writer semantics.
- Active attacks and 0-pain attacks render correctly. Current state should refresh about every 15–30 seconds and on visibility/focus where practical.
- All edit/add/delete/refill/workout/med/day-state/settings/import/reset/download actions are absent, not merely visually obscured while remaining keyboard-accessible.
- Desktop/mobile navigation and horizontal overflow match the main app's responsive expectations.

### Definition of done

- Unit/integration tests prove snapshot reads and refresh, no writes/localStorage side effects, four read-only tabs, missing mutation controls, and current-state rendering.
- Browser tests at desktop and mobile inspect all four tabs, automatic/current-state behavior, no editing controls, no horizontal overflow, and no console errors.
- Full verification from `app/`: `npm test`, `npm run lint`, `npm run build`, `npm run validate:pwa`, `npm test --prefix server`, `node --check server/index.js`.
- Independent review, disposable-data GUI smoke, cleanup, and a feature commit.

## Checkpoint 2: attack start/end ntfy alerts

### Configuration and privacy

- Add environment-only `NTFY_ATTACK_URL` and optional `NTFY_ATTACK_TOKEN`, using the same strict validation and secret handling as the personal ntfy configuration. Never persist, export, back up, or log them.
- Reuse `PUBLIC_APP_URL` for an optional `/view` click link; do not put credentials in URLs.
- Document separate ntfy topic subscription, immediate start/end behavior, privacy tradeoffs of hosted ntfy, and phone-side DND/battery limitations.
- No real notifications in development/tests; all network behavior uses injected fakes.

### Delivery behavior

- Reuse persistent occurrence/delivery machinery rather than fire-and-forget. Add attack event types and route them to the attack transport, independently of personal reminder preferences and waking-hour gates.
- Start and end have deterministic keys based on attack ID. Repeated pain/detail PATCHes do not resend. Retry/backoff and interrupted-delivery recovery apply. Attack alerts bypass waking hours.
- First enablement must establish a baseline and never emit alerts for historical attacks. Existing pending alerts survive restart. New attacks after the baseline alert on insert; newly ended attacks alert on transition to a non-null valid end. End duration is computed only from valid timestamps.
- API attack writes trigger a scheduler tick for near-immediate delivery; the interval remains a fallback. Disabled configuration creates no attack transport/timer.
- Deleting or changing an attack before delivery must not send a stale/contradictory alert; send-time relevance checks re-read current rows.
- Internal occurrence state remains excluded from export/import/nightly backup and cleared by reset as existing reminder state is.

### Definition of done

- Unit/server tests cover config validation/secrets, historical baseline, start/end dedup, end duration, immediate routing, waking-hour bypass, retry/recovery, deleted/changed stale events, reset exclusion/clearing, and disabled behavior.
- Disposable API smoke with an injected/fake local ntfy receiver verifies actual POST/PATCH attack routes produce the expected separate-topic publish behavior; no real ntfy messages.
- Full standard verification, Docker build if configuration/wiring changes, independent review, deployment documentation, cleanup, and a separate feature commit.

## Out of scope

- Authentication, roles, public exposure, account management, Web Push/service workers, remote write access for the partner, and real notification delivery.
- Notification content for pain, medications, symptoms, notes, or frequent ongoing updates.

## Implementation notes (checkpoint 1)

- `ReadOnlyStoreProvider` was added beside `StoreProvider` in `app/src/lib/store.tsx`. It starts from the in-memory empty-state factory, fetches `/api/export` through `api.exportAll()`, and maps the snapshot with the existing canonical conversion. It never reads or writes the writer localStorage keys, never uploads on first contact, and never queues a write. Refresh is single-flight (in-flight ref guard) every 20 seconds and on window focus / visible `visibilitychange`; a failed refresh keeps the last successful snapshot and reports `error` without dirty/diverged writer latches. Every mutation on this store throws synchronously; the async conflict-resolution method returns a rejected promise.
- `StoreApi` now exposes `readOnly`, and the normal provider always reports `false`.
- `app/src/App.tsx` composes providers per route tree: `/view` and `/view/*` mount only `ReadOnlyStoreProvider`; every other route mounts only `StoreProvider`.
- `PartnerLayout` provides Now/Calendar/Reports/History navigation, a visible Read only badge, and a Live/Updating/Stale/Unavailable freshness indicator, with no Settings link or Toaster. `PartnerHome` is a dedicated read-only Now page (active attack or calm state, today's day state/meds/workouts, Nurtec stock and 30-day use) with no mutation controls.
- Calendar/Reports/History read `readOnly` and omit mutation affordances in the viewer: schedule and attack-edit controls are not rendered (day-sheet attack summaries become non-interactive elements), the entire report span/download group is omitted because the span selector only feeds that omitted download, and History's add/edit/delete controls and dialogs are not mounted. Month navigation, day selection, tab switching, charts, and lists remain.
- Tests cover snapshot mapping/refresh/no storage side effects/mutation rejection, the four partner tabs and route composition, the Now page's current-state rendering, and the shared pages' read-only surfaces.
- Checkpoint 2 (attack start/end ntfy alerts) is **not implemented** in this change.

## Implementation notes (checkpoint 2)

- `app/server/reminder-config.js` now factors the topic URL/token validation into one private helper shared by `resolveReminderConfig` (byte-identical reasons/behavior) and the new `resolveAttackConfig` for environment-only `NTFY_ATTACK_URL` / `NTFY_ATTACK_TOKEN`. `attackViewUrl(publicAppUrl)` returns `<base>/view` (or null), and a malformed `PUBLIC_APP_URL` only disables the click link.
- Attack alerts are event-driven, not tick-generated. `app/server/reminders.js` exposes `noteAttackWrite({ before, after })` (synchronous, DB-only, never throws to the caller, no-op without an attack transport) and records two occurrence types in the existing `reminder_occurrences` table. Keys are dedup tokens only: `attack_start:<attackId>:<raw start>` and `attack_end:<attackId>:<raw end>`; the attack id is stored in `med_id`, the event instant string in `scheduled_at`, and `expires_at` is `event instant + ATTACK_RETRY_WINDOW_MS` (24 hours). An alert still undelivered 24 hours after the event is skipped as `expired` through the existing generic expiry path instead of being retried forever; personal preventive/stock rows keep `expires_at` NULL. No schema migration.
- Event policy: a start alert is recorded only for a genuine insert (`before === null`); an end alert only for a null/absent -> non-null `end` transition (including a fresh POST carrying an end). A stored empty-string `end` counts as absent for that transition, because the API accepts any string end, so `end: ''` -> a real end still alerts once. Correcting an existing non-null end enqueues nothing. The **freshness rule** at enqueue time is `now - 60min <= t <= now + 5min` (both bounds inclusive; `ATTACK_PAST_WINDOW_MS` / `ATTACK_FUTURE_WINDOW_MS` exported), so historical records, backfills, imports, and first enablement never alert while delayed retries and small clock skew still do.
- Routing: the engine takes `transport` and `attackTransport` (at least one required; either may be null). Personal rows keep their existing type/master-switch/waking-hour gates, are never generated at all without a personal topic (an attack-only deployment performs no personal reminder work), and are suppressed whenever the personal master switch is off or no personal transport exists: those rows are left pending, never sent, and never skipped or expired (the suppression check runs before the expiry check, so a disabled master switch cannot burn transient rows). Attack rows ignore the personal master switch and are left pending when the attack transport is absent. Send-time relevance re-reads the current `attacks` row by `med_id` and requires the event instant to still match, so deleted/changed attacks are skipped as `condition_gone` instead of sending stale alerts. Shared claim/backoff/recovery bookkeeping is unchanged.
- Pending selection runs two per-class queries (attack types, then every non-attack type), each bounded by its own `MAX_PER_TICK` budget and ordered by `scheduled_at, key`, with the attack batch processed first. Due-but-suppressed personal rows therefore cannot fill the window and starve attack delivery, while a personal-only engine selects exactly the same rows as before.
- Messages contain only the event time in the settings timezone plus (for an end event with a valid, non-negative interval) a rounded duration (`Xh Ym` / `Ym`); no health details. When the event's local day in the settings timezone differs from the current local day at send time (a delayed delivery, still inside the 24h bound), the message also names that date with its year (`Attack started at 6:00 PM on Apr 10, 2026.`, or `Attack ended at 6:00 PM on Apr 10, 2026 (1h 0m).`), so a stale alert cannot read as a current event; a same-local-day message is unchanged. The date uses the event instant stored in `scheduled_at`, which send-time relevance already requires to match the current attack row.
- `runTick` keeps the exact `{ disabled: true, ... }` early return when personal reminders are disabled and no attack transport exists. With an attack transport it still runs `processPending` and reports `disabled: false, generated: 0`; with no personal transport the personal `generate()` pass is skipped entirely.
- `app/server/app.js` accepts an optional `onAttackChange`; POST and PATCH call it after the successful write inside try/catch (never awaited, never affecting status/body), while DELETE and `/api/import` never call it.
- `app/server/index.js` resolves both configs with fixed enabled/disabled logging (reasons only), creates one engine/scheduler when either topic is configured, and wires attack writes to `noteAttackWrite` + a fire-and-forget scheduler tick. That tick is best-effort near-immediate, never a delivery guarantee: it joins an already-running tick/retry batch, and the one-minute interval is the fallback. The attack transport's click target is `attackViewUrl(...)`.
- Boundaries unchanged: no frontend change, no new dependency, no schema change; attack occurrences stay internal and excluded from export/nightly backup and are cleared by `/api/reset`; credentials remain environment-only and are never persisted, exported, or logged.
