import {buildTerminalCommand} from './entry-command.js';
import {normalizeSymbol} from './config.js';
import {positiveNumber,units,quantize,quantizeMarketPrice,sizeFor} from './entry-numbers.js';
import {timeframeMs} from './mtf-structure.js';

export function evaluateFocusedEntry(candidate,snapshot,context,{now=Date.now,policy={}}={}) {
  const checkedAt=now();
  const limits=entryPolicy(policy);
  if(!candidate || candidate.schemaVersion!==1 || typeof candidate.candidateId!=='string' || !candidate.candidateId ||
    typeof candidate.setupId!=='string' || !candidate.setupId || !['long','short'].includes(candidate.side) ||
    !Number.isSafeInteger(candidate.detectedAt) || candidate.detectedAt<0 || candidate.detectedAt>checkedAt)throw Error('invalid_candidate');
  normalizeSymbol(candidate.symbol);
  const observed=positiveNumber(candidate.observedPrice,'observed_price');
  const trigger=positiveNumber(candidate.triggerPrice,'trigger_price');
  if(!context || context.symbol!==candidate.symbol || context.side!==candidate.side || context.setupId!==candidate.setupId)throw Error('context_identity_mismatch');
  if(snapshot?.symbol!==candidate.symbol)throw Error('snapshot_symbol_mismatch');
  const price=positiveNumber(snapshot.currentMid,'current_price');
  for(const [key,value] of Object.entries(policy))if(!['maxSnapshotAgeMs','maxContextAgeMs','liveTimeoutMs'].includes(key) ||
    !Number.isSafeInteger(value) || value<=0)throw Error('invalid_policy');
  const long=candidate.side==='long';
  const invalidation=context.invalidationPrice===undefined?null:positiveNumber(context.invalidationPrice,'invalidation_price');
  if(context.targets!==undefined && (!Array.isArray(context.targets) || !context.targets.length))throw Error('invalid_targets');
  const rawTargets=(context.targets ?? []).map(t=>positiveNumber(t,'target')).sort((a,b)=>long?a-b:b-a);
  if(rawTargets.some(t=>long?t<=observed:t>=observed))throw Error('invalid_target_geometry');
  if(context.invalidationPrice!==undefined)units(context.invalidationPrice,'invalidation_price');
  for(const target of context.targets ?? [])units(target,'target');
  const factor=context.reducedSizeFactor ?? 0.5;
  units(factor,'reduced_size_factor');
  if(positiveNumber(factor,'reduced_size_factor')>=1)throw Error('invalid_reduced_size_factor');
  const idx=context.positionIdx ?? 0;
  if(![0,long?1:2].includes(idx))throw Error('invalid_position_idx');
  for(const field of ['qty','qtyStep','tickSize'])if(context[field]!==undefined)units(context[field],field);
  const executionKnown=['qty','qtyStep','tickSize'].every(field=>context[field]!==undefined);
  const entry=context.tickSize===undefined?price:Number(quantizeMarketPrice(price,context.tickSize,!long));
  const stop=invalidation===null?null:context.tickSize===undefined?invalidation:Number(quantize(invalidation,context.tickSize,!long));
  const targets=rawTargets.map(t=>({price:context.tickSize===undefined?t:Number(quantize(t,context.tickSize,!long)),rr:null}));
  let risk=null,currentRR=null;
  if(stop!==null && (long?entry>stop:entry<stop)) {
    if(context.tickSize!==undefined)risk=long?units(entry)-units(stop):units(stop)-units(entry);
    for(const target of targets)target.rr=risk!==null?Number(long?units(target.price)-units(entry):units(entry)-units(target.price))/Number(risk):(long?target.price-entry:entry-target.price)/(long?entry-stop:stop-entry);
    currentRR=targets[0]?.rr ?? null;
  }
  const result={decision:'WAIT_RETEST',eligibleDecision:'WAIT_RETEST',symbol:candidate.symbol,side:candidate.side,candidateId:candidate.candidateId,setupId:candidate.setupId,
    entry,invalidationPrice:stop,targets,currentRR,qty:null,positionIdx:idx,reason:'analysis_incomplete',
    freshness:{candidateAgeMs:checkedAt-candidate.detectedAt,priceChangeBps:(price/observed-1)*10000}};
  const events=snapshot.freshness?.eventsByFamily?.[snapshot.primaryFamily];
  result.freshness={...result.freshness,contextAgeMs:Number.isSafeInteger(context.asOf)?checkedAt-context.asOf:null,snapshotAgeMs:Number.isSafeInteger(snapshot.asOf)?checkedAt-snapshot.asOf:null,primaryFamily:snapshot.primaryFamily ?? null,lastTradeAt:events?.lastTradeAt ?? null,lastBookAt:events?.lastBookAt ?? null};
  const wait=reason=>({...result,reason});
  const invalid=reason=>({...result,decision:'INVALIDATED',eligibleDecision:'INVALIDATED',reason});
  const priceReason=priceFreshnessReason(snapshot,context,checkedAt,limits);
  if(priceReason)return wait(priceReason);
  if(context.structure==='broken')return invalid('structure_broken');
  if(context.thesisValid===false)return invalid('thesis_revoked');
  if(invalidation!==null && (long?price<=invalidation:price>=invalidation))return invalid('invalidation_crossed');
  if(context.mtf!==undefined) {
    const mtfReason=mtfContextReason(candidate,snapshot,context,checkedAt,limits);
    if(mtfReason)return wait(mtfReason);
    if(context.mtf.structureValid===false)return invalid('mtf_structure_broken');
    if(context.mtf.rawInvalidationPrice!==undefined && (long?price<=context.mtf.rawInvalidationPrice:
      price>=context.mtf.rawInvalidationPrice))return invalid('mtf_raw_invalidation_crossed');
    if(context.mtf.setupConfirmed!==true)return wait('mtf_setup_pending');
    if(context.mtf.lowerTrigger.confirmed!==true)return wait('mtf_lower_trigger_pending');
  }
  const dataReason=liveDataReason(candidate,snapshot,context,checkedAt,limits);
  if(dataReason)return wait(dataReason);
  if(context.structure!=='valid' || context.thesisValid!==true || context.marketRiskAllowed!==true ||
    stop===null || !targets.length)return wait('analysis_incomplete');
  if(long?price<=trigger:price>=trigger)return wait('trigger_lost');
  if(rawTargets.some(t=>long?price>=t:price<=t) || targets.some(t=>long?entry>=t.price:entry<=t.price))return wait('target_reached');
  if(!risk || currentRR===null)return wait('invalid_risk');
  const reward=long?units(targets[0].price)-units(entry):units(entry)-units(targets[0].price);
  const eligibleDecision=reward>=risk*2n?'ENTER_NOW':reward*2n>=risk*3n?'ENTER_REDUCED':'WAIT_RETEST';
  if(eligibleDecision==='WAIT_RETEST')return wait('rr_below_minimum');
  if(!executionKnown)return wait('execution_data_missing');
  const qty=sizeFor(context.qty,context.qtyStep,eligibleDecision==='ENTER_REDUCED'?factor:1);
  if(Number(qty)<=0)return wait('quantity_below_step');
  return {...result,eligibleDecision,qty,reason:'requires_final_live_check'};
}

