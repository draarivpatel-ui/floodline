import { bounded, parseRain } from './hydrology.js';
import { DEPTH_REFERENCES, isAboveReference } from './routing.js';
import { PRESETS, buildScenario, compareScenario, inspectScenario } from './presets.js';
import { auditBundle, canonicalJSON, routeGeoJSON, telemetryCSV } from './exports.js';
import { cardModel, renderCard } from './card.js';
import { shortcutAction } from './controls.js';
import { renderHydrograph, renderMap } from './viz.js';

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
}

// Cheap step: repaint everything that depends on the scrubbed minute.
function renderMinute() {
  state.view = inspectScenario(state.model, state.minute, state.origin, state.mode);
  els.minute.value = String(state.minute);
  els.minuteReadout.textContent = `${Math.round(state.minute)} / 360`;
  els.minute.setAttribute('aria-valuetext', `${Math.round(state.minute)} minutes from storm start`);
  renderMap(els.map, state.model, state.view, state.origin, state.minute);
  renderHydrograph(els.hydro, state.model, state.minute);
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
  } else if (view.tripDry) {
    stateP.classList.add('ok');
    stateP.textContent = 'Verified dry modeled trip';
  } else {
    stateP.classList.add('warn');
    stateP.textContent = 'Dry at this snapshot, floods during travel';
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
      ? 'no modeled closure this run'
      : `route floods at storm minute ${view.closes.toFixed(1)}`);
  if (!view.dry) {
    addRow(dl, 'Leave by', 'not available');
  } else if (view.departureCutoff === null) {
    addRow(dl, 'Leave by', 'no cutoff needed this run');
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
  const cutoff = v => v === Infinity ? 'never closes' : v === -Infinity ? 'no dry opening' : `${v.toFixed(1)} min`;
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
});

els.mode.addEventListener('change', () => {
  state.mode = els.mode.value;
  state.compare = compareScenario(state.model, state.origin, state.mode);
  renderMetrics();
  renderMinute();
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

els.exportCsv.addEventListener('click', () => download(
  'floodline-telemetry.csv',
  telemetryCSV(state.model, state.minute, state.origin, state.mode, state.view),
  'text/csv;charset=utf-8',
));
els.exportGeo.addEventListener('click', () => download(
  'floodline-route.geojson',
  canonicalJSON(routeGeoJSON(state.model, state.minute, state.view)),
  'application/geo+json',
));
els.exportJson.addEventListener('click', async () => {
  try {
    const bundle = await auditBundle(state.model, state.minute, state.origin, state.mode, state.view);
    download('floodline-audit.json', canonicalJSON(bundle), 'application/json');
    els.exportError.hidden = true;
  } catch (error) {
    els.exportError.textContent = `Audit export failed: ${error instanceof Error ? error.message : String(error)}`;
    els.exportError.hidden = false;
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

populatePresets();
populateOrigins();
syncFormToPreset();
els.preset.value = state.preset.id;
els.origin.value = state.origin;
els.mode.value = state.mode;
computeModel();
