// REST API behavior via fastify inject(): CRUD shapes, patch merge +
// null/missing semantics, validation 4xx, and resource cleanup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

const sampleAttack = {
  start: '2026-01-02T08:00:00.000Z',
  end: null,
  painLog: [{ ts: '2026-01-02T09:00:00.000Z', level: 7 }],
  peakPain: 7,
  symptoms: ['nausea'],
  triggers: ['stress'],
  aura: true,
  notes: 'first',
  source: 'manual',
};

test('attack CRUD: full payload round-trips with the documented shape', async () => {
  const h = await makeApp({ label: 'migraine-attack-full' });
  try {
    const res = await h.app.inject({ method: 'POST', url: '/api/attacks', payload: sampleAttack });
    assert.equal(res.statusCode, 201);
    const created = res.json();
    assert.match(created.id, /^./);
    assert.deepEqual(created, {
      id: created.id,
      start: '2026-01-02T08:00:00.000Z',
      end: null,
      painLog: [{ ts: '2026-01-02T09:00:00.000Z', level: 7 }],
      peakPain: 7,
      symptoms: ['nausea'],
      triggers: ['stress'],
      aura: true,
      notes: 'first',
      source: 'manual',
    });

    const list = await h.app.inject({ method: 'GET', url: '/api/attacks' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 1);
  } finally {
    await h.close();
  }
});

test('attack POST with only start applies all documented defaults', async () => {
  const h = await makeApp({ label: 'migraine-attack-min' });
  try {
    const res = await h.app.inject({ method: 'POST', url: '/api/attacks', payload: { start: '2026-01-03T10:00:00.000Z' } });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json(), {
      id: res.json().id,
      start: '2026-01-03T10:00:00.000Z',
      end: null,
      painLog: [],
      peakPain: -1,
      symptoms: [],
      triggers: [],
      aura: null,
      notes: '',
      source: 'manual',
    });
  } finally {
    await h.close();
  }
});

test('attack PATCH merges only provided fields and keeps the id', async () => {
  const h = await makeApp({ label: 'migraine-attack-patch' });
  try {
    const { id } = (await h.app.inject({ method: 'POST', url: '/api/attacks', payload: sampleAttack })).json();

    const patched = (await h.app.inject({
      method: 'PATCH', url: `/api/attacks/${id}`, payload: { notes: 'changed' },
    })).json();
    assert.equal(patched.id, id);
    assert.equal(patched.notes, 'changed');
    assert.equal(patched.peakPain, 7); // untouched
    assert.deepEqual(patched.painLog, sampleAttack.painLog);
    assert.equal(patched.aura, true);

    // explicit null clears end/aura; missing keys stay
    const cleared = (await h.app.inject({
      method: 'PATCH', url: `/api/attacks/${id}`, payload: { end: '2026-01-02T20:00:00.000Z', aura: false },
    })).json();
    assert.equal(cleared.end, '2026-01-02T20:00:00.000Z');
    assert.equal(cleared.aura, false);
    const cleared2 = (await h.app.inject({
      method: 'PATCH', url: `/api/attacks/${id}`, payload: { end: null, aura: null },
    })).json();
    assert.equal(cleared2.end, null);
    assert.equal(cleared2.aura, null);
    assert.equal(cleared2.notes, 'changed');
  } finally {
    await h.close();
  }
});

test('attack PATCH/DELETE 404 for unknown ids', async () => {
  const h = await makeApp({ label: 'migraine-attack-404' });
  try {
    const patch = await h.app.inject({ method: 'PATCH', url: '/api/attacks/nope', payload: { notes: 'x' } });
    assert.equal(patch.statusCode, 404);
    const del = await h.app.inject({ method: 'DELETE', url: '/api/attacks/nope' });
    assert.equal(del.statusCode, 404);
  } finally {
    await h.close();
  }
});

test('deleting an attack keeps meds but unlinks attackId', async () => {
  const h = await makeApp({ label: 'migraine-unlink' });
  try {
    const { id } = (await h.app.inject({ method: 'POST', url: '/api/attacks', payload: sampleAttack })).json();
    const med = (await h.app.inject({
      method: 'POST', url: '/api/meds',
      payload: { medId: 'nurtec', ts: '2026-01-02T09:00:00.000Z', attackId: id, dose: '75 mg' },
    })).json();
    const del = await h.app.inject({ method: 'DELETE', url: `/api/attacks/${id}` });
    assert.equal(del.statusCode, 200);
    const meds = (await h.app.inject({ method: 'GET', url: '/api/meds' })).json();
    assert.equal(meds.length, 1);
    assert.equal(meds[0].id, med.id);
    assert.equal(meds[0].attackId, null);
  } finally {
    await h.close();
  }
});

