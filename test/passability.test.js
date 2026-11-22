import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalDepthDischarge } from '../src/hydrology.js';
import { buildScenario, PRESETS } from '../src/presets.js';
import {
  checkLifts, initialDepartureCutoff, passableSnapshot, roadFloor,
} from '../src/routing.js';

const CHANNEL = { width: 6, sideSlope: 1, n: 0.038, slope: 0.001, bankfull: 8 };
const signal = heights => ({
  channel: CHANNEL,
  stage: heights,
  q: heights.map(h => normalDepthDischarge(h, CHANNEL)),
});

const twoNodes = (oFloor = 8, sFloor = 8) => [
  { id: 'o', type: 'home', floor: oFloor },
  { id: 's', type: 'shelter', floor: sFloor },
];

test('roadFloor adds a lift then caps at the lower endpoint floor', () => {
  const nodes = new Map(twoNodes(8, 8).map(n => [n.id, n]));
  const edge = { id: 'e', a: 'o', b: 's', m: 10, floor: 2 };
  assert.equal(roadFloor(edge, nodes), 2);
  assert.equal(roadFloor(edge, nodes, 0, new Map([['e', 1.5]])), 3.5);
  assert.equal(roadFloor(edge, nodes, 0, new Map([['e', 99]])), 8);
  const lowEndpoint = new Map(twoNodes(3, 8).map(n => [n.id, n]));
  assert.equal(roadFloor(edge, lowEndpoint, 0, new Map([['e', 99]])), 3);
});

test('roadFloor applies a bridge raise only to bridge roads', () => {
  const nodes = new Map(twoNodes(8, 8).map(n => [n.id, n]));
  const bridge = { id: 'b', a: 'o', b: 's', m: 10, floor: 2, bridge: true };
  const plain = { id: 'p', a: 'o', b: 's', m: 10, floor: 2 };
  assert.equal(roadFloor(bridge, nodes, 0.65), 2.65);
  assert.equal(roadFloor(plain, nodes, 0.65), 2);
  assert.equal(roadFloor(bridge, nodes, 0.65, new Map([['b', 0.4]])), 3.05);
});

test('checkLifts accepts a valid Map and rejects everything malformed', () => {
  assert.doesNotThrow(() => checkLifts(null));
  assert.doesNotThrow(() => checkLifts(undefined));
  assert.doesNotThrow(() => checkLifts(new Map([['e', 0.5]])));
  assert.throws(() => checkLifts({ e: 0.5 }), TypeError);
  assert.throws(() => checkLifts([['e', 0.5]]), TypeError);
  assert.throws(() => checkLifts(new Map([[42, 0.5]])), TypeError);
  assert.throws(() => checkLifts(new Map([['e', -0.5]])), RangeError);
  assert.throws(() => checkLifts(new Map([['e', 11]])), RangeError);
  assert.throws(() => checkLifts(new Map([['e', NaN]])), RangeError);
});

test('passableSnapshot reports floors, depths, node depths, and shelter goals', () => {
  const graph = {
    nodes: [...twoNodes(8, 8), { id: 'g', type: 'home', floor: 1 }],
    edges: [
      { id: 'low', a: 'o', b: 's', m: 100, floor: 1 },
      { id: 'high', a: 'o', b: 's', m: 200, floor: 8 },
    ],
  };
  const snap = passableSnapshot(graph, signal([0, 2, 2]), 1, 0.3);
  assert.equal(snap.stage, 2);
  assert.equal(snap.depths.get('low'), 1);
  assert.equal(snap.depths.get('high'), 0);
  assert.equal(snap.nodeDepths.get('o'), 0);
  assert.equal(snap.nodeDepths.get('g'), 1);
  assert.deepEqual(snap.goals, ['s']);
  assert.equal(snap.threshold, 0.3);
});

