# JSON backup restore UI

## Goal

Let users restore both browser exports from Settings and nightly server JSON backups. The user explicitly requested both additive merge and full replacement modes.

## Current state and constraints

- Settings only imports Migraine Buddy CSV and downloads `JSON.stringify(state)`; there is no JSON file picker.
- `POST /api/import` accepts versioned server envelopes and legacy payloads, restores records additively with `INSERT OR IGNORE`, ignores settings, and must remain unchanged in behavior.
- Nightly dumps and `GET /api/export` share `{ schemaVersion, exportedAt, attacks, meds, refills, workouts, dayStates, stockBaselines, settings }`.
- Browser exports instead have flattened `TrackerState` fields (`rules`, `doses`, `planned`, `timezone`, `lowStockThreshold`, `lowStockAlertedAt`, `reminders`, `seeded`). Both formats must be accepted.
- localStorage is a cache/offline fallback. Unconfirmed local replacements must stay dirty/failed and must never be silently overwritten by hydration.
- Secret delivery configuration and internal reminder occurrence/delivery state are never backup content.

## Required behavior

### File selection and preview

- Add a JSON restore control in Settings → Data, separate from the CSV picker.
- Parse and validate before enabling either action. Handle file-read and JSON syntax failures with useful errors and no state changes.
- Accept current and legacy supported schema envelopes plus flattened browser exports; reject future/invalid schema versions and malformed records/settings.
- Preview filename/export time when available and counts for all six record types. Clearly state that merge keeps current settings and existing records win duplicate IDs, while replace restores records and non-secret settings and removes current data.
- Disable actions while work is in flight. A failed operation leaves current data intact and allows retry/cancel.

### Merge records

- Add only records whose IDs/primary keys do not already exist. Existing local records and current settings remain unchanged; no updates, deletes, or resurrect-on-replace semantics are introduced.
- Deduplicate local optimistic state exactly as the server's additive import does (record IDs; `dayStates.day`). Do not blindly append duplicate IDs.
- In confirmed server mode use the existing additive `/api/import`; offline changes remain local and unsynced under existing queue/latch rules.

### Replace everything

- Add a dedicated `POST /api/restore`; do not turn `/api/import` into replace/upsert and do not implement client-side reset-then-import.
- Validate the entire payload before writing. In one SQLite transaction, clear existing user records/settings and internal reminder state, insert the backup records/settings, and commit. Any error rolls back every change. Return the canonical export envelope for client hydration.
- Restore only known, validated, non-secret settings. Never persist reserved/secret-like keys or internal scheduler state. Restoring clears previous internal reminder state so old occurrences are not reused.
- Direct attack alert callbacks must not fire for restore, matching import/reset behavior.
- Require a second destructive-action confirmation in the UI, with a recommendation to download the current backup first.
- In confirmed server mode, do not optimistically erase/replace local state. Await the atomic server operation through the serialized queue, then adopt the returned snapshot and clear divergence only after success. Force is appropriate because this is an explicit conflict-resolution/destructive choice.
- In browser-only mode apply the validated replacement locally and retain dirty/failed latches so later hydration cannot silently overwrite it. An empty restored backup is still a deliberate dirty replacement.
- Reset stale pending low-stock alert bookkeeping only when replacement actually applies. Preserve normal low-stock evaluation afterward.

## Compatibility and edge cases

- Existing CSV import, demo data, export, reset, conflict resolution, and partner read-only behavior remain intact.
- Old backups missing newer arrays/settings remain restorable; defaults apply for absent replacement settings. Current valid backups round-trip records and all supported non-secret settings.
- Duplicate IDs in a replacement backup fail atomically rather than silently producing a non-exact restore. Merge continues to skip them.
- Unknown/future data must not be presented as successfully restored. Settings restoration must not import URLs, tokens, or other secret-like fields.
- Server-side validation remains authoritative; client validation is also required because browser-only restore has no server.
- Update DEPLOY.md restore instructions, including merge/replace settings semantics and the unchanged SQLite disaster-recovery option.

## Tests and definition of done

- Pure/parser tests: browser and nightly formats, legacy missing fields, malformed JSON/shapes/records/settings, future schema rejection, counts.
- Store tests: additive dedup across record types and unchanged settings; online replace waits for success and adopts canonical state; failure preserves local state/latches; offline replace stays dirty/failed; read-only mutation denial; queue/divergence behavior as applicable.
- Server tests: full round-trip of every record type and supported settings; current data and internal reminder state removed; additive import unchanged; malformed payload, duplicate key, bad settings, and forced write failures roll back completely; secret settings are not accepted/restored; no attack alert callback.
- Settings component tests: picker/preview, both action paths, destructive confirmation, parse/read/server errors, busy state.
- Documentation accurately describes the feature.

Run all from `app/` unless noted:

```sh
npm test
npm run lint
npm run build
npm run validate:pwa
node --check server/index.js
npm test --prefix server
```

Additionally smoke-test merge and replace routes against a disposable `DATA_DIR` (never real `app/server/data`) or use Fastify inject coverage that exercises the actual app factory and transaction behavior. The feature is done only when all checks pass and the actual diff has been independently reviewed.
