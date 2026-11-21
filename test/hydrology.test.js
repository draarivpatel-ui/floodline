import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compositeCN, firstAbove, integrateDischarge, normalDepthDischarge, parseRain, partitionRain, rainSeries,
  rainToDischarge, sampleDischarge, simulate, solveStage, triangle,
} from '../src/hydrology.js';
import { buildScenario, PRESETS } from '../src/presets.js';

const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);

test('TR-55 at CN 80 and 2.5 inches yields 8/9 of an inch of runoff', () => {
  const row = partitionRain(63.5, 80);
  near(row.retention, 63.5);
  near(row.ia, 12.7);
  near(row.runoff, 25.4 * 8 / 9);
  near(row.storage, 50.8 - 25.4 * 8 / 9);
});

test('connected impervious fraction mixes a pervious CN of 62 with pavement CN 98', () => {
  near(compositeCN(62, 35), 74.6);
  assert.equal(compositeCN(62, 0), 62);
  assert.equal(compositeCN(62, 100), 98);
});

// Express the storm in fractions of retention so expected TR-55 runoff is simple rational arithmetic.
for (const inches of [0.5, 1, 2.5, 5, 10, 23 + 1 / 3]) {
  const cn = 1000 / (10 + inches);
  for (const [rainMultiple, runoffMultiple] of [
    [0, 0], [0.1, 0], [0.2, 0], [0.45, 1 / 20], [0.7, 1 / 6], [1.2, 1 / 2], [2.2, 4 / 3],
  ]) {
    test(`TR-55 rational fixture S=${inches} in, P=${rainMultiple} S`, () => {
      const s = 25.4 * inches;
      const row = partitionRain(rainMultiple * s, cn);
      near(row.runoff, runoffMultiple * s);
      near(row.abstraction, Math.min(rainMultiple, 0.2) * s);
      near(row.runoff + row.abstraction + row.storage, row.rain);
      assert.ok(row.storage >= 0 && row.storage <= row.retention);
    });
  }
}

for (const amount of [0, 0.001, 1, 100, 120_000, Number.MAX_VALUE]) {
  test(`CN 100 converts ${amount} mm entirely to excess`, () => {
    assert.deepEqual(partitionRain(amount, 100), {
      rain: amount, retention: 0, ia: 0, abstraction: 0, storage: 0, runoff: amount, residual: 0,
    });
  });
}

for (const rain of [0, 0.6, 11, 58, 313, 6000]) {
  test(`runoff never decreases with increasing CN at ${rain} mm`, () => {
    const values = [1, 20, 30, 57, 80, 98, 100].map(cn => partitionRain(rain, cn).runoff);
    assert.deepEqual(values, [...values].sort((a, b) => a - b));
  });
}

for (const cn of [1, 30, 56, 80, 98, 100]) {
  test(`runoff never decreases as rainfall accumulates at CN ${cn}`, () => {
    const values = [0, 1, 7, 33, 104, 373, 100_000].map(rain => partitionRain(rain, cn).runoff);
    assert.deepEqual(values, [...values].sort((a, b) => a - b));
  });
}

for (const input of ['', '  ', '1,,2', ',1', '1, ', '-1', '1e4', 'NaN', '5001', '1.2.3', 'Infinity', Array(25).fill('1').join(' ')]) {
  test(`rainfall parser rejects ${JSON.stringify(input)}`, () => assert.throws(() => parseRain(input), RangeError));
}

test('hyetograph parser accepts mixed whitespace, decimals, commas and a trailing newline', () => {
  assert.deepEqual(parseRain('1.5,  2\n3.75,\t0 .2\n'), [1.5, 2, 3.75, 0, 0.2]);
});

test('incremental excess telescopes and dry bins add no excess', () => {
  const bins = rainSeries([12, 0, 16, 0, 42, 0], 81);
  assert.deepEqual(bins.map(row => row.minute), [15, 30, 45, 60, 75, 90]);
  assert.equal(bins[1].runoffIncrement, 0);
  assert.equal(bins[5].runoffIncrement, 0);
  near(bins.reduce((sum, row) => sum + row.runoffIncrement, 0), partitionRain(70, 81).runoff);
});

test('5000 mm limit validates arrays as well as pasted data', () => {
  assert.throws(() => rainSeries([5001], 90), RangeError);
  assert.throws(() => rainSeries(Array(2), 70), RangeError);
  assert.throws(() => rainSeries([-0.1], 70), RangeError);
  assert.throws(() => rainSeries([], 70), RangeError);
  assert.throws(() => partitionRain(12, 101), RangeError);
  assert.throws(() => partitionRain(-12, 70), RangeError);
  assert.throws(() => compositeCN(99, 30), RangeError);
  assert.throws(() => compositeCN(62, 101), RangeError);
});

for (const [lag, support] of [[1, 2], [2, 7], [17, 72], [33, 109], [126, 127], [21, 720]]) {
  test(`triangle with peak ${lag} and support ${support} conserves unit volume`, () => {
    const nodal = Array.from({ length: support + 1 }, (_, t) => triangle(t, lag, support));
    assert.equal(nodal[0], 0);
    assert.equal(nodal.at(-1), 0);
    assert.equal(nodal.indexOf(Math.max(...nodal)), lag);
    near(integrateDischarge(nodal), 1, 1e-12);
  });
}

