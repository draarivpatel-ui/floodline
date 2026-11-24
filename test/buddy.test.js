import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as hydrology from '../src/hydrology.js';
import * as routing from '../src/routing.js';
import * as presets from '../src/presets.js';
import * as mitigation from '../src/mitigation.js';
import * as brief from '../src/brief.js';
import * as exports from '../src/exports.js';
import * as card from '../src/card.js';
import * as controls from '../src/controls.js';
import { PRESETS, buildScenario } from '../src/presets.js';
import { cutoffMatrix } from '../src/timeline.js';
import { buddyDialogText, buddyModel, buddyText, renderBuddy, suggestBuddies } from '../src/buddy.js';

const model = buildScenario(PRESETS[0]);
const graph = model.preset.graph;
const origins = graph.nodes.filter(n => ['home', 'school'].includes(n.type)).map(n => n.id);
const matrix = cutoffMatrix(graph, model.active, origins, 'car', { raise: model.raise });

const assignmentsOf = () => Object.fromEntries(suggestBuddies(graph, origins));
const cardOf = (language = 'en', assignments = assignmentsOf(), m = matrix) =>
  buddyModel({ graph, matrix: m, tierLabel: '50-yr', scale: 1, mode: 'car', assignments, language });
const pairOf = (card, zoneLabel) => card.pairs.find(p => p.zone === zoneLabel);

class El {
  constructor(doc) { this.ownerDocument = doc; this.children = []; this._text = ''; this.lang = ''; }
  appendChild(child) { this.children.push(child); return child; }
  set textContent(v) { this._text = v; if (v === '') this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(' '); }
}
const doc = { createElement: () => new El(doc) };

test('suggestBuddies pairs every origin with a different zone', () => {
  const sug = suggestBuddies(graph, origins);
  assert.equal(sug.size, origins.length);
  for (const [zone, buddy] of sug) {
    assert.notEqual(zone, buddy);
    assert.ok(origins.includes(buddy));
  }
  assert.equal(sug.get('school'), 'homes');
  assert.equal(sug.get('homes'), 'school');
  assert.equal(sug.get('gardens'), 'school');
});

test('buddyModel builds one checklist block per matrix row', () => {
  const card = cardOf();
  assert.equal(card.lang, 'en');
  assert.equal(card.title, 'Neighborhood buddy card');
  assert.match(card.tier, /50-yr/);
  assert.match(card.tier, /by car/);
  assert.equal(card.pairs.length, matrix.rows.length);
  for (const pair of card.pairs) assert.ok(pair.items.length >= 4);
});

test('each pair carries the zone first-cut minute in its checklist', () => {
  const card = cardOf();
  const school = matrix.rows.find(r => r.origin === 'school');
  const pair = pairOf(card, school.label);
  assert.ok(pair.items.some(item => item.includes(`storm minute ${school.firstCut}`)));
});

test('a zone that never cuts gets the open-window line', () => {
  const openMatrix = { rows: matrix.rows.map(r => ({ ...r, firstCut: null })) };
  const card = cardOf('en', assignmentsOf(), openMatrix);
  for (const pair of card.pairs) {
    assert.ok(pair.items.some(item => /keeps a verified dry window/.test(item)));
    assert.ok(pair.items.some(item => /confirm contact on the hour/.test(item)));
  }
});

test('a zone with no safe departure gets the shelter-in-place line', () => {
  const stuckMatrix = { rows: matrix.rows.map(r => ({ ...r, lastSafe: null })) };
  const card = cardOf('en', assignmentsOf(), stuckMatrix);
  for (const pair of card.pairs) {
    assert.ok(pair.items.some(item => /shelter in place/.test(item)));
  }
});

test('ordering tells the longer-window zone to call the earlier-cut zone', () => {
  const card = cardOf();
  const school = pairOf(card, 'Cypress School');
  assert.ok(school.items.some(item =>
    /Willow Homes cuts first at minute 80, so Cypress School should call Willow Homes before then\./.test(item)));
});

