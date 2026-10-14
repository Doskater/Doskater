import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ANALYST_PROTOCOL } from './analyst-protocol.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';
import { assertNeutralPayload } from './schema-guard.js';
import {
  MODERN_PROTOCOL, LEGACY_PROTOCOL, SERVER_INFO,
  DEFAULT_MAX_BODY_BYTES, DEFAULT_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_WINDOW_MS
} from './config.js';

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'MCP-Protocol-Version',
    ...extra
  });
  res.end(JSON.stringify(body));
}

function safeEqual(actual, expected) {
  const a = Buffer.from(String(actual ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorize(req, res, env) {
  const token = env.DATA_PLANE_TOKEN;
  if (!token) {
    sendJson(res, 503, { error: 'service_auth_not_configured' });
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? '').trim());
  if (!match || !safeEqual(match[1], token)) {
    sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    return false;
  }
  return true;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) return;
      chunks.push(chunk);
    });
    req.on('end', () => size > maxBytes ? reject(new Error('request_too_large')) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function modernResult(result) {
  return {
    ...result,
    resultType: 'complete',
    _meta: { ...(result?._meta ?? {}), 'io.modelcontextprotocol/serverInfo': SERVER_INFO }
  };
}

function sendRpcResult(res, id, result, modern = true) {
  const payload = modern ? modernResult(result) : result;
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result: payload }, {
    'mcp-protocol-version': modern ? MODERN_PROTOCOL : LEGACY_PROTOCOL
  });
}

function sendRpcError(res, id, code, message, status = 200) {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export function createHttpServer({
  env = process.env,
  toolHandlers = {},
  logger = { info() {}, warn() {}, error() {} },
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  rateLimitMax = DEFAULT_RATE_LIMIT_MAX,
  rateLimitWindowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  clock = Date
} = {}) {
  const rate = new Map();
  const now = () => typeof clock.now === 'function' ? clock.now() : Date.now();

  function withinRateLimit(req) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = typeof forwarded === 'string' && forwarded ? forwarded.split(',')[0].trim() : (req.socket.remoteAddress || 'unknown');
    const current = now();
    let entry = rate.get(ip);
    if (!entry || current - entry.started >= rateLimitWindowMs) entry = { started: current, count: 0 };
    entry.count += 1;
    rate.set(ip, entry);
    return entry.count <= rateLimitMax;
  }

  async function handleMcp(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    if (!authorize(req, res, env)) return;
    if (!withinRateLimit(req)) return sendJson(res, 429, { error: 'rate_limit_exceeded' }, { 'retry-after': '60' });

    let raw;
    try { raw = await readBody(req, maxBodyBytes); }
    catch (error) { return sendJson(res, error.message === 'request_too_large' ? 413 : 400, { error: error.message }); }

    let message;
    try { message = JSON.parse(raw.toString('utf8')); }
    catch { return sendRpcError(res, null, -32700, 'Parse error', 400); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return sendRpcError(res, message?.id, -32600, 'Invalid Request', 400);

    const { id, method } = message;
    if (method === 'initialize') {
      return sendRpcResult(res, id, {
        protocolVersion: LEGACY_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: ANALYST_PROTOCOL
      }, false);
    }
    if (method === 'notifications/initialized') {
      res.writeHead(202, { 'access-control-allow-origin': '*' }); res.end(); return;
    }
    if (method === 'server/discover') {
      return sendRpcResult(res, id, {
        supportedVersions: [MODERN_PROTOCOL],
        capabilities: { tools: {} },
        instructions: ANALYST_PROTOCOL,
        ttlMs: 0,
        cacheScope: 'private'
      });
    }
    if (method === 'tools/list') {
      return sendRpcResult(res, id, { tools: TOOL_DEFINITIONS, ttlMs: 0, cacheScope: 'private' });
    }
    if (method !== 'tools/call') return sendRpcError(res, id, -32601, `Method not found: ${String(method)}`);

    const name = message.params?.name;
    if (!TOOL_DEFINITIONS.some(tool => tool.name === name)) return sendRpcError(res, id, -32602, `Unknown tool: ${String(name)}`);
    const handler = toolHandlers[name];
    if (typeof handler !== 'function') return sendRpcError(res, id, -32603, `Tool handler unavailable: ${String(name)}`, 503);

    try {
      const result = await handler(message.params?.arguments ?? {});
      try { assertNeutralPayload(result); }
      catch (error) {
        logger.error?.({ event: 'neutral_payload_violation', tool: name, field: error.message });
        return sendRpcError(res, id, -32603, 'neutral_payload_violation');
      }
      return sendRpcResult(res, id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result
      });
    } catch (error) {
      logger.error?.({ event: 'tool_failed', tool: name, message: String(error?.message ?? error) });
      return sendRpcError(res, id, -32000, String(error?.message ?? 'internal_error'));
    }
  }

  return http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { return sendJson(res, 400, { error: 'invalid_url' }); }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST,OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization, MCP-Protocol-Version'
      });
      res.end(); return;
    }
    if (url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok', service: SERVER_INFO.name, authConfigured: Boolean(env.DATA_PLANE_TOKEN) });
    if (url.pathname === '/mcp') return handleMcp(req, res);
    return sendJson(res, 404, { error: 'not_found' });
  });
}
