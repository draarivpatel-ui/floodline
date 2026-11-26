import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const printStart = css.indexOf('@media print');
const print = css.slice(printStart, css.indexOf('@media (max-width: 720px)', printStart));

test('form controls and disclosure rows use a high contrast control border', () => {
  assert.match(css, /--control-line: #657260;/);
  assert.match(css, /input\[type="text"\],\nselect,\ntextarea \{[\s\S]*?border: 1px solid var\(--control-line\)/);
  assert.match(css, /\.secondary > summary \{[^}]*border-bottom: 1px solid var\(--control-line\)/);
  assert.match(css, /\.advanced summary \{[^}]*border-bottom: 1px solid var\(--control-line\)/);
});

test('mobile pointer targets reserve at least 44px of height', () => {
  const mobileStart = css.lastIndexOf('@media (max-width: 720px)');
  const mobile = css.slice(mobileStart);
  assert.match(mobile, /\.btn, \.btn\.small \{ min-height: 44px; \}/);
  assert.match(mobile, /input\[type="text"\], select \{ min-height: 44px; \}/);
  assert.match(mobile, /input\[type="range"\] \{ min-height: 44px; \}/);
  assert.match(mobile, /summary \{ min-height: 44px; \}/);
  assert.match(mobile, /\.check \{ min-height: 44px; align-items: center; \}/);
});

test('workbench print hides controls and the dark map plate', () => {
  assert.match(print, /\.plate, \.tier-row, \.slider-row/);
  assert.match(print, /input, select, textarea, summary \{ display: none !important; \}/);
  assert.match(print, /label\[for="bookmark-url"\], label\[for="verify-input"\]/);
});

test('print tables are allowed to wrap within the letter page', () => {
  assert.match(print, /\.sheet \{ font-size: 7\.2pt; \}/);
  assert.match(print, /\.sheet th, \.sheet td \{ white-space: normal; overflow-wrap: break-word/);
  assert.match(print, /\.sheet td:first-child, \.sheet th:first-child \{ min-width: 0; \}/);
  assert.match(print, /#compare-table \{ width: 100%; min-width: 0; table-layout: fixed; \}/);
  assert.match(print, /#compare-table th:nth-child\(8\) \{ width: 12%; \}/);
});