test('passableSnapshot reads fractional minutes through the stage solver', () => {
  const graph = { nodes: twoNodes(), edges: [{ id: 'e', a: 'o', b: 's', m: 100, floor: 1 }] };
  const sim = signal([0, 0, 4, 4]);
  const snap = passableSnapshot(graph, sim, 1.5, 0.3);
  assert.ok(snap.stage > 0 && snap.stage < 4);
  assert.ok(snap.depths.get('e') > 0);
});

test('passableSnapshot validates threshold, raise, and the graph', () => {
  const graph = { nodes: twoNodes(), edges: [{ id: 'e', a: 'o', b: 's', m: 100, floor: 1 }] };
  const sim = signal([0, 1, 1]);
  assert.throws(() => passableSnapshot(graph, sim, 1, -0.1), RangeError);
  assert.throws(() => passableSnapshot(graph, sim, 1, 11), RangeError);
  assert.throws(() => passableSnapshot(graph, sim, 1, NaN), RangeError);
  assert.throws(() => passableSnapshot(graph, sim, 1, 0.3, 11), RangeError);
  assert.throws(() => passableSnapshot(graph, sim, 1, 0.3, 0, { e: 1 }), TypeError);
  const broken = { nodes: twoNodes(), edges: [{ id: 'e', a: 'o', b: 'ghost', m: 1, floor: 1 }] };
  assert.throws(() => passableSnapshot(broken, sim, 1, 0.3), RangeError);
});

test('a lift lifts a flooded road back under the vehicle reference', () => {
  const graph = {
    nodes: twoNodes(),
    edges: [{ id: 'e', a: 'o', b: 's', m: 100, floor: 1 }],
  };
  const sim = signal([0, 1.5, 1.5]); // depth 0.5 at floor 1
  const before = passableSnapshot(graph, sim, 1, 0.3);
  assert.ok(before.impassable(before.depths.get('e')));
  const after = passableSnapshot(graph, sim, 1, 0.3, 0, new Map([['e', 0.8]]));
  assert.equal(after.depths.get('e'), 0);
  assert.ok(!after.impassable(after.depths.get('e')));
});

test('initialDepartureCutoff returns Infinity for a road that never floods', () => {
  const graph = {
    nodes: twoNodes(),
    edges: [{ id: 'e', a: 'o', b: 's', m: 800, floor: 8 }],
  };
  const cutoff = initialDepartureCutoff(graph, signal([0, 0, 0, 1, 1]), 'o', 'car');
  assert.equal(cutoff, Infinity);
});

test('initialDepartureCutoff subtracts the walking time from the wet minute', () => {
  const graph = {
    nodes: twoNodes(),
    edges: [{ id: 'e', a: 'o', b: 's', m: 800, floor: 2 }],
  };
  const sim = signal([0, 0, 0, 4, 4]);
  const limit = normalDepthDischarge(2, CHANNEL);
  const expected = 2 + limit / normalDepthDischarge(4, CHANNEL) - 800 / 400;
  const cutoff = initialDepartureCutoff(graph, sim, 'o', 'car');
  assert.ok(Math.abs(cutoff - expected) < 1e-9, `${cutoff} != ${expected}`);
});

test('a lift turns an already-closed departure window back into an open one', () => {
  const graph = {
    nodes: twoNodes(),
    edges: [{ id: 'e', a: 'o', b: 's', m: 800, floor: 2 }],
  };
  const sim = signal([0, 0, 0, 4, 4]);
  assert.ok(initialDepartureCutoff(graph, sim, 'o', 'car') < 2.5);
  const lifted = initialDepartureCutoff(graph, sim, 'o', 'car', 0, new Map([['e', 5]]));
  assert.equal(lifted, Infinity);
});

test('a positive impassability depth extends the dry-rule cutoff', () => {
  const graph = {
    nodes: twoNodes(),
    edges: [{ id: 'e', a: 'o', b: 's', m: 800, floor: 2 }],
  };
  const sim = signal([0, 0, 0, 4, 4]);
  const dry = initialDepartureCutoff(graph, sim, 'o', 'car');
  const vehicle = initialDepartureCutoff(graph, sim, 'o', 'car', 0, null, 0.3);
  assert.ok(vehicle > dry, `${vehicle} not > ${dry}`);
});

