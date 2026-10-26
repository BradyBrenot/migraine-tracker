# Approved follow-up roadmap

User approved the reviewer-prioritized items 1–5 and all smaller worthwhile improvements. Implement and commit each numbered feature separately, with focused verification and simultaneous GLM + DeepSeek review for material/high-risk changes. Do not widen attack-alert freshness windows, build an offline outbox, add authentication, or broadly redesign the app.

## 1. Active-attack exercise suppression

- `assessExercise` must suppress when an attack is active at `now`, even if an earlier explicit Well/Off day record exists.
- Active means overlapping the assessed local day and `end === null` or a valid end later than `now`. Ended attacks retain the existing explicit-record recovery semantics.
- Keep `effectiveDayState` display behavior unchanged. Update misleading JSDoc and shared/server tests.
- Implemented: `assessExercise` now independently suppresses when an attack is active at `now` (start <= now, overlapping the assessed local day, and end null/empty or a valid end > now) even beside an explicit Well/Off record.
- Ended/future-start attacks and the reported `state` are unchanged; shared and server reminder tests were extended (including a pending-retry drop and the ended-attack Off recovery path).
- Review fix: an open end is capped at `now` (matching `hasAttackThatDay`), so an ongoing attack never suppresses a future assessed local day.

## 2. Safe partner installation

- Add a distinct partner manifest with `id`/`start_url` `/view`, scope `/view`, and a Migraine Partner name. Reuse icons and dark colors.
- Serve a deterministic partner HTML document referencing that manifest for `/view` and nested routes; a second Vite HTML input is preferred over delayed JavaScript manifest swapping.
- Normal writer install behavior remains unchanged. Extend source/build PWA validation for both manifests and SPA fallback tests. Verify actual production `/view` document/manifest linkage.
- Implemented: `public/partner.webmanifest` declares the distinct app (`id`/`start_url` `/view`, scope `/view`, Migraine Partner name/short name and description) and reuses the writer's icon array verbatim.
- Implemented: `view.html` is a second Vite HTML input (`dist/view.html`) with the partner title and `/partner.webmanifest` link; it shares the single `src/main.tsx` runtime, and `index.html`/writer install output is unchanged.
- Implemented: the server resolves the partner shell once at startup and the SPA fallback serves it for `/view` and `/view/*` (query strings ignored), while every other route keeps the writer shell; a stale dist without `view.html` falls back to the writer shell without a `callNotFound` loop.
- Implemented: `validate:pwa` and the Vitest installable-shell tests cover both manifests (identity, colors, icon IHDR checks, writer/partner icon equality) and both HTML shells, including built-dist asset and manifest linkage.
- Implemented: server static tests cover the partner fallback (root, nested, trailing slash, query string), writer fallback for all other routes, the JSON `/api` 404, stale-dist degradation, and partner-scoped encoded traversal.
- Implemented: DEPLOY.md documents the separate partner install and its online-only behavior; writer install behavior is unchanged.

## 3. Peak-pain correction

- AttackFormDialog must save explicit peak changes for existing attacks, including raising and lowering, without adding a synthetic pain-log entry.
- Store update semantics must distinguish an explicit `peakPain` patch from recomputation. Future new pain entries must not silently resurrect an older corrected peak; derive from the stored current peak plus the new entry rather than rescanning old history in that path.
- Preserve 0-pain attacks and new/past attack behavior. Add create/raise/lower/store regression tests.
- Implemented: editing an attack now sends the selected `peakPain` directly in the patch (raising, lowering, or 0) with no `logPain` call or synthetic pain-log entry; untouched legacy peaks stay out of the patch, and new/past attack creation still uses `logPain`.
- Implemented: `updateAttack` honors an explicit numeric `peakPain` verbatim, preserves an already-known peak across metadata edits, and derives from the log only when the stored peak is still `-1` (legacy records).
- Implemented: `logPain` folds the new entry into the stored peak with `Math.max` instead of rescanning history, so a corrected-down peak cannot be resurrected.
- Implemented: new AttackFormDialog and store regression tests cover raise/lower/0, metadata-only edits, later pain entries, legacy derivation, and 0-pain attacks.

## 4. Workout goal integrity and History warning

