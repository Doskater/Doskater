import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchlist } from '../watchlist.js';
import { CORE_SYMBOLS, MAX_ACTIVE_SYMBOLS, DYNAMIC_TTL_MS } from '../config.js';

test('starts with core symbols and core cannot expire', () => {
  let now = 0;
  const removed = [];
  const list = createWatchlist({ coreSymbols: CORE_SYMBOLS, maxActive: MAX_ACTIVE_SYMBOLS, dynamicTtlMs: DYNAMIC_TTL_MS, now: () => now, onRemove: s => removed.push(s) });
  assert.deepEqual(list.list().map(x => x.symbol), CORE_SYMBOLS);
  now = DYNAMIC_TTL_MS * 10;
  list.expire();
  assert.deepEqual(list.list().map(x => x.symbol), CORE_SYMBOLS);
  assert.deepEqual(removed, []);
});

test('adds refreshes and expires dynamic candidates after 20 minutes', () => {
  let now = 1000;
  const added = [];
  const removed = [];
  const list = createWatchlist({ coreSymbols: CORE_SYMBOLS, maxActive: 12, dynamicTtlMs: DYNAMIC_TTL_MS, now: () => now, onAdd: s => added.push(s), onRemove: s => removed.push(s) });
  list.ensure(['stxusdt']);
  assert.equal(list.list().find(x => x.symbol === 'STXUSDT').core, false);
  assert.deepEqual(added, ['BTCUSDT','ETHUSDT','SOLUSDT','STXUSDT']);
  now += DYNAMIC_TTL_MS - 1;
  list.touch('STXUSDT');
  now += DYNAMIC_TTL_MS - 1;
  list.expire();
  assert.ok(list.list().some(x => x.symbol === 'STXUSDT'));
  now += 2;
  list.expire();
  assert.ok(!list.list().some(x => x.symbol === 'STXUSDT'));
  assert.deepEqual(removed, ['STXUSDT']);
});

test('duplicate ensure is idempotent but refreshes last touched time', () => {
  let now = 0;
  const added = [];
  const list = createWatchlist({ coreSymbols: CORE_SYMBOLS, maxActive: 12, dynamicTtlMs: DYNAMIC_TTL_MS, now: () => now, onAdd: s => added.push(s) });
  list.ensure(['ARBUSDT']);
  now = 100;
  list.ensure(['arbusdt']);
  assert.equal(added.filter(x => x === 'ARBUSDT').length, 1);
  assert.equal(list.list().find(x => x.symbol === 'ARBUSDT').lastTouched, 100);
});

test('rejects invalid symbols', () => {
  const list = createWatchlist({ coreSymbols: CORE_SYMBOLS, maxActive: 12, dynamicTtlMs: DYNAMIC_TTL_MS });
  assert.throws(() => list.ensure(['../BTC']), /invalid_symbol/);
});

test('12 symbol cap rejects overflow atomically without evicting core', () => {
  const list = createWatchlist({ coreSymbols: CORE_SYMBOLS, maxActive: 12, dynamicTtlMs: DYNAMIC_TTL_MS });
  const nine = ['AAVEUSDT','ARBUSDT','ADAUSDT','DOGEUSDT','XRPUSDT','LINKUSDT','AVAXUSDT','SUIUSDT','STXUSDT'];
  list.ensure(nine);
  assert.equal(list.list().length, 12);
  assert.throws(() => list.ensure(['NEARUSDT']), /watchlist_capacity_exceeded/);
  assert.equal(list.list().length, 12);
  for (const core of CORE_SYMBOLS) assert.ok(list.list().some(x => x.symbol === core && x.core));
});
