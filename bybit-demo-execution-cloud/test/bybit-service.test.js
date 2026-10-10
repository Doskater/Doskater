import test from 'node:test';
import assert from 'node:assert/strict';

async function loadServiceModule() {
  try { return await import('../bybit-service.js'); } catch { return null; }
}

function fakeClient(resolver = async () => ({ retCode: 0, result: {} })) {
  const calls = [];
  return {
    calls,
    request: async (method, path, params) => {
      calls.push({ method, path, params });
      return resolver(method, path, params, calls.length - 1);
    }
  };
}

test('maps read methods to the narrow linear USDT endpoints and shapes snapshot', async () => {
  const mod = await loadServiceModule();
  assert.ok(mod, 'bybit service module should exist');
  const client = fakeClient(async (_method, path) => {
    if (path === '/v5/account/wallet-balance') return { result: { list: [{ accountType: 'UNIFIED', totalEquity: '1000', totalWalletBalance: '900', totalAvailableBalance: '800', totalMarginBalance: '890', totalInitialMargin: '10', totalMaintenanceMargin: '1' }] } };
    if (path === '/v5/position/list') return { result: { list: [{ symbol: 'BTCUSDT', side: 'Buy', size: '0.001', avgPrice: '83000', markPrice: '83100', positionValue: '83.1', unrealisedPnl: '0.1', leverage: '1', liqPrice: '', takeProfit: '84000', stopLoss: '82000' }, { symbol: 'ETHUSDT', side: '', size: '0' }] } };
    if (path === '/v5/order/realtime') return { result: { list: [{ orderId: 'o1', symbol: 'BTCUSDT', side: 'Sell', orderType: 'Market', price: '0', qty: '0.001', leavesQty: '0.001', orderStatus: 'Untriggered', reduceOnly: true, createdTime: '1' }] } };
    return { result: { list: [] } };
  });
  const service = mod.createBybitService(client);
  const snapshot = await service.getAccountSnapshot();
  assert.equal(snapshot.mode, 'BYBIT_DEMO_ONLY');
  assert.equal(snapshot.account.totalEquity, '1000');
  assert.equal(snapshot.positions.length, 1);
  assert.equal(snapshot.positions[0].symbol, 'BTCUSDT');
  assert.equal(snapshot.openOrders[0].orderId, 'o1');
  assert.deepEqual(client.calls.map(c => c.path).sort(), ['/v5/account/wallet-balance','/v5/order/realtime','/v5/position/list'].sort());
  assert.equal(client.calls.find(c => c.path === '/v5/position/list').params.settleCoin, 'USDT');
});

test('maps history and execution reads with optional symbol and bounded limit', async () => {
  const mod = await loadServiceModule();
  assert.ok(mod, 'bybit service module should exist');
  const client = fakeClient(async () => ({ result: { list: [{ orderId: 'x' }] } }));
  const service = mod.createBybitService(client);
  await service.getOrderHistory({ symbol: 'BTCUSDT', limit: 50 });
  await service.getExecutions({ symbol: 'BTCUSDT', limit: 25 });
  assert.deepEqual(client.calls[0], { method: 'GET', path: '/v5/order/history', params: { category: 'linear', symbol: 'BTCUSDT', limit: 50 } });
  assert.deepEqual(client.calls[1], { method: 'GET', path: '/v5/execution/list', params: { category: 'linear', symbol: 'BTCUSDT', limit: 25 } });
  await assert.rejects(() => service.getOrderHistory({ limit: 101 }), /limit/);
});

