import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAggressorImbalance,
  computeRefill,
  computeLiquidityVoid,
  computePriceImpact,
  computeImpactAsymmetry,
  computeLiquidationResponse,
  computeLeadLag,
  buildCausalSummary
} from '../features.js';

const trade = (ts, side, notional) => ({ ts, eventTs: ts, side, notional, price: 100, qty: notional / 100 });
const mid = (ts, value) => ({ ts, mid: value });

test('aggressor imbalance returns raw notionals and normalized imbalance', () => {
  const r = computeAggressorImbalance([trade(1,'buy',300), trade(2,'sell',100)]);
  assert.equal(r.buyNotional, 300);
  assert.equal(r.sellNotional, 100);
  assert.equal(r.totalNotional, 400);
  assert.equal(r.imbalance, 0.5);
  assert.equal(r.quality, 'ok');
});

test('tiny aggressor window is explicitly low volume', () => {
  const r = computeAggressorImbalance([trade(1,'buy',2)], { minNotional: 1000 });
  assert.equal(r.totalNotional, 2);
  assert.equal(r.imbalance, 1);
  assert.equal(r.quality, 'low_volume');
});

test('refill measures recovery half-life and absorption direction', () => {
  const samples = [
    { ts: 0, healthy: true, bidNotional: 1000, askNotional: 1000 },
    { ts: 100, healthy: true, bidNotional: 400, askNotional: 900 },
    { ts: 200, healthy: true, bidNotional: 750, askNotional: 910 },
    { ts: 400, healthy: true, bidNotional: 950, askNotional: 920 }
  ];
  const r = computeRefill(samples);
  assert.ok(r.bid.refillRatio > 0.9);
  assert.equal(r.bid.halfLifeMs, 100);
  assert.ok(r.ask.refillRatio < 0.3);
  assert.equal(r.absorptionDirection, 'buy');
  assert.equal(r.quality, 'ok');
});

test('refill refuses to claim quality from invalid book samples', () => {
  const r = computeRefill([{ ts: 0, healthy: false, bidNotional: 10, askNotional: 10 }]);
  assert.equal(r.quality, 'invalid_book');
  assert.equal(r.bid.refillRatio, null);
});

test('liquidity void separates passive withdrawal from executed depletion', () => {
  const samples = [
    { ts: 0, healthy: true, bidNotional: 1000, askNotional: 1000, spread: 1 },
    { ts: 1000, healthy: true, bidNotional: 900, askNotional: 400, spread: 2 }
  ];
  const passive = computeLiquidityVoid(samples, [trade(500, 'buy', 50)]);
  const executed = computeLiquidityVoid(samples, [trade(500, 'buy', 550)]);
  assert.ok(passive.upVoidScore > executed.upVoidScore);
  assert.ok(passive.upVoidScore > 0.4);
  assert.equal(passive.quality, 'ok');
});

test('price impact reports bps per standardized notional and sample sizes', () => {
  const trades = [trade(100,'buy',100000), trade(300,'sell',200000)];
  const mids = [mid(0,100), mid(150,101), mid(250,101), mid(350,100)];
  const r = computePriceImpact(trades, mids, { standardNotional: 100000, minNotional: 1000 });
  assert.ok(r.buy.bpsPerStandardNotional > 90);
  assert.ok(r.sell.bpsPerStandardNotional > 40);
  assert.equal(r.buy.notional, 100000);
  assert.equal(r.sell.notional, 200000);
  assert.equal(r.quality, 'ok');
});

test('impact asymmetry identifies the more efficient side', () => {
  assert.equal(computeImpactAsymmetry({ buy: { bpsPerStandardNotional: 12 }, sell: { bpsPerStandardNotional: 3 }, quality: 'ok' }).direction, 'buy_more_efficient');
  assert.equal(computeImpactAsymmetry({ buy: { bpsPerStandardNotional: 2 }, sell: { bpsPerStandardNotional: 10 }, quality: 'ok' }).direction, 'sell_more_efficient');
});

test('liquidation response distinguishes continuation from absorbed long-liquidation burst', () => {
  const liqs = [{ eventTs: 100, ts: 100, side: 'long', notional: 100000 }];
  const continuation = computeLiquidationResponse(liqs, [mid(0,100), mid(200,98)], { thresholdBps: 50 });
  const absorbed = computeLiquidationResponse(liqs, [mid(0,100), mid(200,100.2)], { thresholdBps: 50 });
  assert.equal(continuation.classification, 'continuation');
  assert.equal(absorbed.classification, 'absorbed');
});

test('lead lag identifies stable first breaker and refuses unstable evidence', () => {
  const leader = computeLeadLag({
    'binance:spot': [mid(0,100), mid(100,100.2)],
    'bybit:perp': [mid(0,100), mid(350,100.2)]
  }, { thresholdBps: 10, minLeadMs: 100 });
  assert.equal(leader.leader, 'binance:spot');
  assert.equal(leader.lagMs, 250);

  const unstable = computeLeadLag({
    a: [mid(0,100), mid(100,100.2)],
    b: [mid(0,100), mid(120,100.2)]
  }, { thresholdBps: 10, minLeadMs: 100 });
  assert.equal(unstable.leader, 'no_clear_leader');
});

test('causal summary compresses correlated features and exposes contradiction', () => {
  const r = buildCausalSummary({
    leadLag: { leader: 'binance:spot', lagMs: 200, quality: 'ok' },
    aggressor: { imbalance: 0.7, totalNotional: 200000, quality: 'ok' },
    refill: { absorptionDirection: 'sell', quality: 'ok' },
    void: { upVoidScore: 0.1, downVoidScore: 0.1, quality: 'ok' },
    impactAsymmetry: { direction: 'buy_more_efficient', quality: 'ok' }
  });
  assert.match(r.summary, /binance:spot/);
  assert.match(r.summary, /buy/i);
  assert.match(r.strongestContradiction, /sell/i);
});