test('ordering handles never-cut zones on both sides', () => {
  const bothOpen = { rows: matrix.rows.map(r => ({ ...r, firstCut: null })) };
  const card = cardOf('en', assignmentsOf(), bothOpen);
  for (const pair of card.pairs) {
    assert.ok(pair.items.some(item => /Both zones keep a verified dry window/.test(item)));
  }
  const mixed = { rows: matrix.rows.map(r => ({ ...r, firstCut: r.origin === 'homes' ? null : 40 })) };
  const mixedCard = cardOf('en', { school: 'homes', homes: 'school', gardens: 'school' }, mixed);
  const schoolPair = pairOf(mixedCard, 'Cypress School');
  assert.ok(schoolPair.items.some(item => /never loses its verified window/.test(item)));
});

test('household counts appear only when either side is nonzero', () => {
  const card = cardOf();
  const school = pairOf(card, 'Cypress School');
  assert.ok(school.items.some(item => /counts 0 households in Cypress School and 96 in Willow Homes/.test(item)));
  const zeroMatrix = { rows: matrix.rows.map(r => ({ ...r, households: 0 })) };
  const zeroCard = cardOf('en', assignmentsOf(), zeroMatrix);
  for (const pair of zeroCard.pairs) {
    assert.ok(!pair.items.some(item => /households/.test(item)));
  }
});

test('a custom assignment changes the pairing', () => {
  const card = cardOf('en', { school: 'gardens', homes: 'school', gardens: 'school' });
  assert.equal(pairOf(card, 'Cypress School').buddy, 'Terrace Homes');
});

test('family go-card plain text mirrors the rendered language and omits unavailable route fields', () => {
  const minute = model.preset.demoMinute;
  const view = presets.inspectScenario(model, minute, 'school', 'car');
  const en = card.cardModel(model, minute, 'school', 'car', view, 'en');
  const enText = card.cardText(en);
  assert.match(enText, /^FAMILY EVACUATION CARD - TRAINING EXERCISE ONLY/);
  assert.match(enText, /From: Cypress School/);
  assert.match(enText, /Never enter floodwater/);
  assert.ok(!enText.includes('undefined'));
  const es = card.cardModel(model, minute, 'school', 'car', view, 'es');
  const esText = card.cardText(es);
  assert.match(esText, /^TARJETA FAMILIAR DE EVACUACIÓN - SOLO PARA PRÁCTICA/);
  assert.match(esText, /Nunca entre en aguas de inundación/);
  assert.match(esText, /Desde: Cypress School/);
  assert.match(esText, /Hacia: Ridge Shelter/);
  assert.match(esText, /Ruta:/);
  assert.equal(card.cardDialogText('es').copy, 'Copiar texto');
  assert.equal(card.cardDialogText('xx').copy, 'Copy text');
});

test('the Spanish card is fully localized including the mode label', () => {
  const card = cardOf('es');
  assert.equal(card.lang, 'es');
  assert.equal(card.title, 'Tarjeta de apoyo entre vecinos');
  assert.match(card.tier, /en automóvil/);
  assert.ok(pairOf(card, 'Cypress School').items.some(i => /La última salida seca verificada/.test(i)));
  assert.ok(card.shared.some(i => /Simulación ficticia/.test(i)));
});

test('a pedestrian card uses the on-foot mode label', () => {
  const card = buddyModel({ graph, matrix, tierLabel: '50-yr', scale: 1, mode: 'pedestrian', assignments: assignmentsOf(), language: 'es' });
  assert.match(card.tier, /a pie/);
  assert.ok(pairOf(card, 'Cypress School').items.some(i => /a pie/.test(i)));
});

test('an unknown language falls back to English', () => {
  const card = cardOf('fr');
  assert.equal(card.lang, 'en');
  assert.equal(card.title, 'Neighborhood buddy card');
});

test('an empty matrix still yields the shared warnings', () => {
  const card = buddyModel({ graph, matrix: { rows: [] }, tierLabel: '50-yr', scale: 1, mode: 'car', assignments: {}, language: 'en' });
  assert.equal(card.pairs.length, 0);
  assert.equal(card.shared.length, 3);
});

