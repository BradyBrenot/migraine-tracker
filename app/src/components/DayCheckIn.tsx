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

const STATUSES: DayStateStatus[] = ['well', 'off', 'attack'];

/**
 * Compact check-in for today's overall state. An explicit choice is always
 * available — attack days included — because this is the user's own record,
 * not a derived one.
 */
export default function DayCheckIn() {
  const { state, setDayState } = useStore();
  const now = useNow();
  const todayKey = localDayKey(now, state.timezone);
  const record = state.dayStates.find((d) => d.day === todayKey) ?? null;

  const [editing, setEditing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const showChoices = editing || !record;

  function choose(status: DayStateStatus) {
    setDayState(todayKey, status);
    setEditing(false);
    setNoteOpen(false);
  }

  function saveNote() {
    if (!record) return;
    // Empty string is intentional: store treats it as an explicit clear.
    setDayState(todayKey, record.status, noteDraft.trim());
    setNoteOpen(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Today
          </span>
          {showChoices ? (
            <div className="flex items-center gap-1.5">
              {STATUSES.map((status) => {
                const meta = STATUS_META[status];
                const selected = record?.status === status;
                return (
                  <button
                    key={status}
                    type="button"
                    onClick={() => choose(status)}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors active:scale-95 ${
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
          ) : record ? (
            <span
              className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_META[record.status].pill}`}
            >
              Today: {STATUS_META[record.status].label}
            </span>
          ) : null}
        </div>
        {!showChoices && record && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              aria-expanded={noteOpen}
              onClick={() => {
                setNoteDraft(record.notes);
                setNoteOpen((open) => !open);
              }}
              className="text-xs font-medium text-slate-400 underline underline-offset-2 transition-colors hover:text-slate-200"
            >
              Note
            </button>
            <button
              type="button"
              onClick={() => {
                setNoteOpen(false);
                setEditing(true);
              }}
              className="text-xs font-medium text-slate-400 underline underline-offset-2 transition-colors hover:text-slate-200"
            >
              Change
            </button>
          </div>
        )}
      </div>
      {!showChoices && record && noteOpen && (
        <div className="flex items-center gap-1.5">
          <input
            aria-label="Day note"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="Optional note…"
            className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={saveNote}
            className="shrink-0 rounded-md border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-300 hover:border-slate-500"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setNoteOpen(false)}
            className="shrink-0 text-xs text-slate-500 hover:text-slate-300"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
