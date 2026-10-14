import { pathToFileURL } from 'node:url';
import { assertNeutralPayload } from '../schema-guard.js';

const EXPECTED_TOOLS = new Set(['source_health','prepare_snapshot','market_universe','historical_market_data','historical_derivatives_data','cross_market_data','microstructure_data']);

export async function runSmoke({ baseUrl, token, fetchImpl = fetch, includeMicrostructure = true } = {}) {
  if (!baseUrl) throw new Error('base_url_required');
  if (!token) throw new Error('token_required');
  const root=String(baseUrl).replace(/\/$/,'');
  let id=0;
  async function rpc(method,params={}) {
    const response=await fetchImpl(`${root}/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
    if(!response.ok) throw new Error(`smoke_http_${response.status}`);
    const payload=await response.json();
    if(payload.error) throw new Error(`smoke_rpc_${payload.error.code}:${payload.error.message}`);
    if(payload.result?.structuredContent) assertNeutralPayload(payload.result.structuredContent);
    return payload.result;
  }
  const healthResponse=await fetchImpl(`${root}/healthz`);
  if(!healthResponse.ok) throw new Error(`health_http_${healthResponse.status}`);
  const health=await healthResponse.json();
  if(health.status!=='ok') throw new Error('health_not_ok');
  const discovery=await rpc('server/discover');
  if(!String(discovery.instructions??'').includes('Trading Analyst Protocol')) throw new Error('analyst_protocol_missing');
  const listed=await rpc('tools/list');
  const names=new Set((listed.tools??[]).map(x=>x.name));
  for(const name of EXPECTED_TOOLS) if(!names.has(name)) throw new Error(`tool_missing:${name}`);
  if(names.size!==EXPECTED_TOOLS.size) throw new Error('unexpected_tool_exposed');
  const prepared=await rpc('tools/call',{name:'prepare_snapshot',arguments:{}});
  const snapshotId=prepared.structuredContent?.snapshotId;
  if(!snapshotId) throw new Error('snapshot_id_missing');
  const universe=await rpc('tools/call',{name:'market_universe',arguments:{snapshotId,limit:20}});
  const symbols=(universe.structuredContent?.rows??[]).map(x=>x.symbol).filter(Boolean).slice(0,3);
  const sample=symbols.length?symbols:['BTCUSDT'];
  await rpc('tools/call',{name:'historical_market_data',arguments:{snapshotId,symbols:sample,timeframe:'1h',maxRows:2000}});
  await rpc('tools/call',{name:'historical_derivatives_data',arguments:{snapshotId,symbols:sample,resolution:'5m',fields:['openInterest','fundingRate','markPrice','indexPrice','basisBps'],maxRows:2000}});
  await rpc('tools/call',{name:'cross_market_data',arguments:{snapshotId,symbols:sample,mode:'snapshot'}});
  if(includeMicrostructure) await rpc('tools/call',{name:'microstructure_data',arguments:{snapshotId,symbols:sample.slice(0,1),bucketMs:1000,lookbackMs:5000}});
  return {ok:true,snapshotId,sampleSymbols:sample};
}

function direct(){try{return import.meta.url===pathToFileURL(process.argv[1]).href}catch{return false}}
if(direct()){
  runSmoke({baseUrl:process.env.DATA_PLANE_URL,token:process.env.DATA_PLANE_TOKEN}).then(result=>{console.log(JSON.stringify(result));}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
