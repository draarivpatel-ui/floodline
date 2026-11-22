import { canonicalJSON, csvCell } from './exports.js';
import { sha256hex } from './sha256.js';

const BRIEF_NOTICE = 'Synthetic training exercise output for education only. It is not a forecast, warning, or evacuation order. Never enter floodwater and follow local emergency alerts.';
const BRIEF_DISCLOSURE = 'Storm tiers scale the invented training storm (not design-storm return periods). Intervention costs, household counts, and the 0.30 m vehicle impassability reference are disclosed planning-model constants, not measurements of a real place.';
const HASH_PREFIX = '#flood=';
const HASH_VERSION = 1;

// Canonical JSON carries only finite numbers; infinite cutoffs travel as tokens.
const num = v => Number.isFinite(v) ? v : v === Infinity ? 'never' : 'closed-at-start';

// Deterministic resilience brief payload over the comparator and cutoff matrix.
export function briefPayload({ model, tierLabel, scale, comparison, matrix, budgetM }) {
  return {
    version: HASH_VERSION,
    notice: BRIEF_NOTICE,
    disclosure: BRIEF_DISCLOSURE,
    preset: model.preset.id,
    stormTier: { label: tierLabel, scale },
    vehicleReferenceM: comparison.threshold,
    budgetCapM: budgetM,
    mitigations: model.mitigations,
    comparison: comparison.rows.map(row => ({
      intervention: row.intervention?.id ?? 'baseline',
      label: row.intervention?.label ?? 'Baseline, no intervention',
      costM: row.costM,
      peakStageM: row.sim.peakStage,
      stageDropM: row.stageDrop,
      passableKm: row.passableKm,
      passableDeltaKm: row.passableDelta,
      strandedZones: [...row.stranded],
      strandedCount: row.strandedCount,
      strandedReduction: row.strandedReduction,
      householdsAvoided: row.householdsAvoided,
      avoidedPerM: row.perMillion,
      earliestCutoffMin: num(row.earliest),
      cutoffExtensionMin: row.extension === null ? 'not-comparable' : row.extension,
      cutoffs: Object.fromEntries([...row.cutoffs].map(([k, v]) => [k, num(v)])),
    })),
    cutoffTimeline: matrix.rows.map(row => ({
      origin: row.origin,
      label: row.label,
      households: row.households,
      firstCutMin: row.firstCut,
      lastSafeMin: row.lastSafe,
      reopened: row.reopened,
      hourly: row.hourly,
    })),
  };
}

export function signBrief(payload) {
  return { algorithm: 'SHA-256', sha256: sha256hex(canonicalJSON(payload)), payload };
}

export function briefDocument(payload) {
  return canonicalJSON(signBrief(payload));
}

// Recompute the digest of a parsed brief document; any payload change fails it.
export function verifyBriefDocument(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (!doc || typeof doc !== 'object' || doc.algorithm !== 'SHA-256' ||
      typeof doc.sha256 !== 'string' || !doc.payload || typeof doc.payload !== 'object') {
    return { ok: false, reason: 'not a FloodLine brief document' };
  }
  let digest;
  try {
    digest = sha256hex(canonicalJSON(doc.payload));
  } catch {
    return { ok: false, reason: 'payload cannot be canonically serialized' };
  }
  return digest === doc.sha256
    ? { ok: true, sha256: digest }
    : { ok: false, reason: 'payload digest does not match the signature' };
}

