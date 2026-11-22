import { bounded, normalDepthDischarge, sampleDischarge, solveStage } from './hydrology.js';
import { TRAVEL_METERS_PER_MIN, checkLifts, checkRoads, featureDepth, graphNodes, roadFloor } from './routing.js';

export const TIMELINE_MINUTES = 360;
export const HOUR_MARKS = Object.freeze([0, 60, 120, 180, 240, 300, 360]);

// Every interval a road is overtop, as [start, end) storm minutes with linear
// crossing interpolation like firstAbove. A road that floods then drains can
// reopen, matching the snapshot rule the rest of the workbench uses.
export function wetIntervals(q, limit, end = q.length - 1) {
  const intervals = [];
  let open = q[0] > limit ? 0 : null;
  for (let i = 1; i <= end; i += 1) {
    const a = q[i - 1];
    const b = q[i];
    const cross = (limit - a) / (b - a);
    if (open === null && a <= limit && b > limit) open = i - 1 + cross;
    else if (open !== null && a > limit && b <= limit) {
      intervals.push([open, i - 1 + cross]);
      open = null;
    }
  }
  if (open !== null) intervals.push([open, Infinity]);
  return intervals;
}

// A leg is traversable only when no wet interval touches its crossing window;
// leaving exactly as the road floods counts as wet, as the snapshot rule does.
const windowWet = (intervals, entry, exit) =>
  intervals.some(([s, e]) => s <= exit && e > entry);

// Per-edge flood schedule shared across a scan.
export function buildSchedule(graph, sim, raise = 0, lifts = null) {
  bounded(raise, 0, 10, 'Bridge raise');
  checkLifts(lifts);
  const nodes = graphNodes(graph);
  checkRoads(graph, nodes);
  const end = sim.q.length - 1;
  const floors = new Map(graph.edges.map(edge => [edge.id, roadFloor(edge, nodes, raise, lifts)]));
  const wets = new Map(graph.edges.map(edge => [
    edge.id, wetIntervals(sim.q, normalDepthDischarge(floors.get(edge.id), sim.channel), end),
  ]));
  const shelters = graph.nodes.filter(node => node.type === 'shelter').map(node => node.id);
  return { nodes, floors, wets, shelters, end };
}

function stageAt(sim, minute) {
  return Number.isInteger(minute) ? sim.stage[minute] : solveStage(sampleDischarge(sim.q, minute), sim.channel);
}

// Earliest-arrival search from a departure minute: a leg may be traversed only
// while the road stays dry for the whole crossing window, and no waiting mid-trip
// is explored. The earliest-arrival plan is what gets checked, so a flag can be
// conservative (a slower route might still work); it is never optimistic. A trip
// may finish past the array end only when the run drains fully, the same rule
// routeAt uses for verified trips.
export function departFeasible(graph, sim, origin, tDepart, mode, schedule = null) {
  const speed = TRAVEL_METERS_PER_MIN[mode];
  if (!Object.hasOwn(TRAVEL_METERS_PER_MIN, mode)) throw new RangeError('Unknown travel mode.');
  bounded(tDepart, 0, Number.MAX_VALUE, 'Departure minute');
  const sched = schedule ?? buildSchedule(graph, sim);
  const { nodes, wets, shelters, end } = sched;
  if (!nodes.has(origin) || tDepart > end) {
    return { reached: false, shelter: null, arrival: null, reason: 'origin', path: null };
  }
  if (featureDepth(stageAt(sim, tDepart), nodes.get(origin).floor) > 0) {
    return { reached: false, shelter: null, arrival: null, reason: 'origin', path: null };
  }
  const tailDry = sim.q[end] === 0 && sim.stage[end] === 0;
  const goals = new Set(shelters);
  const arrive = new Map([[origin, tDepart]]);
  const prev = new Map();
  const open = new Set(nodes.keys());
  while (open.size) {
    let current = null;
    let best = Infinity;
    for (const id of open) {
      const at = arrive.get(id) ?? Infinity;
      if (at < best) { best = at; current = id; }
    }
    if (current === null) break;
    if (goals.has(current)) {
      const path = [];
      let tail = current;
      while (prev.has(tail)) {
        const { from, edge } = prev.get(tail);
        path.unshift(edge);
        tail = from;
      }
      return { reached: true, shelter: current, arrival: best, reason: null, path };
    }
    open.delete(current);
    for (const edge of graph.edges) {
      const to = edge.a === current ? edge.b : edge.b === current ? edge.a : null;
      if (!open.has(to)) continue;
      const exit = best + edge.m / speed;
      if (exit > end + 1e-9 && !tailDry) continue;
      if (!windowWet(wets.get(edge.id), best, Math.min(exit, end)) &&
          exit < (arrive.get(to) ?? Infinity)) {
        arrive.set(to, exit);
        prev.set(to, { from: current, edge });
      }
    }
  }
  return { reached: false, shelter: null, arrival: null, reason: 'cutoff', path: null };
}

// Feasibility of a verified dry departure for every integer minute 0..tMax.
export function departureScan(graph, sim, origin, mode, { tMax = TIMELINE_MINUTES, raise = 0, lifts = null } = {}) {
  bounded(tMax, 1, sim.q.length - 1, 'Timeline horizon');
  const sched = buildSchedule(graph, sim, raise, lifts);
  const end = Math.min(tMax, sched.end);
  const feasible = new Uint8Array(tMax + 1);
  for (let t = 0; t <= end; t += 1) {
    feasible[t] = departFeasible(graph, sim, origin, t, mode, sched).reached ? 1 : 0;
  }
  return feasible;
}

function summarize(feasible) {
  let firstCut = null;
  let lastSafe = null;
  let reopened = false;
  let sawFail = false;
  for (let t = 0; t < feasible.length; t += 1) {
    if (feasible[t]) {
      lastSafe = t;
      if (sawFail) reopened = true;
    } else {
      sawFail = true;
      if (firstCut === null) firstCut = t;
    }
  }
  return { firstCut, lastSafe, reopened };
}

// The alert matrix: for every vulnerable zone, whether a departure at each hour
// mark can still be verified dry, plus the first failed and last safe minutes.
export function cutoffMatrix(graph, sim, origins, mode, { tMax = TIMELINE_MINUTES, raise = 0, lifts = null } = {}) {
  const nodes = graphNodes(graph);
  const rows = origins.map(origin => {
    const feasible = departureScan(graph, sim, origin, mode, { tMax, raise, lifts });
    const { firstCut, lastSafe, reopened } = summarize(feasible);
    const hourly = HOUR_MARKS.map(mark => (mark <= tMax ? Boolean(feasible[mark]) : null));
    const node = nodes.get(origin);
    return {
      origin,
      label: node?.label ?? origin,
      feasible,
      hourly,
      firstCut,
      lastSafe,
      reopened,
      households: node?.households ?? 0,
    };
  });
  return { tMax, mode, rows };
}