test('meds: defaults, required medId, patch null semantics', async () => {
  const h = await makeApp({ label: 'migraine-meds' });
  try {
    const created = (await h.app.inject({
      method: 'POST', url: '/api/meds', payload: { medId: 'nurtec' },
    }));
    assert.equal(created.statusCode, 201);
    const med = created.json();
    assert.match(med.ts, /^\d{4}-\d{2}-\d{2}T/); // generated timestamp
    assert.equal(med.dose, '');
    assert.equal(med.attackId, null);
    assert.equal(med.notes, '');
    assert.equal(med.source, 'manual');

    const missing = await h.app.inject({ method: 'POST', url: '/api/meds', payload: { dose: 'x' } });
    assert.equal(missing.statusCode, 400);

    // explicit null dose resets to '' (old ?? '' semantics); missing keeps
    await h.app.inject({ method: 'PATCH', url: `/api/meds/${med.id}`, payload: { dose: '75 mg', attackId: 'atk1' } });
    const nulled = (await h.app.inject({
      method: 'PATCH', url: `/api/meds/${med.id}`, payload: { dose: null, attackId: null },
    })).json();
    assert.equal(nulled.dose, '');
    assert.equal(nulled.attackId, null);

    const kept = (await h.app.inject({
      method: 'PATCH', url: `/api/meds/${med.id}`, payload: { dose: '50 mg' },
    })).json();
    assert.equal(kept.dose, '50 mg');

    const invalid = await h.app.inject({ method: 'PATCH', url: `/api/meds/${med.id}`, payload: { attackId: 5 } });
    assert.equal(invalid.statusCode, 400);
    const unchanged = (await h.app.inject({ method: 'GET', url: '/api/meds' })).json()[0];
    assert.equal(unchanged.attackId, null);
    assert.equal(unchanged.dose, '50 mg');
  } finally {
    await h.close();
  }
});

test('dirty legacy rows: unrelated invalid stored fields do not block valid patches', async (t) => {
  const h = await makeApp({ label: 'migraine-dirty-legacy' });
  t.after(() => h.close());

  // rows written before validation existed: out-of-range peakPain and a
  // non-string attack_id stored directly in SQLite
  h.db.prepare(`INSERT INTO attacks (id,start,"end",pain_log,peak_pain,symptoms,triggers,aura,notes,source)
    VALUES ('dirty1','2025-01-01T00:00:00Z',NULL,'[]',99,'[]','[]',NULL,'legacy','manual')`).run();
  h.db.prepare(`INSERT INTO meds (id,med_id,ts,dose,attack_id,notes,source)
    VALUES ('dirtym','nurtec','2025-01-01T00:00:00Z','',7,'legacy','manual')`).run();

  // a notes-only patch succeeds despite the unrelated dirty stored field
  const patched = await h.app.inject({ method: 'PATCH', url: '/api/attacks/dirty1', payload: { notes: 'fixed notes' } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().id, 'dirty1'); // route id preserved
  assert.equal(patched.json().notes, 'fixed notes');
  assert.equal(patched.json().peakPain, 99); // untouched dirty value stays as-is

  // patching the dirty field itself still requires a valid value
  const invalid = await h.app.inject({ method: 'PATCH', url: '/api/attacks/dirty1', payload: { peakPain: 12 } });
  assert.equal(invalid.statusCode, 400);
  const stillDirty = h.db.prepare('SELECT peak_pain FROM attacks WHERE id = ?').get('dirty1');
  assert.equal(stillDirty.peak_pain, 99);

  const fixed = await h.app.inject({ method: 'PATCH', url: '/api/attacks/dirty1', payload: { peakPain: 5 } });
  assert.equal(fixed.statusCode, 200);
  assert.equal(fixed.json().peakPain, 5);

  // same policy for meds: dirty stored attackId tolerated on unrelated patch
  const medPatched = await h.app.inject({ method: 'PATCH', url: '/api/meds/dirtym', payload: { notes: 'ok' } });
  assert.equal(medPatched.statusCode, 200);
  // the TEXT column's affinity stores 7 as '7' — same as the original server
  assert.equal(medPatched.json().attackId, '7');
  // but a patch touching attackId must still be valid
  const medInvalid = await h.app.inject({ method: 'PATCH', url: '/api/meds/dirtym', payload: { attackId: 3 } });
  assert.equal(medInvalid.statusCode, 400);
});

test('refills: required fields, mapper shape', async () => {
  const h = await makeApp({ label: 'migraine-refills' });
  try {
    const created = (await h.app.inject({
      method: 'POST', url: '/api/refills', payload: { medId: 'nurtec', date: '2026-01-10', notes: '8 tablets' },
    }));
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().source, 'manual');
    assert.deepEqual(created.json(), {
      id: created.json().id, medId: 'nurtec', date: '2026-01-10', quantity: null, notes: '8 tablets', source: 'manual',
    });

    const noDate = await h.app.inject({ method: 'POST', url: '/api/refills', payload: { medId: 'nurtec' } });
    assert.equal(noDate.statusCode, 400);
    const noMed = await h.app.inject({ method: 'POST', url: '/api/refills', payload: { date: '2026-01-10' } });
    assert.equal(noMed.statusCode, 400);

    const del = await h.app.inject({ method: 'DELETE', url: `/api/refills/${created.json().id}` });
    assert.equal(del.statusCode, 200);
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/refills' })).json().length, 0);
  } finally {
    await h.close();
  }
});

