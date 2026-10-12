import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer, MCP_PROTOCOL_VERSION, TOOL_DEFINITIONS } from '../server.js';

const TOKEN='test-feed-token';

function fakeCollector(overrides={}) {
  return {
    getStatus: () => ({ started:true, activeSymbols:3 }),
    getWatchlist: () => [{symbol:'BTCUSDT',core:true}],
    ensureSymbols: async symbols => symbols.map(symbol=>({symbol})),
    getSnapshot: symbol => ({symbol,runtime:'WARMING_UP',coverage:[]}),
    getSummary: symbol => ({symbol,runtime:'WARMING_UP'}),
    ...overrides
  };
}

async function withServer(options, fn) {
  const server=createHttpServer(options);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise(resolve=>server.close(resolve)); }
}

async function request(base,path,{method='GET',token=TOKEN,body,headers={}}={}) {
  const h={...headers}; if(token) h.authorization=`Bearer ${token}`;
  if(body!==undefined) h['content-type']='application/json';
  const res=await fetch(base+path,{method,headers:h,body:body===undefined?undefined:(typeof body==='string'?body:JSON.stringify(body))});
  const text=await res.text(); return {res,text,json:text?JSON.parse(text):null};
}

async function rpc(base,message,token=TOKEN) {
  return request(base,'/mcp',{method:'POST',token,body:message,headers:{'mcp-protocol-version':MCP_PROTOCOL_VERSION}});
}

test('health is public while protected endpoints require bearer token', async()=>{
  await withServer({env:{MICROSTRUCTURE_FEED_TOKEN:TOKEN},collector:fakeCollector()},async base=>{
    assert.equal((await request(base,'/healthz',{token:null})).res.status,200);
    assert.equal((await request(base,'/v1/status',{token:null})).res.status,401);
    assert.equal((await request(base,'/v1/status',{token:'wrong'})).res.status,401);
    const good=await request(base,'/v1/status'); assert.equal(good.res.status,200); assert.equal(good.json.activeSymbols,3);
    assert.equal(good.text.includes(TOKEN),false);
  });
});

test('protected API fails closed if token is not configured', async()=>{
  await withServer({env:{},collector:fakeCollector()},async base=>{
    assert.equal((await request(base,'/healthz',{token:null})).res.status,200);
    assert.equal((await request(base,'/v1/status',{token:null})).res.status,503);
  });
});

test('REST status watchlist ensure and microstructure routes dispatch to collector', async()=>{
  const calls=[];
  const collector=fakeCollector({
    getWatchlist:()=>[{symbol:'BTCUSDT'}],
    ensureSymbols:async symbols=>{calls.push(symbols);return symbols;},
    getSnapshot:symbol=>({symbol,runtime:'FULL_EVENT_STREAM'})
  });
  await withServer({env:{MICROSTRUCTURE_FEED_TOKEN:TOKEN},collector},async base=>{
    assert.equal((await request(base,'/v1/watchlist')).json[0].symbol,'BTCUSDT');
    const ensured=await request(base,'/v1/watchlist/ensure',{method:'POST',body:{symbols:['stxusdt']}});
    assert.equal(ensured.res.status,200); assert.deepEqual(calls,[['STXUSDT']]);
    const snap=await request(base,'/v1/microstructure/btcusdt');
    assert.equal(snap.json.symbol,'BTCUSDT'); assert.equal(snap.json.runtime,'FULL_EVENT_STREAM');
  });
});

test('REST rejects malformed JSON invalid symbols capacity errors and oversized bodies', async()=>{
  const collector=fakeCollector({ensureSymbols:async()=>{throw new Error('watchlist_capacity_exceeded');}});
  await withServer({env:{MICROSTRUCTURE_FEED_TOKEN:TOKEN},collector,maxBodyBytes:80},async base=>{
    assert.equal((await request(base,'/v1/watchlist/ensure',{method:'POST',body:'{bad'})).res.status,400);
    assert.equal((await request(base,'/v1/microstructure/..%2FBTC')).res.status,400);
    assert.equal((await request(base,'/v1/watchlist/ensure',{method:'POST',body:{symbols:['STXUSDT']}})).res.status,409);
    const huge=await request(base,'/v1/watchlist/ensure',{method:'POST',body:{symbols:['BTCUSDT'],padding:'x'.repeat(200)}});
    assert.equal(huge.res.status,413);
  });
});

