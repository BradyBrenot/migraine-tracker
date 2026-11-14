# Removal-first repository cleanup

Date: 2026-11-13
Status: completed and independently approved (reviewer-ds, reviewer-k3, reviewer-glm)

Implementation record (2026-11-13): completed. Before/after collected
scenarios: frontend 765 -> 726, server 228 -> 203, HA 224 -> 213 (75 removed,
matching the closed manifest). Test-area files 83 -> 81; measured physical test
lines 32,594 -> 31,412. Runtime dependencies 46 -> 15 (31 removed; dev 22 -> 20,
including `kimi-plugin-inspect-react` and `tw-animate-css`). Lockfile package
entries 600 -> 441 with no resolved version of a surviving package changed.

## Intent

Reduce dead code, template residue, dependency weight, redundant tests, and documentation bulk without changing product behavior or weakening health-data protections. This is not a feature refactor or a test-count quota. Every test deletion is listed in `2026-11-13-test-deletion-manifest.md` with named surviving coverage; additional discretionary pruning is forbidden.

## Measured starting point

- Clean checkout at `163a314` before this work.
- Counting rule: 83 test-area files including helpers/conftest/`__init__`, totaling 32,591 physical lines; 78 runnable test modules (53 Vitest, 13 Node, 12 Python). There are 127 non-test TS/TSX/JS/Python files totaling 26,096 physical lines.
- Runtime counts: frontend 765 scenarios; server 228/228 passing; 115 Python test function declarations before parametrization.
- Baseline frontend: 764 passed, 1 failed (`Home workout per-kind dedup > upgrades the highest-effort duplicate rather than the latest one`), also failing alone. The fixture subtracts hours from the wall clock and crosses a UTC day boundary. Baseline lint passed.
- 43 of 53 `src/components/ui` files are unreachable: 5,403 physical lines. Only `alert-dialog`, `button`, `dialog`, `input`, `label`, `sheet`, `sonner`, `switch`, `tabs`, and `textarea` are reachable.
- The current 46 runtime dependencies can reduce to 15; `kimi-plugin-inspect-react` is additional instrumentation. The shipped plugin lacks the `apply: "serve"` guard claimed by its README, so it currently transforms production and demo builds too.
- `src/pwa.test.ts` duplicates `scripts/validate-pwa.mjs`; seven built-output cases are skipped on a clean pre-build CI test run, while CI separately builds and runs the validator.
- `usage.ts` ships array and indexed forms of three helpers; the array forms are test-only oracles. `daysSinceLastFromIndex` also has no production caller.

## Step 0: establish a deterministic green baseline

Before any deletion, make the entire `Home workout per-kind dedup` describe clock-independent, not just the currently failing case. Use the file's existing `vi.useFakeTimers({ toFake: ['Date'] })` + `setSystemTime` + `resetModules()`/re-import pattern (or anchor every fixture inside the configured current day). Fake **only** `Date`; never fake `setTimeout`/`setInterval`, which would break RTL `waitFor` and the `useNow` tick. Add a same-day precondition where useful so future fixture mistakes fail clearly.

Run `npm test` and require all 765 scenarios green. Record this as the reference run before deleting anything. As a one-time negative check, temporarily invert effort precedence and confirm the retained highest-effort-duplicate test fails, then restore the source exactly.

## Checkpoint 1: delete dead weight

