import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_STATES,
  CORE_SYMBOLS,
  MAX_ACTIVE_SYMBOLS,
  DYNAMIC_TTL_MS,
  WINDOW_MS,
  normalizeSymbol,
  isSupportedSymbol
} from '../config.js';

test('exports exact v1 runtime and watchlist constants', () => {
  assert.deepEqual(RUNTIME_STATES, ['FULL_EVENT_STREAM', 'WARMING_UP', 'PARTIAL', 'UNAVAILABLE']);
  assert.deepEqual(CORE_SYMBOLS, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.equal(MAX_ACTIVE_SYMBOLS, 12);
  assert.equal(DYNAMIC_TTL_MS, 20 * 60 * 1000);
  assert.deepEqual(WINDOW_MS, [1000, 5000, 30000, 60000]);
});

test('normalizes valid USDT symbols to uppercase', () => {
  assert.equal(normalizeSymbol(' btcusdt '), 'BTCUSDT');
  assert.equal(isSupportedSymbol('stxusdt'), true);
});

test('rejects path-like and malformed symbols', () => {
  for (const value of ['../BTC', 'BTC/USDT', 'BTC', '', 'AUSDT', 'BTCUSDT?x=1']) {
    assert.equal(isSupportedSymbol(value), false, String(value));
  }
  assert.throws(() => normalizeSymbol('../BTC'), /invalid_symbol/);
});
