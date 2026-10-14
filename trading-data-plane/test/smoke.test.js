import test from 'node:test';
import assert from 'node:assert/strict';
import { runSmoke } from '../scripts/smoke.js';

test('smoke exercises discovery, snapshot, universe, bounded history, derivatives and cross-market without recommendation fields', async () => {
  const calls=[];
  const responses=[
    {status:'ok'},
    {jsonrpc:'2.0',id:1,result:{instructions:'Trading Analyst Protocol v1'}},
    {jsonrpc:'2.0',id:2,result:{tools:[{name:'source_health'},{name:'prepare_snapshot'},{name:'market_universe'},{name:'historical_market_data'},{name:'historical_derivatives_data'},{name:'cross_market_data'},{name:'microstructure_data'}]}},
    {jsonrpc:'2.0',id:3,result:{structuredContent:{snapshotId:'snap'}}},
    {jsonrpc:'2.0',id:4,result:{structuredContent:{rows:[{symbol:'BTCUSDT'}]}}},
    {jsonrpc:'2.0',id:5,result:{structuredContent:{rows:[]}}},
    {jsonrpc:'2.0',id:6,result:{structuredContent:{rows:[]}}},
    {jsonrpc:'2.0',id:7,result:{structuredContent:{symbols:{BTCUSDT:{venues:{}}}}}},
    {jsonrpc:'2.0',id:8,result:{structuredContent:{symbols:{BTCUSDT:{families:{}}}}}}
  ];
  const fetchImpl=async (url,options={})=>{
    calls.push({url,options});
    const body=responses.shift();
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  };
  const result=await runSmoke({baseUrl:'https://data.example',token:'secret',fetchImpl,includeMicrostructure:true});
  assert.equal(result.ok,true);
  assert.equal(calls.length,9);
  const toolCalls=calls.filter(call=>call.options?.body).map(call=>JSON.parse(call.options.body)).filter(body=>body.method==='tools/call');
  const byName=Object.fromEntries(toolCalls.map(body=>[body.params.name,body.params.arguments]));
  assert.equal(Object.hasOwn(byName.historical_market_data,'startMs'),false);
  assert.equal(Object.hasOwn(byName.historical_derivatives_data,'startMs'),false);
  assert.deepEqual(byName.cross_market_data,{snapshotId:'snap',symbols:['BTCUSDT'],mode:'snapshot'});
});
