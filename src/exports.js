import { DEPTH_REFERENCES, routeAt } from './routing.js';

const GEOJSON_NOTICE = 'Fictional training geometry. Never navigate with this file.';
const CSV_NOTICE = 'Synthetic training data. Never use for navigation.';
const AUDIT_NOTICE = 'Synthetic training exercise output for education only. It is not a forecast, warning, or evacuation order. Never enter floodwater and follow local emergency alerts.';
const METERS_PER_DEGREE = 111195;
// BOM is a Cf too; the class also covers zero-width spaces, bidi marks and tag chars.
const FORMULA_GUARD = /^(?:[\t\r\n]|[\s\p{Cf}]*[=+@-])/u;

export function csvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('CSV numbers must be finite.');
    return String(value);
  }
  const text = String(value);
  const protectedText = FORMULA_GUARD.test(text.normalize('NFKC')) ? "'" + text : text;
  return '"' + protectedText.replaceAll('"', '""') + '"';
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

// One row per simulated minute including the full discharge tail beyond the workbench horizon.
// Route columns are evaluated at each row's own minute; the workbench selection is flagged separately.
export function telemetryCSV(model, minute, origin, mode, view) {
  const sim = model.active;
  if (!Number.isInteger(minute) || minute < 0 || minute >= sim.q.length) {
    throw new RangeError('Export minute is outside the simulated run.');
  }
  const rainAt = new Map(sim.bins.map(bin => [bin.minute, bin.mm]));
  const header = [
    'minute', 'rainfall_mm', 'discharge_m3_s', 'stage_m', 'overbank_m',
    'selected_origin', 'travel_mode', 'selected_route_m', 'selected_naive_wet_m',
    'trip_dry', 'departure_cutoff_min', 'selected_snapshot', 'notice',
  ];
  const rows = [csvRow(header)];
  for (let i = 0; i < sim.q.length; i += 1) {
    const rowView = i === minute ? view : routeAt(model.preset.graph, sim, i, origin, mode, model.raise);
    rows.push(csvRow([
      i,
      rainAt.get(i) ?? 0,
      sim.q[i],
      sim.stage[i],
      Math.max(0, sim.stage[i] - sim.channel.bankfull),
      origin,
      mode,
      rowView.dry?.distance ?? null,
      rowView.naiveMax ?? null,
      rowView.dry ? (rowView.tripDry === true ? 'yes' : rowView.tripDry === false ? 'no' : 'unverified') : 'unreachable',
      rowView.departureCutoff,
      i === minute ? 'yes' : 'no',
      CSV_NOTICE,
    ]));
  }
  return rows.join('\r\n') + '\r\n';
}

function point(node) {
  return [node.x * 4 / METERS_PER_DEGREE, -node.y * 4 / METERS_PER_DEGREE];
}

// Display-only coordinates anchored near Null Island; the basin and its places are fictional.
export function routeGeoJSON(model, minute, view) {
  const graph = model.preset.graph;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const features = [];
  for (const edge of graph.edges) {
    const depth = view.depths.get(edge.id) ?? 0;
    if (depth <= 0) continue;
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [point(nodes.get(edge.a)), point(nodes.get(edge.b))],
      },
      properties: { kind: 'road', id: edge.id, label: edge.label, depthM: depth },
    });
  }
  if (view.dry && view.dry.nodes.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: view.dry.nodes.map(id => point(nodes.get(id))),
      },
      properties: {
        kind: 'dry_snapshot',
        shelter: view.dry.shelter.id,
        tripDry: view.tripDry,
        distanceM: view.dry.distance,
      },
    });
  }
  return {
    type: 'FeatureCollection',
    synthetic_coordinates: true,
    storm_minute: minute,
    notice: GEOJSON_NOTICE,
    features,
  };
}

// Deterministic serialization: object keys sorted recursively, array order preserved.
export function canonicalJSON(value) {
  return encodeCanonical(value, new Set());
}

function encodeCanonical(value, seen) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON only supports finite numbers.');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Canonical JSON cannot serialize circular structures.');
    seen.add(value);
    try {
      return '[' + Array.from(value, item => encodeCanonical(item, seen)).join(',') + ']';
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('Canonical JSON cannot serialize circular structures.');
    seen.add(value);
    try {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('Canonical JSON only supports plain objects.');
      }
      const keys = Object.keys(value).sort();
      const parts = [];
      for (const key of keys) {
        const item = value[key];
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
          throw new TypeError(`Canonical JSON cannot serialize key "${key}".`);
        }
        parts.push(JSON.stringify(key) + ':' + encodeCanonical(item, seen));
      }
      return '{' + parts.join(',') + '}';
    } finally {
      seen.delete(value);
    }
  }
  throw new TypeError('Canonical JSON only supports standard JSON primitives.');
}

function routeSummary(path) {
  if (!path) return null;
  return {
    nodes: [...path.nodes],
    edges: path.edges.map(edge => edge.id),
    distanceM: path.distance,
    shelter: path.shelter.id,
  };
}

// A self-contained, deterministic record of the synthetic run for classroom audit.
export async function auditBundle(model, minute, origin, mode, view) {
  const sim = model.active;
  const payload = {
    version: 1,
    notice: AUDIT_NOTICE,
    preset: model.preset.id,
    inputs: { raw: model.input, run: model.patched },
    mitigations: model.mitigations,
    raiseM: model.raise,
    selection: { origin, mode, minute },
    graph: model.preset.graph,
    thresholdReferencesM: DEPTH_REFERENCES,
    hydrograph: {
      dischargeM3S: Array.from(sim.q),
      stageM: Array.from(sim.stage),
    },
    budget: {
      bins: sim.bins.map(bin => ({
        minute: bin.minute,
        rainfallMm: bin.mm,
        runoffIncrementMm: bin.runoffIncrement,
        cumulativeRainMm: bin.rain,
        abstractionMm: bin.abstraction,
        storageMm: bin.storage,
        runoffMm: bin.runoff,
        residualMm: bin.residual,
      })),
      bankfullM: sim.channel.bankfull,
      bankfullM3S: sim.bankfullQ,
      firstOverbankMin: sim.firstOverbank,
      peak: { minute: sim.peakMinute, dischargeM3S: sim.peakQ, stageM: sim.peakStage },
      runoffVolumeM3: sim.volume,
      dischargedVolumeM3: sim.discharged,
      volumeResidualM3: sim.residual,
      maxRainResidualMm: sim.maxRainResidual,
    },
    route: {
      naive: routeSummary(view.naive),
      dry: routeSummary(view.dry),
      tripDry: view.tripDry,
      travelMinutes: view.travelMinutes,
      clearanceM: view.clearance,
      closesMin: view.closes,
      departureCutoffMin: view.departureCutoff,
      naiveMaxM: view.naiveMax,
      naiveWetEdges: view.naiveWet.map(edge => edge.id),
    },
    geojson: routeGeoJSON(model, minute, view),
  };
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(canonicalJSON(payload)),
  );
  const sha256 = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
  return { algorithm: 'SHA-256', sha256, payload };
}
