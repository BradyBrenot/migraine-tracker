# Mobile Home core controls and per-kind workout upgrades

## Goal

Make the normal mobile Home view expose every low-willpower instant-logging control without vertical scrolling on an Oppo Find X9 Ultra-class viewport, and make workout quick-logging idempotent per kind per local day.

The Find X9 Ultra has a 1440 × 3168 physical display. Browser CSS dimensions depend on Android display scaling; use an approximately 412 × 915 CSS-pixel viewport for primary validation, with 360px and desktop as secondary checks. Official hardware reference: https://www.oppo.com/en/smartphones/series-find-x/find-x9-ultra/specs

## Current state

- The previous uncommitted UI pass compacted the wellness card and History, fixed contrast, and wrapped the Reports mobile header. Preserve all of that work.
- Home still uses a 92px Attack button, 24px top main padding, two rows of acute medication buttons below the `sm` breakpoint, and separate past-action and same-day-medication sections. Core medication controls can fall below the mobile fold.
- `WorkoutQuickLog` always calls `addWorkout`; repeated taps create duplicate same-kind records on one day. It shows weekly totals but no explicit today state.
- Store mutations are synchronous optimistic updates followed by a serialized backend queue. Existing `updateWorkout` patches a record in place. No server/API change is needed for the Home quick-log behavior.

## Binding product rules

- A local day may contain both one Strength and one Cardio workout.
- Repeating a kind must never add another quick-log entry for that local day.
- A strictly higher effort replaces the existing effort for that kind by updating the existing record. Effort order is Low < Medium < Hard.
- Equal or lower effort is a no-op with clear feedback; it must not POST or PATCH.
- Undo after a new entry deletes that entry. Undo after an upgrade restores the previous effort rather than deleting the workout.
- Home clearly shows today's logged state and highest effort independently for Strength and Cardio.
- Existing Mobility behavior and weekly goal semantics remain unchanged. Attack-day exercise suppression remains unchanged.
- The normal view's core above-fold content includes Attack start, day-state controls/guidance, Strength and Cardio quick log, all four acute and both preventive medication buttons, and important med limit/stock information.
- Past attack/med/pain actions and additional same-day medication details may be below the fold. Active attack, note editing, dialogs, and unusually large additional datasets are exceptional states and may scroll.

## Scope and constraints

- Focus on `WorkoutQuickLog`, mobile layout in `Home`, mobile main spacing in `Layout` if needed, and meaningful frontend tests.
- Preserve the prior DayCheckIn, History, Reports, contrast, and navigation improvements.
- No server, API, migration, dependency, reminder, or deployment changes.
- Do not silently deduplicate or delete existing historical records. New quick-log actions must not create further duplicates; pre-existing duplicate/imported data remains intact.
- Keep the two-tap new-log and valid-upgrade flows, accessible names, visible focus, dark palette, and roughly 40px primary targets.
- Avoid desktop regressions and broad redesigns.

## Edge cases

- Strength and Cardio on the same day must coexist.
- Same-kind equal/lower effort must preserve the record and its timestamp/details.
- Higher effort updates only effort, preserving record ID, timestamp, notes, and duration.
- Weekly counts must not increase on an upgrade or rejected repeat.
- Invalid timestamps must not be treated as today's records.
- Existing same-day duplicates are not automatically removed; choose a deterministic current record for display/update and document the choice if relevant.
- Today's state must use the configured timezone's local day, not the UTC date.

## Definition of done

- New/upgrade/reject/Undo behavior is covered by tests, including Strength and Cardio coexistence and visible today state.
- On an approximately 412 × 915 viewport with normal seeded data, all defined core controls and critical stock/limit badges are visible above the fixed bottom navigation without scrolling.
- Additional past actions may begin below the fold; no horizontal overflow occurs at 360px or the Oppo-class width.
- Actual production-build browser checks cover mobile and desktop, new log, rejected repeat, higher-effort upgrade, Undo, both kinds, Attack suppression, console errors, and critical med information.
- Full verification passes from `app/`: `npm test`, `npm run lint`, `npm run build`, `npm run validate:pwa`, `npm test --prefix server`, and `node --check server/index.js`.
- Independent review findings are resolved or disclosed. Disposable review processes/data are cleaned up.

## Implementation notes

- Duplicate policy (`WorkoutQuickLog`): for a kind and configured local day, the "current" record is the highest effort (low < medium < hard), tie-broken by the latest valid `performedAt`, then by later position in `state.workouts`; duplicates are never deleted or merged.
- Undo after an upgrade restores the previous effort through `updateWorkout` (id, performedAt, notes and duration survive); only a new log's Undo deletes the entry.
- The unknown-stock Nurtec badge now reads `no count` (was `stock not set`) so it fits the 4-up mobile card; its explanatory `title` is unchanged.

## Attack mental-model correction (follow-up)

- The day check-in offers Well/Off only. Attack is displayed from real attack records or a legacy explicit Attack day record; the small chip never creates a disconnected day-only attack.
- An active real attack overrides any earlier Well/Off record for Home guidance and exercise suppression. Home hides the redundant wellness card while the active-attack banner is present and shows rest guidance in that banner.
- After an attack ends, an explicit Well/Off recovery choice may override the inferred Attack day. Without an explicit choice, the day remains Attack/Rest. The primary CTA reads `Another attack started` when an attack already overlaps today.
- Day notes remain available on inferred/legacy Attack days. Saving a note without an existing day record latches an Attack record; Change offers Well/Off and preserves notes.
- Pain intensity and attack presence are distinct: the pain dialog always offers `0`, including with no active attack. Choosing it deliberately starts a real 0-pain attack (for example vestibular or analgesic-treated migraine), not an Off day; the dialog makes that distinction explicit.
- Off-day guidance should recommend an action Home can actually log: a 10-minute walk as Cardio/Low, rather than sending the user to History for Mobility.
- These changes are frontend presentation/Home behavior only; notification rules and APIs remain unchanged.

Implementation: `DayCheckIn` takes `effectiveStatus?: DayStateStatus | null` (explicit record wins; inferred `attack` renders the collapsed pill) and its note save on a record-less inferred day calls `setDayState(todayKey, 'attack', note)` to latch the day record (an empty draft only closes the editor without latching a record). Home owns `attackOverlapsToday`, hides the wellness section while `activeAttack` exists and prints `Rest — no exercise needed.` in the banner, labels the CTA `Another attack started` when an attack already overlaps today, always renders the pain `0` button, and uses `Easy day — a 10-min walk counts (Cardio · Low).` for Off days.
