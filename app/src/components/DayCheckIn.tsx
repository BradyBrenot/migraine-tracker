import { useState } from 'react';
import { useStore } from '@/lib/store';
import { useNow } from '@/lib/clock';
import { localDayKey } from '../../shared/datetime.ts';
import type { DayStateStatus } from '@/types';

const STATUS_META: Record<DayStateStatus, { label: string; pill: string }> = {
  well: { label: 'Well', pill: 'border-emerald-900 bg-emerald-950/60 text-emerald-300' },
  off: { label: 'Off', pill: 'border-amber-900 bg-amber-950/60 text-amber-300' },
  attack: { label: 'Attack', pill: 'border-rose-900 bg-rose-950/60 text-rose-300' },
};

/**
 * Choices offered to the user: Well and Off only. Attack is display-only — it
 * comes from real attack records (via `effectiveStatus`) or a legacy explicit
 * Attack day record, never from this check-in.
 */
const CHOICES: DayStateStatus[] = ['well', 'off'];

/**
 * Compact check-in for today's overall state. One row: a "Today" label, the
 * current status pill (no "Today: …" duplication) or the two choices, and
 * right-aligned Note/Change actions.
 *
 * The product model separates the day check-in from attacks:
 * - an explicit `record` always wins for display and Change offers Well/Off;
 * - with no record, `effectiveStatus` — computed by the parent from real
 *   attacks — may render a collapsed inferred Attack day (pill + Note/Change);
 * - saving a NON-EMPTY note on such an inferred day latches an explicit Attack
 *   record so the note has somewhere to live (Change then preserves it via the
 *   store); a blank draft just closes the editor without latching.
 *
 * `guidance` — computed by the parent from the effective day state — is shown
 * on collapsed and record-less days and hidden while actively re-choosing.
 */
export default function DayCheckIn({
  guidance,
  effectiveStatus,
  displayOverride,
}: {
  guidance?: string;
  /**
   * Parent-computed `effectiveDayState` for today. Only consulted when no
   * explicit record exists; an explicit record always wins.
   */
  effectiveStatus?: DayStateStatus | null;
  /**
   * Display-only pill override. The Log page uses `attack` while an attack is
   * actually in progress so an earlier explicit Well/Off record cannot make the
   * card read "Well" under an active-attack banner. It never changes what a
   * later choice or note saves.
   */
  displayOverride?: DayStateStatus | null;
}) {
  const { state, setDayState } = useStore();
  const now = useNow();
  const todayKey = localDayKey(now, state.timezone);
  const record = state.dayStates.find((d) => d.day === todayKey) ?? null;

  const [editing, setEditing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');

  // Inferred Attack is display-only: no record, but real attacks cover today.
  const inferredAttack = !record && effectiveStatus === 'attack';
  const displayStatus: DayStateStatus | null =
    displayOverride ?? record?.status ?? (inferredAttack ? 'attack' : null);
  // An active-attack display override keeps Attack primary, but an explicit
  // Well/Off choice made during the attack must still be acknowledged here so
  // the user sees that their choice was recorded.
  const overrideNotice =
    displayOverride && record && record.status !== displayOverride
      ? `day marked ${STATUS_META[record.status].label}`
      : null;
  const showChoices = editing || displayStatus === null;

  function choose(status: DayStateStatus) {
    setDayState(todayKey, status);
    setEditing(false);
    setNoteOpen(false);
  }

  function saveNote() {
    // Inferred Attack days have no record yet: saving a note latches an
    // explicit Attack record so the note is persisted like any other day.
    const status = record?.status ?? displayStatus;
    if (!status) return;
    // A record-less inferred Attack day has no note to clear: an empty draft
    // just closes the editor instead of latching a valueless Attack record.
    if (!record && !noteDraft.trim()) {
      setNoteOpen(false);
      return;
    }
    // Empty string is intentional: store treats it as an explicit clear.
    setDayState(todayKey, status, noteDraft.trim());
    setNoteOpen(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Today
        </span>
        {showChoices ? (
          <div className="flex items-center gap-1.5">
            {CHOICES.map((status) => {
              const meta = STATUS_META[status];
              const selected = record?.status === status;
              return (
                <button
                  key={status}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => choose(status)}
                  className={`min-h-11 rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors active:scale-95 sm:min-h-10 ${
                    selected
                      ? meta.pill
                      : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
        ) : (
          displayStatus && (
            <span
              className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_META[displayStatus].pill}`}
            >
              {STATUS_META[displayStatus].label}
            </span>
          )
        )}
        {overrideNotice && !showChoices && (
          <span role="status" className="text-xs font-medium text-slate-300">
            {overrideNotice}
          </span>
        )}
        {!showChoices && displayStatus ? (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-expanded={noteOpen}
              onClick={() => {
                setNoteDraft(record?.notes ?? '');
                setNoteOpen((open) => !open);
              }}
              className="inline-flex min-h-11 items-center rounded-lg px-2.5 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 sm:min-h-10"
            >
              Note
            </button>
            <button
              type="button"
              onClick={() => {
                setNoteOpen(false);
                setEditing(true);
              }}
              className="inline-flex min-h-11 items-center rounded-lg px-2.5 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 sm:min-h-10"
            >
              Change
            </button>
          </div>
        ) : editing ? (
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="ml-auto inline-flex min-h-11 items-center rounded-lg px-2.5 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 sm:min-h-10"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {!editing && guidance && <p className="text-xs text-slate-400">{guidance}</p>}
      {!showChoices && displayStatus && noteOpen && (
        <div className="flex items-center gap-1.5">
          <input
            aria-label="Day note"
            autoFocus
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                saveNote();
              } else if (e.key === 'Escape') {
                setNoteOpen(false);
              }
            }}
            placeholder="Optional note…"
            className="min-h-10 min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={saveNote}
            className="min-h-11 shrink-0 rounded-md border border-slate-700 px-2.5 text-xs font-semibold text-slate-300 hover:border-slate-500 sm:min-h-10"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setNoteOpen(false)}
            className="min-h-11 shrink-0 rounded-md px-2 text-xs font-medium text-slate-400 hover:text-slate-200 sm:min-h-10"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
