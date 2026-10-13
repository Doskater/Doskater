import {promises as fs} from 'node:fs';
import {normalizeSymbol} from './config.js';
import {analyzeStructure,resolveRoles,DEFAULT_ROLES,canonicalTimeframe} from './mtf-structure.js';
import {classifyScenarios} from './mtf-scenarios.js';
import {normalizeSetup,readSetups,syncSetups,getWatcherConfig} from './trigger-watcher.js';
import {createCandidate} from './entry-journal.js';
import {quantizeMarketPrice} from './entry-numbers.js';

const SOURCES=['binance:spot','binance:perp','bybit:spot','bybit:linear'];
const BINANCE_INTERVALS=['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w'];
const BYBIT_INTERVALS={'1m':'1','3m':'3','5m':'5','15m':'15','30m':'30','1h':'60','2h':'120','4h':'240','6h':'360','12h':'720','1d':'D','1w':'W'};
export async function readPublicCandles({symbol,timeframe,source='binance:perp',limit=240,fetchImpl=fetch}={}) {
  symbol=normalizeSymbol(symbol);
  timeframe=canonicalTimeframe(timeframe);
  if(!SOURCES.includes(source)||!Number.isSafeInteger(limit)||limit<20||limit>1000)throw Error('invalid_candle_request');
  const bybit=source.startsWith('bybit:');
  if(bybit?!BYBIT_INTERVALS[timeframe]:!BINANCE_INTERVALS.includes(timeframe))throw Error('unsupported_exchange_timeframe');
  const url=new URL(bybit?'https://api.bybit.com/v5/market/kline':source==='binance:spot'
    ?'https://api.binance.com/api/v3/klines':'https://fapi.binance.com/fapi/v1/klines');
  url.searchParams.set('symbol',symbol);url.searchParams.set('limit',String(limit));
  url.searchParams.set('interval',bybit?BYBIT_INTERVALS[timeframe]:timeframe);
  if(bybit)url.searchParams.set('category',source==='bybit:spot'?'spot':'linear');
  const response=await fetchImpl(url.href,{method:'GET',cache:'no-store',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('candle_fetch_failed');
  const body=await response.json();
  const raw=bybit?(body.retCode===0?body.result?.list:null):body;
  if(!Array.isArray(raw))throw Error('invalid_candle_response');
  const candles=raw.map(c=>{
    if(!Array.isArray(c)||c.length<6||c.slice(0,6).some(x=>x===null||x===''||x===undefined))throw Error('invalid_candle_response');
    return {time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4]),volume:Number(c[5])};
  });
  if(bybit)candles.reverse();
  return {symbol,source,candles};
}
export async function runStructurePipeline({symbols,source='binance:perp',roles=DEFAULT_ROLES,asOf=Date.now(),
  reader=readPublicCandles,framesBySymbol,options={}}={}) {
  if(!Array.isArray(symbols)||!symbols.length||symbols.length>12)throw Error('invalid_monitored_symbols');
  const normalized=symbols.map(normalizeSymbol);
  if(new Set(normalized).size!==normalized.length)throw Error('duplicate_symbol');
  const resolved=resolveRoles(roles),wanted=[...new Set(Object.values(resolved).flat())];
  return Promise.all(normalized.map(async symbol=>{
    let frames=framesBySymbol?.[symbol];
    if(framesBySymbol===undefined) {
      frames=Object.fromEntries(await Promise.all(wanted.map(async timeframe=>{
        try{return [timeframe,await reader({symbol,timeframe,source})];}
        catch{return [timeframe,{symbol,source,candles:null}];}
      })));
    }
    return classifyScenarios(analyzeStructure({symbol,source,asOf,roles:resolved,frames:frames ?? {},options}));
  }));
}
function selectedScenarios(result) {
  if(result.status!=='FULL'||result.regime==='unknown')return [];
  const chosen=new Map();
  for(const c of result.scenarios ?? []) {
    if(c.symbol!==result.symbol||c.source!==result.source||!['long','short'].includes(c.side)||!Number.isFinite(c.confidence)||
      c.confidence<.35 || c.asOf!==result.asOf || !Number.isFinite(c.triggerPrice)||c.triggerPrice<=0)continue;
    const f=result.frames[c.timeframe];
    if(!f?.ok || Math.abs(f.last.close-c.triggerPrice)>6*f.atr)continue;
    const prior=chosen.get(c.side);
    if(!prior || Number(c.lowerTrigger?.confirmed)>Number(prior.lowerTrigger?.confirmed) ||
      Boolean(c.lowerTrigger?.confirmed)===Boolean(prior.lowerTrigger?.confirmed)&&prior.confidence<c.confidence)chosen.set(c.side,c);
  }
  return [...chosen.values()];
}
export function deriveWatcherSet(results,existing=[]) {
  const bySymbol=new Map();
  for(const r of results) {
    if(bySymbol.has(r.symbol))throw Error('duplicate_analysis_symbol');
    bySymbol.set(r.symbol,r);
  }
  const setups=existing.map(normalizeSetup).filter(s=>{
    const r=bySymbol.get(s.symbol);
    // Partial/unknown data cannot remove a valid monitoring configuration.
    return !r || r.status!=='FULL'||r.regime==='unknown';
  });
  const evidence=[];
  for(const r of results)for(const c of selectedScenarios(r)) {
    const setup=normalizeSetup({symbol:r.symbol,side:c.side,triggerPrice:c.triggerPrice});
    setups.push(setup);
    evidence.push({symbol:r.symbol,side:c.side,triggerPrice:c.triggerPrice,scenarioId:c.scenarioId,
      scenario:c.type,zone:c.zone,invalidationPrice:c.invalidationPrice,targets:c.targets,
      source:c.source,timeframe:c.timeframe,asOf:r.asOf,confidence:c.confidence,setupConfirmed:c.setupConfirmed});
  }
  setups.sort((a,b)=>a.symbol.localeCompare(b.symbol)||a.side.localeCompare(b.side));
  return {setups,evidence};
}
export async function syncStructureWatchers(results,{config=getWatcherConfig(),fsImpl=fs,reason='mtf_structure_refresh'}={}) {
  if(typeof reason!=='string'||!reason)throw Error('sync_reason_required');
  const before=await readSetups({config,fsImpl});
  const desired=deriveWatcherSet(results,before);
  const result=await syncSetups(desired.setups,{config,fsImpl});
  await fsImpl.appendFile(config.logFile,JSON.stringify({event:'watcher_sync',reason,changes:result.changes,
    setupCount:result.setups.length,evidence:desired.evidence})+'\n',{mode:0o600});
  // Configuration writes only: never start services, notify, or access execution.
  return {...result,evidence:desired.evidence,reason};
}
export function buildStructuralContext(result,candidate,execution={}) {
  const desired=deriveWatcherSet([result],[]);
  const setup=desired.setups.find(s=>s.symbol===candidate.symbol&&s.side===candidate.side&&s.triggerPrice===candidate.triggerPrice);
  if(!setup || createCandidate(setup,{currentMid:candidate.observedPrice},{now:()=>result.asOf}).setupId!==candidate.setupId)
    throw Error('structural_scenario_identity_mismatch');
  const c=selectedScenarios(result).find(c=>c.side===candidate.side&&c.triggerPrice===candidate.triggerPrice);
  const long=c.side==='long',last=result.frames[c.timeframe].last;
  const valid=long?last.close>c.invalidationPrice:last.close<c.invalidationPrice;
  // Copy only execution/risk fields; external inputs cannot overwrite structural evidence.
  const external=Object.fromEntries(['marketRiskAllowed','qty','qtyStep','tickSize','positionIdx','reducedSizeFactor']
    .filter(k=>execution[k]!==undefined).map(k=>[k,execution[k]]));
  // Engine prices are computed floats. Convert using the existing market-price
  // quantizer before they reach the strict exact-decimal execution contract.
  const invalidationPrice=external.tickSize===undefined?c.invalidationPrice:
    Number(quantizeMarketPrice(c.invalidationPrice,external.tickSize,!long));
  const targets=external.tickSize===undefined?c.targets:
    c.targets.map(t=>Number(quantizeMarketPrice(t,external.tickSize,!long)));
  return {...external,symbol:result.symbol,side:c.side,setupId:candidate.setupId,asOf:result.asOf,
    structure:valid?'valid':'broken',thesisValid:valid,invalidationPrice,targets,
    mtf:{schemaVersion:1,symbol:result.symbol,side:c.side,source:result.source,asOf:result.asOf,
      scenarioId:c.scenarioId,setupId:candidate.setupId,triggerPrice:candidate.triggerPrice,timeframe:c.timeframe,
      regime:result.regime,coverage:result.agreement.coverage,confidence:c.confidence,zone:c.zone,
      entryTimeframes:result.roles.entry,setupConfirmedAt:c.setupConfirmedAt,
      setupConfirmed:c.setupConfirmed,lowerTrigger:c.lowerTrigger,structureValid:valid,
      rawInvalidationPrice:c.invalidationPrice,invalidationPrice,targets}};
}
