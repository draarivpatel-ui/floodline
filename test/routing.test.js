import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstAbove, normalDepthDischarge, solveStage } from '../src/hydrology.js';
import { buildScenario, compareScenario, inspectScenario, PRESETS } from '../src/presets.js';
import { initialDepartureCutoff, isAboveReference, routeAt, shortestPath } from '../src/routing.js';

const channel = { width: 6, sideSlope: 1, n: 0.038, slope: 0.001 };
const signal = heights => ({
  channel,
  q: heights.map(h => normalDepthDischarge(h, channel)),
  stage: heights,
});
const graph = (n, rows) => ({
  nodes: Array.from({ length: n }, (_, id) => ({ id: String(id), type: id >= n - 2 ? 'shelter' : 'home', floor: 8 })),
  edges: rows.map(([a, b, m, floor = 8, bridge = false], id) =>
    ({ a: String(a), b: String(b), m, floor, bridge, id: String(id) })),
});

function enumerate(g, origin, destinations, allowed, evaluate) {
  const seen = new Set();
  const answers = [];
  function visit(at, edges) {
    if (destinations.includes(at)) {
      answers.push(evaluate(edges));
      return;
    }
    seen.add(at);
    for (const e of g.edges) {
      const next = e.a === at ? e.b : e.b === at ? e.a : null;
      if (next !== null && allowed(e) && !seen.has(next)) visit(next, edges.concat(e));
    }
    seen.delete(at);
  }
  visit(origin, []);
  return answers;
}

function randomFixture(seed) {
  let state = seed;
  const pick = max => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state >>> 9) % max;
  };
  const edges = [];
  for (let a = 0; a < 6; a += 1) {
    for (let b = a + 1; b < 6; b += 1) {
      if (pick(5) < 3) edges.push([a, b, pick(800) + 30, 1 + pick(8) * 0.5]);
    }
  }
  return graph(6, edges);
}

for (let caseNo = 1; caseNo <= 36; caseNo += 1) {
  test(`snapshot Dijkstra agrees with exhaustive dry simple paths on graph ${caseNo}`, () => {
    const g = randomFixture(caseNo);
    const height = 1 + (caseNo % 11) * 0.3;
    const s = signal([0, height, 0]);
    const allowed = e => e.floor >= height;
    const expected = Math.min(...enumerate(g, '0', ['4', '5'], allowed, p => p.reduce((a, e) => a + e.m, 0)));
    const actual = routeAt(g, s, 1, '0', 'car');
    assert.equal(actual.dry?.distance ?? Infinity, expected);
    assert.ok(actual.dry?.edges.every(allowed) ?? true);
  });
}

for (let caseNo = 1; caseNo <= 20; caseNo += 1) {
  test(`initial departure deadline agrees with exhaustive path enumeration on graph ${caseNo}`, () => {
    const g = randomFixture(caseNo * 97);
    const s = signal([0, 0, 0.3, 0.6, 1.1, 2.7, 5.1, 6, 0]);
    const allowed = () => true;
    const expected = Math.max(...enumerate(g, '0', ['4', '5'], allowed, edges => {
      let duration = 0;
      return Math.min(...edges.map(edge => {
        duration += edge.m / 400;
        return (firstAbove(s.q, normalDepthDischarge(edge.floor, channel)) ?? Infinity) - duration;
      }));
    }));
    const actual = initialDepartureCutoff(g, s, '0', 'car');
    if (Number.isFinite(expected)) assert.ok(Math.abs(actual - expected) < 1e-12);
    else assert.equal(actual, expected);
  });
}

test('standalone Dijkstra chooses shorter parallel edge and returns an ordered path', () => {
  const g = graph(5, [[0, 2, 400], [0, 2, 80], [2, 3, 120], [0, 4, 300]]);
  const result = shortestPath(g, '0', ['3', '4']);
  assert.deepEqual(result.edges.map(edge => edge.id), ['1', '2']);
  assert.deepEqual(result.nodes, ['0', '2', '3']);
  assert.equal(result.distance, 200);
  assert.equal(shortestPath(g, '3', ['3']).distance, 0);
  assert.equal(shortestPath(g, '1', ['3']), null);
  assert.equal(shortestPath(g, 'unknown', ['3']), null);
  assert.throws(() => shortestPath(graph(3, [[0, 1, -50]]), '0', ['1']), RangeError);
});

for (const [mode, threshold] of [['pedestrian', 0.15], ['car', 0.30]]) {
  test(`${mode} warning reference is inclusive and is not the routing rule`, () => {
    assert.equal(isAboveReference(threshold - 0.001, mode), false);
    assert.equal(isAboveReference(threshold, mode), true);
    assert.equal(isAboveReference(threshold + 0.001, mode), true);
    const g = graph(3, [[0, 1, 35, 1]]);
    const s = signal([0, 1, 1.01]);
    assert.ok(routeAt(g, s, 1, '0', mode).dry);
    assert.equal(routeAt(g, s, 2, '0', mode).dry, null);
  });
}

