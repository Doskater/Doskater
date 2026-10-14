import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../app.js';
import { assertNeutralPayload } from '../schema-guard.js';

async function rpc(base, method, params = {}) {
  const response = await fetch(`${base}/mcp`, {
    method:'POST',
    headers:{authorization:'Bearer secret','content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})
  });
  return response.json();
}

function fixtureClients() {
  const bybit = {
    async listLinearInstruments(){ return [{symbol:'BTCUSDT',status:'Trading',quoteCoin:'USDT',settleCoin:'USDT',contractType:'LinearPerpetual',launchTime:'1'}]; },
    async listSpotInstruments(){ return [{symbol:'BTCUSDT',status:'Trading'}]; },
    async getLinearTickers(){ return [{symbol:'BTCUSDT',lastPrice:'101',turnover24h:'1000000',volume24h:'10000',bid1Price:'100.9',bid1Size:'5',ask1Price:'101.1',ask1Size:'5',markPrice:'101',indexPrice:'100',openInterest:'1000',fundingRate:'0.0001',nextFundingTime:'999999'}]; },
    async getSpotTickers(){ return [{symbol:'BTCUSDT',lastPrice:'100',bid1Price:'99.9',ask1Price:'100.1'}]; },
    async getKlines(){ return [['9000','99','102','98','101','10','1000']]; },
    async getOpenInterest(){ return {list:[{timestamp:'9000',openInterest:'1000'}],nextPageCursor:''}; },
    async getFundingHistory(){ return [{fundingRateTimestamp:'9000',fundingRate:'0.0001'}]; },
    async getMarkPriceKlines(){ return [['9000','101','101','101','101']]; },
    async getIndexPriceKlines(){ return [['9000','100','100','100','100']]; },
    async getSpotKlines(){ return [['9000','100','100','100','100','1','100']]; }
  };
  const binance = {
    async getSpotExchangeInfo(){ return {symbols:[{symbol:'BTCUSDT',status:'TRADING'}]}; },
    async getFuturesExchangeInfo(){ return {symbols:[{symbol:'BTCUSDT',status:'TRADING'}]}; },
    async getSpotBookTickers(){ return [{symbol:'BTCUSDT',bidPrice:'99.8',askPrice:'100.2'}]; },
    async getFuturesBookTickers(){ return [{symbol:'BTCUSDT',bidPrice:'100.8',askPrice:'101.2'}]; },
    async getSpotKlines(){ return [[9000,'100','100','100','100','1',9000,'100']]; },
    async getFuturesKlines(){ return [[9000,'101','101','101','101','1',9000,'101']]; }
  };
  return {bybit,binance};
}

test('MCP full chain exposes seven neutral data tools through one snapshot', async t => {
  const {bybit,binance}=fixtureClients();
  const collector={ async ensureSymbols(){}, getNeutralBuckets(symbol){return {symbol,capturedAt:10000,families:{'bybit:linear':{coverage:{state:'GOOD'},buckets:[]}}};} };
  const clock={value:10000,now(){return this.value;}};
  const app=createApp({bybit,binance,microstructure:{collector},env:{DATA_PLANE_TOKEN:'secret'},clock});
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  t.after(()=>app.server.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;

  const discover=await rpc(base,'server/discover');
  assert.match(discover.result.instructions,/VALIDATE DATA/);
  const listed=await rpc(base,'tools/list');
  assert.equal(listed.result.tools.length,7);
  assert.equal(listed.result.tools.some(x=>/order|execute|trade/i.test(x.name)),false);

  const prepared=await rpc(base,'tools/call',{name:'prepare_snapshot',arguments:{}});
  const snapshotId=prepared.result.structuredContent.snapshotId;
  const calls=[
    ['source_health',{}],
    ['market_universe',{snapshotId}],
    ['historical_market_data',{snapshotId,symbols:['BTCUSDT'],timeframe:'1h',startMs:0}],
    ['historical_derivatives_data',{snapshotId,symbols:['BTCUSDT'],resolution:'5m',startMs:0,fields:['openInterest','fundingRate','markPrice','indexPrice','basisBps']}],
    ['cross_market_data',{snapshotId,symbols:['BTCUSDT'],mode:'snapshot'}],
    ['microstructure_data',{snapshotId,symbols:['BTCUSDT'],bucketMs:1000,lookbackMs:5000}]
  ];
  for (const [name,args] of calls) {
    const result=await rpc(base,'tools/call',{name,arguments:args});
    assert.equal(result.error,undefined,`${name}: ${JSON.stringify(result.error)}`);
    assert.doesNotThrow(()=>assertNeutralPayload(result.result.structuredContent));
  }
});
