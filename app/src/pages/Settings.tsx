import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Upload, Trash2, Sparkles, FileDown, FileUp, AlertTriangle, Pill, Plus,
} from 'lucide-react';
import { useStore } from '@/lib/store';
import { ApiError, api } from '@/lib/api';
import { nurtecInventory, parseTabletQuantity } from '@/lib/inventory';
import { useNow } from '@/lib/clock';
import { fmtDateFull, fmtTime, toLocalInput } from '@/lib/format';
import { MED_CATALOG, medColor } from '@/lib/meds';
import { importMigraineBuddyCSV, type ImportResult } from '@/lib/mbImport';
import { isValidTimeZone } from '../../shared/datetime.ts';
import {
  normalizeReminderSettings, reminderSettingsErrors,
} from '../../shared/reminders.ts';
import { parseBackup } from '../../shared/backup.ts';
import type { BackupRecordKey, ParsedBackup } from '../../shared/backup.ts';
import type { ReminderSettings, TrackerState } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

type AttackAlertStatus = 'checking' | 'configured' | 'not-configured' | 'unavailable';

const BACKUP_RECORD_KEYS: readonly BackupRecordKey[] = [
  'attacks', 'meds', 'refills', 'workouts', 'dayStates', 'stockBaselines',
];

const BACKUP_RECORD_LABELS: Record<
  BackupRecordKey,
  { singular: string; plural: string; preview: string }
> = {
  attacks: { singular: 'attack', plural: 'attacks', preview: 'attacks' },
  meds: { singular: 'medication entry', plural: 'medication entries', preview: 'medication entries' },
  refills: { singular: 'refill', plural: 'refills', preview: 'refills' },
  workouts: { singular: 'workout', plural: 'workouts', preview: 'workouts' },
  dayStates: { singular: 'day state', plural: 'day states', preview: 'day states' },
  stockBaselines: {
    singular: 'starting count',
    plural: 'starting counts',
    preview: 'starting counts',
  },
};

/** Human label for the two accepted on-disk formats. */
function backupFormatLabel(backup: ParsedBackup): string {
  if (backup.format === 'envelope') {
    return backup.schemaVersion === null
      ? 'Server backup (legacy)'
      : `Server backup · schema v${backup.schemaVersion}`;
  }
  return 'Browser export';
}

/** Local date/time for `exportedAt`, falling back to the raw value. */
function formatExportedAt(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : value;
}

/**
 * How many backup records already exist locally, using the same key rules as
 * the merge action: ids (blank ids are new — the server assigns one) and day
 * states by day.
 */
function countAlreadyPresent(
  backup: ParsedBackup,
  state: TrackerState,
): Record<BackupRecordKey, number> {
  const attackIds = new Set(state.attacks.map((a) => a.id));
  const medIds = new Set(state.meds.map((m) => m.id));
  const refillIds = new Set(state.refills.map((r) => r.id));
  const workoutIds = new Set(state.workouts.map((w) => w.id));
  const dayKeys = new Set(state.dayStates.map((d) => d.day));
  const baselineIds = new Set(state.stockBaselines.map((b) => b.id));
  return {
    attacks: backup.attacks.filter((a) => a.id !== '' && attackIds.has(a.id)).length,
    meds: backup.meds.filter((m) => m.id !== '' && medIds.has(m.id)).length,
    refills: backup.refills.filter((r) => r.id !== '' && refillIds.has(r.id)).length,
    workouts: backup.workouts.filter((w) => w.id !== '' && workoutIds.has(w.id)).length,
    dayStates: backup.dayStates.filter((d) => dayKeys.has(d.day)).length,
    stockBaselines: backup.stockBaselines
      .filter((b) => b.id !== '' && baselineIds.has(b.id)).length,
  };
}

function describeAddedCounts(added: Record<BackupRecordKey, number>): string {
  return BACKUP_RECORD_KEYS
    .filter((key) => added[key] > 0)
    .map((key) => {
      const labels = BACKUP_RECORD_LABELS[key];
      return `${added[key]} ${added[key] === 1 ? labels.singular : labels.plural}`;
    })
    .join(', ');
}

/**
 * A 400/413 from the server is a DEFINITE rejection before any write: both
 * bulk routes validate the payload (and enforce the 25 MiB body limit) before
 * their transaction, so "nothing changed" is safe to say. Everything else —
 * a 5xx, a network failure, or the bulk timeout — leaves the outcome unknown
 * and must never claim nothing changed.
 */
function isDefiniteRestoreRejection(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 400 || error.status === 413);
}

