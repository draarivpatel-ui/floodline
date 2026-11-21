import { bounded, compositeCN, simulate } from './hydrology.js';
import { compareMitigation, routeAt } from './routing.js';

const nodeRows = [
  ['school', 'Cypress School', 'school', 175, 205, 4.15],
  ['homes', 'Willow Homes', 'home', 92, 305, 2.70],
  ['gardens', 'Terrace Homes', 'home', 615, 302, 3.00],
  ['westNorth', 'West Ridge', 'junction', 206, 104, 4.7],
  ['eastNorth', 'East Ridge', 'junction', 512, 92, 4.8],
  ['westLow', 'Low crossing west', 'junction', 329, 210, 3.85],
  ['eastLow', 'Low crossing east', 'junction', 524, 208, 3.80],
  ['southWest', 'Willow Junction', 'junction', 306, 311, 3.4],
  ['southEast', 'Market Junction', 'junction', 558, 320, 3.4],
  ['shelter', 'Ridge Shelter', 'shelter', 687, 141, 5.6],
  ['farShelter', 'Library Shelter', 'shelter', 746, 334, 5.5],
  ['northWest', 'Meadow Gate', 'junction', 90, 102, 4.3],
  ['northEast', 'Pine Corner', 'junction', 711, 75, 5.2],
];

const roadRows = [
  ['school-west', 'School Avenue', 'school', 'westLow', 3.6],
  ['underpass', 'Canal Underpass', 'westLow', 'eastLow', 1.30],
  ['east-ridge', 'Station Road', 'eastLow', 'shelter', 3.6],
  ['school-ridge', 'Cypress Rise', 'school', 'westNorth', 4.1],
  ['ridge-bridge', 'High Bridge', 'westNorth', 'eastNorth', 2.68, true],
  ['ridge-north', 'Ridge Avenue', 'eastNorth', 'shelter', 4.6],
  ['willow-west', 'Willow Lane', 'homes', 'southWest', 2.54],
  ['willow-school', 'School Walk', 'homes', 'school', 2.60],
  ['canal-south', 'Market Bridge', 'southWest', 'southEast', 2.17],
  ['market-east', 'Market Street', 'southEast', 'eastLow', 3.2],
  ['market-homes', 'Terrace Street', 'southEast', 'gardens', 2.95],
  ['homes-library', 'Library Lane', 'gardens', 'farShelter', 2.98],
  ['library-shelter', 'Library Avenue', 'farShelter', 'shelter', 3.8],
  ['west-low', 'Canal Drive', 'southWest', 'westLow', 3.14],
  ['meadow-ridge', 'Meadow Road', 'northWest', 'westNorth', 4.19],
  ['meadow-school', 'Meadow Avenue', 'school', 'northWest', 4.10],
  ['pine-ridge', 'Pine Road', 'eastNorth', 'northEast', 4.7],
  ['pine-shelter', 'Shelter Lane', 'northEast', 'shelter', 5.1],
];

const makeGraph = (relief, shear) => {
  const nodes = nodeRows.map(([id, label, type, x, y, floor]) => ({
    id, label, type, x: x + shear * (y - 200) / 200, y, floor: floor * relief,
  }));
  const map = new Map(nodes.map(node => [node.id, node]));
  const edges = roadRows.map(([id, label, a, b, floor, bridge = false]) => ({
    id, label, a, b, floor: floor * relief, bridge,
    m: 4 * Math.hypot(map.get(a).x - map.get(b).x, map.get(a).y - map.get(b).y),
  }));
  return { nodes, edges, shear };
};

const channel = (width, sideSlope, n, slope, bankfull) => ({ width, sideSlope, n, slope, bankfull });

export const PRESETS = [
  {
    id: 'bayou', label: 'Bayou School District', storm: 'Cloudburst', areaKm2: 4.4,
    cn: 83, blockage: 0.30, rain: [7, 15, 28, 37, 29, 18, 8, 4], peakLag: 26, endLag: 108,
    channel: channel(15, 2, 0.034, 0.0012, 2.06), graph: makeGraph(1, 0), demoMinute: 75,
  },
  {
    id: 'coastal', label: 'Coastal Delta Town', storm: 'Feeder band', areaKm2: 5.8,
    cn: 80, blockage: 0.24, rain: [5, 12, 20, 26, 22, 15, 12, 21, 18, 12, 6, 4],
    peakLag: 38, endLag: 135, channel: channel(23, 3, 0.030, 0.00062, 1.92),
    graph: makeGraph(0.85, 32), demoMinute: 101,
  },
  {
    id: 'urban', label: 'Impervious Urban Core', storm: 'Drain overwhelm', areaKm2: 2.7,
    cn: 94, blockage: 0.40, rain: [6, 25, 40, 26, 10, 4], peakLag: 17, endLag: 72,
    channel: channel(11, 0.75, 0.028, 0.002, 2.20), graph: makeGraph(1.09, -30), demoMinute: 54,
  },
];

export function buildScenario(preset, edits = {}, mitigations = {}) {
  const { rain = preset.rain, cn = preset.cn, impervious = null, blockage = preset.blockage } = edits;
  const { pavement = false, clear = false, bridge = false } = mitigations;
  const effectiveCN = impervious === null ? cn : compositeCN(cn, impervious);
  const input = { rain: [...rain], cn: effectiveCN, blockage, areaKm2: preset.areaKm2,
    peakLag: preset.peakLag, endLag: preset.endLag, channel: preset.channel };
  const patched = { ...input, cn: pavement ? Math.max(1, effectiveCN - 8) : effectiveCN,
    blockage: clear ? 0 : blockage };
  const baseline = simulate(input);
  const active = pavement || clear ? simulate(patched) : baseline;
  const raise = bridge ? 0.65 : 0;
  return { preset, input, patched, baseline, active, raise, mitigations: { pavement, clear, bridge } };
}

export function inspectScenario(model, minute, origin, mode) {
  bounded(minute, 0, 360, 'Workbench minute');
  return routeAt(model.preset.graph, model.active, minute, origin, mode, model.raise);
}

export function compareScenario(model, origin, mode) {
  return compareMitigation(model.preset.graph, model.baseline, model.active, origin, mode, model.raise);
}
