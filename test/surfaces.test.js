import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cardModel } from '../src/card.js';
import { shortcutAction } from '../src/controls.js';
import { auditBundle, canonicalJSON, csvCell, routeGeoJSON, telemetryCSV } from '../src/exports.js';
import { buildScenario, inspectScenario, PRESETS } from '../src/presets.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const model = buildScenario(PRESETS[0]);
const minute = model.preset.demoMinute;
const view = inspectScenario(model, minute, 'school', 'car');

for (const hostile of ['=2+2', '+2', '-2', '@sum', '  =3', '\tplain', '\rplain', '\nplain', '\uFEFF=3', ' \t=123', '\uFF1D2+2', '\uFF0B3', '\uFF20sum', '\uFF0D42']) {
  test(`CSV puts spreadsheet payload ${JSON.stringify(hostile)} behind a literal prefix`, () => {
    assert.equal(csvCell(hostile), `"'${hostile}"`);
  });
}

test('CSV keeps numeric negatives numeric and quotes text fields losslessly', () => {
  assert.equal(csvCell(-3.5), '-3.5');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('North, "Main"'), '"North, ""Main"""');
  assert.throws(() => csvCell(Infinity), RangeError);
});

function parseCSV(text) {
  const rows = [[]];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (!quoted && ch === ',') {
      rows.at(-1).push(field);
      field = '';
    } else if (!quoted && ch === '\r' && text[i + 1] === '\n') {
      rows.at(-1).push(field);
      rows.push([]);
      field = '';
      i += 1;
    } else field += ch;
  }
  if (field || rows.at(-1).length) rows.at(-1).push(field);
  else rows.pop();
  assert.equal(quoted, false);
  return rows;
}

test('CSV exports the full runoff tail with a rectangular table and full precision peak', () => {
  const lateStorm = buildScenario(PRESETS[0], { rain: [...Array(23).fill(0), 50], cn: 100 });
  const result = inspectScenario(lateStorm, 360, 'school', 'car');
  const [head, ...rows] = parseCSV(telemetryCSV(lateStorm, 360, 'school', 'car', result));
  assert.ok(rows.every(row => row.length === head.length));
  assert.equal(rows.length, lateStorm.active.q.length);
  assert.equal(Number(rows.at(-1)[head.indexOf('minute')]), 468);
  assert.equal(Number(rows[360][head.indexOf('rainfall_mm')]), 50);
  const peak = rows[lateStorm.active.peakMinute];
  assert.equal(Number(peak[head.indexOf('discharge_m3_s')]), lateStorm.active.peakQ);
  assert.equal(Number(peak[head.indexOf('stage_m')]), lateStorm.active.peakStage);
});

test('CSV marks exactly one selected minute without freezing per-minute route telemetry', () => {
  const [head, ...rows] = parseCSV(telemetryCSV(model, minute, 'school', 'car', view));
  const at = name => head.indexOf(name);
  assert.equal(rows.filter(row => row[at('selected_snapshot')] === 'yes').length, 1);
  assert.equal(rows[minute][at('selected_snapshot')], 'yes');
  assert.equal(rows[minute][at('trip_dry')], 'yes');
  assert.equal(rows[model.active.peakMinute][at('trip_dry')], 'unreachable');
  assert.equal(rows[model.active.peakMinute][at('selected_route_m')], '');
  assert.equal(Number(rows[minute][at('selected_route_m')]), view.dry.distance);
  assert.match(rows[minute][at('notice')], /never use for navigation/i);
});

test('canonical JSON is key-order invariant recursively and preserves array order', () => {
  const ordered = { a: [{ a: 1, b: 2 }, false, null], z: 'n' };
  const shuffled = { z: 'n', a: [{ b: 2, a: 1 }, false, null] };
  assert.equal(canonicalJSON(shuffled), JSON.stringify(ordered));
  assert.notEqual(canonicalJSON(shuffled), canonicalJSON({ ...ordered, a: [...ordered.a].reverse() }));
  for (const bad of [Infinity, undefined, { missing: undefined }, [NaN], Array(1)]) assert.throws(() => canonicalJSON(bad));
});