const TOO_LARGE_DESCRIPTION =
  'Restore uploads are limited to 25 MB. Use a smaller backup, or restore the '
  + 'SQLite files (see DEPLOY.md).';

const UNCONFIRMED_DESCRIPTION =
  'The server may already have applied the replacement — check the current data before retrying.';

export default function Settings() {
  const store = useStore();
  const { state } = store;
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [useServerOpen, setUseServerOpen] = useState(false);
  const [tzDraft, setTzDraft] = useState<string | null>(null);
  const [baselineQuantity, setBaselineQuantity] = useState('');
  const [baselineNotes, setBaselineNotes] = useState('');
  /** null = untouched (follows "now"); string = the user's datetime-local draft. */
  const [baselineAt, setBaselineAt] = useState<string | null>(null);
  /** null = follow the persisted settings; otherwise an unsaved form draft. */
  const [reminderDraft, setReminderDraft] = useState<ReminderSettings | null>(null);
  const [attackAlertStatus, setAttackAlertStatus] =
    useState<AttackAlertStatus>('checking');
  const now = useNow();

  // ── JSON backup restore (merge / replace) ──────────────────────────
  const jsonFileRef = useRef<HTMLInputElement>(null);
  const [jsonPreview, setJsonPreview] = useState<
    { filename: string; backup: ParsedBackup } | null
  >(null);
  /** Parser/read error shown inline until a new file or explicit dismissal. */
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  /**
   * Synchronous guard so a double click cannot start the destructive action
   * twice before React re-renders the disabled buttons.
   */
  const restoreBusyRef = useRef(false);
  /**
   * Monotonic token for the JSON file read. Reading is async, so without it a
   * slow earlier pick could resolve AFTER a newer one and overwrite that
   * pick's preview/error state. Incremented per accepted pick; a stale read
   * bails at every await boundary.
   */
  const jsonReadTokenRef = useRef(0);

  // Read-only environment configuration. Fetched once; a late response after
  // unmount is ignored, and any failure/malformed body reads as unavailable.
  useEffect(() => {
    let cancelled = false;
    void api.getHealth()
      .then((health) => {
        if (cancelled) return;
        const configured = health?.notifications?.attackAlerts;
        if (configured === true) setAttackAlertStatus('configured');
        else if (configured === false) setAttackAlertStatus('not-configured');
        else setAttackAlertStatus('unavailable');
      })
      .catch(() => {
        if (!cancelled) setAttackAlertStatus('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const attackAlertLabel = attackAlertStatus === 'checking'
    ? 'Checking…'
    : attackAlertStatus === 'configured'
      ? 'Configured'
      : attackAlertStatus === 'not-configured'
        ? 'Not configured'
        : 'Unavailable';

  const savedReminders = normalizeReminderSettings(state.reminders);
  const reminderForm = reminderDraft ?? savedReminders;
  const reminderErrors = reminderSettingsErrors(reminderForm);
  const remindersDirty = JSON.stringify(reminderForm) !== JSON.stringify(savedReminders);

  function editReminders(patch: Partial<ReminderSettings>) {
    setReminderDraft({ ...reminderForm, ...patch });
  }

  const tzValue = tzDraft ?? state.timezone;
  const tzTrimmed = tzValue.trim();
  const tzValid = isValidTimeZone(tzTrimmed);
  const tzChanged = tzTrimmed !== state.timezone;

  const inventory = nurtecInventory(state, now);
  const baselineAtValue = baselineAt ?? toLocalInput(new Date(now));
  const baselineAtParsed = baselineAt ? Date.parse(baselineAt) : now;
  const baselineEffectiveMs = Number.isFinite(baselineAtParsed) ? baselineAtParsed : now;
  const baselineQuantityParsed = parseTabletQuantity(baselineQuantity);
  const canAddBaseline = baselineQuantityParsed.valid && baselineQuantityParsed.quantity !== null;
  const nurtecBaselines = [...state.stockBaselines]
    .filter((b) => b.medId === 'nurtec')
    .sort((a, b) =>
      b.effectiveAt.localeCompare(a.effectiveAt) || b.createdAt.localeCompare(a.createdAt));

  const previewBackup = jsonPreview?.backup ?? null;
  const alreadyPresent = previewBackup ? countAlreadyPresent(previewBackup, state) : null;
  const alreadyPresentTotal = alreadyPresent
    ? BACKUP_RECORD_KEYS.reduce((sum, key) => sum + alreadyPresent[key], 0)
    : 0;
  const duplicateTotal = previewBackup
    ? BACKUP_RECORD_KEYS.reduce((sum, key) => sum + previewBackup.duplicateCounts[key], 0)
    : 0;

  function addBaseline() {
    if (!canAddBaseline || baselineQuantityParsed.quantity === null) return;
    store.addStockBaseline({
      medId: 'nurtec',
      effectiveAt: new Date(baselineEffectiveMs).toISOString(),
      quantity: baselineQuantityParsed.quantity,
      notes: baselineNotes.trim(),
    });
    toast.success('Starting count added');
    setBaselineQuantity('');
    setBaselineNotes('');
    setBaselineAt(null);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const result = importMigraineBuddyCSV(text);
    if (!result.attacks.length && !result.meds.length) {
      toast.error('Nothing importable found', {
        description: result.warnings[0] ?? 'Check that this is a Migraine Buddy CSV export.',
      });
      return;
    }
    setPreview(result);
  }

  function confirmImport() {
    if (!preview) return;
    store.importData(preview.attacks, preview.meds);
    toast.success(
      `Imported ${preview.attacks.length} attacks and ${preview.meds.length} medication entries`,
    );
    setPreview(null);
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `migraine-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleJsonFile(e: React.ChangeEvent<HTMLInputElement>) {
    // Belt-and-suspenders: the picker button is disabled while an operation is
    // in flight, but a programmatic change (or a race with the re-render) must
    // never replace the preview under a restore that is already running. The
    // value is still cleared so a later pick of the same file fires onChange;
    // no preview/error state is touched.
    if (restoreBusyRef.current) {
      e.target.value = '';
      return;
    }
    // Only the newest pick may publish a preview/error (see the ref's note).
    const token = ++jsonReadTokenRef.current;
    const file = e.target.files?.[0];
    // Reset immediately so choosing the same file again still fires onChange.
    e.target.value = '';
    if (!file) return;
    setJsonError(null);

    let text: string;
    try {
      text = await file.text();
    } catch {
      if (token !== jsonReadTokenRef.current) return;
      toast.error('Could not read the backup file', {
        description: `“${file.name}” could not be read. Nothing was changed.`,
      });
      return;
    }
    // A newer pick superseded this read while it was in flight: the rest of
    // this handler (parsing + setState below) must not run.
    if (token !== jsonReadTokenRef.current) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const message = `“${file.name}” is not valid JSON: ${(error as Error).message}`;
      setJsonError(message);
      toast.error('Not a valid JSON file', { description: message });
      return;
    }

    const result = parseBackup(parsed);
    if (!result.ok) {
      const message = `“${file.name}” is not a supported backup: ${result.error}`;
      setJsonError(message);
      toast.error('Backup not recognized', { description: message });
      return;
    }

    setJsonPreview({ filename: file.name, backup: result.backup });
  }

  async function mergeFromPreview() {
    const preview = jsonPreview;
    if (!preview || restoreBusyRef.current) return;
    restoreBusyRef.current = true;
    setRestoreBusy(true);
    try {
      const { added, synced } = store.mergeBackup(preview.backup);
      const total = BACKUP_RECORD_KEYS.reduce((sum, key) => sum + added[key], 0);
      if (total === 0) {
        toast.success('Nothing new to add — all records already exist');
      } else {
        toast.success(`Added ${describeAddedCounts(added)}`);
      }
      // The queue already reports a generic sync failure; this names the
      // consequence for the records that were just added locally. It must not
      // promise an automatic merge: nothing will reach the server on its own.
      // A definite 400/413 means the server rejected the payload before
      // writing anything; everything else is an uncertain outcome.
      synced.catch((error: unknown) => {
        if (isDefiniteRestoreRejection(error)) {
          if (error.status === 413) {
            toast.error('Backup file is too large', { description: TOO_LARGE_DESCRIPTION });
            return;
          }
          toast.error('Records were added on this device only', {
            description: 'The server rejected the import — nothing was added there.',
          });
          return;
        }
        toast.error('Records were added on this device only', {
          description: 'The server copy may not include them; these additions are marked unsynced.',
        });
      });
      setJsonPreview(null);
    } catch (error) {
      toast.error('Merge failed — nothing was changed', {
        description: error instanceof Error ? error.message : 'The backup could not be merged.',
      });
    } finally {
      restoreBusyRef.current = false;
      setRestoreBusy(false);
    }
  }

  async function replaceFromPreview() {
    const preview = jsonPreview;
    if (!preview || restoreBusyRef.current) return;
    restoreBusyRef.current = true;
    setRestoreBusy(true);
    try {
      await store.replaceBackup(preview.backup);
      setReplaceOpen(false);
      setJsonPreview(null);
      if (store.serverMode) {
        toast.success('Backup restored');
      } else {
        // Browser-only restore: nothing reached the server and nothing will
        // sync on its own — say so instead of implying a future sync.
        toast.success('Restore applied on this device only', {
          description: 'The server data was not changed. This device is marked unsynced.',
        });
      }
    } catch (error) {
      // No optimistic connected replace, so local state is untouched. The
      // server side is only certainly untouched for a 4xx rejection (the
      // restore route validates before its transaction); a 5xx/network/timeout
      // may have committed the replacement, so say the outcome is unknown.
      setReplaceOpen(false);
      if (isDefiniteRestoreRejection(error)) {
        if (error.status === 413) {
          toast.error('Backup file is too large', { description: TOO_LARGE_DESCRIPTION });
        } else {
          toast.error('Restore failed — nothing was changed', {
            description: error.message,
          });
        }
      } else {
        toast.error('Restore could not be confirmed', {
          description: UNCONFIRMED_DESCRIPTION,
        });
      }
    } finally {
      restoreBusyRef.current = false;
      setRestoreBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* import */}
      <section className="rounded-2xl border bg-slate-900 p-5 shadow-sm">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <Upload className="h-4 w-4" /> Import from Migraine Buddy
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          In Migraine Buddy: <em>Settings → Export → CSV</em>. The importer recognizes
          start/end times, pain level, medications, symptoms, triggers, and notes —
          and maps medications to your catalog (Nurtec, Tylenol, Ibuprofen, Naproxen, …).
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={handleFile}
        />
        <Button className="mt-3 gap-2" onClick={() => fileRef.current?.click()}>
          <Upload className="h-4 w-4" /> Choose CSV file
        </Button>
      </section>

      {/* med limits */}
      <section className="rounded-2xl border bg-slate-900 p-5 shadow-sm">
        <h2 className="text-base font-bold">Medication limits</h2>
        <p className="mt-1 text-sm text-slate-400">
          Usage-day limits per rolling window — these drive the warning bars on the Calendar tab.
          (Standard MOH guidance: triptans/gepants ≤ 10–15 days/month, NSAIDs &amp; acetaminophen ≤ 15 days/month.)
        </p>
        <div className="mt-4 space-y-3">
          {MED_CATALOG.filter((m) => m.defaultRule).map((m) => {
            const rule = state.rules[m.id] ?? m.defaultRule!;
            return (
              <div key={m.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex w-28 items-center gap-1.5 font-semibold">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: medColor(m.id) }} />
                  {m.name}
                </span>
                <span className="text-slate-400">max</span>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  className="h-8 w-16"
                  value={rule.limit}
                  onChange={(e) =>
                    store.setRule(m.id, Math.max(1, Number(e.target.value) || 1), rule.windowDays)
                  }
                />
                <span className="text-slate-400">days per</span>
                <Input
                  type="number"
                  min={7}
                  max={90}
                  className="h-8 w-16"
                  value={rule.windowDays}
                  onChange={(e) =>
                    store.setRule(m.id, rule.limit, Math.max(7, Number(e.target.value) || 30))
                  }
                />
                <span className="text-slate-400">days</span>
                <span className="ml-3 text-slate-400">·</span>
                <span className="ml-1 text-slate-400">default dose</span>
                <Input
                  className="h-8 w-24"
                  value={state.doses[m.id] ?? ''}
                  placeholder="—"
                  onChange={(e) => store.setDoseDefault(m.id, e.target.value)}
                />
              </div>
            );
          })}
        </div>
      </section>

      {/* Nurtec inventory */}
      <section className="rounded-2xl border bg-slate-900 p-5 shadow-sm">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <Pill className="h-4 w-4" /> Nurtec inventory
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Optimistic count from this device — the server&apos;s inventory count is authoritative.
        </p>

        <div className="mt-3 space-y-1 text-sm">
          {inventory.level === 'unknown' && (
            <p className="text-slate-400">Stock not set — add a starting count below</p>
          )}
          {inventory.level === 'negative' && (
            <p className="text-rose-300">
              Recorded stock is negative ({inventory.quantity} tablets) — correct it below.
            </p>
          )}
          {(inventory.level === 'ok' || inventory.level === 'low') && (
            <p className={inventory.level === 'low' ? 'text-amber-300' : 'text-slate-200'}>
              {inventory.quantity} tablets left
              {inventory.level === 'low' && (
                <> · Low (alert level {state.lowStockThreshold})</>
              )}
            </p>
          )}
        </div>

        {state.lowStockAlertedAt && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
            <span>
              Low-stock alert on since {new Date(state.lowStockAlertedAt).toLocaleDateString()}
            </span>
            <Button
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => store.resetLowStockAlert()}
            >
              Reset alert
            </Button>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <Label htmlFor="low-stock-threshold" className="text-slate-300">Alert level</Label>
          <Input
            id="low-stock-threshold"
            aria-label="Low-stock alert level"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            className="h-8 w-16"
            value={state.lowStockThreshold}
            onChange={(e) => {
              const raw = e.target.value.trim();
              // Ignore transient/invalid keystrokes instead of writing a bogus level.
              if (raw === '') return;
              const value = Number(raw);
              if (!Number.isInteger(value) || value < 0) return;
              store.setLowStockThreshold(value);
            }}
          />
          <span className="text-slate-400">tablets — alerts once when stock drops to this</span>
        </div>

        <div className="mt-5 border-t border-slate-800 pt-4">
          <h3 className="text-sm font-semibold">Add starting count / correction</h3>
          <p className="mt-1 text-xs text-slate-500">
            A new count replaces the running count from its effective time — use it to set
            the initial stock or correct drift (including a negative count).
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Tablets</Label>
              <Input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                aria-label="Starting tablet count"
                aria-invalid={!baselineQuantityParsed.valid}
                placeholder="e.g. 8"
                value={baselineQuantity}
                onChange={(e) => setBaselineQuantity(e.target.value)}
              />
              {!baselineQuantityParsed.valid && (
                <p role="alert" className="text-xs text-rose-300">
                  Tablets must be a whole number (0 or more).
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>
                Effective at <span className="font-normal text-slate-500">(optional)</span>
              </Label>
              <Input
                type="datetime-local"
                aria-label="Effective at"
                value={baselineAtValue}
                onChange={(e) => setBaselineAt(e.target.value)}
              />
            </div>
          </div>
          <div className="mt-2 space-y-1.5">
            <Label>Notes <span className="font-normal text-slate-500">(optional)</span></Label>
            <Input
              aria-label="Starting count notes"
              placeholder="e.g. initial count"
              value={baselineNotes}
              onChange={(e) => setBaselineNotes(e.target.value)}
            />
          </div>
          <Button className="mt-3 gap-2" onClick={addBaseline} disabled={!canAddBaseline}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>

        {nurtecBaselines.length > 0 && (
          <div className="mt-4 space-y-1.5">
            <h3 className="text-sm font-semibold">Starting counts &amp; corrections</h3>
            {nurtecBaselines.map((b) => (
              <div
                key={b.id}
                className="flex items-center gap-2 rounded-lg border bg-slate-950/40 px-3 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-slate-200">Quantity {b.quantity}</span>
                  <span className="text-slate-400">
                    {' '}· effective {fmtDateFull(b.effectiveAt)} at {fmtTime(b.effectiveAt)}
                  </span>
                  {b.notes && <span className="text-slate-400"> · {b.notes}</span>}
                </div>
                <button
                  onClick={() => {
                    store.deleteStockBaseline(b.id);
                    toast.success('Count deleted');
                  }}
                  className="rounded-lg p-2 text-slate-400 hover:bg-rose-950 hover:text-rose-400"
                  aria-label="Delete count"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* time zone */}
      <section className="rounded-2xl border bg-slate-900 p-5 shadow-sm">
        <h2 className="text-base font-bold">Time zone</h2>
        <p className="mt-1 text-sm text-slate-400">
          Current: <span className="font-semibold text-slate-200">{state.timezone}</span>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Controls local day and Sunday-start week buckets — including the weekly workout goals.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            aria-label="Time zone"
            aria-invalid={!tzValid}
            value={tzValue}
            placeholder="e.g. America/New_York"
            className="h-9 max-w-xs"
            onChange={(e) => setTzDraft(e.target.value)}
          />
          <Button
            disabled={!tzValid || !tzChanged}
            onClick={() => {
              if (!tzValid) return;
              store.setTimezone(tzTrimmed);
              setTzDraft(null);
            }}
          >
            Save
          </Button>
        </div>
        {!tzValid && (
          <p className="mt-2 text-xs text-rose-400">
            Enter a valid IANA time zone, e.g. America/New_York.
          </p>
        )}
      </section>

      {/* reminders */}
      <section className="rounded-2xl border bg-slate-900 p-5 shadow-sm">
        <h2 className="text-base font-bold">Reminders</h2>
        <p className="mt-1 text-sm text-slate-400">
          These non-secret preferences control which reminders are eligible and when.
          Delivery is configured on the server by the operator; the app never stores
          or displays delivery credentials, and a send is not proof that a phone
          displayed the message.
        </p>

        <div className="mt-3 rounded-lg border border-slate-800 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-200">Attack alerts</span>
            <span role="status" className="text-xs font-semibold text-slate-400">
              {attackAlertLabel}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Configuration comes from the server environment and is read-only here.
            It only indicates configuration — it gives no delivery guarantee, and a
            send is not proof that a phone displayed it.
          </p>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-slate-800 px-3 py-2">
          <div>
            <Label htmlFor="reminders-enabled" className="text-slate-200">Enable reminders</Label>
            <p className="text-xs text-slate-500">Master switch. Server delivery still requires NTFY_URL.</p>
          </div>
          <Switch
            id="reminders-enabled"
            aria-label="Enable reminders"
            checked={reminderForm.enabled}
            onCheckedChange={(checked) => editReminders({ enabled: checked })}
          />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {([
            ['preventive', 'Preventive doses', 'Emgality / Botox due dates'],
            ['lowStock', 'Low Nurtec stock', 'Once per low-stock episode'],
            ['checkIn', 'Daily check-in', 'When no Well/Off/Attack is logged'],
            ['exercise', 'Exercise', 'When this Sunday-week is behind goals'],
          ] as const).map(([key, label, hint]) => (
            <div
              key={key}
              className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 px-3 py-2"
            >
              <div>
                <Label htmlFor={`reminder-${key}`} className="text-slate-200">{label}</Label>
                <p className="text-xs text-slate-500">{hint}</p>
              </div>
              <Switch
                id={`reminder-${key}`}
                aria-label={label}
                checked={reminderForm[key]}
                onCheckedChange={(checked) => editReminders({ [key]: checked })}
              />
            </div>
          ))}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Waking start</Label>
            <Input
              type="time"
              aria-label="Waking start"
              aria-invalid={reminderErrors.some((e) => e.includes('waking'))}
              value={reminderForm.wakingStart}
              onChange={(e) => editReminders({ wakingStart: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Waking end</Label>
            <Input
              type="time"
              aria-label="Waking end"
              aria-invalid={reminderErrors.some((e) => e.includes('waking'))}
              value={reminderForm.wakingEnd}
              onChange={(e) => editReminders({ wakingEnd: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Daily check-in time</Label>
            <Input
              type="time"
              aria-label="Daily check-in time"
              aria-invalid={reminderErrors.some((e) => e.includes('checkInTime'))}
              value={reminderForm.checkInTime}
              onChange={(e) => editReminders({ checkInTime: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Exercise reminder time</Label>
            <Input
              type="time"
              aria-label="Exercise reminder time"
              aria-invalid={reminderErrors.some((e) => e.includes('exerciseTime'))}
              value={reminderForm.exerciseTime}
              onChange={(e) => editReminders({ exerciseTime: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Grace period (minutes)</Label>
            <Input
              type="number"
              min={15}
              max={360}
              step={1}
              inputMode="numeric"
              aria-label="Grace period minutes"
              aria-invalid={reminderErrors.some((e) => e.includes('graceMinutes'))}
              value={reminderForm.graceMinutes}
              onChange={(e) => editReminders({
                graceMinutes: Number(e.target.value) || 0,
              })}
            />
            <p className="text-xs text-slate-500">
              Missed daily/exercise prompts stop being delivered after this window.
            </p>
          </div>
        </div>

        {reminderErrors.length > 0 && (
          <div role="alert" className="mt-3 rounded-lg bg-rose-950/50 px-3 py-2 text-xs text-rose-200">
            {reminderErrors.map((error) => <p key={error}>{error}</p>)}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            disabled={reminderErrors.length > 0 || !remindersDirty}
            onClick={() => {
              const errors = store.updateReminders(reminderForm);
              if (errors.length) {
                toast.error('Reminder settings not saved', { description: errors.join('; ') });
                return;
              }
              setReminderDraft(null);
              toast.success('Reminder settings saved');
            }}
          >
            Save reminder settings
          </Button>
          {remindersDirty && reminderErrors.length === 0 && (
            <button
              type="button"
              className="text-xs text-slate-400 underline underline-offset-2 hover:text-slate-200"
              onClick={() => setReminderDraft(null)}
            >
              Discard changes
            </button>
          )}
          <span className="text-xs text-slate-500">
            Waking hours use your time zone ({state.timezone}); overnight windows are not supported.
          </span>
        </div>
      </section>

      {/* data */}
      <section className="rounded-2xl border bg-slate-900 p-5 shadow-sm">
        <h2 className="text-base font-bold">Data</h2>
        <p className="mt-1 text-sm text-slate-400">
          {store.sync.status === 'conflict' ? (
            <>This device has changes that were never saved to the server, and the server holds its own copy. Nothing syncs until you resolve this below.</>
          ) : store.sync.status === 'error' ? (
            <>Connected to the backend, but some recent changes couldn&apos;t be saved there. They are safe on this device and marked <span className="font-semibold text-amber-300">unsynced</span>.</>
          ) : store.sync.status === 'syncing' ? (
            <>Connected to the backend server — syncing {store.sync.pending} change{store.sync.pending === 1 ? '' : 's'}…</>
          ) : store.serverMode ? (
            <>Connected to the backend server — your data is stored on the server and cached in this browser.</>
          ) : (
            <>No backend reachable — running in browser-only mode (data lives in local storage).</>
          )}
        </p>

        {store.sync.diverged && (
          <div className="mt-3 rounded-xl border border-rose-900 bg-rose-950/40 p-4">
            <h3 className="flex items-center gap-2 text-sm font-bold text-rose-200">
              <AlertTriangle className="h-4 w-4" /> Unsynced changes on this device
            </h3>
            <p className="mt-1 text-sm text-slate-300">
              Changes made here never reached the server, so the two copies differ.
              Automatic merging isn&apos;t safe — deleted items would come back.
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-slate-400">
              <li>Download this device&apos;s data as a JSON backup (recommended), then</li>
              <li>replace this device&apos;s data with the server copy.</li>
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" className="gap-2" onClick={exportJSON}>
                <FileDown className="h-4 w-4" /> Download this device&apos;s data
              </Button>
              <Button
                className="gap-2 bg-rose-800 text-rose-100 hover:bg-rose-700"
                onClick={() => setUseServerOpen(true)}
              >
                Use server copy…
              </Button>
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" className="gap-2" onClick={exportJSON}>
            <FileDown className="h-4 w-4" /> Export backup (JSON)
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => {
              store.loadDemoData();
              toast.success('Demo data loaded');
            }}
          >
            <Sparkles className="h-4 w-4" /> Load demo data
          </Button>
          <Button
            variant="outline"
            className="gap-2 text-rose-400 hover:text-rose-300"
            onClick={() => setResetOpen(true)}
          >
            <Trash2 className="h-4 w-4" /> Erase everything
          </Button>
        </div>

        <div className="mt-4 border-t border-slate-800 pt-4">
          <h3 className="text-sm font-semibold">Restore from a JSON backup</h3>
          <p className="mt-1 text-xs text-slate-500">
            Accepts this app&apos;s <span className="font-semibold text-slate-400">Export backup (JSON)</span>{' '}
            file and nightly/server backup envelopes (including older schema versions).
            The preview lets you merge only missing records or replace everything.
          </p>
          <input
            ref={jsonFileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleJsonFile}
          />
          <Button
            variant="outline"
            className="mt-3 gap-2"
            onClick={() => jsonFileRef.current?.click()}
            disabled={restoreBusy}
          >
            <FileUp className="h-4 w-4" /> Choose JSON backup…
          </Button>
          {jsonError && (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-lg bg-rose-950/50 px-3 py-2 text-xs text-rose-200"
            >
              <span className="min-w-0 flex-1">{jsonError}</span>
              <button
                type="button"
                className="shrink-0 underline underline-offset-2 hover:text-rose-100"
                onClick={() => setJsonError(null)}
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      </section>

      {/* import preview dialog */}
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Import preview</DialogTitle>
          </DialogHeader>
          {preview && (
            <div className="space-y-3 py-2 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-slate-800 p-3 text-center">
                  <div className="text-2xl font-black">{preview.attacks.length}</div>
                  <div className="text-xs text-slate-400">attacks</div>
                </div>
                <div className="rounded-lg bg-slate-800 p-3 text-center">
                  <div className="text-2xl font-black">{preview.meds.length}</div>
                  <div className="text-xs text-slate-400">medication entries</div>
                </div>
              </div>
              {preview.attacks.length > 0 && (
                <p className="text-xs text-slate-400">
                  Range: {new Date(preview.attacks[0].start).toLocaleDateString()} →{' '}
                  {new Date(preview.attacks[preview.attacks.length - 1].start).toLocaleDateString()}
                </p>
              )}
              {preview.warnings.map((w, i) => (
                <p key={i} className="rounded-lg bg-amber-950 p-2 text-xs text-amber-300">
                  ⚠️ {w}
                </p>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>Cancel</Button>
            <Button onClick={confirmImport}>Import</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* JSON restore preview */}
      <Dialog
        open={!!jsonPreview}
        onOpenChange={(open) => {
          if (!open && !restoreBusy) setJsonPreview(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Restore preview</DialogTitle>
          </DialogHeader>
          {jsonPreview && previewBackup && alreadyPresent && (
            <div className="space-y-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="break-all font-semibold text-slate-200">{jsonPreview.filename}</p>
                <p className="text-xs text-slate-400">
                  {backupFormatLabel(previewBackup)}
                  {previewBackup.exportedAt
                    ? ` · exported ${formatExportedAt(previewBackup.exportedAt)}`
                    : ''}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {BACKUP_RECORD_KEYS.map((key) => (
                  <div
                    key={key}
                    className="rounded-lg bg-slate-800 p-3 text-center"
                    aria-label={`${previewBackup[key].length} ${
                      previewBackup[key].length === 1
                        ? BACKUP_RECORD_LABELS[key].singular
                        : BACKUP_RECORD_LABELS[key].plural
                    }`}
                  >
                    <div className="text-xl font-black">{previewBackup[key].length}</div>
                    <div className="text-xs text-slate-400">
                      {BACKUP_RECORD_LABELS[key].preview}
                    </div>
                    {alreadyPresent[key] > 0 && (
                      <div className="mt-0.5 text-[10px] text-amber-300">
                        {alreadyPresent[key]} already present
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <p className="text-xs text-slate-400">
                {alreadyPresentTotal > 0
                  ? `${alreadyPresentTotal} record${alreadyPresentTotal === 1 ? '' : 's'} already on this device (existing records are kept by merge).`
                  : 'None of these records are on this device yet.'}
              </p>

              {duplicateTotal > 0 && (
                <div
                  role="alert"
                  className="rounded-lg bg-amber-950/60 px-3 py-2 text-xs text-amber-200"
                >
                  This file contains {duplicateTotal} duplicate record
                  {duplicateTotal === 1 ? '' : 's'}. Merge keeps the first of each;
                  replacing is unavailable because a replacement must be exact.
                </div>
              )}

              {previewBackup.skippedSettingKeys.length > 0 && (
                <p className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300">
                  {previewBackup.skippedSettingKeys.length} unrecognized settings key
                  {previewBackup.skippedSettingKeys.length === 1 ? '' : 's'} will be skipped.
                </p>
              )}

              <p className="text-xs text-slate-500">
                Merge adds only records that are missing here and never changes settings
                or existing records. Replace removes ALL current records and restores the
                backup&apos;s records and non-secret settings.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setJsonPreview(null)}
              disabled={restoreBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void mergeFromPreview()}
              disabled={restoreBusy}
            >
              Merge missing records
            </Button>
            <Button
              variant="destructive"
              onClick={() => setReplaceOpen(true)}
              disabled={restoreBusy || duplicateTotal > 0}
            >
              Replace everything…
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* JSON replace confirmation */}
      <AlertDialog
        open={replaceOpen}
        onOpenChange={(open) => {
          if (!restoreBusy) setReplaceOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace all data with this backup?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes every record and setting currently stored
              {store.serverMode ? ' on the server and in this browser' : ' in this browser'}{' '}
              and restores this backup&apos;s records and non-secret settings.
              Download the current state first if you might need it — use{' '}
              <span className="font-semibold">Export backup (JSON)</span> in the Data
              section above.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoreBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-800 text-rose-50 hover:bg-rose-700"
              disabled={restoreBusy}
              onClick={(event) => {
                // Keep the dialog open while the async restore runs; it is
                // closed explicitly on success (and on failure, to retry).
                event.preventDefault();
                void replaceFromPreview();
              }}
            >
              Replace everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* reset confirm */}
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Erase all data?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears every attack and medication entry stored in this browser.
              Consider exporting a JSON backup first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                store.resetAll();
                toast.success('All data erased');
              }}
            >
              Erase everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* conflict resolution: replace local with the server snapshot */}
      <AlertDialog open={useServerOpen} onOpenChange={setUseServerOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard local changes and use the server copy?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces everything stored in this browser with the server&apos;s
              data. Local changes that were never synced will be lost — download a
              backup first if you might need them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-800 text-rose-50 hover:bg-rose-700"
              onClick={() => {
                void store.resolveUseServer();
                setUseServerOpen(false);
              }}
            >
              Discard local &amp; use server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
