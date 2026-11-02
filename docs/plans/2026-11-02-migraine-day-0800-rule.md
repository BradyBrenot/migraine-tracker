# Migraine day: the local 08:00-to-08:00 rule (2026-11-02)

## Goal

A local calendar day counts as an attack/migraine day when the user was in an
attack during that day's migraine-day window. The window starts at 08:00, not
midnight, so:

- a migraine that ended while the user was asleep (e.g. 22:00 the previous
  night -> 06:00 today) does **not** mark today;
- an early-morning migraine (e.g. 01:00-02:00 on Nov 2) counts **Nov 1**, so it
  never silently disappears;
- a migraine that crosses 08:00 counts **both** adjacent days (it genuinely
  overlapped both windows).

## Rule

- A local migraine day runs from `08:00` to `08:00` the next day. A day
  **counts** when at least one attack overlaps
  `[08:00 on that day, 08:00 on the next local day)`.
- Fixed at `08:00` local (`ATTACK_DAY_START_TIME` /
  `ATTACK_DAY_START_MINUTE` in `app/shared/attackstats.ts`). It is a product
  rule, not a setting, and is independent of the reminder `wakingStart`.
- DST-safe: both window bounds come from `zonedDateTimeToMs`, never fixed 24h
  arithmetic. This also avoids `dayKeyStartMs` being an hour early in zones
  whose DST starts at local midnight (e.g. America/Santiago, America/Havana).
- Half-open: an attack ending exactly at 08:00 counts the previous day, not the
  day whose window starts there. A zero-duration attack exactly at 08:00 counts
  the new day.
- Degenerate attacks (zero/negative duration, missing or unparseable end) are
  reduced to their start instant and use the same pre-/post-08:00 attribution.
- An ongoing attack uses `nowMs` as its end (via `parseAttackTimes`), so its
  attributed day(s) can grow while it continues; a day already attributed does
  not disappear when the attack crosses 08:00.

### Implementation

`attackCountsAsAttackDay(startMs, endMs, dayKey, timeZone)` is the single
predicate. `attackDayKeys` returns the attributed days:

- a start before 08:00 also adds the previous local day;
- a single-day attack is tested against its own window;
- a multi-day attack always overlaps its first and every full middle day, so
  only the last (possibly pre-08:00 tail) day is tested;
- non-ISO / pathological instants keep the historical `[first]` fallback and
  never throw. A final representable key (`9999-12-31`) is kept fail-open
  because no next window end is representable. Historical whole-day-skips
  (e.g. Pacific/Apia 2011-12-30) remain an accepted exception for an
  untested middle key.

`attackDayKeysInMonth` remains a pass-through filter over those keys.

### Performance: steady-state ticks are history-independent

Two layers keep the 15s Home/PartnerHome tick cheap.

**1. Intl-free coarse filter inside the predicate.** `attackCountsAsAttackDay`
first checks a conservative UTC window `[UTC midnight - 24h, UTC midnight + 72h]`.
Real IANA offsets are within -12h..+14h (historical LMT within ±16h), so the
true local 08:00-to-08:00 window is contained; a miss cannot be a false
negative, and every coarse hit still runs the exact `zonedDateTimeToMs` check.
The year-9999 fail-open is checked before the fast path. This alone cut a
full-history clear-day scan from **24.5 / 96 / 243 / 474 ms** to
**0.2 / 0.6 / 1.4 / 2.9 ms** for 500 / 2,000 / 5,000 / 10,000 attacks on
Node 24 desktop, and is pinned by a `formatToParts` zero-call test.

**2. Finished-history indexes in the pages.**
`useTodayAttackFacts` + `buildAttackIndex` parse finished attacks once per data
change and evaluate their day/overlap facts once per local day; only
`end === null` attacks are re-evaluated per tick. A `buildMedIndex` per
`state.meds` makes rolling usage/painkiller/hint queries touch only the
in-window instant tail, and `useNurtecInventory` memoizes the Nurtec-only
filtered parts while `shared/inventory.ts` revalidates source strings/timezone
on its instant caches. On Node 24 desktop with 10,000 attacks the measured
steady-state tick drops to **~0.005 ms** (finished build ~5 ms once on
mount/data change); with 10,000 meds the uncached ~2.9 ms rolling scans become
index queries over the window tail plus Nurtec-sized stock arithmetic.

