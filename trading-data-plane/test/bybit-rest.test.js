import test from 'node:test';
import assert from 'node:assert/strict';
import { createBybitRestClient } from '../upstream/bybit-rest.js';

function response(json, status = 200, headers = {}) {
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('listLinearInstruments follows every nextPageCursor', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    const u = new URL(url);
    const cursor = u.searchParams.get('cursor');
    if (!cursor) return response({ retCode: 0, result: { list: [
      { symbol:'AAAUSDT', status:'Trading', quoteCoin:'USDT', settleCoin:'USDT', contractType:'LinearPerpetual', launchTime:'1' },
      { symbol:'BADUSDC', status:'Trading', quoteCoin:'USDC', settleCoin:'USDC', contractType:'LinearPerpetual' }
    ], nextPageCursor:'next' } });
    return response({ retCode: 0, result: { list: [
      { symbol:'BBBUSDT', status:'Trading', quoteCoin:'USDT', settleCoin:'USDT', contractType:'LinearPerpetual', launchTime:'2' },
      { symbol:'PENDINGUSDT', status:'PreLaunch', quoteCoin:'USDT', settleCoin:'USDT', contractType:'LinearPerpetual' }
    ], nextPageCursor:'' } });
  };
  const client = createBybitRestClient({ fetchImpl, retry: fn => fn() });
  const rows = await client.listLinearInstruments();
  assert.deepEqual(rows.map(x => x.symbol), ['AAAUSDT','BBBUSDT']);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /cursor=next/);
});

test('ticker methods return public result lists and record health', async () => {
  const samples = [];
  const health = { record(source, sample) { samples.push([source, sample]); } };
  const fetchImpl = async url => {
    const category = new URL(url).searchParams.get('category');
    return response({ retCode: 0, result: { list: [{ symbol: category === 'spot' ? 'BTCUSDT' : 'ETHUSDT', lastPrice:'1' }] } });
  };
  const client = createBybitRestClient({ fetchImpl, retry: fn => fn(), health });
  assert.equal((await client.getLinearTickers())[0].symbol, 'ETHUSDT');
  assert.equal((await client.getSpotTickers())[0].symbol, 'BTCUSDT');
  assert.ok(samples.every(([source, sample]) => source === 'bybit_rest' && sample.ok === true));
});

test('getKlines uses public kline endpoint and retries a transient 429', async () => {
  let attempts = 0;
  const fetchImpl = async url => {
    attempts += 1;
    if (attempts === 1) return new Response('{}', { status:429, headers:{ 'retry-after':'0' } });
    assert.match(String(url), /\/v5\/market\/kline/);
    return response({ retCode:0, result:{ list:[["1000","1","2","0.5","1.5","10","15"]] } });
  };
  const retry = async fn => {
    try { return await fn(); } catch (error) { assert.equal(error.status, 429); return fn(); }
  };
  const client = createBybitRestClient({ fetchImpl, retry });
  const rows = await client.getKlines({ symbol:'BTCUSDT', interval:'60', startMs:0, endMs:2000, limit:1000 });
  assert.equal(attempts, 2);
  assert.equal(rows[0][0], '1000');
});

test('getOpenInterest exposes pagination cursor and uses Bybit intervalTime', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    return response({ retCode:0, result:{ list:[{openInterest:'1',timestamp:'1000'}], nextPageCursor:'next' } });
  };
  const client = createBybitRestClient({ fetchImpl, retry:fn=>fn() });
  const out = await client.getOpenInterest({ symbol:'BTCUSDT', intervalTime:'5min', startMs:0, endMs:2000, cursor:'abc', limit:200 });
  assert.equal(out.nextPageCursor, 'next');
  assert.match(urls[0], /intervalTime=5min/);
  assert.match(urls[0], /cursor=abc/);
});
