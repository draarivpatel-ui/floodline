import { bounded, parseRain, simulate } from './hydrology.js';
import { DEPTH_REFERENCES, isAboveReference } from './routing.js';
import { PRESETS, buildScenario, compareScenario, inspectScenario } from './presets.js';
import { auditBundle, canonicalJSON, routeGeoJSON, telemetryCSV } from './exports.js';
import { cardModel, renderCard } from './card.js';
import { shortcutAction } from './controls.js';
import { renderCutoffChart, renderHydrograph, renderMap } from './viz.js';
import { IMPASSABLE_M, STORM_TIERS, bestInBudget, compareTier, tieredInput } from './mitigation.js';
import { cutoffMatrix } from './timeline.js';
import { buddyDialogText, buddyModel, buddyText, renderBuddy, suggestBuddies } from './buddy.js';
import {
  briefCSV, briefDocument, briefMarkdown, briefPayload, decodeScenarioHash,
  encodeScenarioHash, verifyBriefDocument,
} from './brief.js';
import { runSelfTests } from './selftest.js';

const $ = id => document.getElementById(id);

const els = {
  preset: $('preset'), origin: $('origin'), mode: $('mode'),
  minute: $('minute'), minuteReadout: $('minute-readout'),
  play: $('play'), prev: $('prev'), next: $('next'), peak: $('peak'),
  goCard: $('go-card'), dialog: $('card-dialog'), cardLang: $('card-language'),
  cardPaper: $('card-paper'), cardPrint: $('card-print'), cardClose: $('card-close'),
  stageNow: $('stage-now'), routeStatus: $('route-status'),
  map: $('map'), hydro: $('hydrograph'), hydroStats: $('hydro-stats'), metrics: $('metrics'),
  form: $('edit-form'), rain: $('custom-rain'), cn: $('cn'), impervious: $('impervious'),
  blockage: $('blockage'), editError: $('edit-error'),
  pavement: $('pavement'), clear: $('clear'), bridge: $('bridge'),
  shortcuts: $('shortcuts'), settings: $('settings'), downloadJump: $('download-jump'),
  exportCsv: $('export-csv'), exportGeo: $('export-geojson'), exportJson: $('export-json'),
  exportError: $('export-error'),
  tierRow: $('tier-row'), intensity: $('intensity'), intensityReadout: $('intensity-readout'),
  budget: $('budget'), budgetReadout: $('budget-readout'),
  compareTable: $('compare-table'), compareNote: $('compare-note'),
  cutoffSvg: $('cutoff-chart'), alertMatrix: $('alert-matrix'), cutoffNote: $('cutoff-note'),
  buddyNote: $('buddy-note'), buddyTable: $('buddy-table'), buddyOpen: $('buddy-open'),
  buddyDialog: $('buddy-dialog'), buddyLang: $('buddy-language'), buddyPaper: $('buddy-paper'),
  buddyText: $('buddy-text'), buddyCopy: $('buddy-copy'), buddyPrint: $('buddy-print'),
  buddyClose: $('buddy-close'),
  buddyTitle: $('buddy-dialog-title'), buddyLanguageLabel: $('buddy-language-label'),
  buddySummary: $('buddy-text-summary'),
  briefJson: $('export-brief-json'), briefCsv: $('export-brief-csv'), briefMd: $('export-brief-md'),
  bookmark: $('bookmark'), bookmarkUrl: $('bookmark-url'),
  verifyInput: $('verify-input'), verifyBtn: $('verify-btn'), verifyResult: $('verify-result'),
  selftest: $('selftest'), selftestList: $('selftest-list'),
};

const MODE_LABEL = { car: 'by car', pedestrian: 'on foot' };
const REF_LABEL = { car: 'car', pedestrian: 'walking' };

const state = {
  preset: PRESETS.find(p => p.id === 'bayou') ?? PRESETS[0],
  edits: null,
  mitigations: { pavement: false, clear: false, bridge: false },
  origin: 'school',
  mode: 'car',
  minute: 75,
  model: null,
  view: null,
  compare: null,
  playing: false,
  timer: null,
  tier: 't50',
  intensity: null,
  budgetM: 9,
  tierSpec: null,
  comparison: null,
  matrix: null,
  cutoffRun: null,
  buddies: {},
};