- Weekly goals count distinct configured-local days per kind for Strength and Cardio, at most one of each per day; Mobility behavior remains unchanged. This repairs legacy duplicate inflation without deleting/migrating records.
- WorkoutFormDialog warns when the selected kind already has a record on that configured-local day (excluding the record being edited), but does not block detailed historical entry. Home quick-log highest-effort behavior remains unchanged.
- Add duplicate-day, timezone, invalid-date, and dialog tests.
- Implemented: `countWorkoutsInWeek` keeps its signature/shape but buckets Strength and Cardio into per-kind sets of `localDayKey(instantMs, timeZone)` inside the existing half-open `sundayWeekBounds` window, so duplicate same-day rows count once; no records are deleted, merged, or migrated.
- Implemented: Mobility is deliberately unchanged — every mobility session still counts individually and never satisfies a strength/cardio goal. Invalid `performedAt` values are still skipped before any day bucket is created.
- Implemented: `WorkoutFormDialog` shows an inline `role="status"` warning (before the save button, never disabling it) when another same-kind goal record already exists on the configured-local day of the valid entered `performedAt`, excluding the record being edited. Changing kind/day clears it, an invalid/cleared date never warns, and Mobility never warns because mobility duplicates cannot change a goal.
- Implemented: shared workout/reminder tests cover same-day duplicates, one-per-kind days, distinct days, cross-zone bucketing, the fall-back repeated hour, spring-forward bounds, invalid timestamps, unchanged mobility, and duplicates failing to meet goals; dialog tests cover warn-before-save, edit exclusion, kind/date clearing, invalid dates, and no mobility warning; server reminder tests prove duplicate-only weeks still send instead of `condition_gone`.
- Review fix: goal copy now says strength/cardio DAYS (constants unchanged at 2/3), the exercise reminder body matches ("2 strength days and 3 cardio days"), and the dialog warning uses a persistent polite live region that skips workout scans while the dialog is closed.

## 5. Alert and sync diagnostics

- Add a bounded timeout (about 15s) to frontend API requests so a stalled request fails and releases the serialized writer queue instead of hanging indefinitely.
- Log fixed non-secret text when a direct attack write is suppressed by the event-freshness rule. Do not widen the freshness window.
- Expose only boolean reminder/attack-alert configuration status through health metadata, never URLs/tokens. Show attack-alert configuration status in Settings as read-only environment information.
- Update API mocks/tests, health tests, and deployment docs. No real notification traffic.
- Implemented: every frontend API request now carries a ~15-second `AbortController` timeout; a stalled request rejects so the serialized writer queue latches unsynced/failed instead of hanging, and the timer is always cleared.
- Implemented: `noteAttackWrite` logs one fixed non-secret message when a genuine fresh-window rejection suppresses a start or end alert (`attack alert start suppressed: instant outside freshness window or invalid` / the matching `end` text). The freshness windows and enqueue behavior are unchanged, and fresh alerts, metadata/repeat PATCHes, and personal-only engines log nothing.
- Implemented: `GET /api/health` reports only `{ ok: true, notifications: { reminders, attackAlerts } }` booleans (only `=== true` is true; everything else is false and extra fields are never echoed), wired from the startup ntfy configuration.
- Implemented: Settings fetches health once on mount and shows a read-only "Attack alerts" configuration status ("Configured" / "Not configured" / "Unavailable") with a no-delivery-guarantee explanation and no toggles or credentials.
- Implemented: focused Vitest API-timeout and Settings health tests, extended Node attack-alert suppression-log and health endpoint tests, and documented the timeout, health booleans, and read-only Settings status in DEPLOY.md.

## 6. Home timezone parity

- Home Today's medications uses configured-timezone local-day filtering with invalid-date guards, matching PartnerHome and workout behavior. Add non-UTC coverage.
- Implemented: Home derives one `todayKey` from `localDayKey(now, state.timezone)` before the "Today's meds" `useMemo`; the filter parses each `ts`, skips non-finite values, and compares its configured-zone day key to `todayKey`. Ordering (newest first) and the empty-section/rendering behavior are unchanged.
- Implemented: `Home.wellness.test.tsx` adds non-UTC coverage in two configured zones (Pacific/Kiritimati UTC+14 and America/Los_Angeles UTC-7) proving that meds in the configured-local day are included even when UTC is another day, and meds just outside it (UTC-today or UTC-yesterday) are excluded; both timezone cases fail under the previous browser-day filter. Invalid-timestamp guards are covered with mixed valid/invalid rows and an all-invalid set that keeps state intact and renders no Today section.

## 7. Partner readability and attack-medication context

- Fix meaningful secondary text contrast on PartnerHome.
- In the active-attack card, show medications linked to that attack (name/dose/time), including an explicit empty state. Keep it read-only and distinct from all medications today.
- Implemented: every meaningful `text-slate-500`/`text-slate-600` style on PartnerHome is now `text-slate-400` — the "Last attack ended …" line, the "Not logged" status fallback, the Medications and Workouts headings, both "None logged today." empty states, the medication quantity and workout duration text, the Nurtec explanation, and the footer read-only notice. Decorative gradients, borders, colored dots, and existing accent/`slate-100`–`slate-300` text are unchanged.
- Implemented: the active-attack card gains a read-only "Medications for this attack" subsection (h2 + Pill icon, `text-rose-200`) rendered as a semantic `<ul>`/`<li>` list using the same row markup as Today's list (colored dot, name, dose, quantity, right-aligned time). It shows only meds whose `attackId` equals the active attack (unlinked meds stay in Today's list and are not hidden or re-filtered), sorted newest first by parsed `ts`; linked meds with a non-finite `Date.parse(ts)` sort last and render an em dash instead of calling `fmtTime`, so malformed dates are kept, not dropped. Empty state is exactly "No medication linked to this attack." and the section has no totals, warnings, controls, or store mutations.
- Implemented: `PartnerHome.test.tsx` adds focused coverage for linked med display, unlinked meds excluded from the attack card but retained under Today, the exact empty state, newest-first `listitem` order, malformed-timestamp rows (em dash, never "Invalid Date"), a 0/10 peak-pain attack with a linked med, and a contrast regression guard asserting populated active-attack, calm, and empty renders contain no `.text-slate-500`/`.text-slate-600` elements.

