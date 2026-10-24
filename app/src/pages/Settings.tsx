import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Upload, Trash2, Sparkles, FileDown } from 'lucide-react';
import { useStore } from '@/lib/store';
import { MED_CATALOG, medColor } from '@/lib/meds';
import { importMigraineBuddyCSV, type ImportResult } from '@/lib/mbImport';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export default function Settings() {
  const store = useStore();
  const { state } = store;
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

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

      {/* data */}
      <section className="rounded-2xl border bg-slate-900 p-5 shadow-sm">
        <h2 className="text-base font-bold">Data</h2>
        <p className="mt-1 text-sm text-slate-400">
          {store.serverMode ? (
            <>Connected to the backend server — your data is stored on the server and cached in this browser.</>
          ) : (
            <>No backend reachable — running in browser-only mode (data lives in local storage).</>
          )}
        </p>
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
    </div>
  );
}
