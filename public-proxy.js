import http from "node:http";
import { Readable } from "node:stream";

const PORT = Number(process.env.PORT || 10000);

const UPSTREAM =
  process.env.UPSTREAM_MCP_URL ||
  "https://trading-data-mcp.onrender.com/mcp";

const TOKEN = process.env.UPSTREAM_BEARER_TOKEN;

const ALLOWED_TOOLS = new Set([
  "source_health",
  "macro_regime",
  "crypto_flows",
  "btc_onchain",
  "sol_onchain",
  "ada_onchain",
  "evm_onchain"
]);

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 120;
const MAX_BODY_BYTES = 1_000_000;

const rate = new Map();

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function checkRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();

  let entry = rate.get(ip);
  if (!entry || now - entry.started >= WINDOW_MS) {
    entry = { started: now, count: 0 };
    rate.set(ip, entry);
  }

  entry.count += 1;
  return entry.count <= MAX_REQUESTS_PER_WINDOW;
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function validateRpc(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const err = validateRpc(item);
      if (err) return err;
    }
    return null;
  }

  if (!value || typeof value !== "object") return null;

  if (value.method === "tools/call") {
    const tool = value.params?.name;

    if (!ALLOWED_TOOLS.has(tool)) {
      return {
        id: value.id,
        message: `Tool is not exposed by this read-only proxy: ${String(tool)}`
      };
    }
  }

  return null;
}

function filterJsonRpc(value) {
  if (Array.isArray(value)) {
    return value.map(filterJsonRpc);
  }

  if (
    value &&
    typeof value === "object" &&
    value.result &&
    Array.isArray(value.result.tools)
  ) {
    value.result.tools = value.result.tools.filter(tool =>
      ALLOWED_TOOLS.has(tool?.name)
    );
  }

  return value;
}

function redact(text) {
  if (!TOKEN) return text;
  return text
    .split(TOKEN).join("[REDACTED]")
    .split(`Bearer ${TOKEN}`).join("Bearer [REDACTED]");
}

function filterResponseText(text, contentType) {
  if (contentType.includes("application/json")) {
    try {
      return JSON.stringify(filterJsonRpc(JSON.parse(text)));
    } catch {
      return redact(text);
    }
  }

  if (contentType.includes("text/event-stream")) {
    return text
      .split("\n")
      .map(line => {
        if (!line.startsWith("data:")) return line;

        const raw = line.slice(5).trim();
        try {
          return `data: ${JSON.stringify(filterJsonRpc(JSON.parse(raw)))}`;
        } catch {
          return redact(line);
        }
      })
      .join("\n");
  }

  return redact(text);
}

const MODERN_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOL = "2025-11-25";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
const SERVER_INFO = { name: "trading-data-mcp", version: "1.0.0" };

function stripModernParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const clean = { ...params };
  delete clean._meta;
  delete clean.inputResponses;
  delete clean.requestState;
  return clean;
}

function isModernRpc(req, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.method === "initialize") return false;
  const headerVersion = req.headers["mcp-protocol-version"];
  const metaVersion = value.params?._meta?.[PROTOCOL_VERSION_META_KEY];
  return value.method === "server/discover" ||
    headerVersion === MODERN_PROTOCOL ||
    metaVersion === MODERN_PROTOCOL;
}

function modernEnvelope(result) {
  return {
    ...result,
    resultType: "complete",
    _meta: {
      ...(result?._meta || {}),
      [SERVER_INFO_META_KEY]: SERVER_INFO
    }
  };
}

function sendModernResult(res, id, result) {
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "mcp-protocol-version": MODERN_PROTOCOL,
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "MCP-Protocol-Version"
  });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result: modernEnvelope(result) }));
}

function sendRpcError(res, id, code, message, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(jsonRpcError(id, code, message));
}

function parseUpstreamRpc(text, contentType) {
  if (contentType.includes("application/json")) return JSON.parse(text);
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw) return JSON.parse(raw);
    }
  }
  throw new Error("unsupported_upstream_response");
}

async function callLegacyRpc(message) {
  const legacyMessage = {
    ...message,
    params: stripModernParams(message.params)
  };

  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": LEGACY_PROTOCOL,
      "user-agent": "Trading-Data-ChatGPT-ReadOnly-Proxy/1.1"
    },
    body: JSON.stringify(legacyMessage)
  });

  const contentType = upstream.headers.get("content-type") || "";
  const text = await upstream.text();
  let payload;
  try {
    payload = parseUpstreamRpc(text, contentType);
  } catch {
    throw new Error(`upstream_protocol_error_${upstream.status}`);
  }
  return { upstream, payload };
}

