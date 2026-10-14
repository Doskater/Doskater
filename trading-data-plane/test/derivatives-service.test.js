import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotStore } from '../snapshot-store.js';
import { createDerivativesService } from '../services/derivatives-service.js';

function setup(cutoff = 36_000_000) {
  const store = createSnapshotStore({ clock:{ now:() => cutoff } });
  const snap = store.create({ dataCutoff:cutoff, universe:[{symbol:'BTCUSDT'}] });
  return { store, snap };
}

test('normalizes OI, funding, mark/index and computes neutral basis on aligned timestamps', async () => {
  const { store, snap } = setup();
  const bybit = {
    async getOpenInterest(){ return { list:[{ openInterest:'100', timestamp:'32400000' }], nextPageCursor:'' }; },
    async getFundingHistory(){ return [{ fundingRate:'0.001', fundingRateTimestamp:'32400000' }]; },
    async getMarkPriceKlines(){ return [['32400000','101','101','101','101']]; },
    async getIndexPriceKlines(){ return [['32400000','100','100','100','100']]; }
  };
  const liquidationProvider = {
    async getAggregates(){ return { rows:[{ timestamp:32400000, liquidationBuyNotional:5, liquidationSellNotional:6 }], coverage:{ state:'FULL', startMs:0, endMs:36_000_000, reason:null } }; }
  };
  const service = createDerivativesService({ bybit, snapshotStore:store, liquidationProvider });
  const out = await service.getHistoricalDerivativesData({
    snapshotId:snap.snapshotId, symbols:['BTCUSDT'], resolution:'5m', startMs:0,
    fields:['openInterest','fundingRate','markPrice','indexPrice','basisBps','liquidationBuyNotional','liquidationSellNotional']
  });
  assert.equal(out.rows.length, 1);
  const row = out.rows[0];
  assert.equal(row.openInterest, 100);
  assert.equal(row.fundingRate, 0.001);
  assert.equal(row.markPrice, 101);
  assert.equal(row.indexPrice, 100);
  assert.equal(row.basisBps, 100);
  assert.equal(row.liquidationBuyNotional, 5);
  assert.equal(out.coverage.BTCUSDT.liquidations.state, 'FULL');
});

test('missing liquidation history is explicit and never fabricated as zero', async () => {
  const { store, snap } = setup();
  const bybit = {
    async getOpenInterest(){ return { list:[{ openInterest:'100', timestamp:'32400000' }], nextPageCursor:'' }; },
    async getFundingHistory(){ return []; },
    async getMarkPriceKlines(){ return []; },
    async getIndexPriceKlines(){ return []; }
  };
  const service = createDerivativesService({ bybit, snapshotStore:store });
  const out = await service.getHistoricalDerivativesData({
    snapshotId:snap.snapshotId, symbols:['BTCUSDT'], resolution:'5m', startMs:0,
    fields:['openInterest','liquidationBuyNotional','liquidationSellNotional']
  });
  assert.equal(out.coverage.BTCUSDT.liquidations.state, 'UNAVAILABLE');
  assert.match(out.coverage.BTCUSDT.liquidations.reason, /provider/);
  assert.equal(out.rows[0].openInterest, 100);
  assert.equal(out.rows[0].liquidationBuyNotional, null);
  assert.equal(out.rows[0].liquidationSellNotional, null);
});

test('follows paginated open-interest cursor and keeps deterministic rows', async () => {
  const { store, snap } = setup();
  const cursors = [];
  const bybit = {
    async getOpenInterest({ cursor }) {
      cursors.push(cursor ?? '');
      return cursor
        ? { list:[{ openInterest:'90', timestamp:'28800000' }], nextPageCursor:'' }
        : { list:[{ openInterest:'100', timestamp:'32400000' }], nextPageCursor:'next' };
    },
    async getFundingHistory(){ return []; }, async getMarkPriceKlines(){ return []; }, async getIndexPriceKlines(){ return []; }
  };
  const service = createDerivativesService({ bybit, snapshotStore:store });
  const out = await service.getHistoricalDerivativesData({ snapshotId:snap.snapshotId, symbols:['BTCUSDT'], resolution:'5m', startMs:0, fields:['openInterest'] });
  assert.deepEqual(cursors, ['', 'next']);
  assert.deepEqual(out.rows.map(x => x.timestamp), [28800000,32400000]);
});
