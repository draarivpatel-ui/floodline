import { firstAbove, normalDepthDischarge, sampleDischarge, solveStage } from './hydrology.js';

export const DEPTH_REFERENCES = Object.freeze({ pedestrian: 0.15, car: 0.30 });
export const TRAVEL_METERS_PER_MIN = Object.freeze({ pedestrian: 80, car: 400 });

export function shortestPath(graph, start, destinations, allows = () => true) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const goals = new Set(destinations);
  if (!nodes.has(start) || goals.size === 0) return null;
  const adjacent = new Map([...nodes.keys()].map(id => [id, []]));
  for (const edge of graph.edges) {
    if (!adjacent.has(edge.a) || !adjacent.has(edge.b) || !Number.isFinite(edge.m) || edge.m <= 0) {
      throw new RangeError(`Invalid road ${edge.id}.`);
    }
    if (allows(edge)) {
      adjacent.get(edge.a).push([edge.b, edge]);
      adjacent.get(edge.b).push([edge.a, edge]);
    }
  }
  const best = new Map([[start, 0]]);
  const prev = new Map();
  const open = new Set(nodes.keys());
  while (open.size) {
    let current = null;
    let distance = Infinity;
    for (const id of open) {
      if ((best.get(id) ?? Infinity) < distance) {
        current = id;
        distance = best.get(id);
      }
    }
    if (current === null) break;
    if (goals.has(current)) {
      const path = [current];
      const edges = [];
      let tail = current;
      while (prev.has(tail)) {
        const [parent, edge] = prev.get(tail);
        edges.unshift(edge);
        path.unshift(parent);
        tail = parent;
      }
      return { nodes: path, edges, distance, shelter: nodes.get(current) };
    }
    open.delete(current);
    for (const [to, edge] of adjacent.get(current)) {
      const proposal = distance + edge.m;
      if (open.has(to) && proposal < (best.get(to) ?? Infinity)) {
        best.set(to, proposal);
        prev.set(to, [current, edge]);
      }
    }
  }
  return null;
}

export function featureDepth(stage, floor) {
  return Math.max(0, stage - floor);
}

export function isAboveReference(depth, mode) {
  if (!Object.hasOwn(DEPTH_REFERENCES, mode)) throw new RangeError('Unknown travel comparison.');
  return depth >= DEPTH_REFERENCES[mode];
}

export function roadFloor(edge, nodes, raise = 0) {
  return Math.min(edge.floor + (edge.bridge ? raise : 0), nodes.get(edge.a).floor, nodes.get(edge.b).floor);
}

function roadSchedule(sim, floor, start, end) {
  const threshold = normalDepthDischarge(floor, sim.channel);
  return firstAbove(sim.q, threshold, start, end);
}

function intervals(path, floors, metersPerMinute) {
  let elapsed = 0;
  return path.edges.map(edge => {
    const entry = elapsed;
    elapsed += edge.m / metersPerMinute;
    return { edge, floor: floors.get(edge.id), entry, exit: elapsed };
  });
}

