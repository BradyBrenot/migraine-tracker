import { useEffect, useState } from 'react';
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
 * comes from a real active attack (via `displayOverride`), the shared
 * attack-day inference (which is Off), or a legacy explicit Attack day record,
 * never from this check-in.
 */
const CHOICES: DayStateStatus[] = ['well', 'off'];

/**
 * Compact check-in for today's overall state. One row: a "Today" label, the
 * current status pill (no "Today: …" duplication) or the two choices, and
 * right-aligned Note/Change actions.
 *
 * The product model separates the day check-in from attacks:
 * - an active attack `displayOverride` shows Attack and `locked` removes
 *   Well/Off and Change entirely for its duration;
 * - otherwise an explicit `record` wins and Change offers Well/Off;
 * - with no record, `effectiveStatus` — computed by the parent from real
 *   attacks — renders the day (attack days are Off), collapsed with Note/Change;
 * - saving a NON-EMPTY note on a record-less day latches that effective status
 *   so the note has somewhere to live (never Attack); a blank draft just closes
 *   the editor without latching.
 *
 * `guidance` — computed by the parent from the effective day state — is shown
 * on collapsed and record-less days and hidden while actively re-choosing.
 */
export default function DayCheckIn({
  guidance,
  effectiveStatus,
  displayOverride,
  locked = false,
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
  /**
   * true while an attack is active: the day follows the attack, so neither a
   * Well/Off choice nor Change is offered. A Change editor that was already
   * open is closed so the controls cannot outlive the attack.
   */
  locked?: boolean;
}) {
  const { state, setDayState } = useStore();
  const now = useNow();
  const todayKey = localDayKey(now, state.timezone);
  const record = state.dayStates.find((d) => d.day === todayKey) ?? null;

  const [editing, setEditing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');

  // Locking is driven by an external event (an attack starting), so a stale
  // re-choose editor must be discarded. This is a controlled reset, not
  // render-derived state.
  useEffect(() => {
    if (locked && editing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditing(false);
    }
  }, [locked, editing]);

  const displayStatus: DayStateStatus | null =
    displayOverride ?? record?.status ?? effectiveStatus ?? null;
  const showChoices = !locked && (editing || displayStatus === null);

  function choose(status: DayStateStatus) {
    setDayState(todayKey, status);
    setEditing(false);
    setNoteOpen(false);
  }

  function saveNote() {
    // A record-less day (including an attack day, which infers Off) has no
    // record yet: saving a note latches the effective status so the note is
    // persisted like any other day. It is never latched as Attack.
    const status = record?.status ?? effectiveStatus;
    if (!status) return;
    // A record-less day has no note to clear: an empty draft just closes the
    // editor instead of latching a valueless record.
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
            {!locked && (
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
            )}
          </div>
        ) : editing && !locked ? (
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
