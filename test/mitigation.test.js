import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalDepthDischarge, simulate } from '../src/hydrology.js';
import { buildScenario, PRESETS } from '../src/presets.js';
import {
  BUDGET_RANGE, INTERVENTIONS, IMPASSABLE_M, STORM_TIERS, TIER_SCALE_RANGE,
  applyIntervention, bestInBudget, compareTier, evaluateRun, tieredInput,
} from '../src/mitigation.js';
import { DEPTH_REFERENCES, passableSnapshot } from '../src/routing.js';

const originsOf = preset => preset.graph.nodes
  .filter(node => ['home', 'school'].includes(node.type)).map(node => node.id);
const totalKm = graph => graph.edges.reduce((sum, edge) => sum + edge.m, 0) / 1000;
const lowestEdge = graph => graph.edges.reduce((a, b) => (a.floor <= b.floor ? a : b));
const byId = id => INTERVENTIONS.find(item => item.id === id);
const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

test('the disclosed vehicle impassability reference is the car 0.30 m comparison', () => {
  assert.equal(IMPASSABLE_M, 0.30);
  assert.equal(IMPASSABLE_M, DEPTH_REFERENCES.car);
});

test('four named tiers scale the invented storm and 50-yr is the identity tier', () => {
  assert.equal(STORM_TIERS.length, 4);
  assert.deepEqual(STORM_TIERS.map(t => t.id), ['t10', 't50', 't100', 't500']);
  assert.ok(STORM_TIERS.every(t => t.label.endsWith('-yr')));
  const scales = STORM_TIERS.map(t => t.scale);
  assert.deepEqual(scales, [...scales].sort((a, b) => a - b));
  assert.equal(STORM_TIERS[1].scale, 1);
  assert.ok(Object.isFrozen(STORM_TIERS));
});

test('five named interventions carry a disclosed invented cost and a plain summary', () => {
  assert.equal(INTERVENTIONS.length, 5);
  assert.equal(new Set(INTERVENTIONS.map(i => i.id)).size, 5);
  for (const item of INTERVENTIONS) {
    assert.ok(item.costM > 0 && item.costM <= BUDGET_RANGE.max);
    assert.ok(item.label.length > 3 && item.summary.length > 3);
  }
  assert.ok(Object.isFrozen(INTERVENTIONS));
});

test('slider ranges cover every tier scale and every intervention cost', () => {
  assert.deepEqual(TIER_SCALE_RANGE, { min: 0.4, max: 2.2 });
  assert.deepEqual(BUDGET_RANGE, { min: 0, max: 9 });
  assert.ok(Math.min(...STORM_TIERS.map(t => t.scale)) >= TIER_SCALE_RANGE.min);
  assert.ok(Math.max(...STORM_TIERS.map(t => t.scale)) <= TIER_SCALE_RANGE.max);
});

for (const preset of PRESETS) {
  const model = buildScenario(preset);
  const input = model.input;
  const graph = preset.graph;
  for (const iv of INTERVENTIONS) {
    test(`${preset.id} ${iv.id} transforms into a runnable scenario input`, () => {
      const applied = applyIntervention(input, iv, graph);
      assert.ok(applied.input.rain !== input.rain);
      assert.deepEqual(applied.input.rain, input.rain);
      assert.ok(applied.input.cn >= 1 && applied.input.cn <= 100);
      assert.ok(applied.input.blockage >= 0 && applied.input.blockage <= 1);
      assert.ok(Number.isInteger(applied.input.peakLag));
      assert.ok(Number.isInteger(applied.input.endLag));
      assert.ok(applied.input.endLag > applied.input.peakLag && applied.input.endLag <= 720);
      assert.ok(applied.input.channel.n >= 0.001 && applied.input.channel.n <= 2);
      const sim = simulate(applied.input);
      assert.ok(Number.isFinite(sim.peakStage));
      if (iv.cnDelta) assert.equal(applied.input.cn, Math.max(1, input.cn + iv.cnDelta));
      if (iv.blockageSet !== undefined) assert.equal(applied.input.blockage, iv.blockageSet);
      if (iv.bankfullAdd) near(applied.input.channel.bankfull, input.channel.bankfull + iv.bankfullAdd);
      if (iv.conveyance) near(applied.input.channel.slope, input.channel.slope * iv.conveyance);
      if (iv.lagScale) {
        assert.ok(applied.input.peakLag > input.peakLag);
        assert.ok(applied.input.endLag > input.endLag);
      }
      if (iv.liftLowest) {
        assert.equal(applied.lifts.size, 1);
        assert.equal(applied.lifts.get(lowestEdge(graph).id), iv.liftLowest);
      }
    });
  }
}