function addEl(parent, tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  parent.appendChild(el);
  return el;
}

function addRow(dl, term, def) {
  const row = addEl(dl, 'div', 'data-row');
  addEl(row, 'dt', null, term);
  addEl(row, 'dd', null, def);
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function populatePresets() {
  els.preset.textContent = '';
  for (const preset of PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    option.title = preset.storm;
    els.preset.appendChild(option);
  }
}

function populateOrigins() {
  els.origin.textContent = '';
  for (const node of state.preset.graph.nodes) {
    if (node.type !== 'home' && node.type !== 'school') continue;
    const option = document.createElement('option');
    option.value = node.id;
    option.textContent = node.label;
    els.origin.appendChild(option);
  }
}

function syncFormToPreset() {
  const preset = state.preset;
  els.rain.value = preset.rain.join(' ');
  els.cn.value = String(preset.cn);
  els.impervious.value = '';
  els.blockage.value = String(preset.blockage);
  els.editError.hidden = true;
}

function readEdits() {
  const rain = parseRain(els.rain.value);
  const imperviousText = els.impervious.value.trim();
  const impervious = imperviousText === '' ? null : Number(imperviousText);
  const cn = bounded(Number(els.cn.value), 1, impervious === null ? 100 : 98, 'Curve number');
  if (impervious !== null) bounded(impervious, 0, 100, 'Impervious cover');
  const rawBlockage = els.blockage.value.trim();
  if (!rawBlockage) throw new RangeError('Enter blockage between 0 and 1.');
  const blockage = bounded(Number(rawBlockage), 0, 1, 'Blockage');
  return { rain, cn, impervious, blockage };
}

// Expensive step: rerun the storm model only when inputs, preset, or mitigations change.
function computeModel(model = buildScenario(state.preset, state.edits ?? {}, state.mitigations)) {
  state.model = model;
  state.compare = compareScenario(state.model, state.origin, state.mode);
  renderMetrics();
  renderHydroStats();
  renderMinute();
  computeAnalysis();
}

// Cheap step: repaint everything that depends on the scrubbed minute.
function renderMinute() {
  state.view = inspectScenario(state.model, state.minute, state.origin, state.mode);
  els.minute.value = String(state.minute);
  els.minuteReadout.textContent = `${Math.round(state.minute)} / 360`;
  els.minute.setAttribute('aria-valuetext', `${Math.round(state.minute)} minutes from storm start`);
  renderMap(els.map, state.model, state.view, state.origin, state.minute);
  renderHydrograph(els.hydro, state.model, state.minute);
  if (state.matrix) renderCutoffChart(els.cutoffSvg, state.matrix, state.minute, state.origin);
  renderStageNow();
  renderRouteStatus();
}

function setMinute(value) {
  state.minute = Math.min(360, Math.max(0, Math.round(value)));
  renderMinute();
}

function renderStageNow() {
  const { view, minute } = state;
  const bankfull = state.model.active.channel.bankfull;
  const over = Math.max(0, view.stage - bankfull);
  els.stageNow.textContent =
    `Storm minute ${Math.round(minute)}   stage ${view.stage.toFixed(2)} m` +
    `${over > 0 ? ` (${over.toFixed(2)} m over bankfull)` : ''}` +
    `   discharge ${view.discharge.toFixed(2)} m³/s`;
}

function renderRouteStatus() {
  const { view, mode, minute } = state;
  const root = els.routeStatus;
  root.textContent = '';

  const stateP = addEl(root, 'p', 'state');
  if (!view.dry) {
    stateP.classList.add('bad');
    stateP.textContent = 'Unreachable at this minute';
  } else if (view.tripDry === true) {
    stateP.classList.add('ok');
    stateP.textContent = 'Verified dry modeled trip';
  } else if (view.tripDry === false) {
    stateP.classList.add('warn');
    stateP.textContent = 'Dry at this snapshot, floods during travel';
  } else {
    stateP.classList.add('warn');
    stateP.textContent = 'Dry at this snapshot, trip outlasts the modeled run';
  }

  const dl = addEl(root, 'dl');
  addRow(dl, 'Route clearance',
    view.clearance === null ? 'none' : `${(view.clearance * 100).toFixed(0)} cm`);
  if (view.naiveMax === null) {
    addRow(dl, 'Worst shortcut depth', 'no computed shortcut');
  } else {
    const cm = (view.naiveMax * 100).toFixed(0);
    const refCm = DEPTH_REFERENCES[mode] * 100;
    const mark = isAboveReference(view.naiveMax, mode)
      ? `at or above the ${refCm} cm ${REF_LABEL[mode]} reference`
      : `below the ${refCm} cm ${REF_LABEL[mode]} reference`;
    addRow(dl, 'Worst shortcut depth', `${cm} cm, ${mark}`);
  }
  addRow(dl, 'Trip', view.dry
    ? `${Math.round(view.dry.distance)} m, ${view.travelMinutes.toFixed(1)} min ${MODE_LABEL[mode]}`
    : 'none');
  addRow(dl, 'Modeled closure', !view.dry
    ? 'no dry route at this minute'
    : view.closes === null
      ? 'no modeled closure from this minute'
      : `route floods at storm minute ${view.closes.toFixed(1)}`);
  if (!view.dry) {
    addRow(dl, 'Leave by', 'not available');
  } else if (view.departureCutoff === null) {
    addRow(dl, 'Leave by', 'no cutoff needed from this minute');
  } else if (view.departureCutoff >= minute) {
    addRow(dl, 'Leave by',
      `storm minute ${view.departureCutoff.toFixed(1)} (${(view.departureCutoff - minute).toFixed(1)} min from now)`);
  } else {
    addRow(dl, 'Leave by', 'current continuous window already missed');
  }

  if ((view.nodesWet.get(state.origin) ?? 0) > 0) {
    addEl(root, 'p', 'note', 'The start point is inundated in this exercise. Do not enter floodwater. Follow official emergency instructions.');
  } else if (!view.dry) {
    addEl(root, 'p', 'note', 'No dry exit in this exercise. Do not enter floodwater.');
  }
}

function renderMetrics() {
  const sim = state.model.active;
  const cmp = state.compare;
  const totals = sim.bins.at(-1);
  const dl = els.metrics;
  dl.textContent = '';
  addRow(dl, 'Peak discharge', `${sim.peakQ.toFixed(2)} m³/s at storm minute ${sim.peakMinute}`);
  addRow(dl, 'Peak stage', `${sim.peakStage.toFixed(2)} m`);
  addRow(dl, 'First overbank', sim.firstOverbank === null
    ? 'not reached this run' : `storm minute ${sim.firstOverbank.toFixed(1)}`);
  addRow(dl, 'Rain total', `${totals.rain.toFixed(1)} mm in ${sim.bins.length} bins`);
  addRow(dl, 'Runoff', `${totals.runoff.toFixed(1)} mm`);
  addRow(dl, 'Abstractions', `${totals.abstraction.toFixed(1)} mm`);
  addRow(dl, 'Storage held', `${totals.storage.toFixed(1)} mm`);
  addRow(dl, 'Volume check',
    `${sim.discharged.toFixed(1)} of ${sim.volume.toFixed(1)} m³, residual ${sim.residual.toPrecision(2)} m³`);
  addRow(dl, 'Stage drop', cmp.stageDrop > 0 ? `${(cmp.stageDrop * 100).toFixed(1)} cm lower` : 'no change');
  const cutoff = v => v === Infinity ? 'never closes'
    : v === -Infinity ? 'no dry opening'
    : v < 0 ? 'closed before minute 0'
    : `${v.toFixed(1)} min`;
  addRow(dl, 'Departure window', `${cutoff(cmp.before)} becomes ${cutoff(cmp.after)}`);
  addRow(dl, 'Extra window', cmp.extraMinutes === null
    ? (cmp.after === Infinity ? 'route never closes during the run' : 'not available')
    : `+${cmp.extraMinutes.toFixed(1)} min`);
  addRow(dl, 'Protected sites', cmp.protectedSites.length === 0
    ? 'none'
    : `${cmp.protectedSites.length}: ${cmp.protectedSites.map(n => n.label).join(', ')}`);
}

function renderHydroStats() {
  const sim = state.model.active;
  const mitigated = state.model.baseline !== state.model.active;
  els.hydroStats.textContent =
    `Discharge peaks ${sim.peakQ.toFixed(2)} m³/s at storm minute ${sim.peakMinute}; ` +
    `bankfull ${sim.bankfullQ.toFixed(2)} m³/s at ${sim.channel.bankfull.toFixed(2)} m stage.` +
    (mitigated ? ' The dashed gray trace is the run before mitigation.' : '');
}

// The comparator and cutoff workbench below are heavier than the map repaint,
// so they run on scenario or tier changes, never on minute scrubs.
function originNodes() {
  return state.preset.graph.nodes
    .filter(node => ['home', 'school'].includes(node.type))
    .map(node => node.id);
}

function labelOf(id) {
  return state.preset.graph.nodes.find(node => node.id === id)?.label ?? id;
}

function currentTierSpec() {
  if (state.intensity !== null) {
    return { id: 'custom', label: `custom x${state.intensity.toFixed(2)}`, scale: state.intensity };
  }
  return STORM_TIERS.find(tier => tier.id === state.tier) ?? STORM_TIERS[1];
}

function computeAnalysis() {
  state.tierSpec = currentTierSpec();
  const origins = originNodes();
  state.comparison = compareTier(state.model, state.tierSpec.scale, origins, 'car');
  // Keep the tier metadata with the scaled, actively mitigated simulation.
  state.cutoffRun = {
    tier: { ...state.tierSpec },
    sim: simulate(tieredInput(state.model.patched, state.tierSpec.scale)),
  };
  computeCutoffMatrix();
  syncBuddies();
  renderComparator();
  renderCutoff();
  renderBuddyPanel();
}

function computeCutoffMatrix() {
  state.matrix = cutoffMatrix(state.preset.graph, state.cutoffRun.sim, originNodes(), state.mode,
    { raise: state.model.raise });
  state.matrix.tier = state.cutoffRun.tier;
}

// Assignments persist across re-solves; only a missing or stale zone id gets
// a fresh nearest-neighbor suggestion.
function syncBuddies() {
  const origins = originNodes();
  const suggested = suggestBuddies(state.preset.graph, origins);
  for (const id of origins) {
    if (state.buddies[id] === id || !origins.includes(state.buddies[id])) {
      state.buddies[id] = suggested.get(id) ?? null;
    }
  }
}

function renderBuddyPanel() {
  if (!state.matrix) return;
  const modeLabel = MODE_LABEL[state.mode];
  const tier = state.matrix.tier;
  els.buddyNote.textContent =
    `Under the ${tier.label} tier (rain scale x${tier.scale}), ` +
    `${modeLabel} travel: each zone is paired with one buddy zone. Its first cut and ` +
    `last safe minutes above set the check-in deadline on the buddy card.`;
  const table = els.buddyTable;
  table.textContent = '';
  const head = addEl(addEl(table, 'thead'), 'tr');
  for (const h of ['Zone', 'Households', 'First cut', 'Last safe', 'Buddy zone']) {
    const th = addEl(head, 'th', null, h);
    th.scope = 'col';
  }
  const body = addEl(table, 'tbody');
  const origins = originNodes();
  for (const row of state.matrix.rows) {
    const tr = addEl(body, 'tr');
    addEl(tr, 'td', null, row.label);
    addEl(tr, 'td', null, String(row.households));
    addEl(tr, 'td', null, row.firstCut === null ? 'never' : `min ${row.firstCut}`);
    addEl(tr, 'td', null, row.lastSafe === null ? 'none' : `min ${row.lastSafe}`);
    const cell = addEl(tr, 'td');
    const select = addEl(cell, 'select');
    select.setAttribute('aria-label', `Buddy zone for ${row.label}`);
    for (const other of origins) {
      if (other === row.origin) continue;
      const option = addEl(select, 'option', null, labelOf(other));
      option.value = other;
    }
    select.value = state.buddies[row.origin] ?? '';
    select.addEventListener('change', () => {
      state.buddies[row.origin] = select.value;
    });
  }
  if (els.buddyDialog.open) renderBuddyCard();
}

const fmtCut = v => v === Infinity ? 'never' : v === -Infinity ? 'closed' : v.toFixed(1);

function renderTierButtons() {
  els.tierRow.textContent = '';
  for (const tier of STORM_TIERS) {
    const btn = addEl(els.tierRow, 'button', 'btn small', tier.label);
    btn.type = 'button';
    btn.dataset.tier = tier.id;
    btn.setAttribute('aria-pressed', String(state.intensity === null && state.tier === tier.id));
    btn.addEventListener('click', () => {
      state.tier = tier.id;
      state.intensity = null;
      syncTierUi();
      computeAnalysis();
    });
  }
  const custom = addEl(els.tierRow, 'button', 'btn small', 'Custom');
  custom.type = 'button';
  custom.setAttribute('aria-pressed', String(state.intensity !== null));
  custom.addEventListener('click', () => {
    state.intensity = Number(els.intensity.value) / 100;
    syncTierUi();
    computeAnalysis();
  });
}

function syncTierUi() {
  for (const btn of els.tierRow.querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', btn.dataset.tier
      ? String(state.intensity === null && btn.dataset.tier === state.tier)
      : String(state.intensity !== null));
  }
  const shown = state.intensity ?? Number(els.intensity.value) / 100;
  els.intensityReadout.textContent = `x${shown.toFixed(2)}`;
  els.budget.value = String(Math.round(state.budgetM * 10));
  els.budgetReadout.textContent = `$${state.budgetM.toFixed(1)}M`;
}

