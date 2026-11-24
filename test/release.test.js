import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';

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
  assert.ok(sw.includes('v5'), 'expected the v5 cache version');
});

test('every element id app.js looks up exists in index.html', () => {
  const wanted = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]));
  assert.ok(wanted.size > 10, `only found ${wanted.size} lookups`);
  for (const id of wanted) {
    assert.ok(index.includes(`id="${id}"`), `#${id} missing from index.html`);
  }
});

test('the page never references an external origin', () => {
  assert.ok(index.includes("connect-src 'none'"), 'CSP must forbid network connections');
  const externals = [...index.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g)];
  assert.deepEqual(externals, []);
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
