import { describe, expect, it } from 'vitest';
import {
  MED_CATALOG, contrastRatio, medColor, painColor, relativeLuminance, textOn,
  DARK_INK, LIGHT_INK,
} from './meds';
import {
  NURTEC_DEFAULT_RULE, PAINKILLER_DEFAULT_RULE, PAINKILLER_MED_IDS,
} from './usage';

/** Every color that can carry an in-chip label somewhere in the app. */
function palette(): { label: string; color: string }[] {
  const entries = MED_CATALOG.map((m) => ({ label: `catalog:${m.id}`, color: m.color }));
  // Custom (imported) med colors come from a hash of the slug; sample enough
  // ids to cover every extended-palette entry.
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
    entries.push({ label: `custom:${id}`, color: medColor(id) });
  }
  for (let level = 0; level <= 10; level += 1) {
    entries.push({ label: `pain:${level}`, color: painColor(level) });
  }
  return entries;
}

describe('palette contrast', () => {
  it('computes WCAG relative luminance for known anchors', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    // Mid grey is far brighter than the naive 0.5 channel average suggests.
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2159, 3);
  });

  it('reports 21:1 for black on white and 1:1 for a color on itself', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#CC79A7', '#CC79A7')).toBeCloseTo(1, 5);
  });

  it('picks the higher-contrast ink and clears 4.5:1 for every palette color', () => {
    for (const { label, color } of palette()) {
      const ink = textOn(color);
      expect([DARK_INK, LIGHT_INK], label).toContain(ink);
      const ratio = contrastRatio(color, ink);
      expect(ratio, `${label} (${color}) on ${ink}`).toBeGreaterThanOrEqual(4.5);
      // It is the *better* choice, not merely an acceptable one.
      const other = ink === DARK_INK ? LIGHT_INK : DARK_INK;
      expect(contrastRatio(color, ink), label).toBeGreaterThanOrEqual(
        contrastRatio(color, other),
      );
    }
  });

  it('uses dark ink on light Nurtec pink (the old white label failed)', () => {
    // The previous brightness heuristic returned near-white here: 3.1:1.
    expect(textOn('#CC79A7')).toBe(DARK_INK);
  });

  it('keeps light ink on the darkest blues', () => {
    expect(textOn('#0072B2')).toBe(LIGHT_INK);
    expect(textOn('#00224d')).toBe(LIGHT_INK);
  });
});

describe('usage defaults match the medication catalog', () => {
  it('shares the 15-day / 30-day budget across Tylenol, Ibuprofen and Naproxen', () => {
    for (const medId of PAINKILLER_MED_IDS) {
      const def = MED_CATALOG.find((m) => m.id === medId);
      expect(def, medId).toBeTruthy();
      expect(def!.defaultRule).toEqual(PAINKILLER_DEFAULT_RULE);
    }
  });

  it('keeps Nurtec on its own default rule', () => {
    const nurtec = MED_CATALOG.find((m) => m.id === 'nurtec');
    expect(nurtec?.defaultRule).toEqual(NURTEC_DEFAULT_RULE);
  });
});
