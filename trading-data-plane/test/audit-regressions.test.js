import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotStore } from '../snapshot-store.js';
import { createMarketHistoryService } from '../services/market-history-service.js';
import { createDerivativesService } from '../services/derivatives-service.js';
import { createCrossMarketService } from '../services/cross-market-service.js';
import { createSourceHealth } from '../source-health.js';
import { createNeutralMicrostructureCollector } from '../microstructure/neutral-collector.js';
import { TOOL_DEFINITIONS } from '../tool-definitions.js';
const cutoff=7_500_000;
function setup(){const store=createSnapshotStore({clock:{now:()=>cutoff}});const snap=store.create({dataCutoff:cutoff,universe:[{symbol:'BTCUSDT',binancePerp:true}]});return {store,snap};}
const candles=[['7200000','1','2','1','2','1','1'],['3600000','1','1','1','1','1','1']];
test('history excludes a candle whose close occurs after the analysis cutoff',async()=>{
 const {store,snap}=setup();const service=createMarketHistoryService({snapshotStore:store,bybit:{async getKlines(){return candles;}}});
 const out=await service.getHistoricalMarketData({snapshotId:snap.snapshotId,symbols:['BTCUSDT'],timeframe:'1h',startMs:3600000});
 assert.deepEqual(out.rows.map(x=>x.timestamp),[3600000]);
});
test('derivatives exclude unfinished mark/index candles but retain observed OI',async()=>{
 const {store,snap}=setup();const service=createDerivativesService({snapshotStore:store,bybit:{async getMarkPriceKlines(){return candles;},async getIndexPriceKlines(){return candles;},async getOpenInterest(){return {list:[{timestamp:7200000,openInterest:10}]};}}});
 const out=await service.getHistoricalDerivativesData({snapshotId:snap.snapshotId,symbols:['BTCUSDT'],resolution:'1h',startMs:3600000,fields:['markPrice','indexPrice','openInterest']});
 assert.equal(out.rows.find(x=>x.timestamp===7200000).markPrice,null);
 assert.equal(out.rows.find(x=>x.timestamp===3600000).markPrice,1);
});
test('cross-market history excludes unfinished candles at both venues',async()=>{
 const {store,snap}=setup();const service=createCrossMarketService({snapshotStore:store,bybit:{async getKlines(){return candles;}},binance:{async getFuturesKlines(){return candles;}}});
 const out=await service.getCrossMarketData({snapshotId:snap.snapshotId,symbols:['BTCUSDT'],mode:'history',timeframe:'1h',startMs:3600000});
 assert.deepEqual(out.rows.map(x=>x.timestamp),[3600000]);
});
test('empty OI and reference history cannot claim FULL coverage',async()=>{
 const {store,snap}=setup();const derivatives=createDerivativesService({snapshotStore:store,bybit:{async getOpenInterest(){return {list:[]};}}});
 const d=await derivatives.getHistoricalDerivativesData({snapshotId:snap.snapshotId,symbols:['BTCUSDT'],resolution:'1h',fields:['openInterest']});
 assert.equal(d.coverage.BTCUSDT.openInterest.state,'UNAVAILABLE');
 const cross=createCrossMarketService({snapshotStore:store,bybit:{async getKlines(){return [];}},binance:{async getFuturesKlines(){return [];}}});
 const c=await cross.getCrossMarketData({snapshotId:snap.snapshotId,symbols:['BTCUSDT'],mode:'history',timeframe:'1h'});
 assert.equal(c.coverage.BTCUSDT.binancePerp.state,'UNAVAILABLE');
});
test('a failure after a fresh success must remain visible in source health',()=>{
 const health=createSourceHealth({clock:{now:()=>1000}});health.record('bybit_rest',{ok:true});health.record('bybit_rest',{ok:false,reason:'timeout'});
 assert.equal(health.snapshot().bybit_rest.state,'DEGRADED');assert.equal(health.snapshot().bybit_rest.reason,'timeout');
});
test('single-character Bybit tickers are accepted by the schema and collector',async()=>{
 const schema=TOOL_DEFINITIONS.find(x=>x.name==='historical_market_data').inputSchema.properties.symbols.items;
 assert.ok(new RegExp(schema.pattern).test('SUSDT'));
 const collector=createNeutralMicrostructureCollector({coreSymbols:[]});
 await collector.ensureSymbols(['SUSDT']);assert.ok(collector.getStatus().activeSymbols.includes('SUSDT'));
});

test('five seconds of healthy books cannot claim a complete two-minute window',async()=>{
 let handlers;const clock={value:10000,now(){return this.value;}};
 const feed={family:'bybit:linear',setHandlers(h){handlers=h;},async ensureSymbol(){}};
 const collector=createNeutralMicrostructureCollector({feeds:[feed],coreSymbols:[],clock});
 await collector.ensureSymbols(['BTCUSDT']);
 handlers.onBook({family:'bybit:linear',symbol:'BTCUSDT',ts:10000,state:'healthy',bids:[[99,1]],asks:[[101,1]]});
 clock.value=15000;
 handlers.onBook({family:'bybit:linear',symbol:'BTCUSDT',ts:15000,state:'healthy',bids:[[99,1]],asks:[[101,1]]});
 const cov=collector.getNeutralBuckets('BTCUSDT',{lookbackMs:120000}).families['bybit:linear'].coverage;
 assert.equal(cov.fullWindowCovered,false);assert.equal(cov.state,'PARTIAL');assert.equal(cov.observedDurationMs,5000);
});