test('wet origin floor and wet shelter floor both veto dry routing', () => {
  const g = graph(3, [[0, 1, 100, 3], [0, 2, 150, 3]]);
  g.nodes[1].floor = 1.5;
  const s = signal([0, 2, 4]);
  assert.equal(routeAt(g, s, 1, '0', 'car').dry.shelter.id, '2');
  g.nodes[0].floor = 1.7;
  assert.equal(routeAt(g, s, 1, '0', 'car').dry, null);
});

test('bridge counterfactual never raises a low approach or unrelated road', () => {
  const g = graph(4, [[0, 2, 200, 1, true], [0, 3, 200, 1]]);
  g.nodes[2].floor = 1.1;
  const s = signal([0, 1.08, 1.11]);
  assert.equal(routeAt(g, s, 1, '0', 'car').dry, null);
  const raised = routeAt(g, s, 1, '0', 'car', 1);
  assert.equal(raised.dry.shelter.id, '2');
  assert.equal(raised.floors.get('0'), 1.1);
  assert.equal(raised.floors.get('1'), 1);
  assert.equal(routeAt(g, s, 2, '0', 'car', 1).dry, null);
});

test('chosen path can be dry in the snapshot but wet before completing the trip', () => {
  const g = graph(4, [[0, 1, 800, 3], [1, 2, 400, 1]]);
  const s = signal([0, 0, 0, 0.5, 1.5, 2, 0]);
  const fromZero = routeAt(g, s, 0, '0', 'car');
  assert.equal(fromZero.tripDry, true);
  assert.ok(fromZero.departureCutoff > 0 && fromZero.departureCutoff < 1);
  const late = routeAt(g, s, 1, '0', 'car');
  assert.ok(late.dry);
  assert.equal(late.tripDry, false);
  assert.equal(late.travelMinutes, 3);
  assert.equal(routeAt(g, s, 4, '0', 'car').dry, null);
});

test('trip check respects road entry, even when the conservative departure window has already closed', () => {
  const g = graph(4, [[0, 1, 1200, 3], [1, 2, 400, 1]]);
  const s = signal([0, 0, 2, 0, 0, 0]);
  const result = routeAt(g, s, 0, '0', 'car');
  assert.ok(result.departureCutoff < 0);
  assert.equal(result.tripDry, true);
});

for (const p of PRESETS) {
  test(`${p.id} demo reroutes from the flooded underpass to a dry bridge`, () => {
    const model = buildScenario(p);
    const state = inspectScenario(model, p.demoMinute, 'school', 'car');
    assert.ok(state.naiveWet.some(e => e.id === 'underpass'));
    assert.ok(state.dry.edges.some(e => e.id === 'ridge-bridge'));
    assert.ok(state.dry.distance > state.naive.distance);
    assert.ok(state.departureCutoff > p.demoMinute && state.closes >= state.departureCutoff);
    assert.equal(state.tripDry, true);
    assert.equal(inspectScenario(model, model.active.peakMinute, 'school', 'car').dry, null);
    assert.deepEqual(inspectScenario(model, 360, 'school', 'car').dry.nodes, state.naive.nodes);
  });
  for (const flags of [{ pavement: true }, { clear: true }, { bridge: true }, { pavement: true, clear: true, bridge: true }]) {
    test(`${p.id} counterfactual ${Object.keys(flags).join('+')} does not worsen stage or deadline`, () => {
      const model = buildScenario(p, {}, flags);
      const difference = compareScenario(model, 'school', 'car');
      assert.ok(model.active.stage.every((h, i) => h <= model.baseline.stage[i] + 1e-12));
      assert.ok(difference.stageDrop >= 0);
      assert.ok(difference.after >= difference.before);
      if (flags.bridge && !flags.pavement) assert.equal(difference.stageDrop, 0);
      if (flags.pavement && flags.clear) {
        assert.ok(difference.protectedSites.length > 0);
        for (const site of difference.protectedSites) {
          assert.ok(model.baseline.peakStage > site.floor);
          assert.ok(model.active.peakStage <= site.floor);
        }
      }
    });
  }
}

test('duplicate road ids are rejected instead of silently merged', () => {
  const dup = {
    nodes: [
      { id: '0', type: 'home', floor: 8 },
      { id: '1', type: 'junction', floor: 8 },
      { id: '2', type: 'shelter', floor: 8 },
    ],
    edges: [
      { id: 'dup', a: '0', b: '1', m: 100, floor: 1 },
      { id: 'dup', a: '1', b: '2', m: 300, floor: 5 },
    ],
  };
  const s = signal([0, 3, 3]);
  assert.throws(() => routeAt(dup, s, 1, '0', 'car'), /Invalid road dup/);
  assert.throws(() => initialDepartureCutoff(dup, s, '0', 'car'), /Invalid road dup/);
  assert.throws(() => shortestPath(dup, '0', ['2']), /Invalid road dup/);
});

