const CATEGORY = 'linear';

function assertCategory(category) {
  if (category !== undefined && category !== CATEGORY) throw new Error('category must be linear');
}

function assertSymbol(symbol) {
  if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,30}USDT$/.test(symbol)) {
    throw new Error('symbol must be an uppercase USDT perpetual symbol');
  }
}

function assertSide(side) {
  if (!['Buy', 'Sell'].includes(side)) throw new Error('side must be Buy or Sell');
}

function assertPositive(value, name) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(`${name} must be positive`);
  return String(value);
}

function assertLimit(limit) {
  if (limit === undefined) return undefined;
  const numeric = Number(limit);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 100) throw new Error('limit must be an integer from 1 to 100');
  return numeric;
}

function assertOrderId(orderId) {
  if (typeof orderId !== 'string' || !orderId.trim()) throw new Error('orderId is required');
}

function shapePosition(p) {
  return {
    symbol: p.symbol,
    side: p.side,
    size: p.size,
    avgPrice: p.avgPrice,
    markPrice: p.markPrice,
    positionValue: p.positionValue,
    unrealisedPnl: p.unrealisedPnl,
    leverage: p.leverage,
    liqPrice: p.liqPrice,
    takeProfit: p.takeProfit,
    stopLoss: p.stopLoss
  };
}

function shapeOrder(o) {
  return {
    orderId: o.orderId,
    orderLinkId: o.orderLinkId,
    symbol: o.symbol,
    side: o.side,
    orderType: o.orderType,
    price: o.price,
    qty: o.qty,
    leavesQty: o.leavesQty,
    avgPrice: o.avgPrice,
    orderStatus: o.orderStatus,
    reduceOnly: o.reduceOnly,
    createdTime: o.createdTime,
    updatedTime: o.updatedTime
  };
}

function shapeExecution(e) {
  return {
    execId: e.execId,
    orderId: e.orderId,
    symbol: e.symbol,
    side: e.side,
    execPrice: e.execPrice,
    execQty: e.execQty,
    execFee: e.execFee,
    execPnl: e.execPnl,
    execTime: e.execTime
  };
}

