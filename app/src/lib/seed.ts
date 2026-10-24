import type { Attack, MedEvent } from '@/types';
import { uid } from '@/lib/format';

/**
 * Deterministic-ish demo data spanning the last ~75 days so the calendar
 * and reports have something meaningful to show on first run.
 */
export function buildSeedData(): { attacks: Attack[]; meds: MedEvent[] } {
  const attacks: Attack[] = [];
  const meds: MedEvent[] = [];
  const now = new Date();

  const rand = mulberry32(20261009);

  function addAttack(daysAgo: number, startHour: number, durationHrs: number, peak: number, opts?: {
    symptoms?: string[]; triggers?: string[]; notes?: string; aura?: boolean;
  }): Attack {
    const start = new Date(now);
    start.setDate(start.getDate() - daysAgo);
    start.setHours(startHour, Math.floor(rand() * 60), 0, 0);
    const end = new Date(start.getTime() + durationHrs * 3600000);
    const a: Attack = {
      id: uid(),
      start: start.toISOString(),
      end: end.toISOString(),
      painLog: [
        { ts: start.toISOString(), level: Math.max(1, peak - 2) },
        { ts: new Date(start.getTime() + durationHrs * 1800000).toISOString(), level: peak },
      ],
      peakPain: peak,
      symptoms: opts?.symptoms ?? [],
      triggers: opts?.triggers ?? [],
      aura: opts?.aura ?? false,
      notes: opts?.notes ?? '',
      source: 'manual',
    };
    attacks.push(a);
    return a;
  }

  function addMed(medId: string, when: Date, attackId: string | null, dose?: string) {
    meds.push({
      id: uid(), medId, ts: when.toISOString(), attackId,
      notes: '', dose, source: 'manual',
    });
  }

  // --- preventives ---
  // Emgality monthly: 12, 43, 74 days ago
  for (const d of [12, 43, 74]) {
    const when = new Date(now);
    when.setDate(when.getDate() - d);
    when.setHours(8, 30, 0, 0);
    addMed('emgality', when, null, '120 mg auto-injector');
  }
  // Botox quarterly: 61 days ago
  {
    const when = new Date(now);
    when.setDate(when.getDate() - 61);
    when.setHours(14, 0, 0, 0);
    addMed('botox', when, null, '155 units, 31 sites');
  }

  // --- attacks over ~75 days ---
  // This week: an attack 2 days ago (treated with Nurtec + Tylenol)
  {
    const a = addAttack(2, 7, 9, 7, {
      symptoms: ['Nausea', 'Light sensitivity', 'One-sided'],
      triggers: ['Poor sleep'],
      notes: 'Woke up with it. Nurtec at 8am helped by noon.',
    });
    const s = new Date(a.start);
    addMed('nurtec', new Date(s.getTime() + 3600000), a.id, '75 mg');
    addMed('tylenol', new Date(s.getTime() + 7200000), a.id, '500 mg');
  }
  // Attack 6 days ago
  {
    const a = addAttack(6, 15, 6, 5, { symptoms: ['Sound sensitivity'], triggers: ['Stress'] });
    addMed('ibuprofen', new Date(new Date(a.start).getTime() + 1800000), a.id, '400 mg');
  }
  // Attack 9 days ago (Nurtec)
  {
    const a = addAttack(9, 10, 14, 8, {
      symptoms: ['Nausea', 'Light sensitivity', 'Aura'], aura: true, triggers: ['Weather'],
    });
    addMed('nurtec', new Date(new Date(a.start).getTime() + 900000), a.id, '75 mg');
  }
  // Attack 13 days ago (Nurtec) — pushing toward the 15/30-day awareness zone
  {
    const a = addAttack(13, 19, 8, 6, { triggers: ['Screen time'] });
    addMed('nurtec', new Date(new Date(a.start).getTime() + 600000), a.id, '75 mg');
  }
  // Multi-day attack 17–19 days ago
  {
    const a = addAttack(19, 6, 52, 8, {
      symptoms: ['Nausea', 'Vomiting', 'Light sensitivity', 'Brain fog'],
      triggers: ['Hormones'],
      notes: 'Multi-day. Status migrainosus-ish.',
    });
    addMed('naproxen', new Date(new Date(a.start).getTime() + 3600000), a.id, '500 mg');
    addMed('nurtec', new Date(new Date(a.start).getTime() + 86400000), a.id, '75 mg');
  }
  // 24 days ago
  {
    const a = addAttack(24, 12, 5, 4, { symptoms: ['Neck pain'] });
    addMed('tylenol', new Date(new Date(a.start).getTime() + 1200000), a.id, '500 mg');
  }
  // 28 days ago
  {
    const a = addAttack(28, 9, 10, 7, { symptoms: ['Light sensitivity'], triggers: ['Skipped meal'] });
    addMed('nurtec', new Date(new Date(a.start).getTime() + 1800000), a.id, '75 mg');
  }
  // 33 days ago
  {
    const a = addAttack(33, 16, 7, 6, { triggers: ['Alcohol'] });
    addMed('ibuprofen', new Date(new Date(a.start).getTime() + 900000), a.id, '400 mg');
  }
  // 38 days ago
  {
    const a = addAttack(38, 8, 12, 7, { symptoms: ['Nausea', 'Sound sensitivity'] });
    addMed('nurtec', new Date(new Date(a.start).getTime() + 2700000), a.id, '75 mg');
  }
  // 45 days ago
  {
    const a = addAttack(45, 20, 4, 3, { symptoms: ['Fatigue'] });
    addMed('tylenol', new Date(new Date(a.start).getTime() + 3600000), a.id, '500 mg');
  }
  // 50 days ago — untreated
  addAttack(50, 11, 16, 9, {
    symptoms: ['Nausea', 'Vomiting', 'Aura'], aura: true,
    notes: 'No meds left that week. Rough one.',
  });
  // 58 days ago
  {
    const a = addAttack(58, 14, 8, 6, { triggers: ['Travel'] });
    addMed('naproxen', new Date(new Date(a.start).getTime() + 1200000), a.id, '500 mg');
  }
  // 66 days ago
  {
    const a = addAttack(66, 9, 6, 5, { symptoms: ['Light sensitivity'] });
    addMed('ibuprofen', new Date(new Date(a.start).getTime() + 1800000), a.id, '400 mg');
  }
  // 71 days ago
  {
    const a = addAttack(71, 18, 9, 6, { triggers: ['Stress', 'Poor sleep'] });
    addMed('nurtec', new Date(new Date(a.start).getTime() + 3600000), a.id, '75 mg');
  }

  attacks.sort((a, b) => a.start.localeCompare(b.start));
  meds.sort((a, b) => a.ts.localeCompare(b.ts));
  return { attacks, meds };
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
