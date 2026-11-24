import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { roadFloor } from '../src/routing.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = rel => readFileSync(join(root, rel), 'utf8');

const sw = read('sw.js');
const serve = read('tools/serve.mjs');
const index = read('index.html');
const app = read('src/app.js');

const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\]/)[1];
const shellEntries = [...shellBlock.matchAll(/'([^']+)'/g)].map(match => match[1]);
const allowedBlock = serve.match(/const allowed = new Set\(\[([\s\S]*?)\]\)/)[1];
const allowedEntries = [...allowedBlock.matchAll(/'(\/[^']+)'/g)].map(match => match[1]);

test('every src module is precached by the service worker', () => {
  const modules = readdirSync(join(root, 'src')).filter(name => name.endsWith('.js'));
  for (const name of modules) {
    assert.ok(shellEntries.includes(`src/${name}`), `src/${name} missing from sw.js SHELL`);
  }
});

test('every precached shell entry exists on disk', () => {
  for (const entry of shellEntries) {
    assert.doesNotThrow(() => read(entry), `${entry} missing`);
  }
});

test('every src module is served by the dev server allowlist', () => {
  const modules = readdirSync(join(root, 'src')).filter(name => name.endsWith('.js'));
  for (const name of modules) {
    assert.ok(allowedEntries.includes(`/src/${name}`), `/src/${name} missing from serve.mjs`);
  }
});

test('the service worker version advanced with the new shell', () => {
  assert.match(sw, /const VERSION = `\$\{PREFIX\}v8`;/, 'expected the v8 cache version');
});

test('every element id app.js looks up exists in index.html', () => {
  const wanted = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]));
  assert.ok(wanted.size > 10, `only found ${wanted.size} lookups`);
  for (const id of wanted) {
    assert.ok(index.includes(`id="${id}"`), `#${id} missing from index.html`);
  }
});

test('the page never references an external origin for a loadable resource', () => {
  assert.ok(index.includes("connect-src 'none'"), 'CSP must forbid network connections');
  const externals = [...index.matchAll(/<(?:script|img|link)[^>]+(?:src|href)="(https?:)?\/\/[^"]+"[^>]*>/g)]
    .map(match => match[0])
    .filter(tag => !tag.includes('rel="canonical"'));
  assert.deepEqual(externals, []);
});

test('citable metadata includes canonical, OpenGraph and educational JSON-LD', () => {
  assert.ok(index.includes('<link rel="canonical" href="https://aariv.me/floodline/">'));
  assert.ok(index.includes('property="og:url" content="https://aariv.me/floodline/"'));
  assert.ok(index.includes('property="og:image" content="https://aariv.me/floodline/og-image.png"'));
  assert.ok(index.includes('name="twitter:card" content="summary_large_image"'));
  assert.ok(index.includes('<meta name="robots" content="noindex, nofollow">'));
  const ld = index.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ld, 'JSON-LD block missing');
  const data = JSON.parse(ld[1]);
  const software = data['@graph'].find(item => item['@type'] === 'SoftwareApplication');
  assert.equal(software.name, 'FloodLine');
  assert.equal(software.applicationCategory, 'EducationalApplication');
  assert.deepEqual(software.inLanguage, ['en', 'es']);
  assert.ok(data['@graph'].some(item => item['@type'] === 'LearningResource'));
});

test('the OpenGraph image is a real 1200 by 630 PNG in the offline shell', () => {
  const bytes = readFileSync(join(root, 'og-image.png'));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), 1200);
  assert.equal(bytes.readUInt32BE(20), 630);
  assert.ok(statSync(join(root, 'og-image.png')).size > 1000);
  assert.ok(shellEntries.includes('og-image.png'));
  assert.ok(allowedEntries.includes('/og-image.png'));
});

test('the family card exposes localized chrome and a plain-text export', () => {
  for (const id of ['card-copy', 'card-text', 'card-text-summary', 'card-language-label', 'announcer']) {
    assert.ok(index.includes(`id="${id}"`), `#${id} missing`);
  }
  assert.match(app, /cardText\(card\)/);
  assert.match(app, /cardDialogText\(card\.lang\)/);
  assert.match(app, /card-copy/);
});

test('the comparator, timeline, buddy, and self-check panels exist in the page', () => {
  for (const id of ['tier-row', 'intensity', 'budget', 'compare-table', 'cutoff-chart',
    'alert-matrix', 'buddy-note', 'buddy-table', 'buddy-open', 'buddy-dialog',
    'buddy-language', 'buddy-paper', 'buddy-text', 'buddy-copy', 'buddy-print',
    'buddy-close', 'methodology', 'export-brief-json', 'export-brief-csv',
    'export-brief-md', 'bookmark', 'bookmark-url', 'verify-input', 'verify-btn',
    'selftest', 'selftest-list']) {
    assert.ok(index.includes(`id="${id}"`), `#${id} panel missing`);
  }
});

test('no new module imports a remote URL or a package specifier', () => {
  const modules = readdirSync(join(root, 'src')).filter(name => name.endsWith('.js'));
  for (const name of modules) {
    const source = read(`src/${name}`);
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      assert.ok(match[1].startsWith('./'), `${name} imports ${match[1]}`);
    }
    assert.ok(!source.includes('fetch('), `${name} calls fetch()`);
  }
});

test('methodology states the actual road floor equation and separates dry routes from depth references', () => {
  assert.ok(index.includes('min(edge.floor + bridgeRaise + lift, endpointA.floor, endpointB.floor)'));
  const nodes = new Map([['a', { floor: 3 }], ['b', { floor: 5 }]]);
  const edge = { id: 'road', a: 'a', b: 'b', floor: 1, bridge: true };
  assert.equal(roadFloor(edge, nodes, 1, new Map([['road', 0.5]])), 2.5);
  assert.equal(roadFloor(edge, nodes, 3, new Map([['road', 0.5]])), 3);
  assert.equal(roadFloor({ ...edge, bridge: false }, nodes, 3, new Map([['road', 0.5]])), 1.5);
  assert.match(index, /cutoff matrix and buddy cards require no modeled water/);
  assert.match(index, /comparator's peak-road passability uses a separate 0\.30 m vehicle reference/);
  assert.match(index, /shortcut depth display uses 0\.30 m for cars and 0\.15 m for walking as reference warnings/);
  assert.doesNotMatch(index, /vehicle route fails at 0\.30 m|walking route at 0\.15 m|lower of its two endpoint floors, plus/);
});

test('methodology includes the baseline storm scale, custom range and actual budget ranking', () => {
  assert.match(index, /0\.6, 1, 1\.4 or 2 \(custom from 0\.4 to 2\.2\)/);
  assert.match(index, /cutoff matrix also retains the active pavement, drain and bridge mitigations/);
  assert.match(index, /Tier labels are exercise labels, not design return periods/);
  assert.match(index, /avoided stranded households per \$1M/);
  assert.match(index, /prioritizes fewer stranded zones, then more passable road length, then lower cost/);
});
