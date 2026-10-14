import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotStore } from '../snapshot-store.js';
import { createSourceHealth } from '../source-health.js';
import { createSnapshotService } from '../services/snapshot-service.js';

function fakeClock(start = 100_000) {
  return { value: start, now() { return this.value; } };
}

test('prepareSnapshot captures universe once at one cutoff and returns compact metadata', async () => {
  const clock = fakeClock();
  const snapshotStore = createSnapshotStore({ clock, ttlMs: 900_000 });
  const sourceHealth = createSourceHealth({ clock });
  sourceHealth.record('bybit_rest', { ok: true, at: clock.now() });
  const calls = [];
  const service = createSnapshotService({
    snapshotStore,
    sourceHealth,
    captureUniverse: async cutoff => {
      calls.push(cutoff);
      clock.value += 5000;
      return [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }];
    },
    clock
  });
  const result = await service.prepareSnapshot();
  assert.deepEqual(calls, [100_000]);
  assert.equal(result.dataCutoff, 100_000);
  assert.equal(result.universeCount, 2);
  assert.equal(result.createdAt, 105_000);
  assert.equal(result.expiresAt, 1_005_000);
  assert.equal(snapshotStore.require(result.snapshotId).universe.length, 2);
});

test('prepareSnapshot stores cross-market quote bundle captured during snapshot preparation', async () => {
  const clock = { value:2000, now(){ return this.value; } };
  const snapshotStore = createSnapshotStore({ clock });
  const sourceHealth = createSourceHealth({ clock });
  const crossQuotes = { bybitLinear:{ BTCUSDT:{ bidPrice:99, askPrice:101 } }, bybitSpot:{}, binanceSpot:{}, binancePerp:{} };
  const service = createSnapshotService({
    snapshotStore, sourceHealth,
    captureUniverse: async () => ({ universe:[{symbol:'BTCUSDT'}], crossQuotes }),
    clock
  });
  const result = await service.prepareSnapshot();
  const stored = snapshotStore.require(result.snapshotId);
  assert.deepEqual(stored.crossQuotes, crossQuotes);
  assert.equal(stored.universe.length, 1);
});
