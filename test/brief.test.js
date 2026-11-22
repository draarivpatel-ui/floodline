import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  briefCSV, briefDocument, briefMarkdown, briefPayload, decodeScenarioHash,
  encodeScenarioHash, signBrief, verifyBriefDocument,
} from '../src/brief.js';
import { canonicalJSON, csvCell } from '../src/exports.js';
import { INTERVENTIONS, compareTier } from '../src/mitigation.js';
import { PRESETS, buildScenario } from '../src/presets.js';
import { sha256hex, toHex } from '../src/sha256.js';
import { cutoffMatrix } from '../src/timeline.js';

const originsOf = preset => preset.graph.nodes
  .filter(node => ['home', 'school'].includes(node.type)).map(node => node.id);

const docFor = preset => {
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  const comparison = compareTier(model, 1, origins);
  const matrix = cutoffMatrix(preset.graph, model.active, origins, 'car', { raise: model.raise });
  const payload = briefPayload({ model, tierLabel: '50-yr', scale: 1, comparison, matrix, budgetM: 9 });
  return { model, comparison, matrix, payload, doc: briefDocument(payload) };
};

test('SHA-256 matches the FIPS 180-4 known-answer vectors', () => {
  assert.equal(sha256hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(sha256hex(new Uint8Array(1_000_000).fill(97)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('SHA-256 handles the 55 and 56 byte padding boundaries and unicode', () => {
  for (const text of ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64),
    'a'.repeat(119), 'flooding \u00e9vacuation \u4e2d\u6587', 'x'.repeat(1000)]) {
    const expected = createHash('sha256').update(new TextEncoder().encode(text)).digest('hex');
    assert.equal(sha256hex(text), expected, `length ${new TextEncoder().encode(text).length}`);
  }
  assert.equal(sha256hex(Uint8Array.from([97, 98, 99])), sha256hex('abc'));
  assert.equal(toHex(Uint8Array.from([0xde, 0xad, 0xbe, 0xef])), 'deadbeef');
  assert.equal(sha256hex('anything').length, 64);
  assert.throws(() => sha256hex(42), TypeError);
  assert.throws(() => sha256hex(null), TypeError);
});

for (const preset of PRESETS) {
  test(`${preset.id} brief payload is deterministic and carries the disclosures`, () => {
    const a = docFor(preset);
    const b = docFor(preset);
    assert.deepEqual(a.payload, b.payload);
    assert.equal(a.doc, b.doc);
    assert.equal(a.payload.version, 1);
    assert.equal(a.payload.preset, preset.id);
    assert.ok(a.payload.notice.includes('training'));
    assert.ok(a.payload.disclosure.includes('0.30'));
    assert.equal(a.payload.stormTier.label, '50-yr');
    assert.equal(a.payload.stormTier.scale, 1);
    assert.equal(a.payload.vehicleReferenceM, 0.30);
    assert.equal(a.payload.comparison.length, INTERVENTIONS.length + 1);
    assert.equal(a.payload.cutoffTimeline.length, originsOf(preset).length);
  });
}

for (const preset of PRESETS) {
  for (const tier of [{ label: '10-yr', scale: 0.6 }, { label: '100-yr', scale: 1.4 }, { label: 'custom', scale: 1.7 }]) {
    test(`${preset.id} ${tier.label} brief signs and verifies at its own tier`, () => {
      const model = buildScenario(preset);
      const origins = originsOf(preset);
      const comparison = compareTier(model, tier.scale, origins);
      const matrix = cutoffMatrix(preset.graph, model.active, origins, 'car', { raise: model.raise });
      const payload = briefPayload({ model, tierLabel: tier.label, scale: tier.scale, comparison, matrix, budgetM: 4 });
      assert.equal(payload.stormTier.label, tier.label);
      assert.equal(payload.stormTier.scale, tier.scale);
      const check = verifyBriefDocument(briefDocument(payload));
      assert.equal(check.ok, true);
    });
  }
}

test('a document with reordered keys still verifies because signing is canonical', () => {
  const { doc } = docFor(PRESETS[0]);
  const parsed = JSON.parse(doc);
  const reordered = JSON.stringify({
    sha256: parsed.sha256,
    payload: parsed.payload,
    algorithm: parsed.algorithm,
    extraTopLevelField: 'ignored by digest',
  });
  const check = verifyBriefDocument(reordered);
  assert.equal(check.ok, true, 'canonical digest ignores key order and sibling fields');
});

test('brief signature is the canonical-JSON digest and verifies a clean document', () => {
  const { payload, doc } = docFor(PRESETS[0]);
  const signed = signBrief(payload);
  assert.equal(signed.algorithm, 'SHA-256');
  assert.equal(signed.sha256, createHash('sha256')
    .update(canonicalJSON(payload)).digest('hex'));
  assert.equal(signed.sha256, sha256hex(canonicalJSON(payload)));
  assert.equal(signBrief(payload).sha256, signed.sha256);
  const check = verifyBriefDocument(doc);
  assert.equal(check.ok, true);
  assert.equal(check.sha256, signed.sha256);
  const pretty = verifyBriefDocument(JSON.stringify(JSON.parse(doc), null, 2));
  assert.equal(pretty.ok, true);
});

test('every payload edit, forged digest, or malformed document fails verification', () => {
  const { doc } = docFor(PRESETS[0]);
  const parsed = JSON.parse(doc);
  const edits = [
    draft => { draft.payload.comparison[0].passableKm = 999; },
    draft => { draft.payload.injected = true; },
    draft => { draft.payload.preset = 'coastal'; },
    draft => { draft.sha256 = 'f'.repeat(64); },
    draft => { draft.algorithm = 'SHA-1'; },
    draft => { delete draft.sha256; },
    draft => { draft.payload = 'not-an-object'; },
    draft => { draft.payload = null; },
  ];
  for (const apply of edits) {
    const draft = JSON.parse(doc);
    apply(draft);
    assert.equal(verifyBriefDocument(JSON.stringify(draft)).ok, false, apply.toString());
  }
  assert.equal(verifyBriefDocument('not json at all').ok, false);
  assert.equal(verifyBriefDocument('42').ok, false);
  assert.equal(verifyBriefDocument('[1,2,3]').ok, false);
  assert.equal(verifyBriefDocument('{"algorithm":"SHA-256","sha256":"x"}').ok, false);
});

test('infinite cutoffs serialize as tokens so canonical JSON stays finite', () => {
  const comparison = {
    threshold: 0.3,
    rows: [{
      intervention: null, costM: 0, sim: { peakStage: 1 }, stageDrop: 0,
      passableKm: 1, passableDelta: 0, stranded: [], strandedCount: 0,
      strandedReduction: 0, householdsAvoided: 0, perMillion: null,
      earliest: Infinity, extension: null, cutoffs: new Map([['o', Infinity], ['g', -Infinity]]),
    }],
  };
  const matrix = { rows: [{ origin: 'o', label: 'O', households: 3, firstCut: null, lastSafe: 5, reopened: true, hourly: [true] }] };
  const payload = briefPayload({
    model: { preset: { id: 'x' }, mitigations: {} },
    tierLabel: 'custom', scale: 1, comparison, matrix, budgetM: 0,
  });
  assert.equal(payload.comparison[0].earliestCutoffMin, 'never');
  assert.equal(payload.comparison[0].cutoffExtensionMin, 'not-comparable');
  assert.equal(payload.comparison[0].cutoffs.o, 'never');
  assert.equal(payload.comparison[0].cutoffs.g, 'closed-at-start');
  assert.doesNotThrow(() => briefDocument(payload));
});

test('brief CSV is rectangular, CRLF-terminated, and injection-safe', () => {
  const { comparison } = docFor(PRESETS[0]);
  const csv = briefCSV(comparison, '50-yr');
  assert.ok(csv.endsWith('\r\n'));
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, INTERVENTIONS.length + 2);
  assert.ok(lines[0].startsWith('"storm_tier","intervention","label"'));
  assert.ok(lines[0].includes('households_avoided'));
  assert.ok(lines[1].includes('baseline'));
  for (const line of lines.slice(1)) assert.ok(line.includes('50-yr'));
  const hostile = {
    threshold: 0.3,
    rows: [{
      intervention: { id: 'x', label: '=cmd|open' }, costM: 1, sim: { peakStage: 1 },
      stageDrop: 0, passableKm: 1, passableDelta: 0, stranded: [], strandedCount: 0,
      strandedReduction: 0, householdsAvoided: 0, perMillion: null, earliest: 5,
      extension: 1, cutoffs: new Map(),
    }],
  };
  const cell = briefCSV(hostile, 't').trimEnd().split('\r\n')[1].split(',')[2];
  assert.ok(cell.startsWith('"\''), `unguarded cell: ${cell}`);
});

for (const preset of PRESETS) {
  test(`${preset.id} brief CSV names the tier and counts every row`, () => {
    const { comparison } = docFor(preset);
    const lines = briefCSV(comparison, 'custom').trimEnd().split('\r\n');
    assert.equal(lines.length, INTERVENTIONS.length + 2);
    for (const item of INTERVENTIONS) assert.ok(lines.some(l => l.includes(item.id)));
    assert.ok(lines.some(l => l.includes('"Baseline, no intervention"')));
  });
}

for (const preset of PRESETS) {
  test(`${preset.id} markdown brief renders every intervention and zone label`, () => {
    const { payload } = docFor(preset);
    const md = briefMarkdown(payload);
    for (const row of payload.comparison) assert.ok(md.includes(row.label), row.label);
    for (const row of payload.cutoffTimeline) assert.ok(md.includes(row.label), row.label);
    assert.ok(md.split('\n').some(line => line.startsWith('| ')));
  });
}

test('brief markdown shows the table, cutoffs, digest, and disclosures', () => {
  const { payload } = docFor(PRESETS[0]);
  const md = briefMarkdown(payload);
  assert.ok(md.includes('# FloodLine resilience brief'));
  assert.ok(md.includes('| Intervention |'));
  assert.ok(md.includes('SHA-256 ' + sha256hex(canonicalJSON(payload))));
  assert.ok(md.includes(payload.notice));
  assert.ok(md.includes(payload.disclosure));
  assert.ok(md.includes('50-yr'));
  for (const row of payload.cutoffTimeline) assert.ok(md.includes(row.label));
});

const b64url = text => '#flood=' + Buffer.from(text, 'utf8').toString('base64url');
const stateTemplate = {
  v: 1, preset: 'bayou', origin: 'homes', mode: 'car', minute: 42,
  mitigations: { pavement: true, clear: false, bridge: true },
  tier: 't500', intensity: null, budgetM: 3.5,
  edits: { rain: [5, 12, 30, 8], cn: 88, impervious: null, blockage: 0.2 },
};

for (const preset of PRESETS) {
  test(`${preset.id} scenario state round-trips through the URL hash`, () => {
    const state = {
      ...stateTemplate, preset: preset.id, origin: originsOf(preset)[0],
      mode: 'pedestrian', minute: 0, mitigations: { pavement: false, clear: false, bridge: false },
      tier: 't10', edits: null,
    };
    const hash = encodeScenarioHash(state);
    const restored = decodeScenarioHash(hash, PRESETS);
    assert.equal(restored.preset, preset.id);
    assert.equal(restored.origin, originsOf(preset)[0]);
    assert.equal(restored.mode, 'pedestrian');
    assert.equal(restored.minute, 0);
    assert.equal(restored.tier, 't10');
    assert.equal(restored.edits, null);
    assert.deepEqual(restored.mitigations, { pavement: false, clear: false, bridge: false });
  });
}

test('the full scenario state round-trips byte for byte', () => {
  const restored = decodeScenarioHash(encodeScenarioHash(stateTemplate), PRESETS);
  assert.deepEqual(restored.mitigations, { pavement: true, clear: false, bridge: true });
  assert.deepEqual(restored.edits, stateTemplate.edits);
  assert.equal(restored.budgetM, 3.5);
  const hash = encodeScenarioHash(stateTemplate);
  assert.ok(hash.startsWith('#flood='));
  assert.match(hash.slice(7), /^[A-Za-z0-9_-]+$/);
  const custom = decodeScenarioHash(encodeScenarioHash({
    ...stateTemplate, tier: 'custom', intensity: 1.7,
  }), PRESETS);
  assert.equal(custom.tier, 'custom');
  assert.equal(custom.intensity, 1.7);
});

test('encoding is deterministic and state changes change the hash', () => {
  const a = encodeScenarioHash(stateTemplate);
  const b = encodeScenarioHash(stateTemplate);
  assert.equal(a, b);
  assert.notEqual(encodeScenarioHash({ ...stateTemplate, minute: 43 }), a);
  assert.notEqual(encodeScenarioHash({ ...stateTemplate, preset: 'coastal' }), a);
  assert.notEqual(encodeScenarioHash({ ...stateTemplate, mitigations: { ...stateTemplate.mitigations, clear: true } }), a);
});

test('malformed, foreign, or out-of-range hashes all decode to null', () => {
  const bad = [
    '', '#', '#flood=', '#flood=%%%', '#other=AAAA',
    b64url('not json'), b64url('[]'), b64url('42'), b64url('{}'),
    b64url(JSON.stringify({ ...stateTemplate, v: 2 })),
    b64url(JSON.stringify({ ...stateTemplate, preset: 'atlantis' })),
    b64url(JSON.stringify({ ...stateTemplate, mode: 'bike' })),
    b64url(JSON.stringify({ ...stateTemplate, minute: -1 })),
    b64url(JSON.stringify({ ...stateTemplate, minute: 361 })),
    b64url(JSON.stringify({ ...stateTemplate, minute: 1.5 })),
    b64url(JSON.stringify({ ...stateTemplate, minute: '75' })),
    b64url(JSON.stringify({ ...stateTemplate, origin: 42 })),
    b64url(JSON.stringify({ ...stateTemplate, origin: 'x'.repeat(65) })),
    b64url(JSON.stringify({ ...stateTemplate, tier: 't999' })),
    b64url(JSON.stringify({ ...stateTemplate, tier: 'custom', intensity: 0.1 })),
    b64url(JSON.stringify({ ...stateTemplate, tier: 'custom', intensity: 9 })),
    b64url(JSON.stringify({ ...stateTemplate, budgetM: -1 })),
    b64url(JSON.stringify({ ...stateTemplate, budgetM: 10 })),
    b64url(JSON.stringify({ ...stateTemplate, edits: {} })),
    b64url(JSON.stringify({ ...stateTemplate, edits: { ...stateTemplate.edits, rain: [] } })),
    b64url(JSON.stringify({ ...stateTemplate, edits: { ...stateTemplate.edits, rain: new Array(25).fill(1) } })),
    b64url(JSON.stringify({ ...stateTemplate, edits: { ...stateTemplate.edits, rain: [5, -1] } })),
    b64url(JSON.stringify({ ...stateTemplate, edits: { ...stateTemplate.edits, rain: [5001] } })),
    b64url(JSON.stringify({ ...stateTemplate, edits: { ...stateTemplate.edits, cn: 0 } })),
    b64url(JSON.stringify({ ...stateTemplate, edits: { ...stateTemplate.edits, cn: 101 } })),
    b64url(JSON.stringify({ ...stateTemplate, edits: { ...stateTemplate.edits, impervious: -1 } })),
    b64url(JSON.stringify({ ...stateTemplate, edits: { ...stateTemplate.edits, impervious: 101 } })),
    b64url(JSON.stringify({ ...stateTemplate, edits: { ...stateTemplate.edits, blockage: 2 } })),
  ];
  for (const hash of bad) {
    assert.equal(decodeScenarioHash(hash, PRESETS), null, hash.slice(0, 60));
  }
  assert.equal(decodeScenarioHash(null, PRESETS), null);
  assert.equal(decodeScenarioHash(42, PRESETS), null);
});

test('boundary values at each slider end still decode', () => {
  for (const minute of [0, 360]) {
    assert.equal(decodeScenarioHash(encodeScenarioHash({ ...stateTemplate, minute }), PRESETS).minute, minute);
  }
  for (const intensity of [0.4, 2.2]) {
    assert.equal(decodeScenarioHash(encodeScenarioHash(
      { ...stateTemplate, tier: 'custom', intensity }), PRESETS).intensity, intensity);
  }
  for (const budgetM of [0, 9]) {
    assert.equal(decodeScenarioHash(encodeScenarioHash({ ...stateTemplate, budgetM }), PRESETS).budgetM, budgetM);
  }
  const impervious = decodeScenarioHash(encodeScenarioHash({
    ...stateTemplate, edits: { ...stateTemplate.edits, impervious: 62 },
  }), PRESETS);
  assert.equal(impervious.edits.impervious, 62);
});

test('extra fields are ignored and missing mitigations normalize to false', () => {
  const restored = decodeScenarioHash(b64url(JSON.stringify({
    ...stateTemplate, junk: { nested: [1, 2] }, mitigations: { pavement: 'yes' },
  })), PRESETS);
  assert.equal(restored.preset, 'bayou');
  assert.deepEqual(restored.mitigations, { pavement: false, clear: false, bridge: false });
  const bare = decodeScenarioHash(b64url(JSON.stringify({
    v: 1, preset: 'bayou', origin: 'homes', mode: 'car', minute: 1,
    tier: 't10', intensity: null, budgetM: 0, edits: null,
  })), PRESETS);
  assert.deepEqual(bare.mitigations, { pavement: false, clear: false, bridge: false });
});

test('csvCell guards every formula-injection prefix including unicode forms', () => {
  const guarded = ['=2+2', '+SUM(1)', '-10', '@import', '\t=evil', '  =lead', '\uFF1D2', '\uFF0B1', '\uFF0D9', '\uFF20x'];
  for (const value of guarded) {
    const cell = csvCell(value);
    assert.ok(cell.startsWith('"\''), `${JSON.stringify(value)} -> ${cell}`);
  }
  assert.equal(csvCell(-3.5), '-3.5');
  assert.equal(csvCell('plain'), '"plain"');
  assert.equal(csvCell('North, "Main"'), '"North, ""Main"""');
  assert.equal(csvCell(null), '');
  assert.throws(() => csvCell(Infinity), RangeError);
});