function renderComparator() {
  const cmp = state.comparison;
  if (!cmp) return;
  const table = els.compareTable;
  table.textContent = '';
  const head = addEl(addEl(table, 'thead'), 'tr');
  for (const h of ['Intervention', 'Cost', 'Peak stage', 'Depth drop', 'Passable km',
    'Stranded zones', 'Cutoff', 'Avoided/$1M']) {
    const th = addEl(head, 'th', null, h);
    th.scope = 'col';
  }
  const body = addEl(table, 'tbody');
  const best = bestInBudget(cmp, state.budgetM);
  for (const row of cmp.rows) {
    const tr = addEl(body, 'tr');
    if (row.intervention && row.costM > state.budgetM) tr.className = 'dim';
    if (row === best) tr.classList.add('best');
    const name = addEl(tr, 'td', null, row.intervention?.label ?? 'Baseline, no intervention');
    if (row === best) addEl(name, 'span', 'tag', 'best in budget');
    addEl(tr, 'td', null, row.costM === 0 ? 'none' : `$${row.costM.toFixed(1)}M`);
    addEl(tr, 'td', null, `${row.sim.peakStage.toFixed(2)} m`);
    addEl(tr, 'td', null, row.intervention ? `${(row.stageDrop * 100).toFixed(0)} cm` : '-');
    addEl(tr, 'td', null, row.intervention
      ? `${row.passableKm.toFixed(2)} (+${row.passableDelta.toFixed(2)})`
      : row.passableKm.toFixed(2));
    const zones = row.strandedCount === 0 ? 'none'
      : `${row.strandedCount}: ${row.stranded.map(labelOf).join(', ')}`;
    addEl(tr, 'td', null, row.intervention
      ? `${zones} (-${row.strandedReduction})` : zones);
    addEl(tr, 'td', null, fmtCut(row.earliest));
    addEl(tr, 'td', null, row.perMillion === null ? '-' : row.perMillion.toFixed(1));
  }
  const totalKm = (state.preset.graph.edges.reduce((sum, edge) => sum + edge.m, 0) / 1000).toFixed(2);
  els.compareNote.textContent =
    `${state.tierSpec.label} tier (rain scale x${state.tierSpec.scale}) measured at each run's own ` +
    `peak minute under the ${IMPASSABLE_M.toFixed(2)} m vehicle impassability reference: baseline ` +
    `keeps ${cmp.base.passableKm.toFixed(2)} of ${totalKm} km of road passable and strands ` +
    `${cmp.base.strandedCount} of ${cmp.origins.length} zones. Severity tiers scale the invented ` +
    `storm, not design return periods; costs, household counts, and unit rates are disclosed ` +
    `planning-model constants, never measurements of a real place.`;
}

