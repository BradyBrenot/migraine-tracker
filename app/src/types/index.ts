export interface PainPoint {
  ts: string; // ISO timestamp
  level: number; // 0-10
}

export interface Attack {
  id: string;
  start: string; // ISO timestamp
  end: string | null; // null = ongoing
  painLog: PainPoint[]; // chronological pain check-ins
  peakPain: number; // cached max (0-10); -1 = not recorded
  symptoms: string[];
  triggers: string[];
  aura: boolean | null;
  notes: string;
  source: 'manual' | 'import';
}

export interface MedEvent {
  id: string;
  medId: string; // key into med catalog, or custom name
  dose?: string;
  ts: string; // ISO timestamp
  attackId: string | null;
  notes: string;
  source: 'manual' | 'import';
}

/** A pharmacy refill pickup (e.g. Nurtec 75 mg ×8) — historical burden signal. */
export interface Refill {
  id: string;
  medId: string;
  date: string; // YYYY-MM-DD (pickup day; time not tracked)
  notes: string; // e.g. quantity, pharmacy
  source: 'manual' | 'import';
}

export interface MedRule {
  limit: number; // max usage days
  windowDays: number; // per rolling window
}

export interface TrackerState {
  attacks: Attack[];
  meds: MedEvent[];
  refills: Refill[];
  /** per-med usage-day limits: { nurtec: {limit:15, windowDays:30}, ... } */
  rules: Record<string, MedRule>;
  /** per-med default dose strings, used when quick-logging */
  doses: Record<string, string>;
  /** manually scheduled next dose dates (medId → YYYY-MM-DD), e.g. Botox appointments */
  planned: Record<string, string>;
  seeded: boolean;
}
