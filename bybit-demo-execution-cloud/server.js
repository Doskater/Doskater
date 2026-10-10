import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { BYBIT_DEMO_HOST, createBybitClient } from './bybit-client.js';
import { createBybitService } from './bybit-service.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
const SERVER_INFO = { name: 'bybit-demo-execution', version: '0.1.0' };
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_RATE_LIMIT_MAX = 120;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

const readTool = (name, description, properties = {}) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false }
});

const writeTool = (name, description, properties, required = []) => ({
  name,
  description: `WRITE ACTION — Bybit Demo only. ${description} Requires an explicit user request; never real-money trading.`,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: true }
});

const symbolProperty = { type: 'string', pattern: '^[A-Z0-9]{2,30}USDT$' };
const categoryProperty = { type: 'string', enum: ['linear'] };
const positiveStringOrNumber = { anyOf: [{ type: 'string', pattern: '^[0-9]+(?:\\.[0-9]+)?$' }, { type: 'number', exclusiveMinimum: 0 }] };

export const TOOL_DEFINITIONS = [
  readTool('get_account_snapshot', 'Read Bybit Demo unified account balances, open linear positions, and open orders.'),
  readTool('get_positions', 'Read current Bybit Demo linear USDT perpetual positions.', { symbol: symbolProperty }),
  readTool('get_open_orders', 'Read current Bybit Demo linear USDT perpetual open orders.', { symbol: symbolProperty }),
  readTool('get_order_history', 'Read recent Bybit Demo order history.', { symbol: symbolProperty, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  readTool('get_executions', 'Read recent Bybit Demo executions/fills.', { symbol: symbolProperty, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  writeTool('place_order', 'Place a linear USDT perpetual order.', {
    category: categoryProperty, symbol: symbolProperty, side: { type: 'string', enum: ['Buy', 'Sell'] }, qty: positiveStringOrNumber,
    orderType: { type: 'string', enum: ['Market', 'Limit'] }, price: positiveStringOrNumber, reduceOnly: { type: 'boolean' }
  }, ['symbol', 'side', 'qty', 'orderType']),
  writeTool('amend_order', 'Amend quantity and/or price of an existing linear order.', {
    category: categoryProperty, symbol: symbolProperty, orderId: { type: 'string', minLength: 1 }, qty: positiveStringOrNumber, price: positiveStringOrNumber
  }, ['symbol', 'orderId']),
  writeTool('cancel_order', 'Cancel one existing linear order.', {
    category: categoryProperty, symbol: symbolProperty, orderId: { type: 'string', minLength: 1 }
  }, ['symbol', 'orderId']),
  writeTool('cancel_all_orders', 'Cancel all open orders for one linear symbol.', {
    category: categoryProperty, symbol: symbolProperty
  }, ['symbol']),
  writeTool('close_position', 'Close the full open linear position using a reduce-only market order.', {
    category: categoryProperty, symbol: symbolProperty
  }, ['symbol']),
  writeTool('set_leverage', 'Set buy/sell leverage for one linear symbol.', {
    category: categoryProperty, symbol: symbolProperty, leverage: { type: 'number', minimum: 1, maximum: 150 }
  }, ['symbol', 'leverage']),
  writeTool('set_position_protection', 'Set server-side full-position Take Profit and/or Stop Loss triggered by MarkPrice.', {
    category: categoryProperty, symbol: symbolProperty, takeProfit: positiveStringOrNumber, stopLoss: positiveStringOrNumber
  }, ['symbol'])
];

const TOOL_DISPATCH = {
  get_account_snapshot: 'getAccountSnapshot',
  get_positions: 'getPositions',
  get_open_orders: 'getOpenOrders',
  get_order_history: 'getOrderHistory',
  get_executions: 'getExecutions',
  place_order: 'placeOrder',
  amend_order: 'amendOrder',
  cancel_order: 'cancelOrder',
  cancel_all_orders: 'cancelAllOrders',
  close_position: 'closePosition',
  set_leverage: 'setLeverage',
  set_position_protection: 'setPositionProtection'
};

function credentialsConfigured(env) {
  return Boolean(env.BYBIT_DEMO_API_KEY && env.BYBIT_DEMO_API_SECRET);
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'MCP-Protocol-Version',
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

function sendRpcResult(res, id, result, modern = true) {
  const payload = modern
    ? { ...result, resultType: 'complete', _meta: { ...(result?._meta || {}), 'io.modelcontextprotocol/serverInfo': SERVER_INFO } }
    : result;
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result: payload }, { 'mcp-protocol-version': MCP_PROTOCOL_VERSION });
}

function sendRpcError(res, id, code, message, status = 200) {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function readBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => tooLarge ? reject(new Error('request_too_large')) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

export function createHttpServer({
  env = process.env,
  service: injectedService,
  fetchImpl = fetch,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  rateLimitMax = DEFAULT_RATE_LIMIT_MAX,
  rateLimitWindowMs = DEFAULT_RATE_LIMIT_WINDOW_MS
} = {}) {
  const rate = new Map();
  let lazyService = injectedService ?? null;

  function getService() {
    if (lazyService) return lazyService;
    if (!credentialsConfigured(env)) return null;
    lazyService = createBybitService(createBybitClient({
      apiKey: env.BYBIT_DEMO_API_KEY,
      apiSecret: env.BYBIT_DEMO_API_SECRET,
      fetchImpl
    }));
    return lazyService;
  }

  function withinRateLimit(req) {
    const ip = clientIp(req);
    const now = Date.now();
    let entry = rate.get(ip);
    if (!entry || now - entry.started >= rateLimitWindowMs) entry = { started: now, count: 0 };
    entry.count += 1;
    rate.set(ip, entry);
    return entry.count <= rateLimitMax;
  }

  async function handleMcp(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (!withinRateLimit(req)) {
      sendJson(res, 429, { error: 'rate_limit_exceeded' }, { 'retry-after': '60' });
      return;
    }

    let body;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error.message === 'request_too_large') {
        sendJson(res, 413, { error: 'request_too_large' });
        return;
      }
      sendJson(res, 400, { error: 'request_read_failed' });
      return;
    }

    let message;
    try {
      message = JSON.parse(body.toString('utf8'));
    } catch {
      sendRpcError(res, null, -32700, 'Parse error', 400);
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      sendRpcError(res, message?.id, -32600, 'Invalid Request', 400);
      return;
    }

    const { id, method } = message;
    if (method === 'initialize') {
      sendRpcResult(res, id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      }, false);
      return;
    }
    if (method === 'notifications/initialized') {
      res.writeHead(202, { 'access-control-allow-origin': '*' });
      res.end();
      return;
    }
    if (method === 'server/discover') {
      sendRpcResult(res, id, {
        supportedVersions: [MCP_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        ttlMs: 0,
        cacheScope: 'private'
      });
      return;
    }
    if (method === 'tools/list') {
      sendRpcResult(res, id, { tools: TOOL_DEFINITIONS, ttlMs: 0, cacheScope: 'private' });
      return;
    }
    if (method !== 'tools/call') {
      sendRpcError(res, id, -32601, `Method not found: ${String(method)}`);
      return;
    }

    const toolName = message.params?.name;
    const serviceMethod = TOOL_DISPATCH[toolName];
    if (!serviceMethod) {
      sendRpcError(res, id, -32602, `Unknown tool: ${String(toolName)}`);
      return;
    }
    const service = getService();
    if (!service) {
      sendRpcError(res, id, -32001, 'Bybit Demo credentials are not configured');
      return;
    }
    if (typeof service[serviceMethod] !== 'function') {
      sendRpcError(res, id, -32603, `Tool implementation unavailable: ${toolName}`);
      return;
    }

    try {
      const args = message.params?.arguments ?? {};
      const result = await service[serviceMethod](args);
      sendRpcResult(res, id, {
        content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
        structuredContent: result ?? null
      });
    } catch (error) {
      sendRpcError(res, id, -32602, error?.message || 'Tool call failed');
    }
  }

  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'Content-Type, Accept, MCP-Protocol-Version'
      });
      res.end();
      return;
    }
    if (req.url === '/healthz') {
      sendJson(res, 200, {
        status: 'ok',
        mode: 'BYBIT_DEMO_ONLY',
        host: BYBIT_DEMO_HOST,
        credentialsConfigured: credentialsConfigured(env)
      });
      return;
    }
    if (req.url === '/mcp') {
      await handleMcp(req, res);
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });
}

function start() {
  const port = Number(process.env.PORT || 10000);
  const server = createHttpServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`Bybit Demo Execution MCP listening on :${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
