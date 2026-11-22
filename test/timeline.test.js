import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstAbove, normalDepthDischarge, simulate } from '../src/hydrology.js';
import { buildScenario, PRESETS } from '../src/presets.js';
import { roadFloor } from '../src/routing.js';
import {
  HOUR_MARKS, TIMELINE_MINUTES, buildSchedule, cutoffMatrix, departFeasible,
  departureScan, wetIntervals,
} from '../src/timeline.js';

const CHANNEL = { width: 6, sideSlope: 1, n: 0.038, slope: 0.001, bankfull: 8 };
const signal = heights => ({
  channel: CHANNEL,
  stage: heights,
  q: heights.map(h => normalDepthDischarge(h, CHANNEL)),
});

const line = (meters = 400) => ({
  nodes: [
    { id: 'o', type: 'home', floor: 8 },
    { id: 's', type: 'shelter', floor: 8 },
  ],
  edges: [{ id: 'e', a: 'o', b: 's', m: meters, floor: 8 }],
});

const originsOf = preset => preset.graph.nodes
  .filter(node => ['home', 'school'].includes(node.type)).map(node => node.id);

test('wetIntervals reports never, always, single and double flood windows', () => {
  assert.deepEqual(wetIntervals([0, 0, 0], 1), []);
  assert.deepEqual(wetIntervals([2, 3, 4], 1), [[0, Infinity]]);
  assert.deepEqual(wetIntervals([0, 0, 4, 0, 0], 1), [[1.25, 2.75]]);
  const two = wetIntervals([0, 4, 0, 4, 0], 1);
  assert.equal(two.length, 2);
  assert.deepEqual(two[0], [0.25, 1.75]);
  assert.deepEqual(two[1], [2.25, 3.75]);
});

test('wetIntervals treats an exact-threshold sample as dry and an open tail as infinite', () => {
  assert.deepEqual(wetIntervals([0, 1, 1, 0], 1), []);
  assert.deepEqual(wetIntervals([0, 4, 4], 1), [[0.25, Infinity]]);
});

test('a dry departure reaches the shelter in length over speed minutes', () => {
  const sim = signal(new Array(20).fill(0));
  const result = departFeasible(line(800), sim, 'o', 10, 'car');
  assert.equal(result.reached, true);
  assert.equal(result.shelter, 's');
  assert.ok(Math.abs(result.arrival - 12) < 1e-9);
  const walking = departFeasible(line(800), sim, 'o', 0, 'pedestrian');
  assert.ok(Math.abs(walking.arrival - 10) < 1e-9);
});

test('a flooded origin or a flooded only-road blocks departure', () => {
  const wetOrigin = departFeasible(
    { nodes: [{ id: 'o', type: 'home', floor: 1 }, { id: 's', type: 'shelter', floor: 8 }],
      edges: [{ id: 'e', a: 'o', b: 's', m: 100, floor: 8 }] },
    signal([0, 3, 3]), 'o', 1, 'car');
  assert.equal(wetOrigin.reached, false);
  assert.equal(wetOrigin.reason, 'origin');
  const wetRoad = departFeasible({
    nodes: [{ id: 'o', type: 'home', floor: 8 }, { id: 's', type: 'shelter', floor: 8 }],
    edges: [{ id: 'e', a: 'o', b: 's', m: 100, floor: 1 }],
  }, signal([0, 3, 3]), 'o', 0, 'car');
  assert.equal(wetRoad.reached, false);
  assert.equal(wetRoad.reason, 'cutoff');
});

test('a crossing window that clips the start of a wet interval is still wet', () => {
  // Discharge passes the floor-2 limit near t = 1.3; a 2-minute crossing overlaps.
  const graph = {
    nodes: [{ id: 'o', type: 'home', floor: 8 }, { id: 's', type: 'shelter', floor: 8 }],
    edges: [{ id: 'e', a: 'o', b: 's', m: 800, floor: 2 }],
  };
  const sim = signal([0, 0, 4, 4]);
  assert.equal(departFeasible(graph, sim, 'o', 0, 'car').reached, false);
  assert.equal(departFeasible(graph, sim, 'o', 2, 'car').reached, false); // already wet
});