function renderCutoff() {
  if (!state.matrix) return;
  renderCutoffChart(els.cutoffSvg, state.matrix, state.minute, state.origin);
  const table = els.alertMatrix;
  table.textContent = '';
  const head = addEl(addEl(table, 'thead'), 'tr');
  for (const h of ['Zone', '0h', '1h', '2h', '3h', '4h', '5h', '6h', 'First cut', 'Last safe']) {
    const th = addEl(head, 'th', null, h);
    th.scope = 'col';
  }
  const body = addEl(table, 'tbody');
  for (const row of state.matrix.rows) {
    const tr = addEl(body, 'tr');
    addEl(tr, 'td', null, row.label);
    for (const cell of row.hourly) {
      addEl(tr, 'td', cell === null ? '' : cell ? 'ok' : 'cut', cell === null ? '-' : cell ? 'dry' : 'cut');
    }
    addEl(tr, 'td', null, row.firstCut === null ? 'never' : `min ${row.firstCut}`);
    addEl(tr, 'td', null, row.lastSafe === null ? 'none' : `min ${row.lastSafe}`);
  }
  const alerts = state.matrix.rows
    .filter(row => row.firstCut !== null)
    .map(row => `${row.label} at minute ${row.firstCut}`);
  els.cutoffNote.textContent =
    `${state.matrix.tier.label} tier (rain scale x${state.matrix.tier.scale}): each strip answers ` +
    `whether a ${state.mode === 'car' ? 'car' : 'person on foot'} leaving ` +
    `that zone at a storm minute can still reach a shelter on roads that stay dry for the whole ` +
    `trip. Pre-evacuation alerts must land before a zone's first failed departure` +
    `${alerts.length ? ` (${alerts.join('; ')})` : ''}. Click a strip to jump there.`;
}

