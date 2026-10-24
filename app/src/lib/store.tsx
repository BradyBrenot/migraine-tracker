import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Attack, MedEvent, Refill, TrackerState } from '@/types';
import { MED_CATALOG } from '@/lib/meds';
import { uid } from '@/lib/format';
import { buildSeedData } from '@/lib/seed';
import { api as backend } from '@/lib/api';

const STORAGE_KEY = 'migraine-tracker-v1';

function defaultRules(): TrackerState['rules'] {
  const rules: TrackerState['rules'] = {};
  for (const m of MED_CATALOG) {
    if (m.defaultRule) rules[m.id] = { ...m.defaultRule };
  }
  return rules;
}

const DEFAULT_DOSES: Record<string, string> = {
  nurtec: '75 mg',
  tylenol: '500 mg',
  ibuprofen: '400 mg',
  naproxen: '220 mg',
};

function emptyState(): TrackerState {
  return { attacks: [], meds: [], refills: [], rules: defaultRules(), doses: { ...DEFAULT_DOSES }, planned: {}, seeded: false };
}

function loadState(): TrackerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as TrackerState;
    return {
      ...emptyState(),
      ...parsed,
      rules: { ...defaultRules(), ...(parsed.rules ?? {}) },
      doses: { ...DEFAULT_DOSES, ...(parsed.doses ?? {}) },
      planned: { ...(parsed.planned ?? {}) },
    };
  } catch {
    return emptyState();
  }
}

// Module-level guard: React StrictMode mounts twice in dev; hydrate once.
let hydrateStarted = false;

export interface StoreApi {
  state: TrackerState;
  activeAttack: Attack | null;
  /** true once we've confirmed a backend is reachable */
  serverMode: boolean;
  // attacks
  startAttack: (start?: Date) => Attack;
  endAttack: (id: string, end?: Date) => void;
  updateAttack: (id: string, patch: Partial<Attack>) => void;
  deleteAttack: (id: string) => void;
  logPain: (attackId: string, level: number, when?: Date) => void;
  // meds
  logMed: (medId: string, when?: Date, attackId?: string | null, dose?: string, notes?: string) => MedEvent;
  updateMed: (id: string, patch: Partial<MedEvent>) => void;
  deleteMed: (id: string) => void;
  // refills (pharmacy pickups)
  addRefill: (medId: string, date: string, notes?: string) => Refill;
  deleteRefill: (id: string) => void;
  // bulk
  importData: (attacks: Attack[], meds: MedEvent[]) => void;
  setRule: (medId: string, limit: number, windowDays: number) => void;
  setDoseDefault: (medId: string, dose: string) => void;
  setPlannedDose: (medId: string, date: string | null) => void;
  loadDemoData: () => void;
  resetAll: () => void;
}

