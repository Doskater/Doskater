import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { normalizeSymbol } from './config.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
const SERVER_INFO = { name: 'entry-microstructure-feed', version: '0.1.0' };
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_RATE_LIMIT_MAX = 120;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

const readTool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false }
});

const symbolProperty = { type: 'string', pattern: '^[A-Za-z0-9]{2,30}USDT$' };

export const TOOL_DEFINITIONS = [
  readTool('get_stream_status', 'Read health, coverage and runtime state of the public event-level microstructure feed.'),
  readTool('ensure_symbols', 'Ensure public market-data subscriptions are active for candidate symbols. This changes only an in-memory read-only watchlist.', {
    symbols: { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true, items: symbolProperty }
  }, ['symbols']),
  readTool('get_microstructure_snapshot', 'Read the current event-level microstructure feature snapshot for one watched symbol.', { symbol: symbolProperty }, ['symbol']),
  readTool('get_microstructure_summary', 'Read a compact causal microstructure summary for one watched symbol.', { symbol: symbolProperty }, ['symbol'])
];

function authConfigured(env) {
  return Boolean(env.MICROSTRUCTURE_FEED_TOKEN);
}

function validBearer(req, env) {
  const expected = env.MICROSTRUCTURE_FEED_TOKEN;
  if (!expected) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const actual = Buffer.from(match[1], 'utf8');
  const wanted = Buffer.from(String(expected), 'utf8');
  if (actual.length !== wanted.length) return false;
  return timingSafeEqual(actual, wanted);
}

function redact(value, env) {
  const token = String(env.MICROSTRUCTURE_FEED_TOKEN ?? '');
  const text = String(value ?? '');
  return token ? text.split(token).join('REDACTED') : text;
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

function httpErrorStatus(error) {
  if (error?.message === 'watchlist_capacity_exceeded') return 409;
  if (/invalid_symbol|invalid_symbols|symbol_not_watched/.test(error?.message ?? '')) return 400;
  return 500;
}

export function createHttpServer({
  env = process.env,
  collector,
  logger = { info() {}, warn() {}, error() {} },
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  rateLimitMax = DEFAULT_RATE_LIMIT_MAX,
  rateLimitWindowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  healthProvider
} = {}) {
  if (!collector) throw new Error('collector_required');
  const rate = new Map();

  function withinRateLimit(req) {
    const ip = clientIp(req);
    const now = Date.now();
    let entry = rate.get(ip);
    if (!entry || now - entry.started >= rateLimitWindowMs) entry = { started: now, count: 0 };
    entry.count += 1;
    rate.set(ip, entry);
    return entry.count <= rateLimitMax;
  }

  function authorize(req, res) {
    if (!authConfigured(env)) {
      sendJson(res, 503, { error: 'service_auth_not_configured' });
      return false;
    }
    if (!validBearer(req, env)) {
      sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      return false;
    }
    if (!withinRateLimit(req)) {
      sendJson(res, 429, { error: 'rate_limit_exceeded' }, { 'retry-after': '60' });
      return false;
    }
    return true;
  }

  async function parseJsonBody(req, res) {
    let body;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error.message === 'request_too_large') sendJson(res, 413, { error: 'request_too_large' });
      else sendJson(res, 400, { error: 'request_read_failed' });
      return null;
    }
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return null;
    }
  }

  function safeFailure(res, error) {
    const message = redact(error?.message || 'internal_error', env);
    logger.error?.({ event: 'request_failed', message });
    sendJson(res, httpErrorStatus(error), { error: message === 'internal_error' ? message : redact(message, env) });
  }

  async function callCollectorTool(name, args = {}) {
    if (name === 'get_stream_status') return collector.getStatus();
    if (name === 'ensure_symbols') {
      if (!Array.isArray(args.symbols) || args.symbols.length < 1 || args.symbols.length > 12) throw new Error('invalid_symbols');
      return collector.ensureSymbols(args.symbols.map(normalizeSymbol));
    }
    if (name === 'get_microstructure_snapshot') return collector.getSnapshot(normalizeSymbol(args.symbol));
    if (name === 'get_microstructure_summary') return collector.getSummary(normalizeSymbol(args.symbol));
    throw new Error('unknown_tool');
  }

  async function handleMcp(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (!authorize(req, res)) return;

    let body;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error.message === 'request_too_large') sendJson(res, 413, { error: 'request_too_large' });
      else sendJson(res, 400, { error: 'request_read_failed' });
      return;
    }

    let message;
    try { message = JSON.parse(body.toString('utf8')); }
    catch { sendRpcError(res, null, -32700, 'Parse error', 400); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      sendRpcError(res, message?.id, -32600, 'Invalid Request', 400);
      return;
    }

    const { id, method } = message;
    if (method === 'initialize') {
      sendRpcResult(res, id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO }, false);
      return;
    }
    if (method === 'notifications/initialized') {
      res.writeHead(202, { 'access-control-allow-origin': '*' }); res.end(); return;
    }
    if (method === 'server/discover') {
      sendRpcResult(res, id, { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' });
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
    if (!TOOL_DEFINITIONS.some(tool => tool.name === toolName)) {
      sendRpcError(res, id, -32602, `Unknown tool: ${String(toolName)}`);
      return;
    }
    try {
      const result = await callCollectorTool(toolName, message.params?.arguments ?? {});
      sendRpcResult(res, id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      const safeMessage = redact(error?.message || 'internal_error', env);
      logger.error?.({ event: 'mcp_tool_failed', tool: toolName, message: safeMessage });
      sendRpcError(res, id, -32000, safeMessage);
    }
  }

  return http.createServer(async (req, res) => {
    const rawUrl = req.url || '/';
    let url;
    try { url = new URL(rawUrl, 'http://localhost'); }
    catch { sendJson(res, 400, { error: 'invalid_url' }); return; }

    if (url.pathname === '/healthz') {
      let body = { status: 'ok', service: SERVER_INFO.name, authConfigured: authConfigured(env) };
      if (typeof healthProvider === 'function') {
        try { body = { ...body, ...healthProvider() }; } catch {}
      }
      sendJson(res, 200, body);
      return;
    }
    if (url.pathname === '/mcp') { await handleMcp(req, res); return; }
    if (!authorize(req, res)) return;

    try {
      if (req.method === 'GET' && url.pathname === '/v1/status') {
        sendJson(res, 200, collector.getStatus()); return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/watchlist') {
        sendJson(res, 200, collector.getWatchlist()); return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/watchlist/ensure') {
        const body = await parseJsonBody(req, res); if (body === null) return;
        if (!Array.isArray(body.symbols)) throw new Error('invalid_symbols');
        const result = await collector.ensureSymbols(body.symbols.map(normalizeSymbol));
        sendJson(res, 200, result); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/microstructure/')) {
        const encoded = url.pathname.slice('/v1/microstructure/'.length);
        let decoded;
        try { decoded = decodeURIComponent(encoded); } catch { throw new Error('invalid_symbol'); }
        sendJson(res, 200, collector.getSnapshot(normalizeSymbol(decoded))); return;
      }
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      safeFailure(res, error);
    }
  });
}