function setPlaying(on) {
  state.playing = on;
  els.play.textContent = on ? 'Pause' : 'Play';
  if (on) {
    state.timer = setInterval(() => setMinute((state.minute + 1) % 361), 150);
  } else {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function openCard() {
  setPlaying(false);
  renderCard(els.cardPaper, cardModel(
    state.model, state.minute, state.origin, state.mode, state.view, els.cardLang.value,
  ));
  if (!els.dialog.open) els.dialog.showModal();
}

function renderBuddyCard() {
  const card = buddyModel({
    graph: state.preset.graph,
    matrix: state.matrix,
    tierLabel: state.matrix.tier.label,
    scale: state.matrix.tier.scale,
    mode: state.mode,
    assignments: state.buddies,
    language: els.buddyLang.value,
  });
  renderBuddy(els.buddyPaper, card);
  els.buddyText.value = buddyText(card);
  const labels = buddyDialogText(card.lang);
  els.buddyDialog.lang = card.lang;
  els.buddyText.lang = card.lang;
  els.buddyTitle.textContent = card.title;
  els.buddyLanguageLabel.textContent = labels.language;
  for (const option of els.buddyLang.querySelectorAll('option')) {
    option.textContent = labels.languages[option.value];
    option.lang = card.lang;
  }
  els.buddyCopy.textContent = labels.copy;
  els.buddyPrint.textContent = labels.print;
  els.buddyClose.textContent = labels.close;
  els.buddySummary.textContent = labels.plainText;
  els.buddyText.setAttribute('aria-label', labels.plainText);
}

function openBuddy() {
  setPlaying(false);
  renderBuddyCard();
  if (!els.buddyDialog.open) els.buddyDialog.showModal();
}

els.preset.addEventListener('change', () => {
  state.preset = PRESETS.find(p => p.id === els.preset.value) ?? state.preset;
  state.edits = null;
  state.origin = 'school';
  populateOrigins();
  els.origin.value = state.origin;
  state.minute = state.preset.demoMinute;
  syncFormToPreset();
  computeModel();
});

els.origin.addEventListener('change', () => {
  state.origin = els.origin.value;
  state.compare = compareScenario(state.model, state.origin, state.mode);
  renderMetrics();
  renderMinute();
  renderCutoff();
});

els.mode.addEventListener('change', () => {
  state.mode = els.mode.value;
  state.compare = compareScenario(state.model, state.origin, state.mode);
  computeCutoffMatrix();
  renderMetrics();
  renderMinute();
  renderCutoff();
  renderBuddyPanel();
});

els.minute.addEventListener('input', () => {
  setPlaying(false);
  setMinute(Number(els.minute.value));
});
els.prev.addEventListener('click', () => { setPlaying(false); setMinute(state.minute - 5); });
els.next.addEventListener('click', () => { setPlaying(false); setMinute(state.minute + 5); });
els.peak.addEventListener('click', () => {
  setPlaying(false);
  setMinute(Math.min(360, state.model.active.peakMinute));
});
els.play.addEventListener('click', () => setPlaying(!state.playing));

els.form.addEventListener('submit', event => {
  event.preventDefault();
  try {
    const edits = readEdits();
    const next = buildScenario(state.preset, edits, state.mitigations);
    state.edits = edits;
    els.editError.hidden = true;
    computeModel(next);
  } catch (error) {
    els.editError.textContent = error instanceof Error ? error.message : String(error);
    els.editError.hidden = false;
  }
});

for (const [el, key] of [[els.pavement, 'pavement'], [els.clear, 'clear'], [els.bridge, 'bridge']]) {
  el.addEventListener('change', () => {
    state.mitigations[key] = el.checked;
    computeModel();
  });
}

els.goCard.addEventListener('click', openCard);
els.cardLang.addEventListener('change', () => {
  renderCard(els.cardPaper, cardModel(
    state.model, state.minute, state.origin, state.mode, state.view, els.cardLang.value,
  ));
});
els.cardPrint.addEventListener('click', () => window.print());
els.cardClose.addEventListener('click', () => els.dialog.close());

els.buddyOpen.addEventListener('click', openBuddy);
els.buddyLang.addEventListener('change', renderBuddyCard);
els.buddyPrint.addEventListener('click', () => window.print());
els.buddyClose.addEventListener('click', () => els.buddyDialog.close());
els.buddyCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.buddyText.value);
  } catch {
    const block = els.buddyText.closest('.buddy-text-block');
    if (block) block.open = true;
    els.buddyText.focus();
    els.buddyText.select();
  }
});