test('buddyText renders the header, pair blocks, items and shared warnings', () => {
  const text = buddyText(cardOf());
  assert.match(text, /^NEIGHBORHOOD BUDDY CARD - TRAINING EXERCISE ONLY/m);
  assert.match(text, /Storm tier 50-yr/);
  assert.match(text, /Cypress School <> Willow Homes/);
  assert.match(text, /  - Call or text before storm minute 81/);
  assert.match(text, /- Never enter floodwater/);
  const esText = buddyText(cardOf('es'));
  assert.match(esText, /TARJETA DE APOYO ENTRE VECINOS/);
});

test('buddyText is deterministic', () => {
  assert.equal(buddyText(cardOf()), buddyText(cardOf()));
});

test('no English or Spanish card text uses an em or en dash', () => {
  for (const lang of ['en', 'es']) {
    const card = cardOf(lang);
    const blob = card.title + card.tier + card.pairs.map(p => p.items.join(' ')).join(' ') + card.shared.join(' ') + buddyText(card);
    assert.ok(!/[\u2010\u2011\u2012\u2013\u2014\u2015]/.test(blob), `unicode dash in ${lang}`);
  }
});

test('renderBuddy builds a textContent-only card with the pair headings and lang', () => {
  const target = new El(doc);
  renderBuddy(target, cardOf());
  assert.equal(target.lang, 'en');
  const flat = target.textContent;
  assert.match(flat, /Neighborhood buddy card/);
  assert.match(flat, /Cypress School <> Willow Homes/);
  assert.match(flat, /Terrace Homes <> Cypress School/);
  assert.match(flat, /Never enter floodwater/);
  const pairHeadings = target.children.filter(c => c.className === 'buddy-pair');
  assert.equal(pairHeadings.length, 3);
});

test('renderBuddy honors the card language attribute', () => {
  const target = new El(doc);
  renderBuddy(target, cardOf('es'));
  assert.equal(target.lang, 'es');
  assert.match(target.textContent, /Tarjeta de apoyo entre vecinos/);
});

// Run the actual app event handlers with real simulation and table renderers.
// SVG drawing is omitted so these integration checks need no browser.
class UIElement extends El {
  constructor(document, tag = 'div') {
    super(document);
    this.tagName = tag;
    this.value = '';
    this.dataset = {};
    this.attributes = {};
    this.handlers = new Map();
    this.open = false;
    this.classList = { add() {}, toggle() {} };
  }
  appendChild(child) { child.parentElement = this; return super.appendChild(child); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, handler) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }
  emit(name) {
    return Promise.all((this.handlers.get(name) ?? []).map(handler =>
      handler({ target: this, preventDefault() {} })));
  }
  querySelectorAll(tag) {
    return this.children.flatMap(child => [
      ...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag),
    ]);
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector === '.buddy-text-block' && node.className === 'buddy-text-block') return node;
    }
    return null;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}

function loadWorkbench() {
  const elements = new Map();
  const document = {
    createElement: tag => new UIElement(document, tag),
    getElementById: id => elements.get(id),
    addEventListener() {},
  };
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const [, tag, id] of page.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"/g)) {
    elements.set(id, new UIElement(document, tag));
  }
  const get = id => elements.get(id);
  get('intensity').value = '100';
  for (const id of ['buddy-language', 'card-language']) {
    get(id).value = 'en';
    for (const language of ['en', 'es']) {
      const option = document.createElement('option');
      option.value = language;
      get(id).appendChild(option);
    }
  }
  const textBlock = document.createElement('details');
  textBlock.className = 'buddy-text-block';
  textBlock.appendChild(get('buddy-text-summary'));
  textBlock.appendChild(get('buddy-text'));
  const calls = { printed: 0, copied: null };
  const navigator = { clipboard: { async writeText(text) { calls.copied = text; } } };
  const window = {
    location: { hash: '' }, matchMedia: () => ({ matches: false }),
    print() { calls.printed += 1; }, addEventListener() {},
  };
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\n/gm, '');
  const context = {
    ...hydrology, ...routing, ...presets, ...mitigation, ...brief, ...exports, ...card, ...controls,
    cutoffMatrix, buddyDialogText, buddyModel, buddyText, renderBuddy, suggestBuddies,
    renderCutoffChart() {}, renderHydrograph() {}, renderMap() {}, runSelfTests() { return []; },
    document, window, navigator, clearInterval() {},
  };
  runInNewContext(source + '\nglobalThis.workbenchState = state;', context, { filename: 'src/app.js' });
  return { state: context.workbenchState, get, calls, navigator, textBlock };
}