async function handleModernRpc(req, res, message) {
  if (Array.isArray(message)) {
    sendRpcError(res, null, -32600, "JSON-RPC batching is not supported", 400);
    return;
  }

  const method = message?.method;
  const id = message?.id;

  if (method === "server/discover") {
    sendModernResult(res, id, {
      supportedVersions: [MODERN_PROTOCOL],
      capabilities: { tools: {} },
      ttlMs: 0,
      cacheScope: "private"
    });
    return;
  }

  if (method !== "tools/list" && method !== "tools/call") {
    sendRpcError(res, id, -32601, `Method not found: ${String(method)}`);
    return;
  }

  if (method === "tools/call") {
    const tool = message.params?.name;
    if (!ALLOWED_TOOLS.has(tool)) {
      sendRpcError(res, id, -32602, `Tool is not exposed by this read-only proxy: ${String(tool)}`);
      return;
    }
  }

  try {
    const { upstream, payload } = await callLegacyRpc(message);
    if (payload?.error) {
      sendRpcError(
        res,
        id,
        payload.error.code ?? -32603,
        payload.error.message || `Upstream error (${upstream.status})`,
        upstream.ok ? 200 : upstream.status
      );
      return;
    }

    if (!payload?.result) {
      sendRpcError(res, id, -32603, "Upstream returned no MCP result", 502);
      return;
    }

    if (method === "tools/list") {
      const tools = Array.isArray(payload.result.tools)
        ? payload.result.tools.filter(tool => ALLOWED_TOOLS.has(tool?.name))
        : [];
      sendModernResult(res, id, {
        tools,
        ttlMs: 0,
        cacheScope: "private"
      });
      return;
    }

    const result = { ...payload.result };
    if (!Array.isArray(result.content)) result.content = [];
    sendModernResult(res, id, result);
  } catch {
    sendRpcError(res, id, -32603, "Upstream MCP request failed", 502);
  }
}

function copyResponseHeaders(upstream, res) {
  const allowed = [
    "content-type",
    "cache-control",
    "mcp-session-id",
    "mcp-protocol-version"
  ];

  for (const name of allowed) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }

  res.setHeader("access-control-allow-origin", "*");
  res.setHeader(
    "access-control-expose-headers",
    "Mcp-Session-Id, MCP-Protocol-Version"
  );
}

async function forward(req, res) {
  if (!TOKEN) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "UPSTREAM_BEARER_TOKEN is not configured"
    }));
    return;
  }

  if (!checkRateLimit(req)) {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "60"
    });
    res.end(JSON.stringify({ error: "rate_limit_exceeded" }));
    return;
  }

  let body;
  let parsedBody = null;
  let isInitializeRequest = false;

  if (!["GET", "HEAD", "DELETE"].includes(req.method)) {
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "request_too_large" }));
      return;
    }

    if (body.length) {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        parsedBody = parsed;
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        isInitializeRequest = messages.some(
          item => item && typeof item === "object" && item.method === "initialize"
        );
        const violation = validateRpc(parsed);

        if (violation) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(jsonRpcError(
            violation.id,
            -32602,
            violation.message
          ));
          return;
        }
      } catch {
        // Let upstream return the protocol-level parse error.
      }
    }
  }

  if (parsedBody && isModernRpc(req, parsedBody)) {
    await handleModernRpc(req, res, parsedBody);
    return;
  }

  const headers = {
    authorization: `Bearer ${TOKEN}`,
    accept:
      req.headers.accept ||
      "application/json, text/event-stream",
    "user-agent": "Trading-Data-ChatGPT-ReadOnly-Proxy/1.0"
  };

  for (const name of [
    "content-type",
    "mcp-protocol-version",
    "mcp-session-id",
    "last-event-id"
  ]) {
    // The modern MCP protocol header applies after initialization. Some clients
    // optimistically send it on initialize; forwarding it causes strict upstream
    // servers to reject the legacy initialize handshake as a header/body mismatch.
    if (name === "mcp-protocol-version" && isInitializeRequest) continue;

    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }

  let upstream;

  try {
    upstream = await fetch(UPSTREAM, {
      method: req.method,
      headers,
      body:
        ["GET", "HEAD", "DELETE"].includes(req.method)
          ? undefined
          : body
    });
  } catch {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_unavailable" }));
    return;
  }

  copyResponseHeaders(upstream, res);

  const contentType =
    upstream.headers.get("content-type") || "application/octet-stream";

  res.statusCode = upstream.status;

  // GET may be a long-lived MCP SSE channel: stream it directly.
  if (
    req.method === "GET" &&
    contentType.includes("text/event-stream") &&
    upstream.body
  ) {
    Readable.fromWeb(upstream.body).pipe(res);
    return;
  }

  const text = await upstream.text();
  res.end(filterResponseText(text, contentType));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers":
        "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID"
    });
    res.end();
    return;
  }

  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      mode: "public-read-only-proxy",
      upstream_configured: Boolean(TOKEN)
    }));
    return;
  }

  if (req.url === "/mcp" || req.url === "/chatgpt-mcp") {
    await forward(req, res);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Trading Data ChatGPT proxy listening on :${PORT}`);
});