test('a road that floods then drains reopens to later departures', () => {
  const graph = {
    nodes: [{ id: 'o', type: 'home', floor: 8 }, { id: 's', type: 'shelter', floor: 8 }],
    edges: [{ id: 'e', a: 'o', b: 's', m: 400, floor: 2 }],
  };
  const sim = signal([0, 0, 0, 8, 0, 0, 0]); // wet for roughly minutes 2..4 only
  assert.equal(departFeasible(graph, sim, 'o', 2, 'car').reached, false);
  assert.equal(departFeasible(graph, sim, 'o', 5, 'car').reached, true);
  assert.equal(departFeasible(graph, sim, 'o', 6, 'car').reached, true);
});

test('departFeasible validates inputs and reports unreachable instead of throwing', () => {
  const sim = signal([0, 0, 0]);
  assert.throws(() => departFeasible(line(), sim, 'o', 0, 'canoe'), RangeError);
  assert.throws(() => departFeasible(line(), sim, 'o', -1, 'car'), RangeError);
  assert.equal(departFeasible(line(), sim, 'nowhere', 0, 'car').reached, false);
  const noShelter = departFeasible({ nodes: [{ id: 'o', type: 'home', floor: 8 }, { id: 'x', type: 'junction', floor: 8 }], edges: [{ id: 'e', a: 'o', b: 'x', m: 10, floor: 8 }] }, sim, 'o', 0, 'car');
  assert.equal(noShelter.reached, false);
});

test('a still-flowing tail blocks verification while a drained tail allows it', () => {
  const graph = {
    nodes: [{ id: 'o', type: 'home', floor: 8 }, { id: 's', type: 'shelter', floor: 8 }],
    edges: [{ id: 'e', a: 'o', b: 's', m: 800, floor: 8 }],
  };
  const flowing = signal([0, 0, 2, 2]); // trip exits at end+1 with water still up
  assert.equal(departFeasible(graph, flowing, 'o', 2, 'car').reached, false);
  const drained = signal([0, 0, 0, 0]);
  assert.equal(departFeasible(graph, drained, 'o', 2, 'car').reached, true);
});

test('buildSchedule validates the graph and lift map and lifts the lowest crossing', () => {
  const graph = {
    nodes: [{ id: 'o', type: 'home', floor: 8 }, { id: 's', type: 'shelter', floor: 8 }],
    edges: [{ id: 'e', a: 'o', b: 's', m: 400, floor: 2 }],
  };
  const sim = signal([0, 0, 4, 4]);
  const base = buildSchedule(graph, sim);
  const lifted = buildSchedule(graph, sim, 0, new Map([['e', 5]]));
  assert.ok(lifted.floors.get('e') > base.floors.get('e'));
  assert.equal(base.wets.get('e').length, 1);
  assert.equal(lifted.wets.get('e').length, 0);
  assert.throws(() => buildSchedule(graph, sim, 0, new Map([['e', -1]])), RangeError);
  assert.throws(() => buildSchedule(graph, sim, 11), RangeError);
  const broken = { nodes: graph.nodes, edges: [{ id: 'e', a: 'o', b: 'ghost', m: 1, floor: 1 }] };
  assert.throws(() => buildSchedule(broken, sim), RangeError);
});

test('departureScan reports one flag per minute and matches spot checks', () => {
  const model = buildScenario(PRESETS[0]);
  const feasible = departureScan(PRESETS[0].graph, model.active, 'homes', 'car');
  assert.equal(feasible.length, TIMELINE_MINUTES + 1);
  for (let t = 0; t <= TIMELINE_MINUTES; t += 15) {
    const spot = departFeasible(PRESETS[0].graph, model.active, 'homes', t, 'car');
    assert.equal(Boolean(feasible[t]), spot.reached, `minute ${t}`);
  }
  assert.throws(() => departureScan(PRESETS[0].graph, model.active, 'homes', 'car', { tMax: 0 }), RangeError);
  assert.throws(() => departureScan(PRESETS[0].graph, model.active, 'homes', 'car', { tMax: 10 ** 6 }), RangeError);
});