const DEFAULT_POLICY=Object.freeze({maxSnapshotAgeMs:5000,maxContextAgeMs:900000,liveTimeoutMs:2500});
function entryPolicy(overrides) {
  for(const [key,value] of Object.entries(overrides)) {
    if(!(key in DEFAULT_POLICY) || !Number.isSafeInteger(value) || value<=0)throw Error('invalid_policy');
  }
  return {...DEFAULT_POLICY,...overrides};
}
function timestampFresh(ts,now,maxAge) {
  return Number.isSafeInteger(ts) && ts>=0 && ts<=now && now-ts<=maxAge;
}
function mtfContextReason(candidate,snapshot,context,now,policy) {
  const m=context.mtf;
  if(!m || m.schemaVersion!==1 || m.symbol!==candidate.symbol || m.side!==candidate.side ||
    m.setupId!==candidate.setupId || m.triggerPrice!==candidate.triggerPrice ||
    typeof m.scenarioId!=='string'||!m.scenarioId || m.source!==snapshot.primaryFamily ||
    m.asOf!==context.asOf || !timestampFresh(m.asOf,now,policy.maxContextAgeMs) ||
    !['trend','range','compression'].includes(m.regime) || m.coverage!==1 ||
    !Number.isFinite(m.confidence)||m.confidence<.35||m.confidence>1 ||
    typeof m.structureValid!=='boolean' || typeof m.setupConfirmed!=='boolean' ||
    m.invalidationPrice!==context.invalidationPrice || JSON.stringify(m.targets)!==JSON.stringify(context.targets) ||
    m.rawInvalidationPrice!==undefined&&(!Number.isFinite(m.rawInvalidationPrice)||m.rawInvalidationPrice<=0) ||
    !Number.isFinite(m.zone?.lower)||!Number.isFinite(m.zone?.upper)||m.zone.lower<=0||m.zone.upper<=m.zone.lower)
    return 'mtf_context_invalid';
  try {
    timeframeMs(m.timeframe);
    const t=m.lowerTrigger;
    if(!t || typeof t.confirmed!=='boolean')return 'mtf_lower_trigger_missing';
    if(!t.confirmed)return null;
    const interval=timeframeMs(t.timeframe);
    if(!Array.isArray(m.entryTimeframes)||!m.entryTimeframes.includes(t.timeframe)||interval>timeframeMs(m.timeframe))
      return 'mtf_entry_role_invalid';
    const maxAge=Math.min(policy.maxContextAgeMs,interval*2);
    if(!timestampFresh(t.confirmedAt,now,maxAge)||t.confirmedAt>m.asOf)return 'mtf_lower_trigger_stale';
    const c=t.candle,p=t.previous,long=candidate.side==='long';
    if(!c||!p||!Number.isFinite(t.atr)||t.atr<=0||!Number.isFinite(t.price)||t.price<=0 ||
      ![c.high,c.low,c.close,p.high,p.low].every(x=>Number.isFinite(x)&&x>0) ||
      c.low>c.close||c.high<c.close||p.low>p.high || c.close!==t.price || c.closeTime!==t.confirmedAt ||
      !Number.isSafeInteger(c.time)||c.closeTime-c.time!==interval || p.closeTime!==c.time ||
      !Number.isSafeInteger(p.time)||p.closeTime-p.time!==interval ||
      !Number.isSafeInteger(m.setupConfirmedAt)||m.setupConfirmedAt>c.time||m.setupConfirmedAt>m.asOf ||
      (long?c.close<=p.high||c.close<=m.triggerPrice:c.close>=p.low||c.close>=m.triggerPrice) ||
      c.low>m.zone.upper+t.atr||c.high<m.zone.lower-t.atr ||
      (long?c.close>m.zone.upper+2*t.atr:c.close<m.zone.lower-2*t.atr))return 'mtf_lower_evidence_invalid';
    const price=snapshot.currentMid;
    if(long?price>m.zone.upper+2*t.atr:price<m.zone.lower-2*t.atr)return 'mtf_live_price_outside_zone';
  }catch{return 'mtf_lower_trigger_invalid';}
  return null;
}
function priceFreshnessReason(snapshot, context, now, policy) {
  if (!timestampFresh(context.asOf, now, policy.maxContextAgeMs)) return 'context_stale_or_missing';
  if (!timestampFresh(snapshot.asOf, now, policy.maxSnapshotAgeMs)) return 'snapshot_stale_or_missing';
  if (!['binance:spot', 'binance:perp', 'bybit:spot', 'bybit:linear'].includes(snapshot.primaryFamily)) return 'primary_family_missing';
  const events = snapshot.freshness?.eventsByFamily?.[snapshot.primaryFamily];
  if (!events || !timestampFresh(events.lastBookAt, now, policy.maxSnapshotAgeMs)) return 'market_events_stale_or_missing';
  return null;
}
function liveDataReason(candidate,snapshot,context,now,policy) {
  const priceReason = priceFreshnessReason(snapshot, context, now, policy);
  if (priceReason) return priceReason;
  if (snapshot.runtime !== 'FULL_EVENT_STREAM') return 'feed_not_full';
  const events = snapshot.freshness.eventsByFamily[snapshot.primaryFamily];
  if (!timestampFresh(events.lastTradeAt, now, policy.maxSnapshotAgeMs)) return 'market_events_stale_or_missing';
  const f=snapshot.windows?.['60000'];
  const min=candidate.watcherPolicy?.minImbalance;
  const imbalance=f?.aggressor?.imbalance;
  if(typeof min!=='number' || !Number.isFinite(min) || min<0 || min>1 ||
    typeof imbalance!=='number' || !Number.isFinite(imbalance) || Math.abs(imbalance)>1 ||
    f?.aggressor?.quality!=='ok')return 'aggressor_unavailable';
  const long=candidate.side==='long';
  if(long?imbalance<=min:imbalance>=-min)return 'flow_not_confirmed';
  if(f?.impactAsymmetry?.quality!=='ok' ||
    f.impactAsymmetry.direction!==(long?'buy_more_efficient':'sell_more_efficient'))return 'impact_not_confirmed';
  if(f?.refill?.quality!=='ok' || !['buy','sell','neutral'].includes(f.refill.absorptionDirection))return 'refill_unavailable';
  if(f.refill.absorptionDirection===(long?'sell':'buy'))return 'opposing_absorption';
  return null;
}