export function routeAt(graph, sim, minute, origin, mode, raise = 0) {
  if (!Object.hasOwn(TRAVEL_METERS_PER_MIN, mode)) throw new RangeError('Unknown travel mode.');
  const discharge = sampleDischarge(sim.q, minute);
  const stage = Number.isInteger(minute) ? sim.stage[minute] : solveStage(discharge, sim.channel);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const nodesWet = new Map(graph.nodes.map(node => [node.id, featureDepth(stage, node.floor)]));
  const goals = graph.nodes.filter(node => node.type === 'shelter').map(node => node.id);
  const floors = new Map(graph.edges.map(edge => [edge.id, roadFloor(edge, nodes, raise)]));
  const limits = new Map(graph.edges.map(edge => [edge.id, normalDepthDischarge(floors.get(edge.id), sim.channel)]));
  const depths = new Map(graph.edges.map(edge => [
    edge.id, discharge > limits.get(edge.id) ? featureDepth(stage, floors.get(edge.id)) : 0,
  ]));
  const naive = shortestPath(graph, origin, goals);
  const dry = nodes.has(origin) && discharge <= normalDepthDischarge(nodes.get(origin).floor, sim.channel)
    ? shortestPath(graph, origin, goals, edge => discharge <= limits.get(edge.id)) : null;
  const naiveMax = naive ? Math.max(0, ...naive.edges.map(edge => depths.get(edge.id))) : null;
  const naiveWet = naive?.edges.filter(edge => discharge > limits.get(edge.id)) ?? [];
  const base = { stage, discharge, nodesWet, depths, naive, dry, naiveMax, naiveWet, floors };
  if (!dry) return { ...base, clearance: null, closes: null, departureCutoff: null, tripDry: false, travelMinutes: null };

  let closes = Infinity;
  let departureCutoff = Infinity;
  let tripDry = true;
  const end = sim.q.length - 1;
  const legs = intervals(dry, floors, TRAVEL_METERS_PER_MIN[mode]);
  for (const { floor, entry, exit } of legs) {
    // The displayed cutoff is for this route's current continuous dry window.
    const wet = roadSchedule(sim, floor, minute, end);
    if (wet !== null) {
      closes = Math.min(closes, wet);
      departureCutoff = Math.min(departureCutoff, wet - exit);
    }
    if (minute + entry <= end && roadSchedule(sim, floor, minute + entry, Math.min(end, minute + exit)) !== null) {
      tripDry = false;
    }
  }
  const minFloor = Math.min(dry.shelter.floor, ...dry.edges.map(edge => floors.get(edge.id)));
  return {
    ...base, clearance: Math.max(0, minFloor - stage),
    closes: Number.isFinite(closes) ? closes : null,
    departureCutoff: Number.isFinite(departureCutoff) ? departureCutoff : null,
    tripDry, travelMinutes: legs.at(-1)?.exit ?? 0,
  };
}

// Best cutoff across paths that open dry at minute zero, without waiting or reopening.
export function initialDepartureCutoff(graph, sim, origin, mode, raise = 0) {
  const speed = TRAVEL_METERS_PER_MIN[mode];
  if (!Object.hasOwn(TRAVEL_METERS_PER_MIN, mode)) throw new RangeError('Unknown travel mode.');
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const closes = new Map(graph.edges.map(edge => [
    edge.id, roadSchedule(sim, roadFloor(edge, nodes, raise), 0, sim.q.length - 1) ?? Infinity,
  ]));
  const latest = new Map(graph.nodes.filter(node => node.type === 'shelter').map(node => [node.id, Infinity]));
  const unsettled = new Set(nodes.keys());
  while (unsettled.size) {
    let next = null;
    let deadline = -Infinity;
    for (const id of unsettled) {
      if ((latest.get(id) ?? -Infinity) > deadline) {
        next = id;
        deadline = latest.get(id);
      }
    }
    if (next === null || next === origin) break;
    unsettled.delete(next);
    for (const edge of graph.edges) {
      const neighbor = edge.a === next ? edge.b : edge.b === next ? edge.a : null;
      if (!unsettled.has(neighbor)) continue;
      const candidate = Math.min(deadline, closes.get(edge.id)) - edge.m / speed;
      if (candidate > (latest.get(neighbor) ?? -Infinity)) latest.set(neighbor, candidate);
    }
  }
  return latest.get(origin) ?? -Infinity;
}

export function compareMitigation(graph, base, changed, origin, mode, raise) {
  const before = initialDepartureCutoff(graph, base, origin, mode);
  const after = initialDepartureCutoff(graph, changed, origin, mode, raise);
  const time = value => value === Infinity ? Infinity : Math.max(0, value);
  const protectedSites = graph.nodes.filter(node => ['home', 'school'].includes(node.type) &&
    featureDepth(base.peakStage, node.floor) > 0 && featureDepth(changed.peakStage, node.floor) === 0);
  return {
    before, after, protectedSites, stageDrop: base.peakStage - changed.peakStage,
    extraMinutes: Number.isFinite(after) && Number.isFinite(before) ? time(after) - time(before) : null,
  };
}
