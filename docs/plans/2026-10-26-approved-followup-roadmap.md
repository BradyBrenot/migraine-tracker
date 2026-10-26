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

## 5. Alert and sync diagnostics

- Add a bounded timeout (about 15s) to frontend API requests so a stalled request fails and releases the serialized writer queue instead of hanging indefinitely.
- Log fixed non-secret text when a direct attack write is suppressed by the event-freshness rule. Do not widen the freshness window.
- Expose only boolean reminder/attack-alert configuration status through health metadata, never URLs/tokens. Show attack-alert configuration status in Settings as read-only environment information.
- Update API mocks/tests, health tests, and deployment docs. No real notification traffic.

## 6. Home timezone parity

- Home Today's medications uses configured-timezone local-day filtering with invalid-date guards, matching PartnerHome and workout behavior. Add non-UTC coverage.

## 7. Partner readability and attack-medication context

- Fix meaningful secondary text contrast on PartnerHome.
- In the active-attack card, show medications linked to that attack (name/dose/time), including an explicit empty state. Keep it read-only and distinct from all medications today.

## 8. Recent-dose surfacing

- On Home acute-medication cards, show a compact non-blocking recent-dose indicator when the same med was logged within roughly two hours, using valid timestamps and current coarse clock. Do not block logging.
- Include previous-dose context in the log toast where useful without hiding the normal Undo action. Add tests and check the four-up mobile layout.

## 9. Demo-data server guard

- Do not show the browser-only demo-data block in confirmed server mode. Prevent accidental additive import of demo records into canonical server data. Preserve local/demo behavior and update tests.

## Cross-cutting definition of done

- Each feature has focused tests, actual diff review, standard verification from `app/` (`npm test`, lint, build, PWA validation, server tests, server syntax), relevant disposable-data GUI/API smoke, and its own commit.
- Simultaneous reviewer-glm and reviewer-ds reviews for material changes; resolve findings before committing.
- No production data, real ntfy delivery, secrets, generated artifacts, or unrelated changes in commits. Clean up disposable environments.
