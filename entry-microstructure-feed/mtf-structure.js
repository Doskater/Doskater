// Pure candle analysis. No exchange, account, filesystem or execution access.
export const DEFAULT_ROLES=Object.freeze({context:['1D','4h','1h'],setup:['1h','30m','15m'],entry:['15m','5m','1m']});

export function timeframeMs(value) {
  const match=/^([1-9]\d*)(m|h|d|w)$/i.exec(String(value));
  if(!match)throw Error('invalid_timeframe');
  const ms=Number(match[1])*({m:60000,h:3600000,d:86400000,w:604800000}[match[2].toLowerCase()]);
  if(!Number.isSafeInteger(ms))throw Error('invalid_timeframe');
  return ms;
}
export function canonicalTimeframe(value) {
  timeframeMs(value);
  return String(value).toLowerCase();
}
export function resolveRoles(input=DEFAULT_ROLES) {
  if(!input || typeof input!=='object' || Object.keys(input).some(k=>!['context','setup','entry'].includes(k)))throw Error('invalid_roles');
  return Object.fromEntries(['context','setup','entry'].map(role=>{
    if(!Array.isArray(input[role]) || !input[role].length)throw Error('invalid_roles');
    return [role,[...new Set(input[role].map(canonicalTimeframe))].sort((a,b)=>timeframeMs(b)-timeframeMs(a))];
  }));
}
const average=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
export function projectBoundary(boundary,time) {
  return boundary.anchorPrice+boundary.slope*(time-boundary.anchorTime);
}
function atr(rows) {
  return average(rows.slice(-14).map((c,i,tail)=>{
    const prev=i?tail[i-1].close:rows[Math.max(0,rows.length-tail.length-1)].close;
    return Math.max(c.high-c.low,Math.abs(c.high-prev),Math.abs(c.low-prev));
  }));
}
function pivotsFor(rows,left,right) {
  const result=[];
  for(let i=left;i<rows.length-right;i++) {
    for(const kind of ['high','low']) {
      const value=rows[i][kind];
      // Last plateau point wins: equal predecessors allowed, equal successors excluded.
      const before=rows.slice(i-left,i),after=rows.slice(i+1,i+right+1);
      const extreme=kind==='high'
        ?before.every(c=>c.high<=value)&&after.every(c=>c.high<value)
        :before.every(c=>c.low>=value)&&after.every(c=>c.low>value);
      if(extreme)result.push({kind,index:i,time:rows[i].time,price:value,confirmedAt:rows[i+right].closeTime});
    }
  }
  return result;
}
function swingLabel(points,kind,tolerance) {
  if(points.length<2)return 'unknown';
  const delta=points.at(-1).price-points.at(-2).price;
  if(Math.abs(delta)<=tolerance)return kind==='high'?'EH':'EL';
  return kind==='high'?(delta>0?'HH':'LH'):(delta>0?'HL':'LL');
}
function zonesFor(pivots,tolerance) {
  const groups=[];
  for(const p of pivots.slice(-80)) {
    let group=groups.find(g=>g.kind===p.kind && Math.abs(g.price-p.price)<=tolerance);
    if(!group){group={kind:p.kind,price:p.price,touches:[]};groups.push(group);}
    group.touches.push(p);group.price=average(group.touches.map(t=>t.price));
  }
  return groups.map(g=>({kind:g.kind==='low'?'support':'resistance',price:g.price,
    lower:Math.min(...g.touches.map(p=>p.price))-tolerance,
    upper:Math.max(...g.touches.map(p=>p.price))+tolerance,
    confirmedAt:Math.max(...g.touches.map(p=>p.confirmedAt)),touches:g.touches}));
}
function boundaryFor(points,kind,rows,tolerance) {
  let best=null;
  const recent=points.slice(-8);
  for(let start=0;start<recent.length-1;start++) {
    const touches=recent.slice(start);
    const first=touches[0],last=touches.at(-1);
    const slope=(last.price-first.price)/(last.time-first.time);
    if(kind==='support'?slope<=0:slope>=0)continue;
    const candidate={kind,anchorTime:first.time,anchorPrice:first.price,slope,touches,
      confirmedAt:last.confirmedAt,valid:false,provisional:touches.length<3,invalidatedAt:null,tolerance};
    if(touches.some(p=>Math.abs(projectBoundary(candidate,p.time)-p.price)>tolerance))continue;
    const breach=rows.find(c=>c.time>first.time && (kind==='support'
      ?c.close<projectBoundary(candidate,c.time)-tolerance
      :c.close>projectBoundary(candidate,c.time)+tolerance));
    candidate.invalidatedAt=breach?.closeTime ?? null;
    candidate.valid=!candidate.provisional && !breach;
    // Prefer a confirmed fit over a two-point hypothesis, then the latest confirmed fit.
    if(!best || (best.provisional&&!candidate.provisional) ||
      best.provisional===candidate.provisional && candidate.confirmedAt>=best.confirmedAt)best=candidate;
  }
  return best;
}
export function analyzeTimeframe(input,{timeframe,asOf,left=2,right=2,minCandles=20,
  zoneAtr=.35,equalAtr=.10,boundaryAtr=.35}={}) {
  const empty={ok:false,timeframe,candles:[],pivots:[],zones:[],boundaries:{support:null,resistance:null},
    swings:{high:'unknown',low:'unknown'},direction:0,regime:'unknown'};
  try {
    const interval=timeframeMs(timeframe);
    if(!Number.isSafeInteger(asOf)||asOf<0 || ![left,right].every(x=>Number.isSafeInteger(x)&&x>=1&&x<=20) ||
      !Number.isSafeInteger(minCandles)||minCandles<left+right+3 ||
      ![zoneAtr,equalAtr,boundaryAtr].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>0&&x<=2))throw Error('invalid_options');
    if(!Array.isArray(input))throw Error('candles_missing');
    const rows=[];
    let previous=null;
    for(const c of input) {
      if(!c || !Number.isSafeInteger(c.time)||c.time<0||c.time>asOf ||
        !['open','high','low','close'].every(k=>typeof c[k]==='number'&&Number.isFinite(c[k])&&c[k]>0) ||
        !Number.isFinite(c.volume)||c.volume<0 || c.low>Math.min(c.open,c.close) ||
        c.high<Math.max(c.open,c.close)||c.high<c.low)throw Error('invalid_candle');
      if(previous!==null && c.time-previous!==interval)throw Error('candle_gap_or_order');
      previous=c.time;
      if(c.time+interval<=asOf)rows.push({...c,closeTime:c.time+interval});
    }
    if(rows.length<minCandles)throw Error('insufficient_history');
    const last=rows.at(-1);
    if(asOf-last.closeTime>interval)throw Error('candles_stale');
    const volatility=atr(rows),tolerance=Math.max(volatility*equalAtr,last.close*1e-10);
    const pivots=pivotsFor(rows,left,right),highs=pivots.filter(p=>p.kind==='high'),lows=pivots.filter(p=>p.kind==='low');
    const swings={high:swingLabel(highs,'high',tolerance),low:swingLabel(lows,'low',tolerance)};
    const direction=swings.high==='HH'&&swings.low==='HL'?1:swings.high==='LH'&&swings.low==='LL'?-1:0;
    const zones=zonesFor(pivots,volatility*zoneAtr);
    const boundaries={support:boundaryFor(lows,'support',rows,volatility*boundaryAtr),
      resistance:boundaryFor(highs,'resistance',rows,volatility*boundaryAtr)};
    const support=zones.filter(z=>z.kind==='support'&&z.touches.length>=2&&z.lower<last.close).sort((a,b)=>b.price-a.price)[0];
    const resistance=zones.filter(z=>z.kind==='resistance'&&z.touches.length>=2&&z.upper>last.close).sort((a,b)=>a.price-b.price)[0];
    const early=average(rows.slice(-24,-12).map(c=>c.high-c.low)),late=average(rows.slice(-12).map(c=>c.high-c.low));
    const span=xs=>Math.max(...xs.map(c=>c.high))-Math.min(...xs.map(c=>c.low));
    const contracting=rows.length>=24 && (late<early*.9 || span(rows.slice(-12))<span(rows.slice(-24,-12))*.9);
    const converging=boundaries.support?.valid&&boundaries.resistance?.valid&&
      projectBoundary(boundaries.support,last.time)<projectBoundary(boundaries.resistance,last.time);
    const regime=converging&&contracting?'compression':direction?'trend':support&&resistance?'range':'unknown';
    return {ok:true,timeframe:canonicalTimeframe(timeframe),asOf,interval,candles:rows,pivots,zones,boundaries,
      swings,direction,regime,atr:volatility,tolerance,last,range:regime==='range'?{support,resistance}:null,
      evidence:{swings,contracting,converging:Boolean(converging)},options:{left,right,minCandles,zoneAtr,equalAtr,boundaryAtr}};
  }catch(error){return {...empty,reason:error.message};}
}
export function analyzeStructure({symbol,source,asOf,frames={},roles=DEFAULT_ROLES,options={}}={}) {
  if(typeof symbol!=='string'||!/^([A-Z0-9]{2,30})USDT$/.test(symbol))throw Error('invalid_symbol');
  if(!['binance:spot','binance:perp','bybit:spot','bybit:linear'].includes(source))throw Error('invalid_source');
  const resolved=resolveRoles(roles),wanted=[...new Set(Object.values(resolved).flat())];
  const mapped={};
  for(const [tf,data] of Object.entries(frames)) {
    const key=canonicalTimeframe(tf);
    if(mapped[key])throw Error('duplicate_timeframe');
    mapped[key]=data;
  }
  const analyzed=Object.fromEntries(wanted.map(tf=>{
    const data=mapped[tf];
    const identityOk=data?.symbol===symbol&&data?.source===source;
    const f=analyzeTimeframe(identityOk?data.candles:null,{...options,timeframe:tf,asOf});
    return [tf,identityOk?f:{...f,reason:data?'frame_identity_mismatch':'frame_missing'}];
  }));
  const votes=wanted.map(tf=>({timeframe:tf,weight:Math.sqrt(timeframeMs(tf)/60000),
    direction:analyzed[tf].direction,available:analyzed[tf].ok}));
  const total=votes.reduce((n,v)=>n+v.weight,0),available=votes.filter(v=>v.available);
  const covered=available.reduce((n,v)=>n+v.weight,0);
  const signed=covered?available.reduce((n,v)=>n+v.weight*v.direction,0)/covered:0;
  const context=resolved.context.map(tf=>analyzed[tf]).find(f=>f.ok&&f.regime!=='unknown');
  return {schemaVersion:1,symbol,source,asOf,roles:resolved,frames:analyzed,
    status:available.length===wanted.length?'FULL':available.length?'PARTIAL':'DEGRADED',
    regime:context?.regime ?? 'unknown',direction:context?.direction ?? 0,
    entryReady:resolved.entry.every(tf=>analyzed[tf].ok),
    agreement:{votes,coverage:covered/total,signed,strength:Math.abs(signed)*covered/total}};
}
