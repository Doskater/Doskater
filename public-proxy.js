import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ANALYST_PROTOCOL } from './trading-data-plane/analyst-protocol.js';
import { TOOL_DEFINITIONS } from './trading-data-plane/tool-definitions.js';
import { assertNeutralPayload } from './trading-data-plane/schema-guard.js';
import { MODERN_PROTOCOL, LEGACY_PROTOCOL, SERVER_INFO } from './trading-data-plane/config.js';

export const ALLOWED_TOOLS = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
const MAX_BODY_BYTES = 1_000_000;

function sendJson(res,status,body,headers={}) {
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*',...headers});
  res.end(JSON.stringify(body));
}
function rpcResult(id,result){ return {jsonrpc:'2.0',id:id??null,result}; }
function rpcError(id,code,message){ return {jsonrpc:'2.0',id:id??null,error:{code,message}}; }
function modern(result){ return {...result,resultType:'complete',_meta:{...(result?._meta??{}),'io.modelcontextprotocol/serverInfo':SERVER_INFO}}; }
async function readBody(req){
  const chunks=[]; let size=0;
  for await (const chunk of req){ size+=chunk.length; if(size>MAX_BODY_BYTES) throw new Error('request_too_large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function createProxyServer({
  upstreamUrl = process.env.UPSTREAM_MCP_URL,
  token = process.env.UPSTREAM_BEARER_TOKEN,
  fetchImpl = fetch,
  rateLimitMax = 120,
  rateLimitWindowMs = 60_000,
  clock = Date
} = {}) {
  const rate = new Map();
  const now = () => typeof clock.now === 'function' ? clock.now() : Date.now();
  const withinRateLimit = req => {
    const forwarded=req.headers['x-forwarded-for'];
    const ip=typeof forwarded==='string'&&forwarded?forwarded.split(',')[0].trim():(req.socket.remoteAddress||'unknown');
    const current=now();
    let row=rate.get(ip);
    if(!row||current-row.started>=rateLimitWindowMs) row={started:current,count:0};
    row.count+=1; rate.set(ip,row);
    return row.count<=rateLimitMax;
  };
  return http.createServer(async (req,res)=>{
    if(req.method==='OPTIONS'){
      res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,DELETE,OPTIONS','access-control-allow-headers':'Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID'});res.end();return;
    }
    const url=new URL(req.url||'/','http://localhost');
    if(url.pathname==='/healthz') return sendJson(res,200,{status:'ok',mode:'public-read-only-proxy',upstreamConfigured:Boolean(upstreamUrl&&token)});
    if(!['/mcp','/chatgpt-mcp'].includes(url.pathname)) return sendJson(res,404,{error:'not_found'});
    if(req.method!=='POST') return sendJson(res,405,{error:'method_not_allowed'});

    let body;
    try { body=await readBody(req); }
    catch { return sendJson(res,413,{error:'request_too_large'}); }
    let message;
    try { message=JSON.parse(body.toString('utf8')); }
    catch { return sendJson(res,400,rpcError(null,-32700,'Parse error')); }
    if(!message||typeof message!=='object'||Array.isArray(message)) return sendJson(res,400,rpcError(message?.id,-32600,'Invalid Request'));
    const {id,method}=message;

    if(method==='server/discover') return sendJson(res,200,rpcResult(id,modern({supportedVersions:[MODERN_PROTOCOL],capabilities:{tools:{}},instructions:ANALYST_PROTOCOL,ttlMs:0,cacheScope:'private'})),{'mcp-protocol-version':MODERN_PROTOCOL});
    if(method==='initialize') return sendJson(res,200,rpcResult(id,{protocolVersion:LEGACY_PROTOCOL,capabilities:{tools:{}},serverInfo:SERVER_INFO,instructions:ANALYST_PROTOCOL}),{'mcp-protocol-version':LEGACY_PROTOCOL});
    if(method==='notifications/initialized'){ res.writeHead(202,{'access-control-allow-origin':'*'});res.end();return; }
    if(method==='tools/list') return sendJson(res,200,rpcResult(id,modern({tools:TOOL_DEFINITIONS,ttlMs:0,cacheScope:'private'})),{'mcp-protocol-version':MODERN_PROTOCOL});
    if(method!=='tools/call') return sendJson(res,200,rpcError(id,-32601,`Method not found: ${String(method)}`));
    const tool=message.params?.name;
    if(!ALLOWED_TOOLS.has(tool)) return sendJson(res,200,rpcError(id,-32602,`Tool is not exposed by this read-only proxy: ${String(tool)}`));
    if(!withinRateLimit(req)) return sendJson(res,429,rpcError(id,-32000,'rate_limit_exceeded'),{'retry-after':'60'});
    if(!upstreamUrl||!token) return sendJson(res,503,rpcError(id,-32603,'upstream_not_configured'));

    let upstream;
    try {
      upstream=await fetchImpl(upstreamUrl,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json','mcp-protocol-version':MODERN_PROTOCOL,'user-agent':'Trading-Data-ChatGPT-ReadOnly-Proxy/2.0'},body:JSON.stringify(message)});
    } catch {
      return sendJson(res,502,rpcError(id,-32603,'upstream_unavailable'));
    }
    let payload;
    try { payload=await upstream.json(); }
    catch { return sendJson(res,502,rpcError(id,-32603,'upstream_protocol_error')); }
    if(payload?.result?.structuredContent){
      try { assertNeutralPayload(payload.result.structuredContent); }
      catch { return sendJson(res,502,rpcError(id,-32603,'neutral_payload_violation')); }
    }
    return sendJson(res,upstream.status,payload,{'mcp-protocol-version':upstream.headers.get('mcp-protocol-version')||MODERN_PROTOCOL});
  });
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
}

if (isDirectExecution()) {
  const port=Number(process.env.PORT||10000);
  createProxyServer().listen(port,'0.0.0.0',()=>console.log(`Trading Data ChatGPT proxy listening on :${port}`));
}
