import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTrade,
  normalizeBookDelta,
  normalizeLiquidation,
  fromBinanceAggTrade,
  fromBybitPublicTrade,
  fromBinanceLiquidation,
  fromBybitLiquidation
} from '../normalizers.js';

test('normalizes generic trade and calculates notional', () => {
  const trade = normalizeTrade({ venue: 'x', market: 'spot', symbol: 'btcusdt', eventTs: 100, receiveTs: 110, price: '10', qty: '2.5', side: 'buy' });
  assert.deepEqual(trade, { venue: 'x', market: 'spot', symbol: 'BTCUSDT', eventTs: 100, receiveTs: 110, price: 10, qty: 2.5, notional: 25, side: 'buy' });
});

test('maps Binance maker flag to taker aggressor side', () => {
  assert.equal(fromBinanceAggTrade({ e: 'aggTrade', E: 101, s: 'BTCUSDT', p: '100', q: '2', T: 99, m: true }, { market: 'perp', receiveTs: 120 }).side, 'sell');
  assert.equal(fromBinanceAggTrade({ e: 'aggTrade', E: 101, s: 'BTCUSDT', p: '100', q: '2', T: 99, m: false }, { market: 'spot', receiveTs: 120 }).side, 'buy');
});

test('maps Bybit public trade taker side and preserves fill timestamp', () => {
  const trade = fromBybitPublicTrade({ T: 222, s: 'ETHUSDT', S: 'Sell', v: '3', p: '4' }, { market: 'linear', receiveTs: 230 });
  assert.equal(trade.side, 'sell');
  assert.equal(trade.eventTs, 222);
  assert.equal(trade.notional, 12);
});

test('normalizes book deltas with sequence metadata', () => {
  const delta = normalizeBookDelta({ venue: 'binance', market: 'spot', symbol: 'BTCUSDT', eventTs: 1, receiveTs: 2, bids: [['100','2']], asks: [['101','3']], firstUpdateId: 10, finalUpdateId: 12, previousFinalUpdateId: 9 });
  assert.equal(delta.firstUpdateId, 10);
  assert.equal(delta.finalUpdateId, 12);
  assert.deepEqual(delta.bids, [[100, 2]]);
});

test('normalizes liquidation side as liquidated position side across venues', () => {
  const binLong = fromBinanceLiquidation({ e: 'forceOrder', E: 1, o: { s: 'BTCUSDT', S: 'SELL', p: '100', ap: '99', q: '2', z: '2', T: 1 } }, { receiveTs: 2 });
  const bybitLong = fromBybitLiquidation({ T: 1, s: 'BTCUSDT', S: 'Buy', v: '2', p: '100' }, { receiveTs: 2 });
  assert.equal(binLong.side, 'long');
  assert.equal(bybitLong.side, 'long');
  assert.equal(binLong.notional, 198);
  assert.equal(bybitLong.notional, 200);
});

test('rejects malformed or negative numeric values', () => {
  assert.throws(() => normalizeTrade({ venue: 'x', market: 'spot', symbol: 'BTCUSDT', eventTs: 1, receiveTs: 2, price: '-1', qty: '2', side: 'buy' }), /invalid_price/);
  assert.throws(() => normalizeBookDelta({ venue: 'x', market: 'spot', symbol: 'BTCUSDT', eventTs: 1, receiveTs: 2, bids: [['100','-2']], asks: [] }), /invalid_level/);
  assert.throws(() => normalizeLiquidation({ venue: 'x', market: 'perp', symbol: 'BTCUSDT', eventTs: 1, receiveTs: 2, price: 1, qty: -1, side: 'long' }), /invalid_qty/);
});

test('unknown liquidation shapes fail with controlled parse error', () => {
  assert.throws(() => fromBinanceLiquidation({ nope: true }, { receiveTs: 1 }), /invalid_binance_liquidation/);
  assert.throws(() => fromBybitLiquidation({ nope: true }, { receiveTs: 1 }), /invalid_bybit_liquidation/);
});
