import type { MedRule } from '@/types';
import { PREVENTIVE_INTERVALS } from '../../shared/reminders.ts';

export interface MedDef {
  id: string;
  name: string;
  abbr: string; // 1-2 letter badge for calendar chips
  kind: 'acute' | 'nsaid' | 'analgesic' | 'preventive';
  kindLabel: string;
  color: string; // Okabe-Ito colorblind-safe palette
  defaultRule: MedRule | null; // null = no MOH-style day limit
  intervalDays?: number; // for preventives: expected dosing interval
}

// Colors from the Okabe-Ito palette — distinguishable under deuteranomaly.
export const MED_CATALOG: MedDef[] = [
  {
    id: 'nurtec',
    name: 'Nurtec',
    abbr: 'N',
    kind: 'acute',
    kindLabel: 'Gepant · acute',
    color: '#CC79A7', // reddish purple
    defaultRule: { limit: 15, windowDays: 30 },
  },
  {
    id: 'tylenol',
    name: 'Tylenol',
    abbr: 'T',
    kind: 'analgesic',
    kindLabel: 'Acetaminophen',
    color: '#E69F00', // orange
    defaultRule: { limit: 15, windowDays: 30 },
  },
  {
    id: 'ibuprofen',
    name: 'Ibuprofen',
    abbr: 'Ib',
    kind: 'nsaid',
    kindLabel: 'NSAID',
    color: '#56B4E9', // sky blue
    defaultRule: { limit: 15, windowDays: 30 },
  },
  {
    id: 'naproxen',
    name: 'Naproxen',
    abbr: 'Na',
    kind: 'nsaid',
    kindLabel: 'NSAID',
    color: '#0072B2', // deep blue
    defaultRule: { limit: 15, windowDays: 30 },
  },
  {
    id: 'emgality',
    name: 'Emgality',
    abbr: 'E',
    kind: 'preventive',
    kindLabel: 'CGRP mAb · monthly',
    color: '#009E73', // bluish green
    defaultRule: null,
    // Same calendar-day interval the reminder scheduler derives its
    // Emgality/Botox due dates from (shared/reminders.ts).
    intervalDays: PREVENTIVE_INTERVALS.emgality,
  },
  {
    id: 'botox',
    name: 'Botox',
    abbr: 'B',
    kind: 'preventive',
    kindLabel: 'Injection · quarterly',
    color: '#F0E442', // yellow
    defaultRule: null,
    // See emgality above: shared with the reminder scheduler.
    intervalDays: PREVENTIVE_INTERVALS.botox,
  },
];

export const MED_MAP: Record<string, MedDef> = Object.fromEntries(
  MED_CATALOG.map((m) => [m.id, m]),
);

// Extended colorblind-safe palette (Paul Tol) for custom imported meds.
const CUSTOM_MED_COLORS = ['#882255', '#44AA99', '#999933', '#88CCEE', '#DDCC77', '#AA4499'];

export function medColor(medId: string): string {
  const def = MED_MAP[medId];
  if (def) return def.color;
  let h = 0;
  for (let i = 0; i < medId.length; i++) h = (h * 31 + medId.charCodeAt(i)) | 0;
  return CUSTOM_MED_COLORS[Math.abs(h) % CUSTOM_MED_COLORS.length];
}

export function medAbbr(medId: string): string {
  const def = MED_MAP[medId];
  if (def) return def.abbr;
  return medId.charAt(0).toUpperCase() + medId.slice(1, 2);
}

export function medName(medId: string): string {
  const def = MED_MAP[medId];
  if (def) return def.name;
  // custom (imported) med: prettify the slug
  return medId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Catalog ids plus any custom med ids found in the data. */
export function allMedIds(events: { medId: string }[]): string[] {
  const ids = MED_CATALOG.map((m) => m.id);
  const seen = new Set(ids);
  for (const e of events) {
    if (!seen.has(e.medId)) { seen.add(e.medId); ids.push(e.medId); }
  }
  return ids;
}

/** Fuzzy match a free-text medication name (e.g. from Migraine Buddy) to a catalog id. */
export function matchMedId(text: string): string | null {
  const t = text.toLowerCase();
  const aliases: Record<string, string[]> = {
    nurtec: ['nurtec', 'rimegepant'],
    tylenol: ['tylenol', 'acetaminophen', 'paracetamol'],
    ibuprofen: ['ibuprofen', 'advil', 'motrin'],
    naproxen: ['naproxen', 'aleve'],
    emgality: ['emgality', 'galcanezumab'],
    botox: ['botox', 'onabotulinum'],
  };
  for (const [id, names] of Object.entries(aliases)) {
    if (names.some((n) => t.includes(n))) return id;
  }
  return null;
}

export const SYMPTOM_OPTIONS = [
  'Nausea', 'Vomiting', 'Light sensitivity', 'Sound sensitivity', 'Smell sensitivity',
  'Aura', 'Dizziness', 'Neck pain', 'Fatigue', 'Brain fog', 'Throbbing', 'One-sided',
];

export const TRIGGER_OPTIONS = [
  'Stress', 'Poor sleep', 'Weather', 'Alcohol', 'Caffeine', 'Skipped meal',
  'Screen time', 'Hormones', 'Bright light', 'Exercise', 'Dehydration', 'Travel',
];

/**
 * Pain scale colors: sampled from the cividis colormap, which was designed
 * (Nuñez et al., 2018) to be perceptually uniform for viewers with
 * red-green color vision deficiency. Low = dark blue, high = bright yellow.
 */
const CIVIDIS = [
  '#00224d', '#083370', '#35456c', '#4e566c', '#666970',
  '#7c7b78', '#948e77', '#aea271', '#c8b765', '#e4ce51', '#fde737',
];

export function painColor(level: number): string {
  if (level < 0) return '#3f4a5a';
  return CIVIDIS[Math.max(0, Math.min(10, Math.round(level)))];
}

/** Low-alpha version of painColor for tinting calendar day backgrounds. */
export function painTint(level: number): string {
  const hex = painColor(level);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.22)`;
}

/** Relative luminance per WCAG 2.x (sRGB, gamma-corrected). */
export function relativeLuminance(hex: string): number {
  const channels = hexToRgb(hex);
  if (channels === null) return 0;
  const [r, g, b] = channels.map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexToRgb(hex: string): [number, number, number] | null {
  const value = hex.trim().replace(/^#/, '');
  const full = value.length === 3
    ? value.split('').map((c) => c + c).join('')
    : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** Candidate foregrounds for colored chips/bars (black ink vs. white). */
export const DARK_INK = '#000000';
export const LIGHT_INK = '#ffffff';

/**
 * Readable text color on top of a hex background, chosen by WCAG contrast
 * rather than a naive brightness average. Every Okabe-Ito medication color,
 * every custom medication color, and every cividis pain step resolves to
 * at least 4.5:1 with the returned ink.
 */
export function textOn(hex: string): string {
  return contrastRatio(hex, DARK_INK) >= contrastRatio(hex, LIGHT_INK)
    ? DARK_INK
    : LIGHT_INK;
}

/** Status colors (Okabe-Ito) that stay distinguishable under deuteranomaly. */
export const STATUS = {
  ok: '#56B4E9',      // sky blue
  warn: '#E69F00',    // orange
  danger: '#D55E00',  // vermillion
};