export function createBybitService(client) {
  if (!client || typeof client.request !== 'function') throw new Error('client.request is required');

  async function getPositions({ symbol } = {}) {
    if (symbol !== undefined) assertSymbol(symbol);
    const params = symbol ? { category: CATEGORY, symbol } : { category: CATEGORY, settleCoin: 'USDT' };
    const response = await client.request('GET', '/v5/position/list', params);
    return (response.result?.list ?? []).filter(p => Number(p.size) !== 0).map(shapePosition);
  }

  async function getOpenOrders({ symbol } = {}) {
    if (symbol !== undefined) assertSymbol(symbol);
    const params = symbol
      ? { category: CATEGORY, symbol, openOnly: 0 }
      : { category: CATEGORY, settleCoin: 'USDT', openOnly: 0 };
    const response = await client.request('GET', '/v5/order/realtime', params);
    return (response.result?.list ?? []).map(shapeOrder);
  }

  async function getAccountSnapshot() {
    const [wallet, positions, openOrders] = await Promise.all([
      client.request('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
      getPositions(),
      getOpenOrders()
    ]);
    const account = wallet.result?.list?.[0] ?? null;
    return {
      mode: 'BYBIT_DEMO_ONLY',
      account: account ? {
        accountType: account.accountType,
        totalEquity: account.totalEquity,
        totalWalletBalance: account.totalWalletBalance,
        totalAvailableBalance: account.totalAvailableBalance,
        totalMarginBalance: account.totalMarginBalance,
        totalInitialMargin: account.totalInitialMargin,
        totalMaintenanceMargin: account.totalMaintenanceMargin
      } : null,
      positions,
      openOrders
    };
  }

  async function getOrderHistory({ symbol, limit } = {}) {
    if (symbol !== undefined) assertSymbol(symbol);
    const boundedLimit = assertLimit(limit);
    const params = { category: CATEGORY, ...(symbol ? { symbol } : {}), ...(boundedLimit ? { limit: boundedLimit } : {}) };
    const response = await client.request('GET', '/v5/order/history', params);
    return (response.result?.list ?? []).map(shapeOrder);
  }

  async function getExecutions({ symbol, limit } = {}) {
    if (symbol !== undefined) assertSymbol(symbol);
    const boundedLimit = assertLimit(limit);
    const params = { category: CATEGORY, ...(symbol ? { symbol } : {}), ...(boundedLimit ? { limit: boundedLimit } : {}) };
    const response = await client.request('GET', '/v5/execution/list', params);
    return (response.result?.list ?? []).map(shapeExecution);
  }

  async function placeOrder({ category, symbol, side, qty, orderType = 'Market', price, reduceOnly = false } = {}) {
    assertCategory(category);
    assertSymbol(symbol);
    assertSide(side);
    const validQty = assertPositive(qty, 'qty');
    if (!['Market', 'Limit'].includes(orderType)) throw new Error('orderType must be Market or Limit');
    const payload = { category: CATEGORY, symbol, side, orderType, qty: validQty, reduceOnly: Boolean(reduceOnly) };
    if (orderType === 'Limit') {
      payload.price = assertPositive(price, 'price');
      payload.timeInForce = 'GTC';
    }
    const response = await client.request('POST', '/v5/order/create', payload);
    return response.result ?? {};
  }

  async function amendOrder({ category, symbol, orderId, qty, price } = {}) {
    assertCategory(category);
    assertSymbol(symbol);
    assertOrderId(orderId);
    if (qty === undefined && price === undefined) throw new Error('qty or price is required');
    const payload = { category: CATEGORY, symbol, orderId };
    if (qty !== undefined) payload.qty = assertPositive(qty, 'qty');
    if (price !== undefined) payload.price = assertPositive(price, 'price');
    const response = await client.request('POST', '/v5/order/amend', payload);
    return response.result ?? {};
  }

  async function cancelOrder({ category, symbol, orderId } = {}) {
    assertCategory(category);
    assertSymbol(symbol);
    assertOrderId(orderId);
    const response = await client.request('POST', '/v5/order/cancel', { category: CATEGORY, symbol, orderId });
    return response.result ?? {};
  }

  async function cancelAllOrders({ category, symbol } = {}) {
    assertCategory(category);
    assertSymbol(symbol);
    const response = await client.request('POST', '/v5/order/cancel-all', { category: CATEGORY, symbol });
    return response.result ?? {};
  }

  async function closePosition({ category, symbol } = {}) {
    assertCategory(category);
    assertSymbol(symbol);
    const response = await client.request('GET', '/v5/position/list', { category: CATEGORY, symbol });
    const position = (response.result?.list ?? []).find(p => Number(p.size) > 0);
    if (!position) throw new Error(`No open linear position for ${symbol}`);
    const side = position.side === 'Buy' ? 'Sell' : position.side === 'Sell' ? 'Buy' : null;
    if (!side) throw new Error(`Invalid open position side for ${symbol}`);
    const closed = await client.request('POST', '/v5/order/create', {
      category: CATEGORY,
      symbol,
      side,
      orderType: 'Market',
      qty: assertPositive(position.size, 'qty'),
      reduceOnly: true
    });
    return closed.result ?? {};
  }

  async function setLeverage({ category, symbol, leverage } = {}) {
    assertCategory(category);
    assertSymbol(symbol);
    const numeric = Number(leverage);
    if (!Number.isFinite(numeric) || numeric < 1 || numeric > 150) throw new Error('leverage must be between 1 and 150');
    const value = String(leverage);
    const response = await client.request('POST', '/v5/position/set-leverage', {
      category: CATEGORY, symbol, buyLeverage: value, sellLeverage: value
    });
    return response.result ?? {};
  }

  async function setPositionProtection({ category, symbol, takeProfit, stopLoss } = {}) {
    assertCategory(category);
    assertSymbol(symbol);
    if (takeProfit === undefined && stopLoss === undefined) throw new Error('takeProfit or stopLoss is required');
    const payload = { category: CATEGORY, symbol, tpslMode: 'Full', positionIdx: 0 };
    if (takeProfit !== undefined) {
      payload.takeProfit = assertPositive(takeProfit, 'takeProfit');
      payload.tpTriggerBy = 'MarkPrice';
    }
    if (stopLoss !== undefined) {
      payload.stopLoss = assertPositive(stopLoss, 'stopLoss');
      payload.slTriggerBy = 'MarkPrice';
    }
    const response = await client.request('POST', '/v5/position/trading-stop', payload);
    return response.result ?? {};
  }

  return {
    getAccountSnapshot,
    getPositions,
    getOpenOrders,
    getOrderHistory,
    getExecutions,
    placeOrder,
    amendOrder,
    cancelOrder,
    cancelAllOrders,
    closePosition,
    setLeverage,
    setPositionProtection
  };
}
