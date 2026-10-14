import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';

function json(body){ return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}}); }

test('createApp constructs public REST clients when none are injected', async () => {
  const fetchImpl=async url=>{
    const u=new URL(url);
    if(u.hostname==='api.bybit.com' && u.pathname==='/v5/market/instruments-info' && u.searchParams.get('category')==='linear') return json({retCode:0,result:{list:[{symbol:'BTCUSDT',status:'Trading',quoteCoin:'USDT',settleCoin:'USDT',contractType:'LinearPerpetual',launchTime:'1'}],nextPageCursor:''}});
    if(u.hostname==='api.bybit.com' && u.pathname==='/v5/market/instruments-info') return json({retCode:0,result:{list:[{symbol:'BTCUSDT',status:'Trading',quoteCoin:'USDT'}]}});
    if(u.hostname==='api.bybit.com' && u.pathname==='/v5/market/tickers' && u.searchParams.get('category')==='linear') return json({retCode:0,result:{list:[{symbol:'BTCUSDT',lastPrice:'100'}]}});
    if(u.hostname==='api.bybit.com' && u.pathname==='/v5/market/tickers') return json({retCode:0,result:{list:[{symbol:'BTCUSDT',lastPrice:'99'}]}});
    if(u.hostname==='api.binance.com' && u.pathname==='/api/v3/exchangeInfo') return json({symbols:[{symbol:'BTCUSDT',status:'TRADING'}]});
    if(u.hostname==='fapi.binance.com' && u.pathname==='/fapi/v1/exchangeInfo') return json({symbols:[{symbol:'BTCUSDT',status:'TRADING'}]});
    if(u.hostname==='api.binance.com' && u.pathname==='/api/v3/ticker/bookTicker') return json([{symbol:'BTCUSDT',bidPrice:'98.9',askPrice:'99.1'}]);
    if(u.hostname==='fapi.binance.com' && u.pathname==='/fapi/v1/ticker/bookTicker') return json([{symbol:'BTCUSDT',bidPrice:'99.9',askPrice:'100.1'}]);
    throw new Error(`unexpected_url:${url}`);
  };
  const app=createApp({fetchImpl,microstructure:{collector:{async ensureSymbols(){},getNeutralBuckets(){return {families:{}};}}},env:{DATA_PLANE_TOKEN:'x'},clock:{now:()=>10000}});
  const snap=await app.toolHandlers.prepare_snapshot({});
  const universe=await app.toolHandlers.market_universe({snapshotId:snap.snapshotId});
  assert.equal(universe.rows[0].symbol,'BTCUSDT');
  const health=await app.toolHandlers.source_health({});
  assert.equal(health.bybit_rest.state,'GOOD');
  assert.equal(health.binance_spot_rest.state,'GOOD');
  assert.equal(health.binance_futures_rest.state,'GOOD');
});