for (const preset of PRESETS) {
  const model = buildScenario(preset);
  test(`${preset.id} every intervention composes over a scaled tier input`, () => {
    const scaled = tieredInput(model.input, STORM_TIERS[2].scale);
    for (const iv of INTERVENTIONS) {
      const applied = applyIntervention(scaled, iv, preset.graph);
      const sim = simulate(applied.input);
      assert.ok(Number.isFinite(sim.peakStage), `${iv.id}`);
      assert.deepEqual(applied.input.rain, scaled.rain);
    }
  });
}

test('intervention parameter defects are rejected instead of silently clamped', () => {
  const model = buildScenario(PRESETS[0]);
  const graph = PRESETS[0].graph;
  assert.throws(() => applyIntervention(model.input, { lagScale: 0.1 }, graph), RangeError);
  assert.throws(() => applyIntervention(model.input, { liftLowest: 11 }, graph), RangeError);
  assert.throws(() => applyIntervention(model.input, { liftLowest: -0.5 }, graph), RangeError);
  assert.throws(() => applyIntervention(model.input, { blockageSet: 1.5 }, graph), RangeError);
  assert.throws(() => applyIntervention(model.input, { raise: 11 }, graph), RangeError);
  assert.throws(() => applyIntervention(model.input, { lifts: { e0: -1 } }, graph), RangeError);
  assert.throws(() => applyIntervention(model.input, 'not-an-object', graph), RangeError);
});

test('explicit crossing lifts merge with the lowest-crossing lift', () => {
  const model = buildScenario(PRESETS[0]);
  const graph = PRESETS[0].graph;
  const applied = applyIntervention(model.input,
    { liftLowest: 0.4, lifts: { underpass: 0.9, 'canal-south': 0.2 } }, graph);
  assert.equal(applied.lifts.get('underpass'), 0.9);
  assert.equal(applied.lifts.get('canal-south'), 0.2);
  assert.equal(applied.lifts.get(lowestEdge(graph).id), 0.9);
});

test('curve number deltas clamp at the model bounds rather than throwing', () => {
  const model = buildScenario(PRESETS[0]);
  const applied = applyIntervention(model.input, { cnDelta: -400 }, PRESETS[0].graph);
  assert.equal(applied.input.cn, 1);
  const high = applyIntervention(model.input, { cnDelta: 400 }, PRESETS[0].graph);
  assert.equal(high.input.cn, 100);
});

test('tier scaling multiplies each rain bin and keeps the rest of the input', () => {
  const model = buildScenario(PRESETS[0]);
  const scaled = tieredInput(model.input, 1.5);
  assert.deepEqual(scaled.rain, model.input.rain.map(mm => mm * 1.5));
  assert.equal(scaled.cn, model.input.cn);
  for (const bad of [0.01, 9, NaN, Infinity]) {
    assert.throws(() => tieredInput(model.input, bad), RangeError);
  }
});

for (const preset of PRESETS) {
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  const km = totalKm(preset.graph);
  for (const tier of STORM_TIERS) {
    test(`${preset.id} ${tier.id} comparator emits a baseline plus five scored rows`, () => {
      const cmp = compareTier(model, tier.scale, origins);
      assert.equal(cmp.rows.length, INTERVENTIONS.length + 1);
      const [base, ...rest] = cmp.rows;
      assert.equal(base.intervention, null);
      assert.equal(base.costM, 0);
      assert.equal(base.extension, 0);
      for (const row of cmp.rows) {
        assert.ok(Number.isFinite(row.sim.peakStage));
        assert.ok(row.passableKm >= -1e-12 && row.passableKm <= km + 1e-9);
        assert.equal(new Set(row.stranded).size, row.stranded.length);
        assert.ok(row.stranded.every(id => origins.includes(id)));
        assert.deepEqual([...row.cutoffs.keys()].sort(), [...origins].sort());
        assert.ok(row.householdsAvoided >= 0);
        if (row.costM > 0) near(row.perMillion, row.householdsAvoided / row.costM, 1e-12);
        else assert.equal(row.perMillion, null);
      }
      for (const row of rest) {
        assert.ok(row.stageDrop >= -1e-9, `${row.intervention.id} stageDrop ${row.stageDrop}`);
        assert.ok(row.passableDelta >= -1e-9, `${row.intervention.id} passableDelta`);
        assert.ok(row.strandedReduction >= 0, `${row.intervention.id} strandedReduction`);
        assert.ok(row.extension === null || row.extension >= -1e-9);
        assert.ok(row.sim.peakStage <= base.sim.peakStage + 1e-9);
        assert.ok(row.sim.peakQ <= base.sim.peakQ + 1e-9);
      }
    });
  }
}