function assertVisibleTimes(ui) {
  const rows = ui.get('buddy-table').querySelectorAll('tbody')[0].children;
  assert.equal(rows.length, ui.state.matrix.rows.length);
  for (const [index, row] of ui.state.matrix.rows.entries()) {
    assert.equal(rows[index].children[2].textContent, row.firstCut === null ? 'never' : `min ${row.firstCut}`);
    assert.equal(rows[index].children[3].textContent, row.lastSafe === null ? 'none' : `min ${row.lastSafe}`);
  }
}

for (const [scale, expected] of [[2, [59, 58, 65]], [0.6, [null, null, null]]]) {
  test(`app scales the simulation, visible table and buddy card together at x${scale}`, async () => {
    const ui = loadWorkbench();
    ui.get('intensity').value = String(scale * 100);
    await ui.get('intensity').emit('input');
    assert.deepEqual(ui.state.matrix.rows.map(row => row.firstCut), expected);
    assert.equal(ui.state.matrix.tier, ui.state.cutoffRun.tier);
    assert.equal(ui.state.matrix.tier.scale, scale);
    const rainTotal = PRESETS[0].rain.reduce((sum, bin) => sum + bin, 0);
    assert.ok(Math.abs(ui.state.cutoffRun.sim.bins.at(-1).rain - rainTotal * scale) < 1e-9);
    assert.equal(ui.state.model.active.bins.at(-1).rain, rainTotal);
    assertVisibleTimes(ui);
    assert.match(ui.get('buddy-note').textContent, new RegExp(`rain scale x${scale}`));
    assert.match(ui.get('cutoff-note').textContent, new RegExp(`rain scale x${scale}`));
    await ui.get('buddy-open').emit('click');
    assert.match(ui.get('buddy-text').value, new RegExp(`rain scale x${scale}`));
    for (const row of ui.state.matrix.rows) {
      assert.ok(ui.get('buddy-text').value.includes(row.firstCut === null
        ? `${row.label} keeps a verified dry window`
        : `storm minute ${row.firstCut}: that is the first minute ${row.label}`));
    }
  });
}

test('tier buttons rerun the cutoff storm at x2 and x0.6', async () => {
  const ui = loadWorkbench();
  for (const [id, expected] of [['t500', [59, 58, 65]], ['t10', [null, null, null]]]) {
    await ui.get('tier-row').querySelectorAll('button').find(button => button.dataset.tier === id).emit('click');
    assert.equal(ui.state.matrix.tier.id, id);
    assert.deepEqual(ui.state.matrix.rows.map(row => row.firstCut), expected);
    assertVisibleTimes(ui);
  }
});

test('travel-mode changes refresh the visible buddy table using the current scaled storm', async () => {
  const ui = loadWorkbench();
  ui.get('intensity').value = '200';
  await ui.get('intensity').emit('input');
  const carCuts = ui.state.matrix.rows.map(row => row.firstCut);
  const scaledRun = ui.state.cutoffRun;
  await ui.get('buddy-open').emit('click');
  ui.get('mode').value = 'pedestrian';
  await ui.get('mode').emit('change');
  const expected = cutoffMatrix(graph, scaledRun.sim, origins, 'pedestrian', { raise: model.raise });
  assert.deepEqual(ui.state.matrix.rows.map(row => row.firstCut), expected.rows.map(row => row.firstCut));
  assert.notDeepEqual(ui.state.matrix.rows.map(row => row.firstCut), carCuts);
  assert.equal(ui.state.cutoffRun, scaledRun);
  assertVisibleTimes(ui);
  assert.match(ui.get('buddy-note').textContent, /on foot travel/);
  assert.match(ui.get('buddy-text').value, /on foot travel/);
});

