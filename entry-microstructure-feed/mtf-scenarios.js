import {createHash} from 'node:crypto';
import {analyzeTimeframe,projectBoundary,timeframeMs} from './mtf-structure.js';

const clamp=x=>Math.max(0,Math.min(1,x));
function levelFor(frame,kind,time) {
  const boundary=frame.boundaries[kind];
  if(boundary?.valid || boundary && !boundary.provisional && boundary.invalidatedAt>=frame.last.closeTime-
    (frame.interval ?? timeframeMs(frame.timeframe))*3)
    return {price:projectBoundary(boundary,time),kind:'boundary',reference:boundary};
  const pivot=frame.pivots.filter(p=>p.kind===(kind==='support'?'low':'high')).at(-1);
  return pivot?{price:pivot.price,kind:'swing',reference:pivot}:null;
}
export function classifyFrameScenarios(frame,previous,history=previous) {
  if(!frame?.ok || !previous?.ok || frame.candles.length<2)return [];
  const last=frame.last,prev=frame.candles.at(-2),tol=frame.tolerance;
  const support=levelFor(previous,'support',last.time),resistance=levelFor(previous,'resistance',last.time);
  if(!support||!resistance||support.price>=resistance.price)return [];
  const out=[];
  const add=(type,side,level,stop,evidence,confidence=.65,setupConfirmed=true)=>{
    const long=side==='long',padding=Math.max(tol,frame.atr*.25);
    const zone={lower:level-padding,upper:level+padding};
    if(!Number.isFinite(stop)||zone.lower<=0 || (long?stop>=zone.lower:stop<=zone.upper))return;
    const horizontal=previous.zones.filter(z=>long?z.price>Math.max(level,last.close)+tol:z.price<Math.min(level,last.close)-tol)
      .map(z=>z.price).sort((a,b)=>long?a-b:b-a);
    const risk=Math.abs(level-stop),projected=long?level+2.5*risk:level-2.5*risk;
    const targets=horizontal.length?horizontal.slice(0,3):projected>0?[projected]:[];
    if(!targets.length)return;
    out.push({type,side,timeframe:frame.timeframe,zone,invalidationPrice:stop,targets,
      triggerPrice:level,asOf:frame.asOf,setupConfirmedAt:setupConfirmed?last.closeTime:null,
      confidence:clamp(confidence),evidence,setupConfirmed,
      originRegime:frame.regime==='unknown'?previous.regime:frame.regime,reference:long?resistance:support,
      targetBasis:horizontal.length?'confirmed_zones':'projected_2.5R',
      triggerRule:'closed_lower_timeframe_break_near_zone'});
  };
  const s=support.price,r=resistance.price;
  const previousSupport=levelFor(previous,'support',prev.time).price;
  const previousResistance=levelFor(previous,'resistance',prev.time).price;
  const upBreak=prev.close<=previousResistance+tol && last.close>r+tol;
  const downBreak=prev.close>=previousSupport-tol && last.close<s-tol;
  const longStop=s-tol,shortStop=r+tol;
  if(upBreak)add('breakout','long',r,longStop,['close_above_previous_resistance',resistance.kind]);
  if(downBreak)add('breakout','short',s,shortStop,['close_below_previous_support',support.kind]);
  if(!upBreak && last.close<=r+tol && (resistance.kind==='boundary'||frame.regime==='range'))
    add('breakout','long',r,longStop,['watch_resistance_break',resistance.kind],.55,false);
  if(!downBreak && last.close>=s-tol && (support.kind==='boundary'||frame.regime==='range'))
    add('breakout','short',s,shortStop,['watch_support_break',support.kind],.55,false);
  if(prev.close>previousResistance+tol && last.close<r-tol)
    add('failed_breakout','short',r,Math.max(prev.high,last.high,r)+tol,['prior_close_outside','close_back_inside']);
  if(prev.close<previousSupport-tol && last.close>s+tol)
    add('failed_breakout','long',s,Math.min(prev.low,last.low,s)-tol,['prior_close_outside','close_back_inside']);
  if(prev.close<previousSupport-tol && last.close>s+tol)
    add('reclaim','long',s,Math.min(prev.low,s)-tol,['support_lost_then_reclaimed']);
  if(prev.close>previousResistance+tol && last.close<r-tol)
    add('reclaim','short',r,Math.max(prev.high,r)+tol,['resistance_lost_then_reclaimed']);
  if(frame.direction===1 && last.close>r+tol)
    add('trend_continuation','long',r,longStop,['HH_HL','close_above_confirmed_swing']);
  if(frame.direction===-1 && last.close<s-tol)
    add('trend_continuation','short',s,shortStop,['LH_LL','close_below_confirmed_swing']);
  if(frame.direction===1 && last.close<prev.close && last.close>s+tol && last.close<r)
    add('pullback','long',s,Math.min(...previous.pivots.filter(p=>p.kind==='low').slice(-2).map(p=>p.price),s)-frame.atr,
      ['HH_HL_thesis_intact','retracement_toward_support'],.6);
  if(frame.direction===-1 && last.close>prev.close && last.close<r-tol && last.close>s)
    add('pullback','short',r,Math.max(...previous.pivots.filter(p=>p.kind==='high').slice(-2).map(p=>p.price),r)+frame.atr,
      ['LH_LL_thesis_intact','retracement_toward_resistance'],.6);
  if(history?.direction===-1 && frame.direction===1 && last.close>r+tol)
    add('reversal','long',r,longStop,['bearish_swings_replaced_by_HH_HL','opposing_swing_invalidated'],.7);
  if(history?.direction===1 && frame.direction===-1 && last.close<s-tol)
    add('reversal','short',s,shortStop,['bullish_swings_replaced_by_LH_LL','opposing_swing_invalidated'],.7);
  if(frame.regime==='range') {
    const low=frame.range.support.price,high=frame.range.resistance.price,width=high-low;
    if(last.close<=low+width*.3)
      add('range_mean_reversion','long',low,low-frame.atr,['repeated_range_support','lower_range_quartile'],.6);
    if(last.close>=high-width*.3)
      add('range_mean_reversion','short',high,high+frame.atr,['repeated_range_resistance','upper_range_quartile'],.6);
  }
  return out;
}
export function lowerTimeframeTrigger(structure,candidate) {
  const waiting={confirmed:false,reason:'lower_timeframe_unavailable'};
  if(candidate.setupConfirmed===false)return {confirmed:false,reason:'setup_break_pending'};
  if(!structure.entryReady)return waiting;
  // Use the shortest configured entry frame, with all entry frames available.
  const timeframe=[...structure.roles.entry].sort((a,b)=>timeframeMs(a)-timeframeMs(b))[0];
  const f=structure.frames[timeframe];
  if(!f?.ok || f.candles.length<2)return waiting;
  const last=f.last,prev=f.candles.at(-2),long=candidate.side==='long';
  if(candidate.timeframe && timeframeMs(timeframe)>timeframeMs(candidate.timeframe))return {confirmed:false,reason:'entry_frame_above_setup'};
  if(candidate.setupConfirmedAt!==undefined && last.time<candidate.setupConfirmedAt)
    return {confirmed:false,reason:'lower_trigger_predates_setup',timeframe,confirmedAt:last.closeTime};
  if(long?last.close<=candidate.invalidationPrice:last.close>=candidate.invalidationPrice)
    return {confirmed:false,reason:'structural_invalidation',timeframe,confirmedAt:last.closeTime};
  const near=last.low<=candidate.zone.upper+f.atr && last.high>=candidate.zone.lower-f.atr &&
    (long?last.close<=candidate.zone.upper+2*f.atr:last.close>=candidate.zone.lower-2*f.atr);
  const breakConfirmed=long?last.close>prev.high&&last.close>candidate.triggerPrice:
    last.close<prev.low&&last.close<candidate.triggerPrice;
  return {confirmed:Boolean(near&&breakConfirmed),reason:near&&breakConfirmed?'closed_candle_trigger':near?'trigger_pending':'outside_candidate_zone',
    timeframe,confirmedAt:last.closeTime,price:last.close,atr:f.atr,
    candle:{time:last.time,closeTime:last.closeTime,high:last.high,low:last.low,close:last.close},
    previous:{time:prev.time,closeTime:prev.closeTime,high:prev.high,low:prev.low}};
}
export function classifyScenarios(structure) {
  const scenarios=[],identities=new Set();
  for(const tf of structure.roles.setup) {
    const f=structure.frames[tf];
    if(!f?.ok)continue;
    // Retain recent closed setup events so overlapping setup/entry roles can time
    // a subsequent candle. Recompute from prefixes, never from future pivots.
    for(let offset=0;offset<8;offset++) {
      const rows=offset?f.candles.slice(0,-offset):f.candles;
      if(rows.length<f.options.minCandles+1)break;
      const current=offset?analyzeTimeframe(rows,{...f.options,timeframe:tf,asOf:rows.at(-1).closeTime}):f;
      const previous=analyzeTimeframe(rows.slice(0,-1),{...f.options,timeframe:tf,asOf:rows.at(-1).time});
      const historical=rows.slice(0,-6);
      const history=historical.length?analyzeTimeframe(historical,{...f.options,timeframe:tf,asOf:historical.at(-1).closeTime}):previous;
      for(const original of classifyFrameScenarios(current,previous,history.ok?history:previous)) {
      if(offset && original.setupConfirmed===false)continue;
      const c={...original,asOf:structure.asOf};
      const long=c.side==='long';
      if(long?f.last.close<=c.invalidationPrice:f.last.close>=c.invalidationPrice)continue;
      if(c.targets.some(t=>long?f.last.close>=t:f.last.close<=t))continue;
      if(offset && ['breakout','trend_continuation','reversal'].includes(c.type) &&
        (long?f.last.close<c.zone.lower:f.last.close>c.zone.upper))continue;
      const side=c.side==='long'?1:-1;
      const alignment=(1+side*structure.agreement.signed)/2;
      const confidence=clamp((c.confidence*.6+alignment*.4-offset*.01)*structure.agreement.coverage);
      const scenarioId=createHash('sha256').update(JSON.stringify([structure.symbol,structure.source,tf,c.type,c.side,
        c.zone,c.invalidationPrice,c.evidence])).digest('hex');
      if(identities.has(scenarioId))continue;
      identities.add(scenarioId);
      scenarios.push({...c,symbol:structure.symbol,source:structure.source,scenarioId,confidence,
        countertrend:Boolean(structure.direction && structure.direction!==side),
        scoreEvidence:{base:c.confidence,alignment,coverage:structure.agreement.coverage,closedSetupAge:offset},
        lowerTrigger:lowerTimeframeTrigger(structure,c)});
      }
    }
  }
  scenarios.sort((a,b)=>Number(b.lowerTrigger.confirmed)-Number(a.lowerTrigger.confirmed)||b.confidence-a.confidence||a.scenarioId.localeCompare(b.scenarioId));
  const priorContext=structure.regime==='unknown'?scenarios.find(c=>c.setupConfirmed&&['trend','range','compression'].includes(c.originRegime)):null;
  return {...structure,regime:priorContext?.originRegime ?? structure.regime,
    regimeEvidence:priorContext?{kind:'pre_break_context',timeframe:priorContext.timeframe,confirmedAt:priorContext.setupConfirmedAt}:null,
    scenarios,decision:'WAIT',reason:scenarios.length?'requires_fresh_full_pipeline_and_micro_gate':'no_structural_scenario'};
}