1. Delete the 43 unreachable UI components and `src/hooks/use-mobile.ts` (only used by the deleted sidebar). Keep the ten components listed above.
2. Delete root `page.html`, `app/template-info.md`, stock Vite `app/README.md`, and `app/components.json`; the remaining components are owned source. Remove `components.json*` from `app/Dockerfile` and its deployment reference. Update `AGENTS.md` to remove the stale root `page.html` statement. Adjust the retained button's “do not hand-edit” banner to reflect owned code while preserving its Fast Refresh eslint exception.
3. Remove sidebar CSS variables **and** the matching Tailwind `sidebar` color block. Remove accordion/caret keyframes and animations orphaned by deleted components. Remove the unreferenced `tw-animate-css` package along with the other orphaned dependencies.
4. Simplify `ui/sonner.tsx`: the app is dark-only, `Layout` passes `theme="dark"`, and props already override the `next-themes` value. Remove the lookup and package.
5. Remove `inspectAttr()` and `kimi-plugin-inspect-react`; source-location DOM instrumentation is not part of the application. Production, demo, and Docker builds are required evidence because the plugin currently transforms both build modes.
6. Remove all dependencies orphaned by these deletions. Expected surviving runtime dependencies are only:
   - Radix: `react-alert-dialog`, `react-dialog`, `react-label`, `react-slot`, `react-switch`, `react-tabs`
   - `class-variance-authority`, `clsx`, `lucide-react`, `react`, `react-dom`, `react-router`, `recharts`, `sonner`, `tailwind-merge`
   Use `npm uninstall` for the 31 runtime removals and `npm uninstall -D kimi-plugin-inspect-react`; use npm (Node 24/npm 11) for any lockfile metadata update, never hand-edit lockfile internals. Rename the frontend package to `migraine-tracker`. Audit the lockfile diff: no resolved version of a surviving package may change. Finish with a clean `npm ci`.

## Checkpoint 2: bounded production/test de-duplication

### Production simplification

- Delete `usageDaysInWindow`, `medUnionDaysInWindow`, `painkillerBreakdown`, and dead `daysSinceLastFromIndex` from `src/lib/usage.ts`. Keep `daysSinceLast`, which has real callers, and the indexed production implementations. Convert affected unit tests to direct expected results for the indexed functions.
- The converted tests must retain malformed timestamps, preserved duplicate instants, future-dose inclusion, `windowDays` of zero/one/30/`NaN`/positive infinity (non-finite windows produce zero), four zones including `Australia/Lord_Howe`, and reuse of one index across zones. Fold the unique oracle expectations into the two retained index tests named in the manifest; do not add a replacement scenario or helper layer.
- Do not rewrite the store, schema, API, migrations, sync state machine, reminder engine, HA architecture, or deliberate attack/med indexes and caches. Those optimizations need separate measurement before replacement.

### Closed test-deletion manifest

Apply exactly `2026-11-13-test-deletion-manifest.md`: **75 collected scenarios** (39 frontend/shared, 25 server, 11 HA). No other test may be deleted under this plan. If a survivor is renamed/removed or a candidate contains a unique assertion, fold that assertion into the named survivor first or stop and ask; do not silently expand the list.

Important explicit retain decisions from independent review:

- Keep Home's per-record-type demo data-loss guards, seeded/server/offline branches, note-latching cases, raw-overlap CTA, and eastern **and** western configured-zone integrations (they may be split across Home/Calendar, not deleted from both).
- Keep approved content-order, contrast, responsive, and accessibility contracts; “similar class assertion” is not sufficient reason to delete. Keep PartnerHome's contrast floor.
- Keep `test_event_entity_metadata` (event types and baseline are behavior, not registry duplication) and `test_existing_entity_keeps_its_id_after_the_display_name_change` (upgrade/registry identity).
- Do not use producer TypeScript tests as justification for deleting HA Python parsing/fallback tests. Retain one HA case per defensive branch for non-ISO/naive/overflow ends, local-date overflow, lowercase/missing/invalid zones, malformed/missing today, and clamp-at-zero.
- Preserve migrations' workout defaults and exact table-set/v0/v1 table-acquisition assertions by folding them into `migrations.test.js` before deleting the three duplicate migration scenarios.
- Preserve server status health-detail privacy, pathological stored instants, and route/mapper wiring. “Secret exclusion” includes health notes, symptoms, triggers, and pain-log text, not just credentials.
- Preserve every migration, additive import, atomic restore/rollback, reset, export/nightly backup, sync divergence/offline latch, ID-integrity, secret-handling, reminder delivery/dedup/retry/recovery, and HA request-method/transition test not explicitly listed.

### PWA validator parity before deleting `pwa.test.ts`

Fold every unique assertion into `scripts/validate-pwa.mjs` using its normal `check()`/`fail()` paths:

