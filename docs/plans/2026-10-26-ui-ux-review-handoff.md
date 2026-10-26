# UI/UX review and compact Home redesign — coordinator handoff

## Current repository state

- Latest commit: `464b61da7dad13fbdb6350f77d23044c2ed37b79` — `feat: add wellness tracking, inventory, PWA, and reminders`.
- That commit includes checkpoints 1–6 and final hardening. Before this UI task, the working tree was clean.
- No UI implementation has been made in this task. The only intentional new repository file is this handoff document.
- A Builder dispatch was attempted, but failed immediately with `Unknown agent: builder-ds`; it made no changes. Use the current system prompt's available delegation roles (the updated coordinator prompt is expected to use `feature-lead`).
- Prior verified baseline: 190 frontend tests, 121 server tests, lint/build/typecheck, 48 PWA checks, server syntax check, production Fastify/container smokes, and final Docker build. Production npm audits were zero; the full frontend audit has 14 dev-only advisories. The large main-chunk warning is known and nonfatal.

## User's current request

Validate the GUI, especially the recent Day/Workout card. The user considers it ugly, miscentered, and too space-consuming. Compact use of the Home page is important. Also review and improve general UI/UX across the app, using reviewers when useful.

## Browser review already performed

The app was reviewed with disposable seeded data at desktop width and in a 390px-wide iframe to exercise mobile layouts.

### Home wellness card

Relevant current source:

- `app/src/components/DayCheckIn.tsx`
- `app/src/components/WorkoutQuickLog.tsx`
- `app/src/pages/Home.tsx` (wellness section around lines 208–213)

Observed problems:

- `TODAY` and `Today: Off` duplicate each other.
- Note and Change are tiny underlined links at the far right, with weak tap ergonomics.
- Guidance, workout buttons, and weekly counts each consume separate rows; the card is about 190px tall at 390px and feels poorly grouped.
- Related day/workout information has weak hierarchy and too much padding/whitespace.
- Home vertical spacing should not increase. Do not make the primary Attack start/control a tiny target.
- Lighthouse Home: accessibility 0.95, best practices 1. Actual contrast failures:
  - Layout Synced pill: ratio 3.81.
  - DayCheckIn `TODAY`: ratio 3.75.
  - Use slate-400 or stronger for meaningful secondary text.
  - SEO/meta/robots findings are irrelevant to this private app.

### Other tabs

- History at 390px: its four tabs crowd together; text such as `Medications (6)Rx pickups...` loses readable spacing. Keep all four tabs/counts and use compact responsive spacing/labels, not a new navigation pattern.
- Calendar, Reports, and Settings are generally coherent. Settings medication-limit rows wrap awkwardly but do not require a broad redesign.
- History is otherwise clean.

### Behaviors that must not regress

- Well/Off/Attack one-tap check-in collapses; Change reopens it.
- Optional day Note edit/save/clear still works.
- Well = normal routine; Off = light walk/mobility counts; Attack = rest and no exercise logging/nagging.
- Strength/Cardio then Low/Medium/Hard logs in exactly two taps and offers Undo.
- Weekly goals remain 2 strength and minimum 3 cardio; Mobility is separate and never counts toward either.
- Existing Attack, medication, Past attack, and Past med workflows stay on Home.
- Five main navigation tabs remain.

## Recommended focused scope

1. Make the Home wellness card compact and cohesive at 360–400px and desktop:
   - Remove duplicate Today wording and unnecessary labels.
   - Align current state/actions clearly.
   - Keep workout actions and weekly counts inline where practical, with graceful narrow-screen wrapping.
   - Shorten guidance without losing meaning.
   - Avoid repeated badges, over-centering, empty areas, and extra rows.
   - Preserve roughly 40–44px targets for primary actions, visible focus states, and the dark palette.
2. Modestly reduce unnecessary Home vertical whitespace where helpful.
3. Fix History's narrow-screen tab labels/spacing and tap targets.
4. Fix the measured Layout/wellness contrast failures; avoid a blanket app-wide recolor.
5. Add/update meaningful behavior tests for check-in, Note, Change, two-tap logging/Undo, Attack suppression, and responsive History labels/classes. Do not rely only on CSS snapshots.
6. Rebuild and independently validate actual browser desktop/mobile presentation after implementation, including interactive flows and Lighthouse contrast. Do not claim GUI improvement from unit tests alone.

Avoid broad Reports/Calendar/Settings redesigns, new features, API/store/shared/server changes, dependency changes, service workers, deployment, or real notifications.

## Disposable GUI environment currently running

A Docker review container may still be running:

- Name: `migraine-gui-review`
- Last mapped address: `http://127.0.0.1:51598`
- Image: `migraine-tracker:final-coordinator`
- Disposable seeded DB: `C:\Users\brady\AppData\Local\Temp\opencode\migraine-gui-data-Ih8CwG\data`
- ntfy variables were explicitly empty. This is not production data.

Check with:

```powershell
docker ps -a --filter name=migraine-gui-review
docker port migraine-gui-review 3000/tcp
```

When finished, clean up:

```powershell
docker rm -f migraine-gui-review
Remove-Item -Recurse -Force 'C:\Users\brady\AppData\Local\Temp\opencode\migraine-gui-data-Ih8CwG'
```

An earlier Node review server was killed by its timeout. The Docker container replaced it.

For narrow-screen review, a 390px iframe around the app worked when direct window resizing did not control `innerWidth`. Browser tools used: tabs.open/navigate, frames, evaluate, wait, screenshot, snapshot, console, lighthouse.

## Next coordinator steps

1. Read current `AGENTS.md`, this handoff, and the relevant source. Treat the updated system prompt as authoritative for delegation; do not use unavailable `builder-ds`.
2. Inspect current git status. Preserve the previous commit and this handoff; do not reset/clean.
3. Delegate the focused UI work to a fresh `feature-lead` with allowed paths limited to the related frontend components/pages/tests and exact verification commands. Coordinator must not implement production source directly.
4. Review the actual diff and independently run verification.
5. Rebuild `app/dist`, serve with disposable data, and validate actual GUI at desktop and ~390px: Home collapsed/change/note states, Strength/Cardio effort logging and Undo, Attack suppression, History tabs, other four tabs, contrast, console errors, and horizontal overflow.
6. Use a fresh independent UI reviewer if helpful and resolve material findings.
7. Do not commit unless the user explicitly requests it. No push without explicit approval.

## Standard verification

From `app/`:

```sh
npm test
npm run lint
npm run build
npm run validate:pwa
npm test --prefix server
node --check server/index.js
```

Use disposable external `DATA_DIR` for any server/GUI smoke. No fixed persistent test port, production data, deployment, or real ntfy messages.
