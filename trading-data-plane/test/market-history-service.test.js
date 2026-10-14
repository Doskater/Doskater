import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotStore } from '../snapshot-store.js';
import { createMarketHistoryService } from '../services/market-history-service.js';

function storeWithSnapshot(cutoff = 36_000_000) {
  const clock = { now: () => cutoff };
  const store = createSnapshotStore({ clock });
  const snap = store.create({ dataCutoff: cutoff, universe: [{ symbol:'BTCUSDT' }, { symbol:'ETHUSDT' }] });
  return { store, snap };
}

test('caps end at snapshot cutoff, sorts ascending, removes duplicate boundary candles, and returns selected fields', async () => {
  const { store, snap } = storeWithSnapshot(36_000_000);
  const calls = [];
  const bybit = {
    async getKlines({ symbol, endMs }) {
      calls.push({ symbol, endMs });
      if (endMs >= 36_000_000) return [
        ['32400000','9','10','8','9.5','90','900'],
        ['28800000','8','9','7','8.5','80','800']
      ];
      if (endMs >= 28799999) return [
        ['28800000','8','9','7','8.5','80','800'],
        ['25200000','7','8','6','7.5','70','700']
      ];
      return [];
    }
  };
  const service = createMarketHistoryService({ bybit, snapshotStore:store });
  const out = await service.getHistoricalMarketData({
    snapshotId:snap.snapshotId,
    symbols:['BTCUSDT'], timeframe:'1h', startMs:25200000, endMs:180_000_000,
    fields:['timestamp','close','volume'], maxRows:100
  });
  assert.deepEqual(out.rows, [
    { symbol:'BTCUSDT', timestamp:25200000, close:7.5, volume:70 },
    { symbol:'BTCUSDT', timestamp:28800000, close:8.5, volume:80 },
    { symbol:'BTCUSDT', timestamp:32400000, close:9.5, volume:90 }
  ]);
  assert.equal(calls[0].endMs, 36_000_000);
  assert.equal(out.dataCutoff, 36_000_000);
});

test('large matrix paginates deterministically with no gaps or duplicates', async () => {
  const cutoff = 30_000_000;
  const { store, snap } = storeWithSnapshot(cutoff);
  const bybit = {
    async getKlines({ symbol, endMs, startMs, limit }) {
      const base = symbol === 'BTCUSDT' ? 0 : 15_000_000;
      const maxIndex = symbol === 'BTCUSDT' ? 12049 : 7954;
      const endIndex = Math.min(maxIndex, Math.floor((endMs - base) / 1000));
      if (endIndex < 0) return [];
      const startIndex = Math.max(0, endIndex - limit + 1);
      const rows = [];
      for (let i = endIndex; i >= startIndex; i--) {
        const ts = base + i * 1000;
        if (ts < startMs) break;
        rows.push([String(ts),'1','1','1',String(i),'1','1']);
      }
      return rows;
    }
  };
  const service = createMarketHistoryService({ bybit, snapshotStore:store });
  const args = {
    snapshotId:snap.snapshotId,
    symbols:['BTCUSDT','ETHUSDT'], timeframe:'1h', startMs:0, endMs:cutoff,
    fields:['timestamp','close'], maxRows:20_000
  };
  const first = await service.getHistoricalMarketData(args);
  assert.equal(first.rows.length, 20_000);
  assert.ok(first.nextCursor);
  const second = await service.getHistoricalMarketData({ ...args, cursor:first.nextCursor });
  assert.equal(second.rows.length, 5);
  const keys = [...first.rows, ...second.rows].map(row => `${row.symbol}:${row.timestamp}`);
  assert.equal(new Set(keys).size, 20_005);
  assert.equal(second.nextCursor, null);
});

test('expired snapshot fails before serving cached history', async () => {
  const clock = { value:1000, now() { return this.value; } };
  const store = createSnapshotStore({ clock, ttlMs:100 });
  const snap = store.create({ dataCutoff:1000, universe:[{symbol:'BTCUSDT'}] });
  const service = createMarketHistoryService({ bybit:{ async getKlines(){ return []; } }, snapshotStore:store });
  await service.getHistoricalMarketData({ snapshotId:snap.snapshotId, symbols:['BTCUSDT'], timeframe:'1h' });
  clock.value = 1200;
  await assert.rejects(() => service.getHistoricalMarketData({ snapshotId:snap.snapshotId, symbols:['BTCUSDT'], timeframe:'1h' }), /snapshot_expired/);
});
