import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceHealth } from '../source-health.js';
import { assertNeutralPayload } from '../schema-guard.js';

function fakeClock(start = 10_000) {
  return { value: start, now() { return this.value; } };
}

test('fresh successful source is GOOD and stays neutral', () => {
  const clock = fakeClock();
  const health = createSourceHealth({ clock, freshMs: 30_000 });
  health.record('bybit_rest', { ok: true, latencyMs: 42, at: clock.now() });
  const out = health.snapshot();
  assert.equal(out.bybit_rest.state, 'GOOD');
  assert.equal(out.bybit_rest.latencyMs, 42);
  assert.doesNotThrow(() => assertNeutralPayload(out));
});

test('stale successful source is DEGRADED', () => {
  const clock = fakeClock();
  const health = createSourceHealth({ clock, freshMs: 30_000 });
  health.record('bybit_rest', { ok: true, at: clock.now() });
  clock.value += 30_001;
  assert.equal(health.snapshot().bybit_rest.state, 'DEGRADED');
});

test('failed source without a usable success is UNAVAILABLE', () => {
  const clock = fakeClock();
  const health = createSourceHealth({ clock });
  health.record('binance_spot_rest', { ok: false, reason: 'timeout', at: clock.now() });
  const row = health.snapshot().binance_spot_rest;
  assert.equal(row.state, 'UNAVAILABLE');
  assert.equal(row.reason, 'timeout');
});
