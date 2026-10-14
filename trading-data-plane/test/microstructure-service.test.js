import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotStore } from '../snapshot-store.js';
import { createMicrostructureService } from '../services/microstructure-service.js';

function setup() {
  const clock = { value:10_000, now(){ return this.value; } };
  const store = createSnapshotStore({ clock });
  const snap = store.create({ dataCutoff:10_000, universe:[{symbol:'BTCUSDT'},{symbol:'ETHUSDT'}] });
  return { clock, store, snap };
}

test('ensures finalist symbols and returns live neutral buckets with both timestamps', async () => {
  const { clock, store, snap } = setup();
  const ensured = [];
  const collector = {
    async ensureSymbols(symbols){ ensured.push(...symbols); },
    getNeutralBuckets(symbol, options){ return { symbol, options, families:{} }; }
  };
  const service = createMicrostructureService({ collector, snapshotStore:store, clock });
  clock.value = 12_000;
  const out = await service.getMicrostructureData({ snapshotId:snap.snapshotId, symbols:['BTCUSDT'], bucketMs:1000, lookbackMs:60_000 });
  assert.deepEqual(ensured, ['BTCUSDT']);
  assert.equal(out.analysisCutoff, 10_000);
  assert.equal(out.microstructureCapturedAt, 12_000);
  assert.equal(out.symbols.BTCUSDT.symbol, 'BTCUSDT');
});

test('rejects more than ten finalists and symbols outside snapshot universe', async () => {
  const { store, snap } = setup();
  const collector = { async ensureSymbols(){}, getNeutralBuckets(){ return {}; } };
  const service = createMicrostructureService({ collector, snapshotStore:store });
  await assert.rejects(() => service.getMicrostructureData({ snapshotId:snap.snapshotId, symbols:Array.from({length:11},(_,i)=>`X${i}USDT`), bucketMs:1000, lookbackMs:1000 }), /invalid_symbols/);
  await assert.rejects(() => service.getMicrostructureData({ snapshotId:snap.snapshotId, symbols:['SOLUSDT'], bucketMs:1000, lookbackMs:1000 }), /symbol_not_in_snapshot/);
});
