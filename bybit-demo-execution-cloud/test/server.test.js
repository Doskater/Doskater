import test from 'node:test';
import assert from 'node:assert/strict';

async function loadServerModule() {
  try { return await import('../server.js'); } catch { return null; }
}

async function withServer(options, fn) {
  const mod = await loadServerModule();
  assert.ok(mod, 'server module should exist');
  const server = mod.createHttpServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function rpc(base, message) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28' },
    body: JSON.stringify(message)
  });
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}

test('health works without secrets and reveals only configured state', async () => {
  await withServer({ env: {} }, async base => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { status: 'ok', mode: 'BYBIT_DEMO_ONLY', host: 'https://api-demo.bybit.com', credentialsConfigured: false });
    const text = JSON.stringify(body);
    assert.equal(/apiSecret|apiKey|BYBIT_DEMO_API_SECRET|BYBIT_DEMO_API_KEY/.test(text), false);
  });
});

test('supports initialize and modern server discovery without secrets', async () => {
  await withServer({ env: {} }, async base => {
    const init = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(init.response.status, 200);
    assert.equal(init.json.result.protocolVersion, '2026-07-28');
    assert.equal(init.json.result.serverInfo.name, 'bybit-demo-execution');
    const discover = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'server/discover', params: {} });
    assert.deepEqual(discover.json.result.supportedVersions, ['2026-07-28']);
    assert.equal(discover.json.result.resultType, 'complete');
  });
});

test('tools/list exposes only intended demo tools and clearly marks writes', async () => {
  await withServer({ env: {} }, async base => {
    const result = await rpc(base, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const tools = result.json.result.tools;
    const names = tools.map(t => t.name);
    assert.deepEqual(names.sort(), [
      'get_account_snapshot','get_positions','get_open_orders','get_order_history','get_executions',
      'place_order','amend_order','cancel_order','cancel_all_orders','close_position','set_leverage','set_position_protection'
    ].sort());
    assert.equal(names.some(name => /withdraw|transfer|deposit|asset/i.test(name)), false);
    for (const tool of tools.filter(t => ['place_order','amend_order','cancel_order','cancel_all_orders','close_position','set_leverage','set_position_protection'].includes(t.name))) {
      assert.match(tool.description, /WRITE ACTION/i);
      assert.match(tool.description, /demo/i);
    }
  });
});

test('tools/call routes read and write calls to the injected service', async () => {
  const calls = [];
  const service = {
    getPositions: async args => { calls.push(['getPositions', args]); return [{ symbol: 'BTCUSDT' }]; },
    placeOrder: async args => { calls.push(['placeOrder', args]); return { orderId: 'demo1' }; }
  };
  await withServer({ env: {}, service }, async base => {
    const read = await rpc(base, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_positions', arguments: { symbol: 'BTCUSDT' } } });
    assert.deepEqual(read.json.result.structuredContent, [{ symbol: 'BTCUSDT' }]);
    const write = await rpc(base, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'place_order', arguments: { symbol: 'BTCUSDT', side: 'Buy', qty: '0.001', orderType: 'Market' } } });
    assert.deepEqual(write.json.result.structuredContent, { orderId: 'demo1' });
    assert.deepEqual(calls, [
      ['getPositions', { symbol: 'BTCUSDT' }],
      ['placeOrder', { symbol: 'BTCUSDT', side: 'Buy', qty: '0.001', orderType: 'Market' }]
    ]);
  });
});

test('authenticated tool calls fail safely when secrets are missing', async () => {
  await withServer({ env: {} }, async base => {
    const result = await rpc(base, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_account_snapshot', arguments: {} } });
    assert.equal(result.json.error.code, -32001);
    assert.match(result.json.error.message, /credentials are not configured/i);
  });
});

test('unknown tools are rejected and never dispatched', async () => {
  let called = false;
  const service = new Proxy({}, { get() { called = true; return async () => ({}); } });
  await withServer({ env: {}, service }, async base => {
    const result = await rpc(base, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'withdraw', arguments: {} } });
    assert.equal(result.json.error.code, -32602);
    assert.match(result.json.error.message, /Unknown tool/);
    assert.equal(called, false);
  });
});

test('rejects oversized JSON bodies before parsing', async () => {
  await withServer({ env: {}, maxBodyBytes: 64 }, async base => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(200) }) });
    assert.equal(response.status, 413);
  });
});

test('rate limits MCP requests per client', async () => {
  await withServer({ env: {}, rateLimitMax: 1, rateLimitWindowMs: 60000 }, async base => {
    const first = await rpc(base, { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} });
    assert.equal(first.response.status, 200);
    const second = await rpc(base, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} });
    assert.equal(second.response.status, 429);
  });
});