function showExportError(error) {
  els.exportError.textContent = `Export failed: ${error instanceof Error ? error.message : String(error)}`;
  els.exportError.hidden = false;
}

els.exportCsv.addEventListener('click', () => {
  try {
    download('floodline-telemetry.csv',
      telemetryCSV(state.model, state.minute, state.origin, state.mode, state.view),
      'text/csv;charset=utf-8');
    els.exportError.hidden = true;
  } catch (error) {
    showExportError(error);
  }
});
els.exportGeo.addEventListener('click', () => {
  try {
    download('floodline-route.geojson',
      canonicalJSON(routeGeoJSON(state.model, state.minute, state.view)),
      'application/geo+json');
    els.exportError.hidden = true;
  } catch (error) {
    showExportError(error);
  }
});
els.exportJson.addEventListener('click', async () => {
  try {
    const bundle = await auditBundle(state.model, state.minute, state.origin, state.mode, state.view);
    download('floodline-audit.json', canonicalJSON(bundle), 'application/json');
    els.exportError.hidden = true;
  } catch (error) {
    showExportError(error);
  }
});

els.intensity.addEventListener('input', () => {
  state.intensity = Number(els.intensity.value) / 100;
  syncTierUi();
  computeAnalysis();
});

els.budget.addEventListener('input', () => {
  state.budgetM = Number(els.budget.value) / 10;
  syncTierUi();
  renderComparator();
});

