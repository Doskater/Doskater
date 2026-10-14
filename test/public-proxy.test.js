import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ALLOWED_TOOLS, createProxyServer } from '../public-proxy.js';
import { ANALYST_PROTOCOL } from '../trading-data-plane/analyst-protocol.js';

async function rpc(base,method,params={}) {
  const r=await fetch(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  return r.json();
}

test('proxy discovery publishes analyst protocol and exactly seven data tools', async t => {
  const server=createProxyServer({upstreamUrl:'https://upstream.invalid/mcp',token:'secret',fetchImpl:async()=>{throw new Error('should_not_fetch')}});
  server.listen(0,'127.0.0.1'); await once(server,'listening'); t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const discovery=await rpc(base,'server/discover');
  assert.equal(discovery.result.instructions,ANALYST_PROTOCOL);
  const listed=await rpc(base,'tools/list');
  assert.deepEqual(listed.result.tools.map(x=>x.name).sort(),[...ALLOWED_TOOLS].sort());
  assert.equal(ALLOWED_TOOLS.size,7);
});

test('proxy rejects old analytics and execution-like tools before upstream fetch', async t => {
  let calls=0;
  const server=createProxyServer({upstreamUrl:'https://upstream.invalid/mcp',token:'secret',fetchImpl:async()=>{calls++;throw new Error('no')}});
  server.listen(0,'127.0.0.1'); await once(server,'listening'); t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  for (const name of ['macro_regime','place_order','cancel_order']) {
    const out=await rpc(base,'tools/call',{name,arguments:{}});
    assert.equal(out.error.code,-32602);
  }
  assert.equal(calls,0);
});

test('proxy forwards allowed tool calls with upstream bearer token', async t => {
  const seen=[];
  const fetchImpl=async (url,options)=>{
    seen.push({url,options});
    return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'{}'}],structuredContent:{state:'GOOD'}}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const server=createProxyServer({upstreamUrl:'https://data.example/mcp',token:'upstream-secret',fetchImpl});
  server.listen(0,'127.0.0.1'); await once(server,'listening'); t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const out=await rpc(base,'tools/call',{name:'source_health',arguments:{}});
  assert.equal(out.result.structuredContent.state,'GOOD');
  assert.equal(seen.length,1);
  assert.equal(seen[0].options.headers.authorization,'Bearer upstream-secret');
});

test('proxy blocks recommendation leakage from an allowed upstream tool', async t => {
  const fetchImpl=async ()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{structuredContent:{signal:'LONG'}}}),{status:200,headers:{'content-type':'application/json'}});
  const server=createProxyServer({upstreamUrl:'https://data.example/mcp',token:'secret',fetchImpl});
  server.listen(0,'127.0.0.1'); await once(server,'listening'); t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const out=await rpc(base,'tools/call',{name:'source_health',arguments:{}});
  assert.equal(out.error.code,-32603);
  assert.equal(out.error.message,'neutral_payload_violation');
});

test('proxy rate-limits upstream tool calls per client', async t => {
  let calls=0;
  const fetchImpl=async ()=>{calls++;return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{structuredContent:{state:'GOOD'}}}),{status:200,headers:{'content-type':'application/json'}});};
  const server=createProxyServer({upstreamUrl:'https://data.example/mcp',token:'secret',fetchImpl,rateLimitMax:2,rateLimitWindowMs:60000,clock:{now:()=>1000}});
  server.listen(0,'127.0.0.1'); await once(server,'listening'); t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await rpc(base,'tools/call',{name:'source_health',arguments:{}})).error,undefined);
  assert.equal((await rpc(base,'tools/call',{name:'source_health',arguments:{}})).error,undefined);
  const third=await rpc(base,'tools/call',{name:'source_health',arguments:{}});
  assert.equal(third.error.message,'rate_limit_exceeded');
  assert.equal(calls,2);
});