test('SHA-256 fingerprint matches an independent Node digest over the serialized payload', async () => {
  const a = await auditBundle(model, minute, 'school', 'car', view);
  const b = await auditBundle(model, minute, 'school', 'car', view);
  assert.equal(a.algorithm, 'SHA-256');
  assert.match(a.sha256, /^[a-f0-9]{64}$/);
  assert.equal(a.sha256, createHash('sha256').update(canonicalJSON(a.payload)).digest('hex'));
  assert.deepEqual(a, b);
  assert.deepEqual(a.payload.graph, model.preset.graph);
  const later = inspectScenario(model, minute + 1, 'school', 'car');
  const c = await auditBundle(model, minute + 1, 'school', 'car', later);
  assert.notEqual(c.sha256, a.sha256);
});

test('GeoJSON is synthetic, deterministic, and emits an ordered LineString and only inundated roads', () => {
  const a = routeGeoJSON(model, minute, view);
  assert.equal(a.type, 'FeatureCollection');
  assert.equal(a.synthetic_coordinates, true);
  assert.equal(a.storm_minute, minute);
  assert.deepEqual(a, routeGeoJSON(model, minute, view));
  const route = a.features.find(feature => feature.properties.kind === 'dry_snapshot');
  assert.equal(route.geometry.type, 'LineString');
  const coordinates = route.geometry.coordinates;
  assert.equal(coordinates.length, view.dry.nodes.length);
  assert.ok(coordinates[0][0] < coordinates.at(-1)[0]);
  assert.ok(a.features.filter(feature => feature !== route).length >= 1);
  for (const feature of a.features) {
    assert.equal(feature.type, 'Feature');
    for (const [lon, lat] of feature.geometry.coordinates) assert.ok(Math.abs(lon) < 1 && Math.abs(lat) < 1);
  }
  const peak = inspectScenario(model, model.active.peakMinute, 'school', 'car');
  assert.ok(!routeGeoJSON(model, model.active.peakMinute, peak).features.some(f => f.properties.kind === 'dry_snapshot'));
  const zero = inspectScenario(model, 0, 'school', 'car');
  assert.equal(routeGeoJSON(model, 0, zero).features.length, 1);
});

for (const language of ['en', 'es']) {
  test(`${language} go-card gives localized, ordered directions only for a modeled dry trip`, () => {
    const card = cardModel(model, minute, 'school', 'car', view, language);
    assert.equal(card.lang, language);
    assert.match(card.title, language === 'en' ? /Evacuation/i : /Evacuaci\u00f3n/i);
    assert.match(card.training, language === 'en' ? /exercise/i : /pr\u00e1ctica/i);
    assert.match(card.shelter, /Ridge Shelter/);
    assert.equal(card.legs.length, 3);
    assert.match(card.legs[0], /Cypress Rise/);
    assert.match(card.legs[1], /High Bridge/);
    assert.match(card.cutoff, /80/);
    assert.match(card.warning, language === 'en' ? /not an evacuation instruction/i : /no es una orden de evacuaci\u00f3n/i);
    const peak = inspectScenario(model, model.active.peakMinute, 'school', 'car');
    const unavailable = cardModel(model, model.active.peakMinute, 'school', 'car', peak, language);
    assert.match(unavailable.status, language === 'en' ? /unreachable/i : /inaccesible/i);
    assert.deepEqual(unavailable.legs, []);
    assert.doesNotMatch(unavailable.shelter ?? '', /Ridge Shelter/);
    const late = inspectScenario(model, 83, 'school', 'car');
    assert.ok(late.dry);
    assert.equal(late.tripDry, false);
    assert.deepEqual(cardModel(model, 83, 'school', 'car', late, language).legs, []);
  });
}

test('single-key shortcuts are opt-in and support the advertised play and card commands', () => {
  assert.equal(shortcutAction({ key: 'P' }, true), 'toggle');
  assert.equal(shortcutAction({ key: 'g' }, true), 'card');
  assert.equal(shortcutAction({ key: 'p' }, false), null);
  assert.equal(shortcutAction({ key: 'x' }, true), null);
});

for (const prop of ['defaultPrevented', 'repeat', 'ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing']) {
  test(`shortcut ignores ${prop} events`, () => assert.equal(shortcutAction({ key: 'p', [prop]: true }, true), null));
}