els.cutoffSvg.addEventListener('click', event => {
  const row = event.target.closest('[data-origin]');
  const id = row?.dataset?.origin;
  if (!id || !originNodes().includes(id)) return;
  state.origin = id;
  els.origin.value = id;
  state.compare = compareScenario(state.model, state.origin, state.mode);
  renderMetrics();
  const cut = state.matrix?.rows.find(item => item.origin === id)?.firstCut;
  if (cut !== null && cut !== undefined) setMinute(cut);
  else renderMinute();
  renderCutoff();
});

function currentPayload() {
  return briefPayload({
    model: state.model,
    tierLabel: state.tierSpec.label,
    scale: state.tierSpec.scale,
    comparison: state.comparison,
    matrix: state.matrix,
    budgetM: state.budgetM,
  });
}

for (const [el, build] of [
  [els.briefJson, () => ['floodline-brief.json', briefDocument(currentPayload()), 'application/json']],
  [els.briefCsv, () => ['floodline-brief.csv', briefCSV(state.comparison, state.tierSpec.label), 'text/csv;charset=utf-8']],
  [els.briefMd, () => ['floodline-brief.md', briefMarkdown(currentPayload()), 'text/markdown;charset=utf-8']],
]) {
  el.addEventListener('click', () => {
    try {
      const [name, text, type] = build();
      download(name, text, type);
      els.exportError.hidden = true;
    } catch (error) {
      showExportError(error);
    }
  });
}