export function briefCSV(comparison, tierLabel) {
  const header = [
    'storm_tier', 'intervention', 'label', 'cost_usd_millions', 'peak_stage_m',
    'stage_drop_m', 'passable_km_at_peak', 'passable_delta_km', 'stranded_count',
    'stranded_reduction', 'households_avoided', 'avoided_per_million_usd',
    'earliest_cutoff_min', 'cutoff_extension_min', 'notice',
  ];
  const rows = [header.map(csvCell).join(',')];
  for (const row of comparison.rows) {
    rows.push([
      tierLabel,
      row.intervention?.id ?? 'baseline',
      row.intervention?.label ?? 'Baseline, no intervention',
      row.costM, row.sim.peakStage, row.stageDrop, row.passableKm, row.passableDelta,
      row.strandedCount, row.strandedReduction, row.householdsAvoided,
      row.perMillion ?? '', num(row.earliest), row.extension ?? 'not-comparable', BRIEF_NOTICE,
    ].map(csvCell).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

const fmtMin = v => v === 'never' || v === Infinity ? 'never closes'
  : v === 'closed-at-start' || v === -Infinity ? 'closed at start' : `${v.toFixed(1)}`;
const fmtNum = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : 'n/a';

export function briefMarkdown(payload) {
  const { sha256 } = signBrief(payload);
  const lines = [
    '# FloodLine resilience brief',
    '',
    `Basin ${payload.preset}, storm tier ${payload.stormTier.label} (rain scale x${payload.stormTier.scale}), budget cap $${payload.budgetCapM}M.`,
    '',
    '| Intervention | Cost $M | Peak stage m | Depth drop m | Passable km | Stranded zones | Cutoff min |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of payload.comparison) {
    lines.push(`| ${row.label} | ${fmtNum(row.costM, 1)} | ${fmtNum(row.peakStageM)} | ${fmtNum(row.stageDropM)} | ${fmtNum(row.passableKm)} | ${row.strandedCount} | ${fmtMin(row.earliestCutoffMin)} |`);
  }
  lines.push('', 'Departure cutoffs by zone:');
  for (const row of payload.cutoffTimeline) {
    const first = row.firstCut === null ? 'never cut' : `minute ${row.firstCut}`;
    const last = row.lastSafe === null ? 'no safe minute' : `minute ${row.lastSafe}`;
    lines.push(`- ${row.label}: first failed departure ${first}, last safe departure ${last}${row.reopened ? ', reopens later' : ''}.`);
  }
  lines.push('', payload.disclosure, '', `SHA-256 ${sha256}`, '', payload.notice, '');
  return lines.join('\n');
}

// URL-hash bookmarking: the whole scenario state rides in the fragment so a
// shared link replays it. Canonical JSON inside base64url keeps it stable.
function bytesToBase64Url(bytes) {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(text) {
  const bin = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(bin, ch => ch.charCodeAt(0));
}

export function encodeScenarioHash(state) {
  const clean = {
    v: HASH_VERSION,
    preset: state.preset,
    origin: state.origin,
    mode: state.mode,
    minute: Math.round(state.minute),
    mitigations: {
      pavement: Boolean(state.mitigations?.pavement),
      clear: Boolean(state.mitigations?.clear),
      bridge: Boolean(state.mitigations?.bridge),
    },
    tier: state.tier,
    intensity: state.intensity ?? null,
    budgetM: state.budgetM,
    edits: state.edits === null || state.edits === undefined ? null : {
      rain: [...state.edits.rain],
      cn: state.edits.cn,
      impervious: state.edits.impervious,
      blockage: state.edits.blockage,
    },
  };
  const text = canonicalJSON(clean);
  return HASH_PREFIX + bytesToBase64Url(new TextEncoder().encode(text));
}

const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

// Strict decode: any malformed field returns null so a hand-edited link can
// never wedge the workbench. Returns a normalized state, never raw input.
export function decodeScenarioHash(hash, presets) {
  if (typeof hash !== 'string' || !hash.startsWith(HASH_PREFIX)) return null;
  const encoded = hash.slice(HASH_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let state;
  try {
    state = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch {
    return null;
  }
  if (!state || typeof state !== 'object' || state.v !== HASH_VERSION) return null;
  if (!presets.some(p => p.id === state.preset)) return null;
  if (!['car', 'pedestrian'].includes(state.mode)) return null;
  if (!Number.isInteger(state.minute) || state.minute < 0 || state.minute > 360) return null;
  if (typeof state.origin !== 'string' || state.origin.length > 64) return null;
  if (state.tier !== 'custom' && !['t10', 't50', 't100', 't500'].includes(state.tier)) return null;
  if (state.intensity !== null && !inRange(state.intensity, 0.4, 2.2)) return null;
  if (!inRange(state.budgetM, 0, 9)) return null;
  const mit = state.mitigations ?? {};
  const mitigations = {
    pavement: mit.pavement === true, clear: mit.clear === true, bridge: mit.bridge === true,
  };
  let edits = null;
  if (state.edits !== null) {
    const e = state.edits;
    if (!e || typeof e !== 'object' || !Array.isArray(e.rain) ||
        e.rain.length === 0 || e.rain.length > 24 ||
        !e.rain.every(mm => inRange(mm, 0, 5000))) return null;
    if (!inRange(e.cn, 1, 100)) return null;
    if (e.impervious !== null && !inRange(e.impervious, 0, 100)) return null;
    if (!inRange(e.blockage, 0, 1)) return null;
    edits = { rain: [...e.rain], cn: e.cn, impervious: e.impervious, blockage: e.blockage };
  }
  return {
    preset: state.preset, origin: state.origin, mode: state.mode, minute: state.minute,
    mitigations, tier: state.tier, intensity: state.intensity, budgetM: state.budgetM, edits,
  };
}
