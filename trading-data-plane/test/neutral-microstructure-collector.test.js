import test from 'node:test';
import assert from 'node:assert/strict';
import { createNeutralMicrostructureCollector } from '../microstructure/neutral-collector.js';
import { assertNeutralPayload } from '../schema-guard.js';

function fakeClock(start = 100_000) {
  return { value:start, now(){ return this.value; } };
}

function fakeFeed(family) {
  let handlers = {};
  const ensured = [];
  return {
    family,
    ensured,
    setHandlers(value){ handlers = value; },
    start(){}, stop(){},
    async ensureSymbol(symbol){ ensured.push(symbol); },
    removeSymbol(){},
    status(){ return { family, connected:true }; },
    emitTrade(event){ handlers.onTrade?.({ family, ...event }); },
    emitBook(event){ handlers.onBook?.({ family, ...event }); },
    emitLiquidation(event){ handlers.onLiquidation?.({ family, ...event }); },
    emitStatus(event){ handlers.onStatus?.({ family, ...event }); }
  };
}

test('builds only neutral 1s buckets from trades, books and liquidations', async () => {
  const clock = fakeClock();
  const feed = fakeFeed('bybit:linear');
  const collector = createNeutralMicrostructureCollector({ feeds:[feed], clock, coreSymbols:[] });
  await collector.start();
  await collector.ensureSymbols(['BTCUSDT']);
  feed.emitBook({ symbol:'BTCUSDT', ts:99_100, state:'healthy', sequence:1, bids:[[99,2],[98,3]], asks:[[101,2],[102,3]] });
  feed.emitTrade({ symbol:'BTCUSDT', eventTs:99_200, price:100, quantity:2, notional:200, aggressorSide:'buy' });
  feed.emitTrade({ symbol:'BTCUSDT', eventTs:99_700, price:101, quantity:1, notional:101, aggressorSide:'sell' });
  feed.emitLiquidation({ symbol:'BTCUSDT', eventTs:99_800, side:'sell', notional:50 });
  const out = collector.getNeutralBuckets('BTCUSDT', { bucketMs:1000, lookbackMs:2000 });
  const family = out.families['bybit:linear'];
  assert.equal(family.buckets.length, 1);
  const bucket = family.buckets[0];
  assert.equal(bucket.marketBuyNotional, 200);
  assert.equal(bucket.marketSellNotional, 101);
  assert.equal(bucket.marketBuyQty, 2);
  assert.equal(bucket.marketSellQty, 1);
  assert.equal(bucket.liquidationSellNotional, 50);
  assert.equal(bucket.bestBid, 99);
  assert.equal(bucket.bestAsk, 101);
  assert.ok(bucket.bidDepth10bps >= 0);
  assert.equal('causalSummary' in bucket, false);
  assert.equal('impactAsymmetry' in bucket, false);
  assert.equal('refill' in bucket, false);
  assert.doesNotThrow(() => assertNeutralPayload(out));
});

test('sequence gap invalidates family buffers until a clean healthy rebuild', async () => {
  const clock = fakeClock();
  const feed = fakeFeed('binance:perp');
  const collector = createNeutralMicrostructureCollector({ feeds:[feed], clock, coreSymbols:[], warmupMs:5000 });
  await collector.start(); await collector.ensureSymbols(['BTCUSDT']);
  feed.emitBook({ symbol:'BTCUSDT', ts:95_000, state:'healthy', sequence:10, bids:[[99,1]], asks:[[101,1]] });
  clock.value = 100_100;
  let out = collector.getNeutralBuckets('BTCUSDT', { bucketMs:1000, lookbackMs:5000 });
  assert.equal(out.families['binance:perp'].coverage.state, 'GOOD');
  feed.emitBook({ symbol:'BTCUSDT', ts:100_200, state:'unhealthy', reason:'sequence_gap', sequence:20 });
  out = collector.getNeutralBuckets('BTCUSDT', { bucketMs:1000, lookbackMs:5000 });
  assert.equal(out.families['binance:perp'].coverage.state, 'UNAVAILABLE');
  assert.equal(out.families['binance:perp'].buckets.length, 0);
  feed.emitBook({ symbol:'BTCUSDT', ts:100_300, state:'healthy', sequence:1, bids:[[100,1]], asks:[[102,1]] });
  out = collector.getNeutralBuckets('BTCUSDT', { bucketMs:1000, lookbackMs:5000 });
  assert.equal(out.families['binance:perp'].coverage.state, 'WARMING_UP');
  clock.value = 105_400;
  feed.emitBook({ symbol:'BTCUSDT', ts:105_400, state:'healthy', sequence:2, bids:[[101,1]], asks:[[103,1]] });
  out = collector.getNeutralBuckets('BTCUSDT', { bucketMs:1000, lookbackMs:5000 });
  assert.equal(out.families['binance:perp'].coverage.state, 'GOOD');
});

test('does not rebuild already-active subscriptions when TTL is refreshed', async () => {
  const clock = fakeClock();
  const feed = fakeFeed('bybit:linear');
  const collector = createNeutralMicrostructureCollector({ feeds:[feed], clock, coreSymbols:[] });
  await collector.start();
  await collector.ensureSymbols(['BTCUSDT']);
  await collector.ensureSymbols(['BTCUSDT']);
  assert.deepEqual(feed.ensured, ['BTCUSDT']);
});