test('placeOrder validates category side type qty and limit price before calling Bybit', async () => {
  const mod = await loadServiceModule();
  assert.ok(mod, 'bybit service module should exist');
  const client = fakeClient(async () => ({ result: { orderId: 'abc' } }));
  const service = mod.createBybitService(client);
  const placed = await service.placeOrder({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', qty: '0.001', orderType: 'Market' });
  assert.equal(placed.orderId, 'abc');
  assert.equal(client.calls[0].path, '/v5/order/create');
  assert.equal(client.calls[0].params.reduceOnly, false);
  await assert.rejects(() => service.placeOrder({ category: 'inverse', symbol: 'BTCUSDT', side: 'Buy', qty: '1', orderType: 'Market' }), /category/);
  await assert.rejects(() => service.placeOrder({ symbol: 'BTCUSDT', side: 'Long', qty: '1', orderType: 'Market' }), /side/);
  await assert.rejects(() => service.placeOrder({ symbol: 'BTCUSDT', side: 'Buy', qty: '0', orderType: 'Market' }), /qty/);
  await assert.rejects(() => service.placeOrder({ symbol: 'BTCUSDT', side: 'Buy', qty: '1', orderType: 'Stop' }), /orderType/);
  await assert.rejects(() => service.placeOrder({ symbol: 'BTCUSDT', side: 'Buy', qty: '1', orderType: 'Limit' }), /price/);
  assert.equal(client.calls.length, 1);
});

test('amend and cancel operations use only order endpoints and validate identifiers', async () => {
  const mod = await loadServiceModule();
  assert.ok(mod, 'bybit service module should exist');
  const client = fakeClient(async () => ({ result: { orderId: 'o1' } }));
  const service = mod.createBybitService(client);
  await service.amendOrder({ symbol: 'BTCUSDT', orderId: 'o1', qty: '0.002' });
  await service.cancelOrder({ symbol: 'BTCUSDT', orderId: 'o1' });
  await service.cancelAllOrders({ symbol: 'BTCUSDT' });
  assert.deepEqual(client.calls.map(c => c.path), ['/v5/order/amend','/v5/order/cancel','/v5/order/cancel-all']);
  await assert.rejects(() => service.amendOrder({ symbol: 'BTCUSDT', orderId: 'o1' }), /qty or price/);
  await assert.rejects(() => service.cancelOrder({ symbol: 'BTCUSDT' }), /orderId/);
});

test('closePosition reads the live position then sends full reduceOnly market close', async () => {
  const mod = await loadServiceModule();
  assert.ok(mod, 'bybit service module should exist');
  const client = fakeClient(async (_method, path) => {
    if (path === '/v5/position/list') return { result: { list: [{ symbol: 'BTCUSDT', side: 'Buy', size: '0.001' }] } };
    return { result: { orderId: 'close1' } };
  });
  const service = mod.createBybitService(client);
  const result = await service.closePosition({ symbol: 'BTCUSDT' });
  assert.equal(result.orderId, 'close1');
  assert.deepEqual(client.calls[1], {
    method: 'POST', path: '/v5/order/create', params: { category: 'linear', symbol: 'BTCUSDT', side: 'Sell', orderType: 'Market', qty: '0.001', reduceOnly: true }
  });
});

test('setLeverage and protection validate values and map to position endpoints', async () => {
  const mod = await loadServiceModule();
  assert.ok(mod, 'bybit service module should exist');
  const client = fakeClient(async () => ({ result: {} }));
  const service = mod.createBybitService(client);
  await service.setLeverage({ symbol: 'BTCUSDT', leverage: 2 });
  await service.setPositionProtection({ symbol: 'BTCUSDT', takeProfit: 84000, stopLoss: 82000 });
  assert.deepEqual(client.calls[0], { method: 'POST', path: '/v5/position/set-leverage', params: { category: 'linear', symbol: 'BTCUSDT', buyLeverage: '2', sellLeverage: '2' } });
  assert.deepEqual(client.calls[1], { method: 'POST', path: '/v5/position/trading-stop', params: { category: 'linear', symbol: 'BTCUSDT', tpslMode: 'Full', positionIdx: 0, takeProfit: '84000', stopLoss: '82000', tpTriggerBy: 'MarkPrice', slTriggerBy: 'MarkPrice' } });
  await assert.rejects(() => service.setLeverage({ symbol: 'BTCUSDT', leverage: 0 }), /leverage/);
  await assert.rejects(() => service.setLeverage({ symbol: 'BTCUSDT', leverage: 151 }), /leverage/);
  await assert.rejects(() => service.setPositionProtection({ symbol: 'BTCUSDT' }), /takeProfit or stopLoss/);
  await assert.rejects(() => service.setPositionProtection({ symbol: 'BTCUSDT', stopLoss: -1 }), /stopLoss/);
});

test('rejects invalid or non-USDT symbols before any request', async () => {
  const mod = await loadServiceModule();
  assert.ok(mod, 'bybit service module should exist');
  const client = fakeClient();
  const service = mod.createBybitService(client);
  await assert.rejects(() => service.getPositions({ symbol: 'BTCUSD' }), /symbol/);
  await assert.rejects(() => service.placeOrder({ symbol: '../../etc', side: 'Buy', qty: 1, orderType: 'Market' }), /symbol/);
  assert.equal(client.calls.length, 0);
});