const StoreCtx = createContext<StoreApi | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<TrackerState>(loadState);
  const [serverMode, setServerMode] = useState(false);
  const serverRef = useRef(false);

  // localStorage is always a cache; the server (when reachable) is canonical
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  // hydrate from the backend on first load
  useEffect(() => {
    if (hydrateStarted) return;
    hydrateStarted = true;
    (async () => {
      try {
        const data = await backend.exportAll();
        serverRef.current = true;
        setServerMode(true);
        const serverAttacks = data.attacks as Attack[];
        const serverMeds = data.meds as MedEvent[];
        const serverRefills = (data.refills ?? []) as Refill[];
        const serverEmpty = serverAttacks.length === 0 && serverMeds.length === 0 && serverRefills.length === 0;
        const local = loadState();

        if (serverEmpty && (local.attacks.length > 0 || local.meds.length > 0 || local.refills.length > 0)) {
          // first contact: push existing browser data up to the server
          await backend.importAll({ attacks: local.attacks, meds: local.meds, refills: local.refills });
          await backend.putSetting('rules', local.rules);
          await backend.putSetting('doses', local.doses);
          toast.success(`Synced ${local.attacks.length} attacks and ${local.meds.length} med entries to the server`);
          setState(local);
        } else {
          setState((s) => ({
            ...s,
            attacks: serverAttacks,
            meds: serverMeds,
            refills: serverRefills,
            rules: { ...defaultRules(), ...((data.settings?.rules as TrackerState['rules']) ?? {}) },
            doses: { ...DEFAULT_DOSES, ...((data.settings?.doses as Record<string, string>) ?? {}) },
            planned: { ...((data.settings?.planned as Record<string, string>) ?? {}) },
          }));
        }
      } catch {
        // server unreachable — localStorage demo mode
      }
    })();
  }, []);

  /** Fire-and-forget push to the backend when connected. */
  const push = useCallback((fn: () => Promise<unknown>) => {
    if (!serverRef.current) return;
    fn().catch((e) => console.error('[sync] backend write failed:', e));
  }, []);

  const api = useMemo<StoreApi>(() => {
    const activeAttack =
      state.attacks.find((a) => a.end === null) ?? null;

    const recomputePeak = (a: Attack): number => {
      const levels = a.painLog.map((p) => p.level);
      if (a.peakPain >= 0) levels.push(a.peakPain);
      return levels.length ? Math.max(...levels) : -1;
    };

    return {
      state,
      activeAttack,
      serverMode,
      startAttack: (start = new Date()) => {
        const a: Attack = {
          id: uid(), start: start.toISOString(), end: null,
          painLog: [], peakPain: -1,
          symptoms: [], triggers: [], aura: null, notes: '', source: 'manual',
        };
        setState((s) => ({ ...s, attacks: [...s.attacks, a] }));
        push(() => backend.addAttack(a));
        return a;
      },
      endAttack: (id, end = new Date()) => {
        const endIso = end.toISOString();
        setState((s) => ({
          ...s,
          attacks: s.attacks.map((a) =>
            a.id === id ? { ...a, end: endIso } : a),
        }));
        push(() => backend.patchAttack(id, { end: endIso }));
      },
      updateAttack: (id, patch) => {
        let merged: Attack | null = null;
        setState((s) => ({
          ...s,
          attacks: s.attacks.map((a) => {
            if (a.id !== id) return a;
            const next = { ...a, ...patch };
            next.peakPain = recomputePeak(next);
            merged = next;
            return next;
          }),
        }));
        if (merged) push(() => backend.patchAttack(id, merged));
      },
      deleteAttack: (id) => {
        setState((s) => ({
          ...s,
          attacks: s.attacks.filter((a) => a.id !== id),
          meds: s.meds.map((m) => (m.attackId === id ? { ...m, attackId: null } : m)),
        }));
        push(() => backend.deleteAttack(id));
      },
      logPain: (attackId, level, when = new Date()) => {
        let updated: Attack | null = null;
        setState((s) => ({
          ...s,
          attacks: s.attacks.map((a) => {
            if (a.id !== attackId) return a;
            const next = {
              ...a,
              painLog: [...a.painLog, { ts: when.toISOString(), level }]
                .sort((x, y) => x.ts.localeCompare(y.ts)),
            };
            next.peakPain = recomputePeak(next);
            updated = next;
            return next;
          }),
        }));
        if (updated) push(() => backend.patchAttack(attackId, { painLog: (updated as Attack).painLog, peakPain: (updated as Attack).peakPain }));
      },
      logMed: (medId, when = new Date(), attackId = null, dose = '', notes = '') => {
        const m: MedEvent = {
          id: uid(), medId, ts: when.toISOString(), attackId, notes, dose, source: 'manual',
        };
        setState((s) => ({ ...s, meds: [...s.meds, m] }));
        push(() => backend.addMed(m));
        return m;
      },
      updateMed: (id, patch) => {
        setState((s) => ({
          ...s,
          meds: s.meds.map((m) => (m.id === id ? { ...m, ...patch } : m)),
        }));
        push(() => backend.patchMed(id, patch));
      },
      deleteMed: (id) => {
        setState((s) => ({ ...s, meds: s.meds.filter((m) => m.id !== id) }));
        push(() => backend.deleteMed(id));
      },
      addRefill: (medId, date, notes = '') => {
        const r: Refill = { id: uid(), medId, date, notes, source: 'manual' };
        setState((s) => ({
          ...s,
          refills: [...s.refills, r].sort((a, b) => a.date.localeCompare(b.date)),
        }));
        push(() => backend.addRefill(r));
        return r;
      },
      deleteRefill: (id) => {
        setState((s) => ({ ...s, refills: s.refills.filter((r) => r.id !== id) }));
        push(() => backend.deleteRefill(id));
      },
      importData: (attacks, meds) => {
        setState((s) => ({
          ...s,
          attacks: [...s.attacks, ...attacks].sort((a, b) => a.start.localeCompare(b.start)),
          meds: [...s.meds, ...meds].sort((a, b) => a.ts.localeCompare(b.ts)),
        }));
        push(() => backend.importAll({ attacks, meds }));
      },
      setRule: (medId, limit, windowDays) => {
        const rules = { ...state.rules, [medId]: { limit, windowDays } };
        setState((s) => ({ ...s, rules }));
        push(() => backend.putSetting('rules', rules));
      },
      setDoseDefault: (medId, dose) => {
        const doses = { ...state.doses, [medId]: dose };
        setState((s) => ({ ...s, doses }));
        push(() => backend.putSetting('doses', doses));
      },
      setPlannedDose: (medId, date) => {
        const planned = { ...state.planned };
        if (date) planned[medId] = date;
        else delete planned[medId];
        setState((s) => ({ ...s, planned }));
        push(() => backend.putSetting('planned', planned));
      },
      loadDemoData: () => {
        const seed = buildSeedData();
        setState((s) => ({
          ...s,
          attacks: seed.attacks,
          meds: seed.meds,
          seeded: true,
        }));
        push(() => backend.importAll(seed));
      },
      resetAll: () => {
        setState(emptyState());
        push(() => backend.resetAll());
      },
    };
  }, [state, serverMode, push]);

  return <StoreCtx.Provider value={api}>{children}</StoreCtx.Provider>;
}

export function useStore(): StoreApi {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useStore outside provider');
  return ctx;
}

/** Distinct calendar days on which a med was used within the last `windowDays`. */
export function usageDaysInWindow(meds: MedEvent[], medId: string, windowDays: number): number {
  const cutoff = Date.now() - windowDays * 86400000;
  const days = new Set<string>();
  for (const m of meds) {
    if (m.medId !== medId) continue;
    const t = new Date(m.ts).getTime();
    if (t >= cutoff) days.add(m.ts.slice(0, 10));
  }
  return days.size;
}

/** Days since the most recent dose of a med (null if never). */
export function daysSinceLast(meds: MedEvent[], medId: string): number | null {
  const events = meds.filter((m) => m.medId === medId);
  if (!events.length) return null;
  const latest = Math.max(...events.map((m) => new Date(m.ts).getTime()));
  return Math.floor((Date.now() - latest) / 86400000);
}