test('a crossing lift widens the feasible departure window', () => {
  const model = buildScenario(PRESETS[0]);
  const low = PRESETS[0].graph.edges.reduce((a, b) => (a.floor <= b.floor ? a : b));
  const before = departureScan(PRESETS[0].graph, model.active, 'homes', 'car');
  const after = departureScan(PRESETS[0].graph, model.active, 'homes', 'car',
    { lifts: new Map([[low.id, 0.8]]) });
  assert.ok(after.reduce((a, b) => a + b, 0) >= before.reduce((a, b) => a + b, 0));
});

for (const preset of PRESETS) {
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  test(`${preset.id} cutoff matrix rows mirror the feasibility scan`, () => {
    const matrix = cutoffMatrix(preset.graph, model.active, origins, 'car', { raise: model.raise });
    assert.equal(matrix.rows.length, origins.length);
    assert.equal(matrix.tMax, TIMELINE_MINUTES);
    for (const row of matrix.rows) {
      assert.equal(row.feasible.length, TIMELINE_MINUTES + 1);
      assert.equal(row.hourly.length, HOUR_MARKS.length);
      for (let i = 0; i < HOUR_MARKS.length; i += 1) {
        assert.equal(row.hourly[i], Boolean(row.feasible[HOUR_MARKS[i]]));
      }
      const firstFail = row.feasible.findIndex(flag => flag === 0);
      assert.equal(row.firstCut, firstFail === -1 ? null : firstFail);
      const lastOk = row.feasible.reduce((acc, flag, t) => (flag ? t : acc), -1);
      assert.equal(row.lastSafe, lastOk === -1 ? null : lastOk);
      const reopened = row.firstCut !== null && row.lastSafe !== null && row.lastSafe > row.firstCut;
      assert.equal(row.reopened, reopened);
      assert.equal(row.households, preset.graph.nodes.find(n => n.id === row.origin).households ?? 0);
      assert.ok(row.label.length > 0);
    }
  });
}

for (const preset of PRESETS) {
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  test(`${preset.id} last safe departure is monotone in storm scale`, () => {
    const lighter = { ...model.input, rain: model.input.rain.map(mm => mm * 0.5) };
    const heavier = { ...model.input, rain: model.input.rain.map(mm => mm * 1.8) };
    const simLight = simulate(lighter);
    const simHeavy = simulate(heavier);
    for (const origin of origins) {
      const a = departureScan(preset.graph, simLight, origin, 'car');
      const b = departureScan(preset.graph, simHeavy, origin, 'car');
      const lastSafe = flags => flags.reduce((acc, f, t) => (f ? t : acc), -1);
      assert.ok(lastSafe(a) >= lastSafe(b), `${preset.id} ${origin}: ${lastSafe(a)} < ${lastSafe(b)}`);
    }
  });
}

test('departFeasible routes around a flooded leg through a dry detour', () => {
  const graph = {
    nodes: [
      { id: 'o', type: 'home', floor: 8 },
      { id: 'm', type: 'junction', floor: 8 },
      { id: 's', type: 'shelter', floor: 8 },
    ],
    edges: [
      { id: 'low', a: 'o', b: 's', m: 100, floor: 1 },
      { id: 'up', a: 'o', b: 'm', m: 400, floor: 8 },
      { id: 'down', a: 'm', b: 's', m: 400, floor: 8 },
    ],
  };
  const sim = signal([2, 2, 2]);
  const result = departFeasible(graph, sim, 'o', 0, 'car');
  assert.equal(result.reached, true);
  assert.deepEqual(result.path.map(e => e.id), ['up', 'down']);
  assert.ok(Math.abs(result.arrival - 2) < 1e-9, `arrival ${result.arrival}`);
});

