import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotStore } from '../snapshot-store.js';
import { createCrossMarketService } from '../services/cross-market-service.js';

function setup() {
  const clock = { now:() => 10_000 };
  const store = createSnapshotStore({ clock });
  const snap = store.create({
    dataCutoff:10_000,
    universe:[
      {symbol:'BTCUSDT',bybitSpot:true,binanceSpot:true,binancePerp:true},
      {symbol:'ONLYUSDT',bybitSpot:false,binanceSpot:false,binancePerp:false}
    ],
    crossQuotes:{
      bybitLinear:{ BTCUSDT:{bidPrice:99,bidSize:2,askPrice:101,askSize:3,lastPrice:100,markPrice:100.5,indexPrice:100.2}, ONLYUSDT:{bidPrice:1.9,askPrice:2.1,lastPrice:2} },
      bybitSpot:{ BTCUSDT:{bidPrice:98.9,bidSize:1,askPrice:100.9,askSize:1,lastPrice:100} },
      binanceSpot:{ BTCUSDT:{bidPrice:99.1,bidSize:4,askPrice:100.8,askSize:5} },
      binancePerp:{ BTCUSDT:{bidPrice:99.2,bidSize:6,askPrice:100.7,askSize:7} }
    }
  });
  return { store, snap };
}

test('snapshot mode reads only stored cross-market quotes and preserves Bybit-only symbols', async () => {
  const { store, snap } = setup();
  let liveCalls = 0;
  const service = createCrossMarketService({
    bybit:{ async getKlines(){ liveCalls++; return []; } },
    binance:{ async getSpotKlines(){ liveCalls++; return []; }, async getFuturesKlines(){ liveCalls++; return []; } },
    snapshotStore:store
  });
  const out = await service.getCrossMarketData({ snapshotId:snap.snapshotId, symbols:['BTCUSDT','ONLYUSDT'], mode:'snapshot' });
  assert.equal(liveCalls, 0);
  assert.equal(out.rows.length, 2);
  const only = out.rows.find(x => x.symbol === 'ONLYUSDT');
  assert.equal(only.bybitPerp.lastPrice, 2);
  assert.equal(only.binanceSpot, null);
  assert.equal(only.binancePerp, null);
  assert.equal(out.coverage.ONLYUSDT.binanceSpot.state, 'UNAVAILABLE');
});

test('snapshot mode exposes raw basis inputs without arbitrage recommendations', async () => {
  const { store, snap } = setup();
  const service = createCrossMarketService({ bybit:{}, binance:{}, snapshotStore:store });
  const out = await service.getCrossMarketData({ snapshotId:snap.snapshotId, symbols:['BTCUSDT'], mode:'snapshot' });
  const row = out.rows[0];
  assert.equal(row.bybitPerp.markPrice, 100.5);
  assert.equal(row.bybitSpot.lastPrice, 100);
  assert.equal(row.binanceSpot.bidPrice, 99.1);
  assert.equal('arbitrage' in row, false);
  assert.equal('buyVenue' in row, false);
  assert.equal('sellVenue' in row, false);
});

test('history mode caps every venue request at snapshot cutoff', async () => {
  const { store, snap } = setup();
  const ends = [];
  const bybit = {
    async getKlines({ category, endMs }) { ends.push([`bybit:${category}`, endMs]); return [['9000','1','1','1',category==='spot'?'100':'101','1','1']]; }
  };
  const binance = {
    async getSpotKlines({ endMs }) { ends.push(['binance:spot',endMs]); return [[9000,'1','1','1','99','1']]; },
    async getFuturesKlines({ endMs }) { ends.push(['binance:perp',endMs]); return [[9000,'1','1','1','102','1']]; }
  };
  const service = createCrossMarketService({ bybit, binance, snapshotStore:store });
  const out = await service.getCrossMarketData({ snapshotId:snap.snapshotId, symbols:['BTCUSDT'], mode:'history', timeframe:'1h', startMs:8000, endMs:99_999 });
  assert.ok(ends.every(([,end]) => end <= 10_000));
  const row = out.rows.find(x => x.timestamp === 9000);
  assert.equal(row.bybitPerpPrice, 101);
  assert.equal(row.bybitSpotPrice, 100);
  assert.equal(row.binanceSpotPrice, 99);
  assert.equal(row.binancePerpPrice, 102);
});

test('history mode paginates cached synchronized rows with deterministic cursor', async () => {
  const store=createSnapshotStore({clock:{now:()=>10000}});
  const snap=store.create({dataCutoff:10000,universe:[{symbol:'BTCUSDT',bybitSpot:false,binanceSpot:false,binancePerp:false}]});
  let calls=0;
  const bybit={async getKlines(){calls++;return [['9000','1','1','1','1'],['8000','1','1','1','1'],['7000','1','1','1','1']];}};
  const service=createCrossMarketService({bybit,binance:{},snapshotStore:store});
  const first=await service.getCrossMarketData({snapshotId:snap.snapshotId,symbols:['BTCUSDT'],mode:'history',timeframe:'1h',startMs:7000,endMs:9000,maxRows:2});
  assert.equal(first.rows.length,2);
  assert.ok(first.nextCursor);
  const callsAfterFirst=calls;
  const second=await service.getCrossMarketData({snapshotId:snap.snapshotId,symbols:['BTCUSDT'],mode:'history',timeframe:'1h',startMs:7000,endMs:9000,maxRows:2,cursor:first.nextCursor});
  assert.equal(second.rows.length,1);
  assert.equal(new Set([...first.rows,...second.rows].map(x=>x.timestamp)).size,3);
  assert.equal(calls,callsAfterFirst);
});

test('history mode degrades failed reference venue instead of failing whole request', async () => {
  const store=createSnapshotStore({clock:{now:()=>10000}});
  const snap=store.create({dataCutoff:10000,universe:[{symbol:'BTCUSDT',bybitSpot:false,binanceSpot:true,binancePerp:false}]});
  const bybit={async getKlines(){return [['9000','1','1','1','101']];}};
  const binance={async getSpotKlines(){throw new Error('binance_down');}};
  const service=createCrossMarketService({bybit,binance,snapshotStore:store});
  const out=await service.getCrossMarketData({snapshotId:snap.snapshotId,symbols:['BTCUSDT'],mode:'history',timeframe:'1h',startMs:8000,endMs:9000});
  assert.equal(out.rows[0].bybitPerpPrice,101);
  assert.equal(out.coverage.BTCUSDT.binanceSpot.state,'UNAVAILABLE');
  assert.equal(out.coverage.BTCUSDT.binanceSpot.reason,'binance_down');
});
