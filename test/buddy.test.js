import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRESETS, buildScenario } from '../src/presets.js';
import { cutoffMatrix } from '../src/timeline.js';
import { buddyModel, buddyText, renderBuddy, suggestBuddies } from '../src/buddy.js';

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