test('settings PUT/GET round-trip stores arbitrary JSON values', async () => {
  const h = await makeApp({ label: 'migraine-settings' });
  try {
    const put = await h.app.inject({ method: 'PUT', url: '/api/settings/rules', payload: { nurtec: { limit: 15, windowDays: 30 } } });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json(), { ok: true });
    await h.app.inject({ method: 'PUT', url: '/api/settings/planned', payload: { emgality: '2026-03-01' } });
    // value null (empty body) is stored as JSON null, like the original
    await h.app.inject({ method: 'PUT', url: '/api/settings/doses' });

    const settings = (await h.app.inject({ method: 'GET', url: '/api/settings' })).json();
    assert.deepEqual(settings, {
      rules: { nurtec: { limit: 15, windowDays: 30 } },
      planned: { emgality: '2026-03-01' },
      doses: null,
    });
  } finally {
    await h.close();
  }
});

test('invalid write payloads produce controlled 400s and insert nothing', async (t) => {
  const h = await makeApp({ label: 'migraine-invalid' });
  t.after(() => h.close());
  const before = (await h.app.inject({ method: 'GET', url: '/api/attacks' })).json().length;

  const badAttackBodies = [
    {},                                        // missing start
    { start: '' },                             // empty start
    { ...sampleAttack, painLog: 'oops' },      // JSON column protection
    { ...sampleAttack, symptoms: 'nausea' },
    { ...sampleAttack, triggers: { a: 1 } },
    { ...sampleAttack, painLog: [{ ts: 'x', level: 'high' }] },
    { ...sampleAttack, peakPain: 11 },
    { ...sampleAttack, peakPain: 2.5 },
    { ...sampleAttack, aura: 1 },
    { ...sampleAttack, notes: 5 },
    { ...sampleAttack, id: 42 },
  ];
  for (const payload of badAttackBodies) {
    const res = await h.app.inject({ method: 'POST', url: '/api/attacks', payload });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
    assert.ok(res.json().error, 'error message present');
  }

  // garbage body types are controlled too (old code could 500 on these).
  // A raw string with no JSON content-type gets Fastify's 415 (same as the
  // original server); JSON-typed garbage gets our 400.
  for (const payload of [[1, 2], { unrelated: true }]) {
    const res = await h.app.inject({ method: 'POST', url: '/api/attacks', payload });
    assert.equal(res.statusCode, 400);
  }
  const raw = await h.app.inject({ method: 'POST', url: '/api/attacks', payload: 'attack' });
  assert.ok([400, 415].includes(raw.statusCode), `controlled 4xx, got ${raw.statusCode}`);

  // invalid PATCH does not corrupt the stored record
  const { id } = (await h.app.inject({ method: 'POST', url: '/api/attacks', payload: sampleAttack })).json();
  const badPatch = await h.app.inject({ method: 'PATCH', url: `/api/attacks/${id}`, payload: { end: 123 } });
  assert.equal(badPatch.statusCode, 400);
  const after = (await h.app.inject({ method: 'GET', url: '/api/attacks' })).json();
  assert.equal(after.length, before + 1);
  assert.equal(after[0].end, null);

  // invalid settings key
  const badKey = await h.app.inject({ method: 'PUT', url: '/api/settings/bad%20key%2Fx', payload: { a: 1 } });
  assert.equal(badKey.statusCode, 400);
});

test('malformed JSON bodies are rejected by the framework with 400', async (t) => {
  const h = await makeApp({ label: 'migraine-badjson' });
  t.after(() => h.close());
  const res = await h.app.inject({
    method: 'POST', url: '/api/attacks',
    headers: { 'content-type': 'application/json' },
    body: '{"start": ',
  });
  assert.equal(res.statusCode, 400);
});

test('app.close() releases the database handle', async () => {
  const h = await makeApp({ label: 'migraine-close' });
  await h.app.inject({ method: 'GET', url: '/api/health' });
  await h.close();
  // using a closed node:sqlite database must throw
  assert.throws(() => h.db.prepare('SELECT 1').all());
});