test('departFeasible chains multiple dry legs across a junction', () => {
  const graph = {
    nodes: [
      { id: 'o', type: 'home', floor: 8 },
      { id: 'a', type: 'junction', floor: 8 },
      { id: 'b', type: 'junction', floor: 8 },
      { id: 's', type: 'shelter', floor: 8 },
    ],
    edges: [
      { id: 'oa', a: 'o', b: 'a', m: 400, floor: 8 },
      { id: 'ab', a: 'a', b: 'b', m: 400, floor: 8 },
      { id: 'bs', a: 'b', b: 's', m: 400, floor: 8 },
      { id: 'trap', a: 'a', b: 's', m: 10, floor: 1 },
    ],
  };
  const sim = signal([0, 3, 3, 3, 3]);
  const result = departFeasible(graph, sim, 'o', 0, 'car');
  assert.equal(result.reached, true);
  assert.deepEqual(result.path.map(e => e.id), ['oa', 'ab', 'bs']);
  assert.ok(Math.abs(result.arrival - 3) < 1e-9, `arrival ${result.arrival}`);
});

test('a mid-trip flood on a later leg still blocks the departure', () => {
  const graph = {
    nodes: [
      { id: 'o', type: 'home', floor: 8 },
      { id: 'm', type: 'junction', floor: 8 },
      { id: 's', type: 'shelter', floor: 8 },
    ],
    edges: [
      { id: 'first', a: 'o', b: 'm', m: 400, floor: 8 },
      { id: 'second', a: 'm', b: 's', m: 400, floor: 2 },
    ],
  };
  // second leg entered at t=1, exits at t=2; its wet window opens near 1.3.
  const sim = signal([0, 0, 4, 4]);
  assert.equal(departFeasible(graph, sim, 'o', 0, 'car').reached, false);
});

test('a bridge raise lifts only bridge roads in the schedule', () => {
  const graph = {
    nodes: [
      { id: 'o', type: 'home', floor: 8 },
      { id: 'm', type: 'junction', floor: 8 },
      { id: 's', type: 'shelter', floor: 8 },
    ],
    edges: [
      { id: 'spun', a: 'o', b: 'm', m: 400, floor: 2, bridge: true },
      { id: 'road', a: 'm', b: 's', m: 400, floor: 8 },
    ],
  };
  const sched = buildSchedule(graph, signal([0, 0, 4, 4]), 5);
  assert.equal(sched.wets.get('spun').length, 0);
  assert.equal(sched.wets.get('road').length, 0);
  const unraised = buildSchedule(graph, signal([0, 0, 4, 4]), 0);
  assert.equal(unraised.wets.get('spun').length, 1);
});

test('cutoffMatrix honors a shorter horizon and reports nulls past it', () => {
  const model = buildScenario(PRESETS[0]);
  const matrix = cutoffMatrix(PRESETS[0].graph, model.active, ['school'], 'car', { tMax: 120 });
  assert.equal(matrix.tMax, 120);
  const row = matrix.rows[0];
  assert.equal(row.feasible.length, 121);
  assert.equal(row.hourly[0], Boolean(row.feasible[0]));
  assert.equal(row.hourly[1], Boolean(row.feasible[60]));
  assert.equal(row.hourly[2], Boolean(row.feasible[120]));
  assert.equal(row.hourly[6], null);
  assert.throws(() => cutoffMatrix(PRESETS[0].graph, model.active, ['school'], 'car', { tMax: 0 }), RangeError);
});

for (const preset of PRESETS) {
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  test(`${preset.id} pedestrian cutoff matrix mirrors the walking scan`, () => {
    const matrix = cutoffMatrix(preset.graph, model.active, origins, 'pedestrian', { raise: model.raise });
    assert.equal(matrix.mode, 'pedestrian');
    for (const row of matrix.rows) {
      const spot = departFeasible(preset.graph, model.active, row.origin, 30, 'pedestrian');
      assert.equal(Boolean(row.feasible[30]), spot.reached);
      const carRow = cutoffMatrix(preset.graph, model.active, [row.origin], 'car', { raise: model.raise }).rows[0];
      assert.ok(row.feasible.reduce((a, b) => a + b, 0) <= carRow.feasible.reduce((a, b) => a + b, 0),
        `${preset.id} ${row.origin}: pedestrian window wider than car`);
    }
  });
}