test('scaled cutoffs retain active pavement, drain clearing and bridge raising', async () => {
  const ui = loadWorkbench();
  for (const id of ['pavement', 'clear', 'bridge']) {
    ui.get(id).checked = true;
    await ui.get(id).emit('change');
  }
  ui.get('intensity').value = '200';
  await ui.get('intensity').emit('input');
  const scaled = buildScenario(PRESETS[0], { rain: PRESETS[0].rain.map(bin => bin * 2) },
    { pavement: true, clear: true, bridge: true });
  const expected = cutoffMatrix(graph, scaled.active, origins, 'car', { raise: scaled.raise });
  assert.equal(ui.state.cutoffRun.sim.peakStage, scaled.active.peakStage);
  assert.deepEqual(ui.state.matrix.rows.map(row => row.firstCut), expected.rows.map(row => row.firstCut));
  assertVisibleTimes(ui);
});

test('Spanish dialog localizes its title, language selector, actions, expander and every tier label', async () => {
  const ui = loadWorkbench();
  await ui.get('buddy-open').emit('click');
  ui.get('buddy-language').value = 'es';
  await ui.get('buddy-language').emit('change');
  for (const [id, expected] of [
    ['buddy-dialog-title', 'Tarjeta de apoyo entre vecinos'], ['buddy-language-label', 'Idioma'],
    ['buddy-copy', 'Copiar texto'], ['buddy-print', 'Imprimir tarjeta'], ['buddy-close', 'Cerrar'],
    ['buddy-text-summary', 'Texto sin formato para SMS o WhatsApp'],
  ]) assert.equal(ui.get(id).textContent, expected);
  assert.deepEqual(ui.get('buddy-language').querySelectorAll('option').map(option => option.textContent), ['English', 'Español']);
  assert.equal(ui.get('buddy-dialog').lang, 'es');
  assert.equal(ui.get('buddy-text').lang, 'es');
  assert.equal(ui.get('buddy-text').attributes['aria-label'], 'Texto sin formato para SMS o WhatsApp');
  for (const tier of mitigation.STORM_TIERS) {
    await ui.get('tier-row').querySelectorAll('button').find(button => button.dataset.tier === tier.id).emit('click');
    assert.ok(ui.get('buddy-text').value.includes(tier.label.replace('-yr', ' años')));
    assert.doesNotMatch(ui.get('buddy-text').value, /-yr/);
  }
  ui.get('intensity').value = '200';
  await ui.get('intensity').emit('input');
  assert.match(ui.get('buddy-text').value, /personalizado x2\.00/);
  assert.doesNotMatch(ui.get('buddy-text').value, /\bcustom\b/);
  await ui.get('buddy-copy').emit('click');
  assert.equal(ui.calls.copied, ui.get('buddy-text').value);
  await ui.get('buddy-print').emit('click');
  assert.equal(ui.calls.printed, 1);
  await ui.get('buddy-close').emit('click');
  assert.equal(ui.get('buddy-dialog').open, false);
  ui.get('buddy-language').value = 'en';
  await ui.get('buddy-language').emit('change');
  assert.equal(ui.get('buddy-copy').textContent, 'Copy text');
  assert.equal(ui.get('buddy-dialog-title').textContent, 'Neighborhood buddy card');
  assert.match(ui.get('buddy-text').value, /custom x2\.00/);
});

test('Spanish copy fallback opens the localized plain-text control', async () => {
  const ui = loadWorkbench();
  ui.get('buddy-language').value = 'es';
  await ui.get('buddy-open').emit('click');
  ui.navigator.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); };
  await ui.get('buddy-copy').emit('click');
  assert.equal(ui.textBlock.open, true);
  assert.equal(ui.get('buddy-text').focused, true);
  assert.equal(ui.get('buddy-text').selected, true);
  assert.equal(ui.get('buddy-text-summary').textContent, 'Texto sin formato para SMS o WhatsApp');
});
