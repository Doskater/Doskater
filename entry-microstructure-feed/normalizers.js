import { normalizeSymbol } from './config.js';

function finitePositive(value, name, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) throw new Error(`invalid_${name}`);
  return number;
}

function finiteTimestamp(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`invalid_${name}`);
  return number;
}

function normalizeSide(value, allowed, name = 'side') {
  const side = String(value).toLowerCase();
  if (!allowed.includes(side)) throw new Error(`invalid_${name}`);
  return side;
}

function normalizeLevels(levels = []) {
  if (!Array.isArray(levels)) throw new Error('invalid_levels');
  return levels.map(level => {
    if (!Array.isArray(level) || level.length < 2) throw new Error('invalid_level');
    const price = finitePositive(level[0], 'level');
    const qty = finitePositive(level[1], 'level', { allowZero: true });
    return [price, qty];
  });
}

export function normalizeTrade(input) {
  const price = finitePositive(input?.price, 'price');
  const qty = finitePositive(input?.qty, 'qty');
  return {
    venue: String(input.venue),
    market: String(input.market),
    symbol: normalizeSymbol(input.symbol),
    eventTs: finiteTimestamp(input.eventTs, 'event_ts'),
    receiveTs: finiteTimestamp(input.receiveTs, 'receive_ts'),
    price,
    qty,
    notional: price * qty,
    side: normalizeSide(input.side, ['buy', 'sell'])
  };
}

export function normalizeBookDelta(input) {
  const result = {
    venue: String(input?.venue),
    market: String(input?.market),
    symbol: normalizeSymbol(input?.symbol),
    eventTs: finiteTimestamp(input?.eventTs, 'event_ts'),
    receiveTs: finiteTimestamp(input?.receiveTs, 'receive_ts'),
    bids: normalizeLevels(input?.bids),
    asks: normalizeLevels(input?.asks)
  };
  for (const field of ['firstUpdateId', 'finalUpdateId', 'previousFinalUpdateId', 'sequence']) {
    if (input?.[field] !== undefined && input[field] !== null) {
      const value = Number(input[field]);
      if (!Number.isInteger(value) || value < 0) throw new Error(`invalid_${field}`);
      result[field] = value;
    }
  }
  return result;
}

export function normalizeLiquidation(input) {
  const price = finitePositive(input?.price, 'price');
  const qty = finitePositive(input?.qty, 'qty');
  return {
    venue: String(input.venue),
    market: String(input.market),
    symbol: normalizeSymbol(input.symbol),
    eventTs: finiteTimestamp(input.eventTs, 'event_ts'),
    receiveTs: finiteTimestamp(input.receiveTs, 'receive_ts'),
    price,
    qty,
    notional: price * qty,
    side: normalizeSide(input.side, ['long', 'short'])
  };
}

export function fromBinanceAggTrade(message, { market, receiveTs = Date.now() } = {}) {
  if (!message || message.s === undefined || message.p === undefined || message.q === undefined || typeof message.m !== 'boolean') throw new Error('invalid_binance_agg_trade');
  return normalizeTrade({
    venue: 'binance', market, symbol: message.s,
    eventTs: message.T ?? message.E,
    receiveTs,
    price: message.p,
    qty: message.q,
    side: message.m ? 'sell' : 'buy'
  });
}

export function fromBybitPublicTrade(message, { market, receiveTs = Date.now() } = {}) {
  if (!message || message.s === undefined || message.p === undefined || message.v === undefined || message.S === undefined) throw new Error('invalid_bybit_public_trade');
  return normalizeTrade({
    venue: 'bybit', market, symbol: message.s,
    eventTs: message.T,
    receiveTs,
    price: message.p,
    qty: message.v,
    side: String(message.S).toLowerCase()
  });
}

export function fromBinanceLiquidation(message, { receiveTs = Date.now() } = {}) {
  const order = message?.o;
  if (!order || order.s === undefined || order.S === undefined || order.q === undefined || (order.ap === undefined && order.p === undefined)) throw new Error('invalid_binance_liquidation');
  const price = Number(order.ap) > 0 ? order.ap : order.p;
  const qty = Number(order.z) > 0 ? order.z : order.q;
  const orderSide = String(order.S).toUpperCase();
  if (!['BUY', 'SELL'].includes(orderSide)) throw new Error('invalid_binance_liquidation');
  return normalizeLiquidation({
    venue: 'binance', market: 'perp', symbol: order.s,
    eventTs: order.T ?? message.E,
    receiveTs,
    price,
    qty,
    side: orderSide === 'SELL' ? 'long' : 'short'
  });
}

export function fromBybitLiquidation(message, { receiveTs = Date.now() } = {}) {
  if (!message || message.s === undefined || message.S === undefined || message.v === undefined || message.p === undefined) throw new Error('invalid_bybit_liquidation');
  const positionSide = String(message.S).toLowerCase();
  if (!['buy', 'sell'].includes(positionSide)) throw new Error('invalid_bybit_liquidation');
  return normalizeLiquidation({
    venue: 'bybit', market: 'linear', symbol: message.s,
    eventTs: message.T,
    receiveTs,
    price: message.p,
    qty: message.v,
    side: positionSide === 'buy' ? 'long' : 'short'
  });
}