test('MCP initialize discovery and tools/list expose exactly four read-only tools', async()=>{
  assert.deepEqual(TOOL_DEFINITIONS.map(x=>x.name).sort(),['ensure_symbols','get_microstructure_snapshot','get_microstructure_summary','get_stream_status'].sort());
  assert.ok(TOOL_DEFINITIONS.every(x=>x.annotations.readOnlyHint===true && x.annotations.destructiveHint===false));
  await withServer({env:{MICROSTRUCTURE_FEED_TOKEN:TOKEN},collector:fakeCollector()},async base=>{
    const init=await rpc(base,{jsonrpc:'2.0',id:1,method:'initialize',params:{}});
    assert.equal(init.json.result.protocolVersion,MCP_PROTOCOL_VERSION);
    assert.equal(init.json.result.serverInfo.name,'entry-microstructure-feed');
    const discover=await rpc(base,{jsonrpc:'2.0',id:2,method:'server/discover',params:{}});
    assert.deepEqual(discover.json.result.supportedVersions,[MCP_PROTOCOL_VERSION]);
    const list=await rpc(base,{jsonrpc:'2.0',id:3,method:'tools/list',params:{}});
    assert.equal(list.json.result.tools.length,4);
  });
});

test('MCP tools/call routes status ensure snapshot and summary', async()=>{
  const calls=[];
  const collector=fakeCollector({
    getStatus:()=>({ok:'status'}),
    ensureSymbols:async symbols=>{calls.push(['ensure',symbols]);return {symbols};},
    getSnapshot:symbol=>{calls.push(['snap',symbol]);return {symbol,runtime:'FULL_EVENT_STREAM'};},
    getSummary:symbol=>{calls.push(['summary',symbol]);return {symbol,summary:'x'};}
  });
  await withServer({env:{MICROSTRUCTURE_FEED_TOKEN:TOKEN},collector},async base=>{
    assert.deepEqual((await rpc(base,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_stream_status',arguments:{}}})).json.result.structuredContent,{ok:'status'});
    await rpc(base,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ensure_symbols',arguments:{symbols:['stxusdt']}}});
    await rpc(base,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_microstructure_snapshot',arguments:{symbol:'btcusdt'}}});
    await rpc(base,{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get_microstructure_summary',arguments:{symbol:'ethusdt'}}});
    assert.deepEqual(calls,[['ensure',['STXUSDT']],['snap','BTCUSDT'],['summary','ETHUSDT']]);
  });
});

test('MCP rejects unknown tools and oversized body', async()=>{
  await withServer({env:{MICROSTRUCTURE_FEED_TOKEN:TOKEN},collector:fakeCollector(),maxBodyBytes:120},async base=>{
    const unknown=await rpc(base,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'place_order',arguments:{}}});
    assert.equal(unknown.json.error.code,-32602);
    const huge=await request(base,'/mcp',{method:'POST',body:{jsonrpc:'2.0',id:2,method:'tools/list',padding:'x'.repeat(300)}});
    assert.equal(huge.res.status,413);
  });
});

test('upstream errors are redacted in response and logger', async()=>{
  const logs=[];
  const collector=fakeCollector({getStatus:()=>{throw new Error(`upstream failed with ${TOKEN}`);}});
  await withServer({env:{MICROSTRUCTURE_FEED_TOKEN:TOKEN},collector,logger:{error:x=>logs.push(x)}},async base=>{
    const result=await request(base,'/v1/status');
    assert.equal(result.res.status,500);
    assert.equal(result.text.includes(TOKEN),false);
    assert.match(result.text,/REDACTED/);
    assert.equal(JSON.stringify(logs).includes(TOKEN),false);
  });
});