for (const preset of PRESETS) {
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  test(`${preset.id} heavier tiers never add passable road or unstrand zones`, () => {
    const light = compareTier(model, STORM_TIERS[0].scale, origins);
    const heavy = compareTier(model, STORM_TIERS[3].scale, origins);
    assert.ok(heavy.base.passableKm <= light.base.passableKm + 1e-9);
    assert.ok(heavy.base.stranded.length >= light.base.stranded.length);
    assert.ok(heavy.base.sim.peakStage >= light.base.sim.peakStage - 1e-9);
  });
}

for (const preset of PRESETS) {
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  for (const tier of STORM_TIERS) {
    test(`${preset.id} ${tier.id} pedestrian comparator stays well-formed and non-worsening`, () => {
      const cmp = compareTier(model, tier.scale, origins, 'pedestrian');
      assert.equal(cmp.rows.length, INTERVENTIONS.length + 1);
      for (const row of cmp.rows.slice(1)) {
        assert.ok(row.stageDrop >= -1e-9);
        assert.ok(row.passableDelta >= -1e-9);
        assert.ok(row.strandedReduction >= 0);
        assert.ok(row.perMillion === null || Number.isFinite(row.perMillion));
      }
    });
  }
}

for (const preset of PRESETS) {
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  test(`${preset.id} households avoided equals invented counts of newly unstranded homes`, () => {
    const cmp = compareTier(model, 1, origins);
    const households = new Map(preset.graph.nodes.map(n => [n.id, n.households ?? 0]));
    for (const row of cmp.rows.slice(1)) {
      const freed = cmp.base.stranded.filter(id => !row.stranded.includes(id));
      const expected = freed.reduce((sum, id) => sum + households.get(id), 0);
      assert.equal(row.householdsAvoided, expected);
      assert.ok(expected === 0 || freed.some(id => households.get(id) > 0));
    }
  });
}

test('a positive threshold lets vehicles pass water the strict dry rule forbids', () => {
  const graph = {
    nodes: [
      { id: 'o', type: 'home', floor: 8 },
      { id: 's', type: 'shelter', floor: 8 },
    ],
    edges: [{ id: 'e', a: 'o', b: 's', m: 100, floor: 2 }],
  };
  const channel = { width: 6, sideSlope: 1, n: 0.038, slope: 0.001, bankfull: 8 };
  const heights = [0, 0.73, 1.47, 2.2];
  const sim = {
    channel,
    q: heights.map(h => normalDepthDischarge(h, channel)),
    stage: heights,
  };
  const strict = passableSnapshot(graph, sim, 3, 0.0001);
  const vehicle = passableSnapshot(graph, sim, 3, IMPASSABLE_M);
  assert.ok(strict.impassable(strict.depths.get('e')));
  assert.ok(!vehicle.impassable(vehicle.depths.get('e')));
  near(vehicle.depths.get('e'), 0.2, 1e-9);
});

test('depth at exactly the reference counts impassable; depth zero always passes', () => {
  const graph = {
    nodes: [
      { id: 'o', type: 'home', floor: 8 },
      { id: 's', type: 'shelter', floor: 8 },
    ],
    edges: [
      { id: 'edge30', a: 'o', b: 's', m: 100, floor: 1.70 },
      { id: 'edge29', a: 'o', b: 's', m: 200, floor: 1.71 },
    ],
  };
  const channel = { width: 6, sideSlope: 1, n: 0.038, slope: 0.001, bankfull: 8 };
  const sim = { channel, q: [0, normalDepthDischarge(2, channel)], stage: [0, 2] };
  const snap = passableSnapshot(graph, sim, 1, IMPASSABLE_M);
  assert.ok(snap.impassable(snap.depths.get('edge30')));
  assert.ok(!snap.impassable(snap.depths.get('edge29')));
  const dry = passableSnapshot(graph, sim, 0, IMPASSABLE_M);
  assert.ok(!dry.impassable(dry.depths.get('edge30')));
});

