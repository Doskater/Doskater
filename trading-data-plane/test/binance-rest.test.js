import test from 'node:test';
import assert from 'node:assert/strict';
import { createBinanceRestClient } from '../upstream/binance-rest.js';

const jsonResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

test('loads spot and futures exchange info independently', async () => {
  const fetchImpl = async url => {
    const s = String(url);
    if (s.includes('/fapi/')) return jsonResponse({ symbols: [{ symbol:'BTCUSDT', status:'TRADING', quoteAsset:'USDT', contractType:'PERPETUAL' }] });
    return jsonResponse({ symbols: [{ symbol:'ETHUSDT', status:'TRADING', quoteAsset:'USDT' }] });
  };
  const client = createBinanceRestClient({ fetchImpl, retry: fn => fn() });
  assert.equal((await client.getSpotExchangeInfo()).symbols[0].symbol, 'ETHUSDT');
  assert.equal((await client.getFuturesExchangeInfo()).symbols[0].symbol, 'BTCUSDT');
});

test('book ticker methods normalize endpoint arrays and record separate source health', async () => {
  const sources = [];
  const health = { record(source, sample) { if (sample.ok) sources.push(source); } };
  const fetchImpl = async url => jsonResponse([{ symbol:'BTCUSDT', bidPrice:'100', bidQty:'2', askPrice:'101', askQty:'3' }]);
  const client = createBinanceRestClient({ fetchImpl, retry: fn => fn(), health });
  assert.equal((await client.getSpotBookTickers()).length, 1);
  assert.equal((await client.getFuturesBookTickers()).length, 1);
  assert.deepEqual(sources.sort(), ['binance_futures_rest','binance_spot_rest']);
});

test('spot and futures kline methods hit their independent public endpoints', async () => {
  const urls = [];
  const fetchImpl = async url => { urls.push(String(url)); return jsonResponse([[1000,'1','2','0.5','1.5','10']]); };
  const client = createBinanceRestClient({ fetchImpl, retry:fn=>fn() });
  await client.getSpotKlines({ symbol:'BTCUSDT', interval:'1h', startMs:0, endMs:2000, limit:1000 });
  await client.getFuturesKlines({ symbol:'BTCUSDT', interval:'1h', startMs:0, endMs:2000, limit:1000 });
  assert.match(urls[0], /\/api\/v3\/klines/);
  assert.match(urls[1], /\/fapi\/v1\/klines/);
});
