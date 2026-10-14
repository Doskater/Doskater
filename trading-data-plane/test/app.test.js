import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';

test('createApp wires source_health and prepare_snapshot tool handlers', async () => {
  const clock = { value: 1234, now() { return this.value; } };
  const bybit = { async captureUniverse(cutoff) { return [{ symbol: 'BTCUSDT', cutoff }]; } };
  const app = createApp({ bybit, binance: {}, microstructure: {}, env: { DATA_PLANE_TOKEN: 'secret' }, clock });
  const health = await app.toolHandlers.source_health({});
  assert.equal(typeof health, 'object');
  const snap = await app.toolHandlers.prepare_snapshot({});
  assert.equal(snap.dataCutoff, 1234);
  assert.equal(snap.universeCount, 1);
});

test('createApp wires snapshot-backed market_universe when REST-style clients are provided', async () => {
  const clock = { now: () => 5000 };
  const bybit = {
    async listLinearInstruments() { return [{ symbol:'BTCUSDT', launchTime:'1' }]; },
    async listSpotInstruments() { return []; },
    async getLinearTickers() { return [{ symbol:'BTCUSDT', lastPrice:'10' }]; }
  };
  const binance = {
    async getSpotExchangeInfo() { return { symbols:[] }; },
    async getFuturesExchangeInfo() { return { symbols:[] }; }
  };
  const app = createApp({ bybit, binance, env:{ DATA_PLANE_TOKEN:'x' }, clock });
  const snap = await app.toolHandlers.prepare_snapshot({});
  const page = await app.toolHandlers.market_universe({ snapshotId:snap.snapshotId });
  assert.equal(page.rows[0].symbol, 'BTCUSDT');
  assert.equal(page.snapshotId, snap.snapshotId);
});

test('createApp wires historical_market_data when Bybit kline method exists', async () => {
  const clock = { now: () => 10_000 };
  const bybit = {
    async listLinearInstruments() { return [{ symbol:'BTCUSDT', launchTime:'1' }]; },
    async listSpotInstruments() { return []; },
    async getLinearTickers() { return [{ symbol:'BTCUSDT', lastPrice:'10' }]; },
    async getKlines() { return [['9000','1','2','0.5','1.5','10','15']]; }
  };
  const binance = { async getSpotExchangeInfo(){ return {symbols:[]}; }, async getFuturesExchangeInfo(){ return {symbols:[]}; } };
  const app = createApp({ bybit, binance, env:{DATA_PLANE_TOKEN:'x'}, clock });
  const snap = await app.toolHandlers.prepare_snapshot({});
  const history = await app.toolHandlers.historical_market_data({ snapshotId:snap.snapshotId, symbols:['BTCUSDT'], timeframe:'1h', startMs:0 });
  assert.equal(history.rows[0].close, 1.5);
});

test('createApp wires historical_derivatives_data when derivatives methods exist', async () => {
  const clock = { now:() => 10_000 };
  const bybit = {
    async listLinearInstruments(){ return [{symbol:'BTCUSDT',launchTime:'1'}]; }, async listSpotInstruments(){ return []; }, async getLinearTickers(){ return [{symbol:'BTCUSDT'}]; },
    async getOpenInterest(){ return {list:[{openInterest:'2',timestamp:'9000'}],nextPageCursor:''}; },
    async getFundingHistory(){ return []; }, async getMarkPriceKlines(){ return []; }, async getIndexPriceKlines(){ return []; }
  };
  const binance = { async getSpotExchangeInfo(){return {symbols:[]}}, async getFuturesExchangeInfo(){return {symbols:[]}} };
  const app = createApp({ bybit, binance, env:{DATA_PLANE_TOKEN:'x'}, clock });
  const snap = await app.toolHandlers.prepare_snapshot({});
  const out = await app.toolHandlers.historical_derivatives_data({ snapshotId:snap.snapshotId, symbols:['BTCUSDT'], resolution:'5m', startMs:0, fields:['openInterest'] });
  assert.equal(out.rows[0].openInterest, 2);
});

test('createApp wires snapshot-mode cross_market_data from captured quote maps', async () => {
  const clock = { now:() => 10_000 };
  const bybit = {
    async listLinearInstruments(){ return [{symbol:'BTCUSDT',launchTime:'1'}]; }, async listSpotInstruments(){ return [{symbol:'BTCUSDT',status:'Trading'}]; },
    async getLinearTickers(){ return [{symbol:'BTCUSDT',lastPrice:'101'}]; }, async getSpotTickers(){ return [{symbol:'BTCUSDT',lastPrice:'100'}]; }
  };
  const binance = {
    async getSpotExchangeInfo(){return {symbols:[]}}, async getFuturesExchangeInfo(){return {symbols:[]}},
    async getSpotBookTickers(){return []}, async getFuturesBookTickers(){return []}
  };
  const app = createApp({ bybit, binance, env:{DATA_PLANE_TOKEN:'x'}, clock });
  const snap = await app.toolHandlers.prepare_snapshot({});
  const out = await app.toolHandlers.cross_market_data({ snapshotId:snap.snapshotId, symbols:['BTCUSDT'], mode:'snapshot' });
  assert.equal(out.rows[0].bybitPerp.lastPrice, 101);
  assert.equal(out.rows[0].bybitSpot.lastPrice, 100);
});

test('createApp wires microstructure_data when a neutral collector is injected', async () => {
  const clock = { value:10_000, now(){ return this.value; } };
  const bybit = { async captureUniverse(){ return [{symbol:'BTCUSDT'}]; } };
  const collector = { async ensureSymbols(){}, getNeutralBuckets(symbol){ return {symbol,families:{}}; } };
  const app = createApp({ bybit, binance:{}, microstructure:{ collector }, env:{DATA_PLANE_TOKEN:'x'}, clock });
  const snap = await app.toolHandlers.prepare_snapshot({});
  clock.value = 11_000;
  const out = await app.toolHandlers.microstructure_data({ snapshotId:snap.snapshotId, symbols:['BTCUSDT'], bucketMs:1000, lookbackMs:5000 });
  assert.equal(out.analysisCutoff, 10_000);
  assert.equal(out.microstructureCapturedAt, 11_000);
});

test('createApp builds cloud public microstructure when no collector is injected', async () => {
  const sockets=[];
  const websocketFactory=url=>{
    const listeners=new Map();
    const socket={url,sent:[],readyState:0,on(n,f){listeners.set(n,f)},send(v){this.sent.push(JSON.parse(String(v)))},close(){this.readyState=3;listeners.get('close')?.()},open(){this.readyState=1;listeners.get('open')?.()}};
    sockets.push(socket); return socket;
  };
  const bybit={ async captureUniverse(){ return [{symbol:'BTCUSDT'},{symbol:'ETHUSDT'},{symbol:'SOLUSDT'}]; } };
  const app=createApp({bybit,binance:{},microstructure:{websocketFactory},env:{DATA_PLANE_TOKEN:'x'}});
  assert.ok(app.services.microstructureService);
  await app.start();
  assert.equal(sockets.length,4);
  sockets.forEach(x=>x.open());
  assert.ok(sockets.every(x=>x.sent.length>0));
  await app.stop();
  assert.ok(sockets.every(x=>x.readyState===3));
});
