import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotStore } from '../snapshot-store.js';
import { createUniverseService } from '../services/universe-service.js';

function makeRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    symbol: `X${i}USDT`, status:'Trading', quoteCoin:'USDT', settleCoin:'USDT', contractType:'LinearPerpetual', launchTime:String(i)
  }));
}

test('capture keeps Bybit-only contracts and exposes independent venue availability', async () => {
  const bybit = {
    async listLinearInstruments() { return [
      { symbol:'BTCUSDT', launchTime:'1' },
      { symbol:'ONLYUSDT', launchTime:'2' }
    ]; },
    async listSpotInstruments() { return [{ symbol:'BTCUSDT', status:'Trading' }]; },
    async getLinearTickers() { return [
      { symbol:'BTCUSDT', lastPrice:'100', turnover24h:'1000', volume24h:'10', bid1Price:'99', bid1Size:'4', ask1Price:'101', ask1Size:'5', markPrice:'100.5', indexPrice:'100.2', openInterest:'50', fundingRate:'0.001', nextFundingTime:'9999' },
      { symbol:'ONLYUSDT', lastPrice:'2', turnover24h:'20', volume24h:'10', bid1Price:'1.9', bid1Size:'3', ask1Price:'2.1', ask1Size:'4', markPrice:'2', indexPrice:'2', openInterest:'10', fundingRate:'bad', nextFundingTime:'' }
    ]; }
  };
  const binance = {
    async getSpotExchangeInfo() { return { symbols:[{ symbol:'BTCUSDT', status:'TRADING', quoteAsset:'USDT' }] }; },
    async getFuturesExchangeInfo() { return { symbols:[{ symbol:'BTCUSDT', status:'TRADING', quoteAsset:'USDT', contractType:'PERPETUAL' }] }; }
  };
  const service = createUniverseService({ bybit, binance });
  const rows = await service.capture(1234);
  assert.equal(rows.length, 2);
  const btc = rows.find(x => x.symbol === 'BTCUSDT');
  assert.deepEqual([btc.bybitSpot, btc.binanceSpot, btc.binancePerp], [true,true,true]);
  assert.equal(btc.bid1Size, 4);
  const only = rows.find(x => x.symbol === 'ONLYUSDT');
  assert.deepEqual([only.bybitSpot, only.binanceSpot, only.binancePerp], [false,false,false]);
  assert.equal(only.fundingRate, null);
});

test('market universe paginates only stored snapshot rows even above 1000 instruments', async () => {
  const clock = { now: () => 1000 };
  const store = createSnapshotStore({ clock });
  const universe = makeRows(1005);
  const snap = store.create({ dataCutoff: 1000, universe });
  const service = createUniverseService({ bybit:{}, binance:{}, snapshotStore:store });
  const first = service.getUniverse({ snapshotId:snap.snapshotId, limit:1000 });
  assert.equal(first.rows.length, 1000);
  assert.ok(first.nextCursor);
  const second = service.getUniverse({ snapshotId:snap.snapshotId, cursor:first.nextCursor, limit:1000 });
  assert.equal(second.rows.length, 5);
  assert.equal(second.rows[0].symbol, 'X1000USDT');
});

test('Binance outage degrades reference coverage without dropping valid Bybit contracts', async () => {
  const bybit = {
    async listLinearInstruments() { return [{ symbol:'BTCUSDT', launchTime:'1' }]; },
    async listSpotInstruments() { return []; },
    async getLinearTickers() { return [{ symbol:'BTCUSDT', lastPrice:'100' }]; }
  };
  const binance = {
    async getSpotExchangeInfo() { throw new Error('binance_down'); },
    async getFuturesExchangeInfo() { throw new Error('binance_down'); }
  };
  const service = createUniverseService({ bybit, binance });
  const rows = await service.capture(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'BTCUSDT');
  assert.equal(rows[0].binanceSpot, false);
  assert.equal(rows[0].binancePerp, false);
});

test('captureBundle stores neutral quote maps for later snapshot-mode cross-market reads', async () => {
  const bybit = {
    async listLinearInstruments(){ return [{symbol:'BTCUSDT',launchTime:'1'}]; }, async listSpotInstruments(){ return [{symbol:'BTCUSDT',status:'Trading'}]; },
    async getLinearTickers(){ return [{symbol:'BTCUSDT',lastPrice:'101',bid1Price:'100',bid1Size:'2',ask1Price:'102',ask1Size:'3',markPrice:'101',indexPrice:'100'}]; },
    async getSpotTickers(){ return [{symbol:'BTCUSDT',lastPrice:'100',bid1Price:'99',bid1Size:'1',ask1Price:'101',ask1Size:'2'}]; }
  };
  const binance = {
    async getSpotExchangeInfo(){ return {symbols:[{symbol:'BTCUSDT',status:'TRADING',quoteAsset:'USDT'}]}; },
    async getFuturesExchangeInfo(){ return {symbols:[{symbol:'BTCUSDT',status:'TRADING',quoteAsset:'USDT',contractType:'PERPETUAL'}]}; },
    async getSpotBookTickers(){ return [{symbol:'BTCUSDT',bidPrice:'99.5',bidQty:'4',askPrice:'100.5',askQty:'5'}]; },
    async getFuturesBookTickers(){ return [{symbol:'BTCUSDT',bidPrice:'100',bidQty:'6',askPrice:'101',askQty:'7'}]; }
  };
  const service = createUniverseService({ bybit, binance });
  const bundle = await service.captureBundle(123);
  assert.equal(bundle.universe.length, 1);
  assert.equal(bundle.crossQuotes.bybitSpot.BTCUSDT.lastPrice, 100);
  assert.equal(bundle.crossQuotes.binanceSpot.BTCUSDT.bidPrice, 99.5);
  assert.equal(bundle.crossQuotes.binancePerp.BTCUSDT.askSize, 7);
});