test('duplicate place ids and non-finite floors are rejected like road defects', () => {
  const dupNode = {
    nodes: [
      { id: '0', type: 'home', floor: 8 },
      { id: '0', type: 'shelter', floor: 1 },
      { id: '2', type: 'shelter', floor: 8 },
    ],
    edges: [{ id: 'e0', a: '0', b: '2', m: 10, floor: 8 }],
  };
  const nanFloor = {
    nodes: [
      { id: '0', type: 'home', floor: NaN },
      { id: '2', type: 'shelter', floor: 8 },
    ],
    edges: [{ id: 'e0', a: '0', b: '2', m: 10, floor: 8 }],
  };
  const s = signal([0, 1, 1]);
  for (const bad of [dupNode, nanFloor]) {
    assert.throws(() => routeAt(bad, s, 1, '0', 'car'), /Invalid place/);
    assert.throws(() => initialDepartureCutoff(bad, s, '0', 'car'), /Invalid place/);
    assert.throws(() => shortestPath(bad, '0', ['2']), /Invalid place/);
  }
});

test('roads referencing unknown nodes throw a domain RangeError', () => {
  const ghost = {
    nodes: [
      { id: '0', type: 'home', floor: 8 },
      { id: '2', type: 'shelter', floor: 8 },
    ],
    edges: [{ id: 'e0', a: '0', b: 'ghost', m: 10, floor: 8 }],
  };
  const s = signal([0, 1, 1]);
  assert.throws(() => routeAt(ghost, s, 1, '0', 'car'), RangeError);
  assert.throws(() => initialDepartureCutoff(ghost, s, '0', 'car'), RangeError);
  assert.throws(() => shortestPath(ghost, '0', ['2']), RangeError);
});

for (const bad of [-1, -0.001, NaN, Infinity, 10.5]) {
  test(`bridge raise ${bad} is rejected`, () => {
    const g = graph(4, [[0, 2, 100, 8, true]]);
    const s = signal([0, 1, 1]);
    assert.throws(() => routeAt(g, s, 1, '0', 'car', bad), /Bridge raise/);
    assert.throws(() => initialDepartureCutoff(g, s, '0', 'car', bad), /Bridge raise/);
  });
}

test('bridge raise at the documented extremes still routes', () => {
  const g = graph(4, [[0, 2, 100, 8, true]]);
  const s = signal([0, 1, 1]);
  assert.ok(routeAt(g, s, 1, '0', 'car', 10).dry);
  assert.equal(typeof initialDepartureCutoff(g, s, '0', 'car', 0), 'number');
});

test('a trip extending past a still-flowing run reports unverified, not dry', () => {
  const g = graph(5, [[0, 1, 2000, 8], [1, 3, 2000, 8]]);
  const s = signal([0, 0, 0, 0, 0, 1]);
  const view = routeAt(g, s, 4, '0', 'car');
  assert.ok(view.dry);
  assert.equal(view.tripDry, null);
  assert.equal(view.travelMinutes, 10);
});

test('a flood inside the checked window still reports a wet trip past the horizon', () => {
  const g = graph(5, [[0, 4, 3000, 2]]);
  const s = signal([0, 0, 0, 0, 0, 4]);
  const view = routeAt(g, s, 4, '0', 'car');
  assert.ok(view.dry);
  assert.equal(view.tripDry, false);
});

test('a drained tail is certain dry: the last minute of every preset stays verified', () => {
  for (const p of PRESETS) {
    const model = buildScenario(p);
    for (const mode of ['car', 'pedestrian']) {
      const view = inspectScenario(model, 360, 'school', mode);
      assert.ok(view.dry);
      assert.equal(view.tripDry, true, `${p.id} ${mode}`);
    }
  }
});

test('a trip finishing inside the run stays verified', () => {
  const g = graph(5, [[0, 4, 3000, 8]]);
  const s = signal(new Array(12).fill(0));
  const view = routeAt(g, s, 3, '0', 'car');
  assert.ok(view.dry);
  assert.equal(view.tripDry, true);
  assert.equal(view.travelMinutes, 7.5);
});

test('bankfull and depth comparisons agree at a fractional sampled crossing', () => {
  const g = graph(3, [[0, 1, 60, 2]]);
  const s = signal([0, 1, 3, 4]);
  const t = firstAbove(s.q, normalDepthDischarge(2, channel));
  const value = s.q[1] + (s.q[2] - s.q[1]) * (t - 1);
  assert.ok(Math.abs(solveStage(value, channel) - 2) < 1e-12);
  assert.ok(routeAt(g, s, t - 0.001, '0', 'car').dry);
  assert.equal(routeAt(g, s, t + 0.001, '0', 'car').dry, null);
});
