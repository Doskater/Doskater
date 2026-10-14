import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ANALYST_PROTOCOL } from '../analyst-protocol.js';
import { TOOL_DEFINITIONS } from '../tool-definitions.js';
import { createHttpServer } from '../server.js';

async function withServer(options, fn) {
  const server = createHttpServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function rpc(base, body, token = 'secret', headers = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...headers
    },
    body: JSON.stringify(body)
  });
}

const handlers = Object.fromEntries([
  'source_health',
  'prepare_snapshot',
  'market_universe',
  'historical_market_data',
  'historical_derivatives_data',
  'cross_market_data',
  'microstructure_data'
].map(name => [name, async () => ({ tool: name })]));

test('modern server/discover publishes analyst instructions and tools capability', async () => {
  await withServer({ env: { DATA_PLANE_TOKEN: 'secret' }, toolHandlers: handlers }, async base => {
    const res = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }, 'secret', {
      'mcp-protocol-version': '2026-07-28'
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.result.supportedVersions, ['2026-07-28']);
    assert.equal(body.result.instructions, ANALYST_PROTOCOL);
    assert.deepEqual(body.result.capabilities, { tools: {} });
  });
});

test('legacy initialize publishes the same analyst instructions', async () => {
  await withServer({ env: { DATA_PLANE_TOKEN: 'secret' }, toolHandlers: handlers }, async base => {
    const res = await rpc(base, {
      jsonrpc: '2.0', id: 2, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    });
    const body = await res.json();
    assert.equal(body.result.protocolVersion, '2025-11-25');
    assert.equal(body.result.instructions, ANALYST_PROTOCOL);
    assert.equal(body.result.serverInfo.name, 'trading-data-plane');
  });
});

test('tools/list exposes exactly seven read-only non-destructive data tools', async () => {
  await withServer({ env: { DATA_PLANE_TOKEN: 'secret' }, toolHandlers: handlers }, async base => {
    const res = await rpc(base, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const body = await res.json();
    assert.deepEqual(body.result.tools.map(x => x.name), TOOL_DEFINITIONS.map(x => x.name));
    assert.equal(body.result.tools.length, 7);
    for (const tool of body.result.tools) {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
    }
  });
});

test('public MCP fails closed without token and rejects wrong bearer', async () => {
  await withServer({ env: {}, toolHandlers: handlers }, async base => {
    const res = await rpc(base, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
    assert.equal(res.status, 503);
  });
  await withServer({ env: { DATA_PLANE_TOKEN: 'secret' }, toolHandlers: handlers }, async base => {
    const res = await rpc(base, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, 'wrong');
    assert.equal(res.status, 401);
  });
});

test('tool results are blocked when a handler leaks a recommendation field', async () => {
  const leaking = { ...handlers, source_health: async () => ({ nested: { signal: 'LONG' } }) };
  await withServer({ env: { DATA_PLANE_TOKEN: 'secret' }, toolHandlers: leaking }, async base => {
    const res = await rpc(base, {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'source_health', arguments: {} }
    });
    const body = await res.json();
    assert.match(body.error.message, /neutral_payload_violation/);
    assert.doesNotMatch(JSON.stringify(body), /LONG/);
  });
});
