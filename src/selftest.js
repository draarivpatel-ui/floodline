import { integrateDischarge, normalDepthDischarge, partitionRain, rainSeries, rainToDischarge } from './hydrology.js';
import { routeAt } from './routing.js';
import { PRESETS, buildScenario } from './presets.js';
import { INTERVENTIONS, STORM_TIERS, compareTier } from './mitigation.js';
import { cutoffMatrix } from './timeline.js';
import { csvCell } from './exports.js';
import { sha256hex } from './sha256.js';
import { decodeScenarioHash, encodeScenarioHash, signBrief, verifyBriefDocument, briefPayload } from './brief.js';

const check = (condition, detail) => {
  if (!condition) throw new Error(`check failed: ${detail}`);
  return detail;
};

// Every check is a real run of the shipped modules, not a canned answer.
export const SELF_CHECKS = [
  {
    id: 'sha256-kat',
    name: 'SHA-256 known-answer vectors (FIPS 180-4)',
    run() {
      const cases = [
        ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
        ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
          '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
      ];
      for (const [text, want] of cases) {
        check(sha256hex(text) === want, `digest of ${JSON.stringify(text)}`);
      }
      const million = sha256hex(new Uint8Array(1_000_000).fill(97));
      check(million === 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0', 'million a digest');
      return '3 vectors plus the million-a digest match';
    },
  },
  {
    id: 'runoff-conservation',
    name: 'Runoff partition conservation and monotonicity',
    run() {
      for (const cn of [30, 55, 80, 98, 100]) {
        for (const rain of [0, 3, 17, 64, 210, 1400]) {
          const row = partitionRain(rain, cn);
          check(Math.abs(row.abstraction + row.storage + row.runoff - rain) < 1e-9,
            `budget closes at CN ${cn}, ${rain} mm`);
          check(row.runoff >= 0 && row.runoff <= rain, `0 <= Q <= P at CN ${cn}`);
        }
      }
      for (const cn of [40, 76, 95]) {
        const rising = [0, 5, 25, 90, 400, 2400].map(r => partitionRain(r, cn).runoff);
        check(rising.every((v, i) => i === 0 || v >= rising[i - 1]), `runoff monotone in rain at CN ${cn}`);
      }
      for (const rain of [2, 40, 300]) {
        const byCn = [20, 45, 70, 90, 100].map(c => partitionRain(rain, c).runoff);
        check(byCn.every((v, i) => i === 0 || v >= byCn[i - 1]), `runoff monotone in CN at ${rain} mm`);
      }
      return 'budget closes and runoff is monotone in rain and CN';
    },
  },
  {
    id: 'discharge-conservation',
    name: 'Hydrograph volume conservation',
    run() {
      const bins = rainSeries([8, 14, 26, 18, 9], 83);
      const q = rainToDischarge(bins, 4.4, 26, 108);
      check(q.every(v => v >= 0), 'discharge never negative');
      const volume = bins.at(-1).runoff * 4.4 * 1000;
      check(Math.abs(integrateDischarge(q) - volume) / volume < 1e-9, 'discharged volume equals runoff volume');
      return `conserved ${volume.toFixed(0)} m3 through the kernel`;
    },
  },
  {
    id: 'routing-exclusion',
    name: 'Routing excludes impassable edges',
    run() {
      const graph = {
        nodes: [
          { id: 'o', type: 'home', floor: 8 },
          { id: 'm', type: 'junction', floor: 8 },
          { id: 's', type: 'shelter', floor: 8 },
        ],
        edges: [
          { id: 'low', a: 'o', b: 's', m: 100, floor: 1 },
          { id: 'high', a: 'o', b: 'm', m: 300, floor: 8 },
          { id: 'high2', a: 'm', b: 's', m: 300, floor: 8 },
        ],
      };
      const channel = { width: 6, sideSlope: 1, n: 0.038, slope: 0.001 };
      const signal = heights => ({
        channel, q: heights.map(h => normalDepthDischarge(h, channel)), stage: heights,
      });
      const view = routeAt(graph, signal([0, 1.5, 1.5]), 1, 'o', 'car');
      check(view.dry && !view.dry.edges.some(e => e.id === 'low'), 'dry route skips the flooded edge');
      const flooded = signal([0, 9, 9]);
      check(routeAt(graph, flooded, 1, 'o', 'car').dry === null, 'all roads wet means unreachable');
      return 'flooded edges excluded, total flooding means unreachable';
    },
  },
  {
    id: 'mitigation-nonworsening',
    name: 'Mitigation never worsens baseline metrics',
    run() {
      for (const preset of PRESETS) {
        const model = buildScenario(preset);
        const origins = preset.graph.nodes
          .filter(n => ['home', 'school'].includes(n.type)).map(n => n.id);
        for (const tier of [STORM_TIERS[1], STORM_TIERS[2]]) {
          const cmp = compareTier(model, tier.scale, origins);
          for (const row of cmp.rows.slice(1)) {
            check(row.stageDrop >= -1e-9, `${preset.id} ${tier.id} ${row.intervention.id} stage drop`);
            check(row.passableDelta >= -1e-9, `${preset.id} ${tier.id} ${row.intervention.id} passable km`);
            check(row.strandedReduction >= 0, `${preset.id} ${tier.id} ${row.intervention.id} stranded`);
            check(row.sim.peakStage <= cmp.base.sim.peakStage + 1e-9,
              `${preset.id} ${tier.id} ${row.intervention.id} peak stage`);
          }
        }
      }
      return `${INTERVENTIONS.length} interventions verified non-worsening on ${PRESETS.length} basins`;
    },
  },
  {
    id: 'cutoff-monotonicity',
    name: 'Heavier storm never extends a safe departure',
    run() {
      for (const preset of PRESETS) {
        const origins = preset.graph.nodes
          .filter(n => ['home', 'school'].includes(n.type)).map(n => n.id);
        const light = buildScenario(preset, { rain: preset.rain.map(r => r * 0.6) });
        const heavy = buildScenario(preset, { rain: preset.rain.map(r => r * 1.8) });
        const a = cutoffMatrix(preset.graph, light.active, origins, 'car');
        const b = cutoffMatrix(preset.graph, heavy.active, origins, 'car');
        for (let i = 0; i < origins.length; i += 1) {
          const safeA = a.rows[i].lastSafe ?? -1;
          const safeB = b.rows[i].lastSafe ?? -1;
          check(safeB <= safeA, `${preset.id} ${origins[i]} last safe ${safeB} > ${safeA}`);
        }
      }
      return 'last safe departure is monotone in storm scale on every basin';
    },
  },
  {
    id: 'csv-escaping',
    name: 'CSV escaping blocks formula injection',
    run() {
      check(csvCell('=2+2') === '"\'=2+2"', 'formula prefix guarded');
      check(csvCell('  =cmd') === '"\'  =cmd"', 'whitespace formula guarded');
      check(csvCell('North, "Main"') === '"North, ""Main"""', 'quotes doubled');
      check(csvCell(-3.5) === '-3.5', 'numbers stay numeric');
      check(csvCell('\uFF1D2') === '"\'\uFF1D2"', 'fullwidth equals guarded');
      return 'injection prefixes, quotes and unicode forms all escaped';
    },
  },
  {
    id: 'tamper-detection',
    name: 'Signed brief detects tampering',
    run() {
      const model = buildScenario(PRESETS[0]);
      const origins = ['school', 'homes', 'gardens'];
      const cmp = compareTier(model, 1, origins);
      const matrix = cutoffMatrix(PRESETS[0].graph, model.active, origins, 'car');
      const payload = briefPayload({
        model, tierLabel: '50-yr', scale: 1, comparison: cmp, matrix, budgetM: 9,
      });
      const doc = signBrief(payload);
      const good = verifyBriefDocument(JSON.stringify(doc));
      check(good.ok === true, 'clean brief verifies');
      const tampered = JSON.parse(JSON.stringify(doc));
      tampered.payload.comparison[0].passableKm = 999;
      check(verifyBriefDocument(JSON.stringify(tampered)).ok === false, 'edited metric detected');
      const swapped = JSON.parse(JSON.stringify(doc));
      swapped.sha256 = swapped.sha256.replaceAll(/[0-9a-f]/g, '0');
      check(verifyBriefDocument(JSON.stringify(swapped)).ok === false, 'forged digest detected');
      check(verifyBriefDocument('not json').ok === false, 'non-JSON rejected');
      check(verifyBriefDocument('{"algorithm":"MD5","sha256":"x","payload":{}}').ok === false,
        'wrong algorithm rejected');
      return 'clean verifies, edited payload, forged digest, and malformed docs all fail';
    },
  },
  {
    id: 'hash-roundtrip',
    name: 'URL-hash bookmark round-trips losslessly',
    run() {
      const state = {
        preset: 'bayou', origin: 'homes', mode: 'pedestrian', minute: 42,
        mitigations: { pavement: true, clear: false, bridge: true },
        tier: 't500', intensity: null, budgetM: 3.5,
        edits: { rain: [5, 12, 30, 8], cn: 88, impervious: null, blockage: 0.2 },
      };
      const restored = decodeScenarioHash(encodeScenarioHash(state), PRESETS);
      check(restored !== null, 'bookmark decodes');
      check(restored.preset === 'bayou' && restored.origin === 'homes' &&
        restored.mode === 'pedestrian' && restored.minute === 42 &&
        restored.mitigations.bridge === true && restored.tier === 't500' &&
        restored.budgetM === 3.5 && restored.edits.cn === 88, 'all fields survive');
      check(decodeScenarioHash('#flood=%%%bad', PRESETS) === null, 'garbage rejected');
      check(decodeScenarioHash('', PRESETS) === null, 'empty rejected');
      return 'state survives encode and decode, malformed links rejected';
    },
  },
];

export function runSelfTests() {
  return SELF_CHECKS.map(item => {
    try {
      return { id: item.id, name: item.name, pass: true, detail: item.run() };
    } catch (error) {
      return {
        id: item.id, name: item.name, pass: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