for (const preset of PRESETS) {
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  for (const scale of [0.6, 2]) {
    test(`${preset.id} scale-${scale} matrix stays consistent at a different storm size`, () => {
      const scaled = { ...model.input, rain: model.input.rain.map(mm => mm * scale) };
      const sim = simulate(scaled);
      const matrix = cutoffMatrix(preset.graph, sim, origins, 'car');
      assert.equal(matrix.rows.length, origins.length);
      for (const row of matrix.rows) {
        assert.equal(row.feasible.length, TIMELINE_MINUTES + 1);
        for (let i = 0; i < HOUR_MARKS.length; i += 1) {
          assert.equal(row.hourly[i], Boolean(row.feasible[HOUR_MARKS[i]]));
        }
      }
    });
  }
}

for (const preset of PRESETS) {
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  test(`${preset.id} a crossing lift never shortens a zone's last safe minute`, () => {
    const low = preset.graph.edges.reduce((a, b) => (a.floor <= b.floor ? a : b));
    const lifts = new Map([[low.id, 0.8]]);
    for (const origin of origins) {
      const base = departureScan(preset.graph, model.active, origin, 'car', { raise: model.raise });
      const lifted = departureScan(preset.graph, model.active, origin, 'car', { raise: model.raise, lifts });
      const lastSafe = flags => flags.reduce((acc, f, t) => (f ? t : acc), -1);
      assert.ok(lastSafe(lifted) >= lastSafe(base), `${origin}: ${lastSafe(lifted)} < ${lastSafe(base)}`);
    }
  });
}

for (const preset of PRESETS) {
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  test(`${preset.id} scan flags are strictly 0 or 1 for every origin and mode`, () => {
    for (const origin of origins) {
      for (const mode of ['car', 'pedestrian']) {
        const flags = departureScan(preset.graph, model.active, origin, mode, { raise: model.raise });
        for (const flag of flags) assert.ok(flag === 0 || flag === 1);
      }
    }
  });
}

for (const preset of [PRESETS[0], PRESETS[1]]) {
  const model = buildScenario(preset);
  const origins = originsOf(preset);
  test(`${preset.id} matrix shows at least one reopened pocket`, () => {
    const matrix = cutoffMatrix(preset.graph, model.active, origins, 'car', { raise: model.raise });
    assert.ok(matrix.rows.some(row => row.reopened),
      'expected a zone that floods then regains a dry departure');
  });
}

for (const preset of PRESETS) {
  for (const mode of ['car', 'pedestrian']) {
    const model = buildScenario(preset);
    const origins = originsOf(preset);
    test(`${preset.id} ${mode} returned paths verify leg by leg against firstAbove`, () => {
      const sim = model.active;
      const nodes = new Map(preset.graph.nodes.map(n => [n.id, n]));
      const end = sim.q.length - 1;
      const speed = { car: 400, pedestrian: 80 }[mode];
      const sched = buildSchedule(preset.graph, sim, model.raise);
      for (const origin of origins) {
        for (let t = 0; t <= TIMELINE_MINUTES; t += 20) {
          const result = departFeasible(preset.graph, sim, origin, t, mode, sched);
          if (!result.reached) continue;
          let entry = t;
          let last = origin;
          for (const edge of result.path) {
            assert.ok(edge.a === last || edge.b === last, `${origin} t${t}: path gap at ${edge.id}`);
            const exit = entry + edge.m / speed;
            const floor = roadFloor(edge, nodes, model.raise);
            const limit = normalDepthDischarge(floor, sim.channel);
            if (entry < end) {
              const wet = firstAbove(sim.q, limit, entry, Math.min(exit, end));
              assert.equal(wet, null, `${preset.id} ${origin} t${t}: ${edge.id} floods in [${entry.toFixed(1)}, ${exit.toFixed(1)}]`);
            }
            if (exit > end) assert.equal(sim.q[end], 0, `${edge.id} exits past a still-flowing tail`);
            last = edge.a === last ? edge.b : edge.a;
            entry = exit;
          }
          assert.equal(last, result.shelter);
          assert.ok(Math.abs(entry - result.arrival) < 1e-9);
          assert.ok(result.path.length > 0);
        }
      }
    });
  }
}