1. Exact writer manifest identity `Migraine Tracker` / `Migraine` (other fields and dist/source equality are already covered).
2. Writer `<title>Migraine Tracker</title>` and `src="/src/main.tsx"` in both source shells; dist must still contain no unbundled `/src/` entry.
3. `name="robots" content="noindex, nofollow"` and a description of at least 20 characters in both source shells.
4. Source `robots.txt` has `User-agent: *` and an empty `Disallow:` (not `Disallow: /`), and built `dist/robots.txt` is unchanged from source.

Run a one-time negative check against disposable copies: corrupt each category above and require the validator to exit nonzero and report each corresponding failure. Do not mutate the real fixtures.

## Checkpoint 3: documentation cleanup

- Rewrite `DEPLOY.md` as a concise operational runbook. Preserve the Compose service; GHCR public-package one-way visibility and TrueNAS 25.10/Goldeye private-registry caveat; authenticated alternative; local-build alternative; ntfy/weather essentials; one-process scheduler constraint; Tailscale/no-auth boundary; Host-header requirement; stopped-container SQLite+WAL backup/restore; JSON merge/replace distinction; update/rollback/schema caveat; and mobile/partner install facts. Remove repeated explanations and CI narration already owned by the workflow/AGENTS.
- Update the root README deployment pointer and remove commentary about the documentation being awful. Keep feature summaries and screenshots.
- Update AGENTS/DEPLOY references made stale by file removal. Do not delete historical design plans in this pass.

## Out of scope

- Product behavior, public API/schema, persisted format, HA protocol/entity behavior, visual redesign, dependency upgrades, coverage tooling, and new features.
- Broad rewrites of `store.tsx`, `Settings.tsx`, Calendar/Reports indexing, reminder delivery, or the HA coordinator.
- Deleting tests to make a red suite green, reaching a count target, or weakening unique malformed-data, privacy, accessibility, migration, or security coverage.

## Verification

From `app/`, after clean `npm ci` and `npm ci --prefix server`:

```sh
npm test
npm run lint
npm run build
npm run validate:pwa
npm run build:demo
npm run validate:demo
node --check server/index.js
npm test --prefix server
npm audit --omit=dev
npm audit --omit=dev --prefix server
```

Record before/after runnable test-file and collected-scenario counts per area, physical test lines, production lines, and dependency counts. Use machine-readable list/collection output where practical; never infer a count from declarations alone.

From repository root on Windows for static HA checks:

```sh
python -m ruff check custom_components/migraine_tracker tests/homeassistant conftest.py
python -m ruff format --check custom_components/migraine_tracker tests/homeassistant conftest.py
python -m compileall -q custom_components/migraine_tracker
python -c "import json; [json.load(open(p, encoding='utf-8')) for p in ('custom_components/migraine_tracker/manifest.json','custom_components/migraine_tracker/strings.json','custom_components/migraine_tracker/translations/en.json','hacs.json')]"
```

Run HA collection and tests in Linux/container, not native Windows. One self-contained form (also run `--collect-only -q` for counts) is:

```sh
docker run --rm -v "${PWD}:/workspace" -w /workspace python:3.14-slim sh -c "python -m venv /tmp/venv && /tmp/venv/bin/pip install -r requirements-homeassistant-dev.txt && /tmp/venv/bin/python -m pytest -q"
```

Run the digest-pinned hassfest check from AGENTS:

```sh
docker run --rm -v "$PWD:/github/workspace" ghcr.io/home-assistant/hassfest@sha256:da6522993280166fe072704989a2b4c33e639e8ceb69c8ab6ad7ec5045c1a1e3
```

From repository root, also run:

```sh
docker build -t migraine-tracker:cleanup-test ./app
docker compose -f app/compose.yaml config --quiet
```

Smoke the built container with disposable storage, checking `/api/health`, `/`, and `/view`; never use a real data directory. Report every unrun check explicitly as unrun.

## Worker return contract

Return a concise per-checkpoint summary; exact files changed; deleted dependencies; actual manifest rows completed plus any blocked rows; the diff location of every required fold-in; before/after per-file scenario counts; exact commands and results (including green Step 0, negative validator/workout checks, lockfile removals-only audit, HA collection, and Docker results); deviations/unrun checks; and remaining risks. Do not commit. Stop for clarification rather than changing product behavior or exceeding the closed manifest.