els.bookmark.addEventListener('click', () => {
  const hash = encodeScenarioHash({
    preset: state.preset.id,
    origin: state.origin,
    mode: state.mode,
    minute: state.minute,
    mitigations: state.mitigations,
    tier: state.intensity === null ? state.tier : 'custom',
    intensity: state.intensity,
    budgetM: state.budgetM,
    edits: state.edits,
  });
  history.replaceState(null, '', hash);
  els.bookmarkUrl.value = window.location.href;
});

els.verifyBtn.addEventListener('click', () => {
  const result = verifyBriefDocument(els.verifyInput.value);
  els.verifyResult.hidden = false;
  els.verifyResult.classList.toggle('ok', result.ok);
  els.verifyResult.textContent = result.ok
    ? `Signature valid: SHA-256 ${result.sha256} matches the payload.`
    : `Signature check failed: ${result.reason}.`;
});

els.selftest.addEventListener('click', () => {
  const results = runSelfTests();
  els.selftestList.textContent = '';
  for (const result of results) {
    const li = addEl(els.selftestList, 'li');
    addEl(li, 'span', result.pass ? 'pass' : 'fail', `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}`);
    addEl(li, 'span', 'detail', result.detail);
  }
});

document.addEventListener('keydown', event => {
  const action = shortcutAction(event, els.shortcuts.checked);
  if (!action) return;
  event.preventDefault();
  if (action === 'toggle') setPlaying(!state.playing);
  else if (action === 'card') openCard();
});

els.settings.open = !window.matchMedia('(max-width: 720px)').matches;
els.downloadJump.addEventListener('click', () => { els.settings.open = true; });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}

function applyBookmark(decoded) {
  state.preset = PRESETS.find(p => p.id === decoded.preset) ?? state.preset;
  populateOrigins();
  state.edits = decoded.edits;
  if (decoded.edits) {
    els.rain.value = decoded.edits.rain.join(' ');
    els.cn.value = String(decoded.edits.cn);
    els.impervious.value = decoded.edits.impervious === null ? '' : String(decoded.edits.impervious);
    els.blockage.value = String(decoded.edits.blockage);
  }
  state.mitigations = { ...decoded.mitigations };
  els.pavement.checked = decoded.mitigations.pavement;
  els.clear.checked = decoded.mitigations.clear;
  els.bridge.checked = decoded.mitigations.bridge;
  const valid = originNodes();
  state.origin = valid.includes(decoded.origin) ? decoded.origin : 'school';
  state.mode = decoded.mode;
  state.minute = decoded.minute;
  state.tier = decoded.tier === 'custom' ? 'custom' : decoded.tier;
  state.intensity = decoded.tier === 'custom' ? decoded.intensity : null;
  if (state.intensity !== null) els.intensity.value = String(Math.round(state.intensity * 100));
  state.budgetM = decoded.budgetM;
}

populatePresets();
populateOrigins();
syncFormToPreset();
const bookmark = decodeScenarioHash(window.location.hash, PRESETS);
if (bookmark) applyBookmark(bookmark);
els.preset.value = state.preset.id;
els.origin.value = state.origin;
els.mode.value = state.mode;
renderTierButtons();
syncTierUi();
computeModel();