## 8. Recent-dose surfacing

- On Home acute-medication cards, show a compact non-blocking recent-dose indicator when the same med was logged within roughly two hours, using valid timestamps and current coarse clock. Do not block logging.
- Include previous-dose context in the log toast where useful without hiding the normal Undo action. Add tests and check the four-up mobile layout.
- Implemented: each acute quick-log card (`MED_CATALOG` entries whose kind is not `preventive`) gains a block-level `Last 25m ago` / `Last <1m ago` line between the kind label and the Nurtec badge, styled at the existing 10/11px secondary scale with `tabular-nums` and `break-words`. It is plain inline text (no badge, pill, absolute positioning, truncation, or disabled state), so one-tap logging and the Nurtec badge markup are unchanged.
- Implemented: the hint uses `RECENT_DOSE_WINDOW_MS` (2h) and `CLOCK_SKEW_TOLERANCE_MS` (60s); the latest same-`medId` event with a finite `Date.parse(ts)` wins regardless of attack, dose, notes, or configured day, empty/malformed timestamps are ignored, age is clamped to zero for display, and more-than-60s-future timestamps are hidden. A `useMemo` keyed on `state.meds` and the coarse `useNow()` clock recomputes it on ticks and after log/undo.
- Implemented: `handleMed` captures one `when` for both the stored `ts` and the displayed time, computes the previous dose from state before `logMed`, and joins the existing dose text, localized time, and `last dose 25m ago` (or `<1m ago`) with ` · `. The `${medName} logged` message and `Undo` action are unchanged; a prior dose older than two hours adds no context.
- Implemented: `Home.wellness.test.tsx` covers the recent hint plus successful logging, old-dose omission, invalid/empty timestamps, far-future suppression, the sub-minute label within the skew tolerance, latest-wins across two doses, preventive exclusion, previous-dose toast context with Undo, and toast omission for an old prior dose. The 360px four-up layout was checked by DOM/class review and geometry (≈61–64px inner card width; the hint is a wrapping block line below the name/kind label and outside the Nurtec badge's absolute desktop span).

## 9. Demo-data server guard

- Do not show the browser-only demo-data block in confirmed server mode. Prevent accidental additive import of demo records into canonical server data. Preserve local/demo behavior and update tests.
- Implemented: `Home` gates the "No data yet" demo block on `!store.serverMode` in addition to the existing `!state.seeded && state.attacks.length === 0`, so it never renders once hydration has confirmed a reachable backend. Copy, markup, placement, the `loadDemoData()` click handler, and the toast are unchanged; no confirmation dialog, store change, persisted flag, or new store field was added.
- Implemented: the guard is deliberately on confirmed server mode (the store's `serverMode` flips only after a successful `GET /api/export`), not on "hydration finished" tracking. Local/offline rendering is untouched: an unreachable server leaves `serverMode === false`, the block still renders, and clicking it still sets `seeded` and populates the seeded attacks/meds locally. Offline demo seeding never reaches `/api/import` because the store's serialized write queue short-circuits while no server is confirmed — the additive server import can only run in confirmed server mode, where this block is now unreachable.
- Implemented: `Home.wellness.test.tsx` adds a `Home demo-data guard` block. With an empty server export (confirmed mode: `serverMode === true`, `sync.status === 'synced'`) the copy and the "Load 75 days of demo data" button are both absent and `api.importAll` is never called. With `api.exportAll` rejecting (`serverMode === false`, status `local`) the copy and button render, and clicking loads demo data locally (`seeded === true`, non-empty seeded attacks/meds), with no demo import sent to the API and the block then hiding via `seeded`. An already-seeded local state also keeps the block hidden.
- Residual caveat (unchanged): `serverMode` stays false until the first `GET /api/export` resolves and forever when the server is unreachable, so on a fresh load against a reachable-but-empty server the block can render for the duration of that one request before hydration flips `serverMode`. This is unchanged pre-confirmation local-mode rendering, and a click in that window still seeds locally; because the store latches that offline mutation as unconfirmed, the later first-contact upload can then push those demo records to the now-empty server. The guard does not close that pre-hydration race (doing so would require hydration-tracking state, which is out of scope); it only guarantees the block is gone once server mode is confirmed.

## Cross-cutting definition of done

- Each feature has focused tests, actual diff review, standard verification from `app/` (`npm test`, lint, build, PWA validation, server tests, server syntax), relevant disposable-data GUI/API smoke, and its own commit.
- Simultaneous reviewer-glm and reviewer-ds reviews for material changes; resolve findings before committing.
- No production data, real ntfy delivery, secrets, generated artifacts, or unrelated changes in commits. Clean up disposable environments.
