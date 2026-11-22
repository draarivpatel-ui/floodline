import { bounded, simulate } from './hydrology.js';
import {
  DEPTH_REFERENCES, checkLifts, initialDepartureCutoff, passableSnapshot, shortestPath,
} from './routing.js';

// Invented storm severity tiers scale the training storm's rain bins. They are
// planning-model labels for the exercise, not design-storm return periods.
export const STORM_TIERS = Object.freeze([
  { id: 't10', label: '10-yr', scale: 0.6 },
  { id: 't50', label: '50-yr', scale: 1 },
  { id: 't100', label: '100-yr', scale: 1.4 },
  { id: 't500', label: '500-yr', scale: 2 },
]);

export const TIER_SCALE_RANGE = Object.freeze({ min: 0.4, max: 2.2 });
export const BUDGET_RANGE = Object.freeze({ min: 0, max: 9 });

// The disclosed vehicle reference: a road is impassable at or above 0.30 m.
export const IMPASSABLE_M = DEPTH_REFERENCES.car;

// Deterministic planning-model interventions. costM values and effects are
// invented unit-rate constants for the exercise, never real-city cost or
// performance measurements.
export const INTERVENTIONS = Object.freeze([
  {
    id: 'green', label: 'Permeable pavement and bioswales', costM: 4.2,
    summary: 'Curve number minus 8, hydrograph slowed 10 percent',
    cnDelta: -8, lagScale: 1.1,
  },
  {
    id: 'basin', label: 'Retention basin expansion', costM: 6.8,
    summary: 'Curve number minus 2, hydrograph slowed 35 percent',
    cnDelta: -2, lagScale: 1.35,
  },
  {
    id: 'culvert', label: 'Critical culvert elevation', costM: 3.1,
    summary: 'Lowest crossing lifted 0.60 m',
    liftLowest: 0.6,
  },
  {
    id: 'wall', label: 'Mobile floodwall and pump station', costM: 5.4,
    summary: 'Containment plus 0.60 m, conveyance credit 35 percent',
    bankfullAdd: 0.6, conveyance: 1.35,
  },
  {
    id: 'package', label: 'Combined low-cost package', costM: 2.6,
    summary: 'Curve number minus 4, drains cleared, plus 0.20 m containment, lowest crossing lifted 0.30 m',
    cnDelta: -4, blockageSet: 0, bankfullAdd: 0.2, liftLowest: 0.3,
  },
]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Translate an intervention into scenario inputs, a bridge raise, and per-crossing lifts.
export function applyIntervention(input, intervention, graph) {
  if (!INTERVENTIONS.includes(intervention) && typeof intervention !== 'object') {
    throw new RangeError('Unknown intervention.');
  }
  const lag = intervention.lagScale ?? 1;
  bounded(lag, 0.5, 3, 'Hydrograph lag scale');
  const peakLag = Math.max(1, Math.round(input.peakLag * lag));
  const endLag = Math.min(720, Math.max(peakLag + 1, Math.round(input.endLag * lag)));
  const cn = clamp(input.cn + (intervention.cnDelta ?? 0), 1, 100);
  const blockage = intervention.blockageSet !== undefined
    ? bounded(intervention.blockageSet, 0, 1, 'Mitigated blockage')
    : clamp(input.blockage + (intervention.blockageDelta ?? 0), 0, 1);
  const channel = {
    ...input.channel,
    n: clamp(input.channel.n * (intervention.nScale ?? 1), 0.001, 2),
    slope: clamp(input.channel.slope * (intervention.conveyance ?? 1), 0, 1),
    bankfull: clamp(input.channel.bankfull + (intervention.bankfullAdd ?? 0), 0.01, 100),
  };
  const lifts = new Map();
  if (intervention.liftLowest) {
    bounded(intervention.liftLowest, 0, 10, 'Lowest-crossing lift');
    const lowest = graph.edges.reduce((a, b) => (a.floor <= b.floor ? a : b));
    lifts.set(lowest.id, intervention.liftLowest);
  }
  for (const [id, lift] of Object.entries(intervention.lifts ?? {})) {
    bounded(lift, 0, 10, `Crossing lift for ${id}`);
    lifts.set(id, lift);
  }
  checkLifts(lifts);
  const raise = bounded(intervention.raise ?? 0, 0, 10, 'Bridge raise');
  return {
    input: {
      rain: [...input.rain], cn, blockage, areaKm2: input.areaKm2,
      peakLag, endLag, channel,
    },
    raise,
    lifts,
  };
}

export function tieredInput(input, scale) {
  bounded(scale, 0.05, 8, 'Storm tier scale');
  return { ...input, rain: input.rain.map(mm => mm * scale) };
}

function shelterIds(graph) {
  return graph.nodes.filter(node => node.type === 'shelter').map(node => node.id);
}

// One comparator run: simulate, then measure the road network at the run's own
// peak minute under the disclosed impassability depth.
export function evaluateRun(graph, input, origins, mode, threshold, raise = 0, lifts = null) {
  const sim = simulate(input);
  const snap = passableSnapshot(graph, sim, sim.peakMinute, threshold, raise, lifts);
  const passableKm = graph.edges
    .filter(edge => !snap.impassable(snap.depths.get(edge.id)))
    .reduce((sum, edge) => sum + edge.m, 0) / 1000;
  const stranded = [];
  for (const origin of origins) {
    const node = snap.nodeDepths.get(origin);
    if (node === undefined) continue;
    const cut = snap.impassable(node) ||
      !shortestPath(graph, origin, snap.goals, edge => !snap.impassable(snap.depths.get(edge.id)));
    if (cut) stranded.push(origin);
  }
  const cutoffs = new Map(origins.map(origin => [
    origin, initialDepartureCutoff(graph, sim, origin, mode, raise, lifts, threshold),
  ]));
  const finite = [...cutoffs.values()].filter(Number.isFinite);
  const earliest = finite.length ? Math.min(...finite)
    : cutoffs.size && [...cutoffs.values()].every(v => v === Infinity) ? Infinity : -Infinity;
  const households = new Map(graph.nodes.map(node => [node.id, node.households ?? 0]));
  return {
    sim, snap, passableKm, stranded, cutoffs, earliest, households,
    householdsStranded: stranded.reduce((sum, id) => sum + (households.get(id) ?? 0), 0),
  };
}

function rowMetrics(base, run, intervention, costM) {
  const avoided = base.stranded.filter(id => !run.stranded.includes(id));
  const householdsAvoided = avoided.reduce((sum, id) => sum + (base.households.get(id) ?? 0), 0);
  const extension = Number.isFinite(base.earliest) && Number.isFinite(run.earliest)
    ? run.earliest - base.earliest : null;
  return {
    intervention, costM, sim: run.sim,
    peakStage: run.sim.peakStage,
    stageDrop: base.sim.peakStage - run.sim.peakStage,
    passableKm: run.passableKm,
    passableDelta: run.passableKm - base.passableKm,
    stranded: [...run.stranded],
    strandedCount: run.stranded.length,
    strandedReduction: base.stranded.length - run.stranded.length,
    householdsAvoided,
    perMillion: costM > 0 ? householdsAvoided / costM : null,
    cutoffs: run.cutoffs,
    earliest: run.earliest,
    extension,
    reopened: run.earliest === Infinity && base.earliest !== Infinity,
  };
}

// Compare the unmitigated scenario inputs against every intervention at one
// storm tier. origins are the vulnerable zones (home and school nodes).
export function compareTier(model, scale, origins, mode = 'car', threshold = IMPASSABLE_M) {
  const graph = model.preset.graph;
  const scaled = tieredInput(model.input, scale);
  const base = evaluateRun(graph, scaled, origins, mode, threshold);
  const rows = [{ ...rowMetrics(base, base, null, 0), costM: 0, extension: 0 }];
  for (const intervention of INTERVENTIONS) {
    const applied = applyIntervention(scaled, intervention, graph);
    const run = evaluateRun(graph, applied.input, origins, mode, threshold, applied.raise, applied.lifts);
    rows.push(rowMetrics(base, run, intervention, intervention.costM));
  }
  return { scale, threshold, mode, origins: [...origins], base, rows };
}

export function bestInBudget(comparison, budgetM) {
  let best = null;
  for (const row of comparison.rows) {
    if (row.intervention === null || row.costM > budgetM) continue;
    if (!best ||
        row.strandedReduction > best.strandedReduction ||
        (row.strandedReduction === best.strandedReduction && row.passableDelta > best.passableDelta) ||
        (row.strandedReduction === best.strandedReduction && row.passableDelta === best.passableDelta && row.costM < best.costM)) {
      best = row;
    }
  }
  return best;
}