Deterministic tests pin this without timing thresholds: `Date.parse` is not
called on a Home/PartnerHome tick for finished attacks, the med-index variants
are differentially tested against the originals, and inventory caches are
tested for in-place mutation and timezone revalidation.

**3. Calendar and Reports.** Calendar now filters the attack index to the
visible six-week grid using the exact `08:00` bound after the last visible day,
so only the attacks that can affect the grid are parsed/day-keyed. Reports uses
the page-level attack/med indexes, computes day keys lazily only for attacks
that can touch the displayed month/trend window, and caches finished-attack
day keys. On Node 24 desktop with 10,000 attacks, Calendar's counted-day scan
drops from ~650 ms to the visible subset, and the 12-month trend drops from
~673 ms to ~9 ms per ongoing tick with prebuilt indexes (the remainder is
medication day bucketing plus the 12-month loop). The cache structurally
refuses ongoing attacks, so an attack crossing 08:00 still gains the new day.

## Consumers

- `app/src/lib/report.ts`: month day counts and the Markdown "attack days" use
  the attributed keys. `buildReportLines` anchors coverage to the first
  attributed day (not the start instant's month), so a Feb 1 01:00 attack still
  produces a January section with Jan 31's day. A month is "known" when it has
  a counted day, any raw attack overlap (even a 0-day tail), or a medication.
- `app/src/pages/Reports.tsx`: "Days affected" uses all attacks' attributed
  days, so a pre-08:00 attack next month still lands in this month's last day;
  "Attacks" remains raw month overlap. The card sub-copy reads `08:00–08:00`.
- `app/src/pages/CalendarPage.tsx`: raw overlap still drives the day sheet's
  attack list, bars, raw attack count, and accessible name; attributed keys
  drive the tint, inferred day state, and month "attack days". A tail-only
  attributed day (the attack's bar is on the next calendar day) shows an
  explanatory message rather than "Nothing logged this day".
- `app/src/pages/Home.tsx` and `PartnerHome.tsx`: the CTA keeps raw overlap;
  inferred Off for *today* uses the counted 08:00-to-08:00 window only.
- `app/shared/daystate.ts`: parameter/JSDoc renamed to `countsAsAttackDay`.
- `app/src/components/DayCheckIn.tsx`: JSDoc clarifies the rule.

### Month-boundary presentation

An attack is still listed/counted as an attack in its **start month**. Its
attributed days can fall in the previous month (e.g. Feb 1 01:00 -> Jan 31), so
a report can legitimately say "January: 1 attack day · 0 attacks" and
"February: 0 attack days · 1 attack". The same asymmetry exists for multi-day
attacks spanning a month boundary; no day is lost.

## Intentionally out of scope

- Explicit `markDayOff` day-state writes and their undo provenance in the
  store are unchanged. They are an explicit current-day rewrite, not the
  windowed attack-day count, so an existing record can still become Off on a
  day the count attributes elsewhere.
- Reminder exercise suppression (`shared/reminders.ts`) is unchanged and keeps
  its deliberate raw-overlap policy.
- Attack bars/timelines, attack lists/counts/durations, and "N attacks" counts
  are unchanged.
- Backend/API/schema/export/backup: no stored data or schema changes.

## Test coverage

- `app/shared/attackstats.test.ts`: 07:59/08:00/08:01 boundaries, half-open
  ends, early-morning-to-previous-day attribution, crossing attacks counting
  both days, ongoing attacks, degenerate cases, zone attribution, cross-month
  clips, DST fall-back, midnight-DST zones (Santiago), year-9999/275760
  non-throwing fallbacks.
- `app/src/lib/report.test.ts`: per-month attributed days, cross-month tails,
  early-morning previous-month days, known-zero months, trend rows, zone
  bucketing and coverage anchoring.
- `app/src/pages/Reports.test.tsx`: October/November tail behaviour, a Nov 1
  early-morning attack counted as Oct 31, and agreement with the Calendar
  month header.
- `app/src/pages/CalendarPage.test.tsx`: header vs sheet on DST, midnight and
  01:00-06:00 attacks attributed to the previous day with the explanatory sheet
  message, and a frozen-clock Off inference test.
- `app/src/pages/Home.wellness.test.tsx`: frozen-clock Off inference, the
  before-08:00 no-inference regression, the after-08:00 companion, and the
  raw-overlap CTA.
- `app/src/pages/PartnerHome.test.tsx`: a before-08:00 tail does not infer Off
  today; a post-08:00 ended attack still does.