// The same fixture input for the next two tests: a 2.90 m peak stage that
// floods a 1.5 m node floor but not a road carried at 8 m.
const FIXTURE_CHANNEL = { width: 6, sideSlope: 1, n: 0.038, slope: 0.001, bankfull: 8 };
const FIXTURE_INPUT = {
  rain: [8, 16, 24, 16, 8], cn: 90, blockage: 0, areaKm2: 2,
  peakLag: 20, endLag: 60, channel: FIXTURE_CHANNEL,
};

test('a zone with a flooded floor counts stranded even when roads look passable', () => {
  const graph = {
    nodes: [
      { id: 'o', type: 'home', floor: 1.5 },
      { id: 's', type: 'shelter', floor: 8 },
    ],
    edges: [{ id: 'e', a: 'o', b: 's', m: 100, floor: 8 }],
  };
  const run = evaluateRun(graph, FIXTURE_INPUT, ['o'], 'car', IMPASSABLE_M);
  assert.ok(run.sim.peakStage > 1.5 + IMPASSABLE_M, `peak ${run.sim.peakStage}`);
  assert.ok(run.stranded.includes('o'));
});

test('passable km sums only below-reference roads at the run peak minute', () => {
  const graph = {
    nodes: [
      { id: 'o', type: 'home', floor: 8 },
      { id: 's', type: 'shelter', floor: 8 },
    ],
    edges: [
      { id: 'wet', a: 'o', b: 's', m: 1000, floor: 1 },
      { id: 'dry', a: 'o', b: 's', m: 2000, floor: 8 },
    ],
  };
  const run = evaluateRun(graph, FIXTURE_INPUT, ['o'], 'car', IMPASSABLE_M);
  assert.ok(run.snap.depths.get('wet') >= IMPASSABLE_M);
  assert.equal(run.snap.depths.get('dry'), 0);
  near(run.passableKm, 2, 1e-12);
});

test('evaluateRun reports stranded households from the invented counts', () => {
  const preset = PRESETS[0];
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  const run = evaluateRun(preset.graph, model.input, origins, 'car', IMPASSABLE_M);
  const households = new Map(preset.graph.nodes.map(n => [n.id, n.households ?? 0]));
  const expected = run.stranded.reduce((sum, id) => sum + households.get(id), 0);
  assert.equal(run.householdsStranded, expected);
  assert.ok(run.householdsStranded > 0);
});

test('bestInBudget picks the strongest affordable intervention or nothing', () => {
  const model = buildScenario(PRESETS[0]);
  const cmp = compareTier(model, 1, originsOf(PRESETS[0]));
  const everything = bestInBudget(cmp, 9);
  assert.ok(everything && everything.intervention && everything.costM <= 9);
  const reduced = bestInBudget(cmp, byId('package').costM);
  assert.equal(reduced.intervention.id, 'package');
  assert.equal(bestInBudget(cmp, 0.5), null);
  assert.equal(bestInBudget({ rows: cmp.rows.slice(0, 1) }, 9), null);
});

for (const preset of PRESETS) {
  test(`${preset.id} vehicle-threshold cutoffs never close earlier than the dry rule`, () => {
    const model = buildScenario(preset);
    const origins = originsOf(preset);
    const run = evaluateRun(preset.graph, model.input, origins, 'car', IMPASSABLE_M);
    const dryRun = evaluateRun(preset.graph, model.input, origins, 'car', 0.0001);
    for (const origin of origins) {
      const vehicle = run.cutoffs.get(origin);
      const dry = dryRun.cutoffs.get(origin);
      if (Number.isFinite(vehicle) && Number.isFinite(dry)) {
        assert.ok(vehicle >= dry - 1e-9, `${origin} ${vehicle} < ${dry}`);
      } else {
        assert.ok(vehicle === Infinity || vehicle >= dry - 1e-9);
      }
    }
  });
}