for (const target of ['input', 'select', 'textarea', 'button', 'a', 'summary', '[contenteditable]', '[role=textbox]', '[role=slider]', '[role=button]', 'dialog']) {
  test(`shortcut ignores focus inside ${target}`, () => {
    const element = { closest: selectors => selectors.split(',').some(s => {
      const normalized = s.trim().replaceAll('"', '').replaceAll("'", '');
      return normalized === target || (target === 'dialog' && normalized === 'dialog[open]');
    }) ? {} : null };
    assert.equal(shortcutAction({ key: 'p', target: element }, true), null);
  });
}

for (const prefix of [0x200B, 0x200E, 0x2060, 0x00AD, 0xE0001, 0x202A].map(cp => String.fromCodePoint(cp))) {
  test(`CSV puts U+${prefix.codePointAt(0).toString(16).toUpperCase()}-prefixed payload behind a literal prefix`, () => {
    const hostile = `${prefix}=x`;
    assert.equal(csvCell(hostile), `"'${hostile}"`);
  });
}

test('canonical JSON rejects circular structures instead of overflowing the stack', () => {
  const selfObj = {}; selfObj.self = selfObj;
  const selfArr = []; selfArr.push(selfArr);
  const a = { b: {} }; a.b.back = a;
  for (const bad of [selfObj, selfArr, a]) {
    assert.throws(() => canonicalJSON(bad), TypeError);
  }
  const shared = { v: 1 };
  assert.equal(canonicalJSON({ x: shared, y: [shared] }), '{"x":{"v":1},"y":[{"v":1}]}');
});

for (const bad of [-1, 75.5, NaN, model.active.q.length, 10_000]) {
  test(`telemetry CSV rejects out-of-run minute ${bad}`, () => {
    assert.throws(() => telemetryCSV(model, bad, 'school', 'car', view), RangeError);
  });
}

test('telemetry CSV accepts the final simulated minute', () => {
  const last = model.active.q.length - 1;
  const tail = inspectScenario(model, last, 'school', 'car');
  const [head, ...rows] = parseCSV(telemetryCSV(model, last, 'school', 'car', tail));
  assert.equal(Number(rows.at(-1)[head.indexOf('minute')]), last);
  assert.equal(rows.at(-1)[head.indexOf('selected_snapshot')], 'yes');
  assert.equal(rows.at(-1)[head.indexOf('trip_dry')], 'yes');
});

test('telemetry CSV flags an unverifiable trip instead of claiming it dry', () => {
  const [head, ...rows] = parseCSV(telemetryCSV(
    model, minute, 'school', 'car', { ...view, tripDry: null },
  ));
  assert.equal(rows[minute][head.indexOf('trip_dry')], 'unverified');
});

for (const language of ['en', 'es']) {
  test(`${language} go-card withholds directions for a trip that outlasts the run`, () => {
    const card = cardModel(model, minute, 'school', 'car', { ...view, tripDry: null }, language);
    assert.match(card.status, language === 'en' ? /unverified/i : /sin verificar/i);
    assert.deepEqual(card.legs, []);
    assert.equal(card.shelter, null);
  });
}

for (const language of ['en', 'es']) {
  test(`${language} card claims no closure only ahead of a reopened route`, () => {
    const reopened = inspectScenario(model, 200, 'school', 'car');
    assert.ok(reopened.dry);
    assert.equal(reopened.closes, null);
    const card = cardModel(model, 200, 'school', 'car', reopened, language);
    assert.match(card.cutoff, language === 'en' ? /from this minute/i : /a partir de este minuto/i);
  });
}

test('front-end release preserves text hygiene and an offline-first security policy', () => {
  const files = ['index.html', 'styles.css', 'README.md', 'sw.js',
    ...readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js')).map(name => `src/${name}`)];
  const bannedDashes = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`, 'u');
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, bannedDashes, file);
    assert.doesNotMatch(text, /\b(?:A[I]|ChatG[P]T|Dev[i]n|Cop[i]lot)\b/i, file);
    assert.doesNotMatch(text, /scroll-behavior\s*:\s*smooth/i, file);
  }
  const page = readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(page, /connect-src 'none'/);
  const externalResources = [...page.matchAll(/<(?:script|img|link)[^>]+(?:src|href)="https?:\/\/[^"]+"[^>]*>/g)]
    .map(match => match[0])
    .filter(tag => !tag.includes('rel="canonical"'));
  assert.deepEqual(externalResources, []);
  assert.match(page, /<h1[^>]*>\s*FloodLine\s*<\/h1>/);
});