test('initialDepartureCutoff reports unreachable origins as -Infinity', () => {
  const sim = signal(new Array(10).fill(0));
  const noPath = {
    nodes: [...twoNodes(), { id: 'x', type: 'home', floor: 8 }],
    edges: [{ id: 'e', a: 'o', b: 's', m: 100, floor: 8 }],
  };
  assert.equal(initialDepartureCutoff(noPath, sim, 'x', 'car'), -Infinity);
  assert.equal(initialDepartureCutoff(noPath, sim, 'ghost', 'car'), -Infinity);
});

test('initialDepartureCutoff validates mode, raise, threshold, and lifts', () => {
  const graph = { nodes: twoNodes(), edges: [{ id: 'e', a: 'o', b: 's', m: 100, floor: 8 }] };
  const sim = signal([0, 0, 0]);
  assert.throws(() => initialDepartureCutoff(graph, sim, 'o', 'boat'), RangeError);
  assert.throws(() => initialDepartureCutoff(graph, sim, 'o', 'car', 11), RangeError);
  assert.throws(() => initialDepartureCutoff(graph, sim, 'o', 'car', 0, null, -1), RangeError);
  assert.throws(() => initialDepartureCutoff(graph, sim, 'o', 'car', 0, [['e', 1]]), TypeError);
});

test('pedestrian cutoffs close earlier than car cutoffs on the same road', () => {
  const graph = {
    nodes: twoNodes(),
    edges: [{ id: 'e', a: 'o', b: 's', m: 800, floor: 2 }],
  };
  const sim = signal([0, 0, 0, 4, 4]);
  const car = initialDepartureCutoff(graph, sim, 'o', 'car');
  const walk = initialDepartureCutoff(graph, sim, 'o', 'pedestrian');
  assert.ok(walk < car, `${walk} not < ${car}`);
  assert.ok(car - walk > 0);
});

for (const preset of PRESETS) {
  test(`${preset.id} peak-minute depths equal stage minus floor on every road`, () => {
    const model = buildScenario(preset);
    const sim = model.active;
    const snap = passableSnapshot(preset.graph, sim, sim.peakMinute, 0.3);
    const nodes = new Map(preset.graph.nodes.map(n => [n.id, n]));
    for (const edge of preset.graph.edges) {
      const floor = roadFloor(edge, nodes, model.raise);
      const expected = Math.max(0, snap.stage - floor);
      assert.ok(Math.abs(snap.depths.get(edge.id) - expected) < 1e-9,
        `${edge.id}: ${snap.depths.get(edge.id)} != ${expected}`);
    }
    for (const node of preset.graph.nodes) {
      const expected = Math.max(0, snap.stage - node.floor);
      assert.ok(Math.abs(snap.nodeDepths.get(node.id) - expected) < 1e-9);
    }
    assert.ok([...snap.depths.values()].some(d => d > 0), 'peak minute floods at least one road');
  });
}

for (const preset of PRESETS) {
  test(`${preset.id} preset cutoffs are finite-or-infinite and lifts never shorten them`, () => {
    const model = buildScenario(preset);
    const origins = preset.graph.nodes
      .filter(n => ['home', 'school'].includes(n.type)).map(n => n.id);
    const low = preset.graph.edges.reduce((a, b) => (a.floor <= b.floor ? a : b));
    for (const origin of origins) {
      const base = initialDepartureCutoff(preset.graph, model.active, origin, 'car');
      const lifted = initialDepartureCutoff(preset.graph, model.active, origin, 'car',
        0, new Map([[low.id, 0.8]]));
      assert.ok(base === Infinity || base === -Infinity || Number.isFinite(base));
      if (Number.isFinite(base) && Number.isFinite(lifted)) {
        assert.ok(lifted >= base - 1e-9, `${origin} ${lifted} < ${base}`);
      } else {
        assert.ok(lifted === base || lifted === Infinity || base === -Infinity);
      }
    }
  });
}