test('one 12 mm fully impervious pulse over 2 km2 has 24000 m3 and known discharge ordinates', () => {
  const q = rainToDischarge(rainSeries([12], 100), 2, 10, 40);
  assert.equal(q[15], 0);
  near(q[20], 10);
  near(q[25], 20);
  near(q[40], 10);
  assert.equal(q[55], 0);
  near(integrateDischarge(q), 24_000);
});

test('rain late in the workbench still appears in the complete hydrograph', () => {
  const q = rainToDischarge(rainSeries([...Array(23).fill(0), 25], 100), 1, 20, 75);
  assert.equal(q.length, 436);
  assert.equal(q[360], 0);
  assert.ok(q[380] > 0);
  assert.equal(q[435], 0);
  near(integrateDischarge(q), 25_000);
});

for (const depth of [0.005, 0.02, 0.15, 0.3, 0.62, 1, 2.28, 5.2, 17, 30, 87, 100]) {
  for (const shape of ['rectangle', 'trapezoid']) {
    test(`Manning inversion for analytical ${shape} at ${depth} m`, () => {
      const rectangle = shape === 'rectangle';
      const channel = { width: depth * (rectangle ? 2 : 2.5), sideSlope: rectangle ? 0 : 0.75, n: 0.05, slope: 0.01 };
      const area = (rectangle ? 2 : 3.25) * depth ** 2;
      const radius = (rectangle ? 0.5 : 0.65) * depth;
      const expected = 2 * area * Math.cbrt(radius) ** 2;
      near(normalDepthDischarge(depth, channel), expected, 1e-8);
      const solved = solveStage(expected, channel);
      near(solved, depth, 1e-10);
      near(normalDepthDischarge(solved, channel), expected, 1e-6);
    });
  }
}

test('Manning zero gradient cannot be inverted for positive discharge', () => {
  const channel = { width: 10, sideSlope: 2, slope: 0, n: 0.04 };
  assert.equal(solveStage(0, channel), 0);
  assert.equal(normalDepthDischarge(1, channel), 0);
  assert.throws(() => solveStage(0.01, channel), /Zero-slope/);
  assert.throws(() => solveStage(-1, channel), RangeError);
  assert.throws(() => normalDepthDischarge(-1, channel), RangeError);
  assert.throws(() => solveStage(2, { ...channel, n: 0 }), RangeError);
  assert.throws(() => solveStage(2, { ...channel, slope: -0.02 }), RangeError);
  assert.throws(() => solveStage(Number.MAX_VALUE, { ...channel, slope: 0.001 }), RangeError);
});

test('crossing time is piecewise linear in discharge, strict at tangent and exact at fractional bounds', () => {
  const discharge = [0, 4, 8, 4, 12, 0];
  assert.equal(sampleDischarge(discharge, 0.25), 1);
  assert.equal(firstAbove(discharge, 3), 0.75);
  assert.equal(firstAbove(discharge, 8), 3.5);
  assert.equal(firstAbove(discharge, 8, 0, 2), null);
  assert.equal(firstAbove(discharge, 8, 3.75, 4.5), 3.75);
  assert.equal(firstAbove(discharge, 12), null);
  assert.equal(firstAbove(discharge, 0, 0, 0), null);
  assert.throws(() => firstAbove(discharge, 4, 2, 1), RangeError);
  assert.throws(() => sampleDischarge(discharge, -0.1), RangeError);
  assert.throws(() => sampleDischarge(discharge, 5.1), RangeError);
});

for (const p of PRESETS) {
  test(`${p.id} solves first overbank from stage-discharge instead of stage interpolation`, () => {
    const s = buildScenario(p).active;
    assert.ok(s.firstOverbank > 0);
    near(solveStage(sampleDischarge(s.q, s.firstOverbank), s.channel), p.channel.bankfull, 1e-9);
    assert.ok(solveStage(sampleDischarge(s.q, s.firstOverbank - 0.01), s.channel) < p.channel.bankfull);
    assert.ok(solveStage(sampleDischarge(s.q, s.firstOverbank + 0.01), s.channel) > p.channel.bankfull);
  });
  test(`${p.id} conserves basin volume and closes the independent rainfall budget`, () => {
    const s = buildScenario(p).active;
    const wholeRain = p.rain.reduce((a, b) => a + b, 0) * p.areaKm2 * 1000;
    const end = s.bins.at(-1);
    near(s.discharged + (end.abstraction + end.storage) * p.areaKm2 * 1000, wholeRain, 1e-8);
    near(s.residual, 0, 1e-8);
  });
  test(`${p.id} zero rain produces neither a flood nor a peak past minute zero`, () => {
    const s = simulate({ ...buildScenario(p).input, rain: [0, 0, 0] });
    assert.equal(s.firstOverbank, null);
    assert.equal(s.peakMinute, 0);
    assert.equal(s.volume, 0);
    assert.ok(s.q.every(q => q === 0));
    assert.ok(s.stage.every(h => h === 0));
  });
  test(`${p.id} maximum accepted storm conserves volume and retains a numerically invertible peak`, () => {
    const input = { ...buildScenario(p).input, rain: Array(24).fill(5000), cn: 100, blockage: 1 };
    const s = simulate(input);
    near(s.discharged, p.areaKm2 * 120_000_000, 1e-6);
    near(normalDepthDischarge(s.peakStage, s.channel), s.peakQ, 1e-6);
    assert.equal(s.q.at(-1), 0);
    assert.ok(s.peakStage > s.channel.bankfull);
  });
}