async function freshSnapshot(getLiveSnapshot,symbol,timeoutMs) {
  const controller=new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(()=>getLiveSnapshot(symbol,{signal:controller.signal})),
      new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('live_timeout'));},timeoutMs);})
    ]);
  }finally{clearTimeout(timer);}
}

export async function runFocusedRevalidation(candidate,context,{
  initialSnapshot,getLiveSnapshot,appendEvent,now=Date.now,policy={}
}={}) {
  if(typeof getLiveSnapshot!=='function')throw Error('live_snapshot_reader_required');
  if(typeof appendEvent!=='function')throw Error('journal_writer_required');
  const limits=entryPolicy(policy);
  const c=structuredClone(candidate),ctx=structuredClone(context);
  const preliminary=initialSnapshot
    ?evaluateFocusedEntry(c,initialSnapshot,ctx,{now,policy:limits})
    :{decision:'WAIT_RETEST',eligibleDecision:'WAIT_RETEST',reason:'no_initial_snapshot'};
  const requestedAt=now();
  let live,result;
  try {
    live=await freshSnapshot(getLiveSnapshot,c.symbol,limits.liveTimeoutMs);
  }catch(error) {
    result={decision:'WAIT_RETEST',eligibleDecision:'WAIT_RETEST',currentRR:null,reason:error.message==='live_timeout'?'live_timeout':'live_fetch_failed'};
  }
  if(!result) {
    try {result=evaluateFocusedEntry(c,live,ctx,{now,policy:limits});}
    catch{result={decision:'WAIT_RETEST',eligibleDecision:'WAIT_RETEST',currentRR:null,reason:'live_snapshot_invalid'};}
    if(Number.isSafeInteger(live?.asOf) && live.asOf<requestedAt)result={...result,decision:'WAIT_RETEST',eligibleDecision:'WAIT_RETEST',reason:'snapshot_predates_live_request'};
  }
  result={...result,stage:'final',checkedAt:now(),candidateId:c.candidateId,setupId:c.setupId,symbol:c.symbol,side:c.side,preliminary};
  if(['ENTER_NOW','ENTER_REDUCED'].includes(result.eligibleDecision)) {
    const events=live.freshness.eventsByFamily[live.primaryFamily];
    result.expiresAt=Math.min(live.asOf+limits.maxSnapshotAgeMs,events.lastTradeAt+limits.maxSnapshotAgeMs,
      events.lastBookAt+limits.maxSnapshotAgeMs,ctx.asOf+limits.maxContextAgeMs);
    if(ctx.mtf)result.expiresAt=Math.min(result.expiresAt,ctx.mtf.lowerTrigger.confirmedAt+
      Math.min(limits.maxContextAgeMs,timeframeMs(ctx.mtf.lowerTrigger.timeframe)*2));
    result.decision=result.eligibleDecision;
    result.reason=result.decision==='ENTER_NOW'?'rr_full':'rr_reduced';
    result.terminalCommand=buildTerminalCommand(result);
  }
  const persist=r=>appendEvent({
    schemaVersion:1,event:'REVALIDATION_DECISION',timestamp:now(),candidateId:c.candidateId,setupId:c.setupId,
    stage:'final',decision:r.decision,currentRR:r.currentRR,reason:r.reason,
    symbol:c.symbol,side:c.side,entry:r.entry ?? null,invalidationPrice:r.invalidationPrice ?? null,targets:r.targets ?? [],
    checkedAt:r.checkedAt,snapshotAsOf:live?.asOf ?? null,freshness:r.freshness ?? null,
    preliminary:{decision:preliminary.decision,eligibleDecision:preliminary.eligibleDecision,currentRR:preliminary.currentRR ?? null,reason:preliminary.reason}
  });
  await persist(result);
  if(result.terminalCommand && now()>result.expiresAt) {
    result={...result,decision:'WAIT_RETEST',eligibleDecision:'WAIT_RETEST',qty:null,reason:'freshness_expired_before_output'};
    delete result.terminalCommand;
    await persist(result);
  }
  return result;
}
