import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SELF_CHECKS, runSelfTests } from '../src/selftest.js';

test('every self-check has a unique id, a name, and a runnable body', () => {
  assert.ok(SELF_CHECKS.length >= 8);
  const ids = new Set(SELF_CHECKS.map(item => item.id));
  assert.equal(ids.size, SELF_CHECKS.length);
  for (const item of SELF_CHECKS) {
    assert.ok(typeof item.id === 'string' && item.id.length > 0);
    assert.ok(typeof item.name === 'string' && item.name.length > 0);
    assert.equal(typeof item.run, 'function');
  }
});

test('the in-page suite covers every promised invariant', () => {
  const ids = new Set(SELF_CHECKS.map(item => item.id));
  for (const required of [
    'sha256-kat', 'runoff-conservation', 'discharge-conservation', 'routing-exclusion',
    'mitigation-nonworsening', 'cutoff-monotonicity', 'csv-escaping',
    'tamper-detection', 'hash-roundtrip',
  ]) {
    assert.ok(ids.has(required), `missing ${required}`);
  }
});

test('runSelfTests reports one result per check and every check passes', () => {
  const results = runSelfTests();
  assert.equal(results.length, SELF_CHECKS.length);
  for (const result of results) {
    assert.ok(typeof result.detail === 'string' && result.detail.length > 0);
    assert.equal(result.pass, true, `${result.id} failed: ${result.detail}`);
  }
});

test('runSelfTests is repeatable and keeps order stable', () => {
  const a = runSelfTests();
  const b = runSelfTests();
  assert.deepEqual(a.map(r => r.id), b.map(r => r.id));
  assert.deepEqual(a.map(r => r.pass), b.map(r => r.pass));
});
