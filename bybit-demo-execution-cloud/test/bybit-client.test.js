import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

async function loadClientModule() {
  try {
    return await import('../bybit-client.js');
  } catch {
    return null;
  }
}

test('exports a fixed demo-only host and accepts no host override', async () => {
  const mod = await loadClientModule();
  assert.ok(mod, 'bybit client module should exist');
  assert.equal(mod.BYBIT_DEMO_HOST, 'https://api-demo.bybit.com');
  const client = mod.createBybitClient({ apiKey: 'key', apiSecret: 'secret', host: 'https://api.bybit.com', fetchImpl: async () => new Response(JSON.stringify({ retCode: 0, result: {} })) });
  assert.equal(client.host, 'https://api-demo.bybit.com');
});

test('forms a signed GET request only under /v5', async () => {
  const mod = await loadClientModule();
  assert.ok(mod, 'bybit client module should exist');
  const calls = [];
  const apiKey = 'demo-key';
  const apiSecret = 'demo-secret';
  const client = mod.createBybitClient({
    apiKey,
    apiSecret,
    now: () => 1700000000000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const result = await client.request('GET', '/v5/position/list', { category: 'linear', symbol: 'BTCUSDT' });
  assert.deepEqual(result.result, { ok: true });
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, 'https://api-demo.bybit.com/v5/position/list?category=linear&symbol=BTCUSDT');
  const query = 'category=linear&symbol=BTCUSDT';
  const payload = `1700000000000${apiKey}5000${query}`;
  const expected = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');
  assert.equal(options.headers['X-BAPI-SIGN'], expected);
  assert.equal(options.headers['X-BAPI-API-KEY'], apiKey);
  assert.equal(options.method, 'GET');
  assert.equal(options.body, undefined);
  await assert.rejects(() => client.request('GET', 'https://api.bybit.com/v5/position/list', {}), /relative \/v5\//);
});

test('forms a signed POST request with JSON body', async () => {
  const mod = await loadClientModule();
  assert.ok(mod, 'bybit client module should exist');
  const calls = [];
  const client = mod.createBybitClient({
    apiKey: 'demo-key', apiSecret: 'demo-secret', now: () => 1700000000000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { orderId: '1' } }), { status: 200 });
    }
  });
  await client.request('POST', '/v5/order/create', { category: 'linear', symbol: 'BTCUSDT', side: 'Buy', qty: '0.001' });
  assert.equal(calls[0].url, 'https://api-demo.bybit.com/v5/order/create');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, JSON.stringify({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', qty: '0.001' }));
});

test('rejects missing credentials before a request is made', async () => {
  const mod = await loadClientModule();
  assert.ok(mod, 'bybit client module should exist');
  assert.throws(() => mod.createBybitClient({ apiKey: '', apiSecret: 'secret' }), /Missing Bybit Demo credentials/);
  assert.throws(() => mod.createBybitClient({ apiKey: 'key', apiSecret: '' }), /Missing Bybit Demo credentials/);
});

test('redacts credentials and signature-like values from nested data', async () => {
  const mod = await loadClientModule();
  assert.ok(mod, 'bybit client module should exist');
  const signature = 'a'.repeat(64);
  const value = {
    message: `key=demo-key secret=demo-secret sig=${signature}`,
    nested: { apiKey: 'demo-key', signature }
  };
  const redacted = mod.redactSensitive(value, ['demo-key', 'demo-secret']);
  const text = JSON.stringify(redacted);
  assert.equal(text.includes('demo-key'), false);
  assert.equal(text.includes('demo-secret'), false);
  assert.equal(text.includes(signature), false);
  assert.equal(text.includes('[REDACTED]'), true);
});
