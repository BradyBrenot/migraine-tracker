import type { Attack, MedEvent } from '@/types';
import { matchMedId } from '@/lib/meds';
import { uid } from '@/lib/format';

export interface ImportResult {
  attacks: Attack[];
  meds: MedEvent[];
  skipped: number;
  warnings: string[];
}

/** Minimal RFC-4180-ish CSV tokenizer (handles quotes, commas, newlines in cells). */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell); cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

function findCol(headers: string[], ...patterns: RegExp[]): number {
  for (const p of patterns) {
    const idx = headers.findIndex((h) => p.test(h.toLowerCase().trim()));
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Parse a date cell. Handles ISO plus Migraine Buddy's US-locale export
 * format "9/12/26 10:22" (M/D/YY HH:mm, 2-digit year → 20xx).
 */
function parseDate(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const hh = Number(m[4] ?? 0), mm = Number(m[5] ?? 0);
    const d = new Date(year, month - 1, day, hh, mm);
    if (!isNaN(d.getTime())) return d;
  }
  const iso = new Date(s);
  if (!isNaN(iso.getTime())) return iso;
  // "Mar 12, 2025" style
  const named = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (named) {
    const d = new Date(`${named[1]} ${named[2]}, ${named[3]} ${named[4] ?? '0'}:${named[5] ?? '00'}`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function parsePain(raw: string): number {
  const n = parseFloat(raw.replace(/[^\d.]/g, ''));
  if (isNaN(n)) return -1;
  return Math.max(0, Math.min(10, Math.round(n)));
}

/** "35h 39m, (started in sleep)" → { ms, note } */
function parseLasted(raw: string): { ms: number | null; note: string } {
  const s = raw.trim();
  const m = s.match(/(\d+)\s*h(?:\s*(\d+)\s*m)?/i);
  const ms = m ? (Number(m[1]) * 60 + Number(m[2] ?? 0)) * 60000 : null;
  const noteMatch = s.match(/\(([^)]+)\)/g);
  const note = noteMatch ? noteMatch.map((x) => x.replace(/[()]/g, '')).join('; ') : '';
  return { ms, note };
}

interface MedEntry { count: number; name: string; dose: string; }

/** "2x Ibuprofen 200mg Oral" → { count: 2, name: 'Ibuprofen', dose: '200 mg' } */
function parseMedEntry(raw: string): MedEntry | null {
  let s = raw.trim();
  if (!s || /^no medication/i.test(s)) return null;
  const countMatch = s.match(/^(\d+)\s*x\s+/i);
  const count = countMatch ? Number(countMatch[1]) : 1;
  if (countMatch) s = s.slice(countMatch[0].length);
  // strip route of administration suffix
  s = s.replace(/\s+(Oral|Injection|Nasal|Sublingual|Rectal|Topical|IV)$/i, '');
  const doseMatch = s.match(/(\d+(?:\.\d+)?)\s*mg/i);
  const dose = doseMatch ? `${doseMatch[1]} mg` : '';
  const name = doseMatch ? s.slice(0, doseMatch.index).trim() : s.trim();
  if (!name) return null;
  return { count, name, dose };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Migraine Buddy CSV importer, built against the real export format:
 * a preamble "other events" section, then an attacks table headed by
 * "#","Started","Lasted",… with four medication-by-helpfulness columns.
 */
export function importMigraineBuddyCSV(text: string): ImportResult {
  const rows = parseCSV(text.replace(/^\uFEFF/, ''));
  const warnings: string[] = [];

  // find the attacks table header (the file may contain preamble sections)
  const headerIdx = rows.findIndex(
    (r) => r.some((h) => /^started$/i.test(h.trim())) && r.some((h) => /^lasted$/i.test(h.trim())),
  );
  if (headerIdx < 0) {
    return {
      attacks: [], meds: [], skipped: 0,
      warnings: ['Could not find the attacks table ("Started" / "Lasted" columns) in this file.'],
    };
  }
  if (headerIdx > 0) {
    warnings.push(`Skipped ${headerIdx} non-attack section(s) at the top of the file (e.g. "other events").`);
  }

  const headers = rows[headerIdx];
  const colStart = findCol(headers, /^started$/);
  const colLasted = findCol(headers, /^lasted$/);
  const colPain = findCol(headers, /pain level|pain|intensity|severity/);
  const colSym = findCol(headers, /^symptoms$/);
  const colTrig = findCol(headers, /trigger/);
  const colNotes = findCol(headers, /^notes$/);
  const medCols = headers
    .map((h, i) => ({ h: h.toLowerCase(), i }))
    .filter(({ h }) => /medication/.test(h));

  const attacks: Attack[] = [];
  const meds: MedEvent[] = [];
  let skipped = 0;
  const customMeds = new Set<string>();

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < 3) continue;
    const start = parseDate(row[colStart] ?? '');
    if (!start) { skipped++; continue; }

    let end: Date | null = null;
    const extraNotes: string[] = [];
    if (colLasted >= 0) {
      const { ms, note } = parseLasted(row[colLasted] ?? '');
      if (ms !== null && ms > 0) end = new Date(start.getTime() + ms);
      if (note) extraNotes.push(note);
    }

    const pain = colPain >= 0 ? parsePain(row[colPain] ?? '') : -1;
    const splitList = (v: string) =>
      v.split(/[;|]/).map((x) => x.trim()).filter(Boolean);
    const notes = [colNotes >= 0 ? (row[colNotes] ?? '').trim() : '', ...extraNotes]
      .filter(Boolean).join(' — ');

    const a: Attack = {
      id: uid(),
      start: start.toISOString(),
      end: end && end > start ? end.toISOString() : null,
      painLog: pain >= 0 ? [{ ts: start.toISOString(), level: pain }] : [],
      peakPain: pain,
      symptoms: colSym >= 0 ? splitList(row[colSym] ?? '') : [],
      triggers: colTrig >= 0 ? splitList(row[colTrig] ?? '') : [],
      aura: null,
      notes,
      source: 'import',
    };
    attacks.push(a);

    // medication columns, labeled by helpfulness
    for (const { h, i } of medCols) {
      const cell = (row[i] ?? '').trim();
      if (!cell || /^no medication/i.test(cell)) continue;
      const helpfulness = h.replace(/\s*medication\s*/i, '').trim(); // helpful / somewhat helpful / …
      for (const part of cell.split(/,(?=\s*\d+\s*x)/)) {
        const entry = parseMedEntry(part);
        if (!entry) continue;
        let medId = matchMedId(entry.name);
        if (!medId) {
          medId = slugify(entry.name);
          customMeds.add(entry.name);
        }
        const dose = entry.dose
          ? entry.count > 1 ? `${entry.dose} ×${entry.count}` : entry.dose
          : entry.count > 1 ? `×${entry.count}` : '';
        meds.push({
          id: uid(), medId,
          ts: new Date(start.getTime() + 1800000).toISOString(), // 30 min after start
          attackId: a.id,
          dose,
          notes: helpfulness,
          source: 'import',
        });
      }
    }
  }

  if (customMeds.size) {
    warnings.push(
      `Not in your med catalog, imported as custom meds: ${[...customMeds].join(', ')}.`,
    );
  }
  if (skipped) warnings.push(`${skipped} row(s) skipped — no parseable start date.`);

  attacks.sort((a, b) => a.start.localeCompare(b.start));
  meds.sort((a, b) => a.ts.localeCompare(b.ts));
  return { attacks, meds, skipped, warnings };
}
