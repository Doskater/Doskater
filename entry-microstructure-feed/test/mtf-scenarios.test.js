import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyFrameScenarios,classifyScenarios,lowerTimeframeTrigger} from '../mtf-scenarios.js';
import {analyzeStructure,analyzeTimeframe} from '../mtf-structure.js';

const bar=(time,close)=>({time,closeTime:time+60000,open:close,close,high:close+.5,low:close-.5,volume:10});
function state({closes=[100,101],direction=1,regime='trend',oldDirection=direction}={}) {
  const candles=closes.map((p,i)=>bar(i*60000,p));
  const high={kind:'high',time:0,index:0,price:110,confirmedAt:0};
  const low={kind:'low',time:0,index:0,price:90,confirmedAt:0};
  const f={ok:true,timeframe:'15m',asOf:120000,candles,last:candles.at(-1),direction,regime,atr:2,tolerance:.2,
    pivots:[high,low],zones:[{kind:'support',price:90,lower:89,upper:91,touches:[low,low]},
      {kind:'resistance',price:110,lower:109,upper:111,touches:[high,high]}],boundaries:{support:null,resistance:null},
    range:regime==='range'?{support:{price:90},resistance:{price:110}}:null};
  return {f,previous:{...f,direction:oldDirection,last:candles.at(-2)}};
}
test('classifies breakout and failed breakout with mirrored evidence and geometry',()=>{
  for(const [closes,type,side] of [[[109,112],'breakout','long'],[[91,88],'breakout','short'],
    [[112,108],'failed_breakout','short'],[[88,92],'failed_breakout','long']]) {
    const {f,previous}=state({closes,direction:0});
    const c=classifyFrameScenarios(f,previous).find(c=>c.type===type&&c.side===side);
    assert.ok(c);assert.ok(c.evidence.length);assert.ok(c.targets.length);
    assert.ok(side==='long'?c.invalidationPrice<c.zone.lower:c.invalidationPrice>c.zone.upper);
  }
});
test('classifies continuation, pullback, reclaim, structural reversal and range mean reversion',()=>{
  for(const [args,type,side] of [
    [{closes:[111,112]},'trend_continuation','long'],
    [{closes:[98,94]},'pullback','long'],
    [{closes:[88,94],direction:0},'reclaim','long'],
    [{closes:[109,112],oldDirection:-1},'reversal','long'],
    [{closes:[92,91],direction:0,regime:'range'},'range_mean_reversion','long'],
    [{closes:[109,108],direction:0,regime:'range'},'range_mean_reversion','short']]) {
    const {f,previous}=state(args);
    assert.ok(classifyFrameScenarios(f,previous).some(c=>c.type===type&&c.side===side),type);
  }
});
test('microstructure is absent from structural direction and confidence; bad geometry is filtered',()=>{
  const {f,previous}=state({closes:[109,112]});
  const first=classifyFrameScenarios(f,previous);
  assert.deepEqual(classifyFrameScenarios({...f,microstructure:{imbalance:-1}},previous),first);
  assert.deepEqual(classifyFrameScenarios({...f,ok:false},previous),[]);
  assert.ok(first.every(c=>c.confidence>=0&&c.confidence<=1));
});
test('lower-timeframe confirmation needs a close trigger near the candidate zone, not a remote chase',()=>{
  const c={side:'long',zone:{lower:99,upper:101},invalidationPrice:95,triggerPrice:101};
  const f={ok:true,atr:1,last:{...bar(60000,102),low:100},candles:[{...bar(0,100),high:101},bar(60000,102)]};
  const s={entryReady:true,roles:{entry:['5m','1m']},frames:{'5m':f,'1m':f}};
  assert.equal(lowerTimeframeTrigger(s,c).confirmed,true);
  assert.equal(lowerTimeframeTrigger({...s,entryReady:false},c).confirmed,false);
  const far={...f,last:bar(60000,120),candles:[bar(0,119),bar(60000,120)]};
  assert.equal(lowerTimeframeTrigger({...s,frames:{'5m':far,'1m':far}},c).confirmed,false);
});
test('a lower candle predating setup confirmation cannot approve entry',()=>{
  const c={side:'long',timeframe:'15m',setupConfirmedAt:120000,
    zone:{lower:99,upper:101},invalidationPrice:95,triggerPrice:101};
  const f={ok:true,atr:1,last:bar(60000,102),candles:[bar(0,100),bar(60000,102)]};
  assert.equal(lowerTimeframeTrigger({entryReady:true,roles:{entry:['1m']},frames:{'1m':f}},c).confirmed,false);
});
test('sloped boundaries compare each candle against its own projection',()=>{
  const {f,previous}=state({closes:[109,109.5],direction:0});
  previous.boundaries.resistance={valid:true,anchorTime:0,anchorPrice:110,slope:-2/60000};
  const c=classifyFrameScenarios(f,previous).find(c=>c.type==='breakout'&&c.side==='long'&&c.setupConfirmed);
  assert.ok(c,'descending line crossed even though prior close is above current projection');
});
function realSqueeze(extra,{boundaryAtr=.35,replaceLast}={}) {
  const values=Array.from({length:90},(_,i)=>100+Math.sin(i*Math.PI/3)*(10-i*.08));
  if(replaceLast!==undefined)values[89]=replaceLast;
  const valuesAll=[...values,...extra],asOf=valuesAll.length*60000;
  const candles=valuesAll.map((p,i)=>({time:i*60000,open:p,high:p+.2,low:p-.2,close:p,volume:10}));
  return classifyScenarios(analyzeStructure({symbol:'NEARUSDT',source:'binance:spot',asOf,options:{boundaryAtr},
    roles:{context:['1m'],setup:['1m'],entry:['1m']},frames:{'1m':{symbol:'NEARUSDT',source:'binance:spot',candles}}}));
}
test('actual compression candles detect their descending-boundary crossing',()=>{
  const r=realSqueeze([103.42487113059644],{replaceLast:102.86487113059644});
  assert.ok(r.scenarios.some(c=>c.type==='breakout'&&c.side==='long'&&c.setupConfirmed));
});
test('actual boundary excursion retains failed-breakout and reclaim evidence',()=>{
  const r=realSqueeze([102.87487113059645,102.22487113059644],{boundaryAtr:.05});
  assert.ok(r.scenarios.some(c=>c.type==='failed_breakout'&&c.side==='short'));
  assert.ok(r.scenarios.some(c=>c.type==='reclaim'&&c.side==='short'));
});
test('overlapping setup/entry roles can confirm on a subsequent candle, never on the breakout candle',()=>{
  const first=realSqueeze([103.42487113059644],{replaceLast:102.86487113059644});
  const next=realSqueeze([103.42487113059644,104],{replaceLast:102.86487113059644});
  assert.ok(first.scenarios.filter(c=>c.setupConfirmed).every(c=>!c.lowerTrigger.confirmed));
  assert.ok(next.scenarios.some(c=>c.type==='breakout'&&c.side==='long'&&c.lowerTrigger.confirmed));
});
test('real candle pipeline identifies range alternatives and missing entry frames never confirm',()=>{
  const asOf=60*60000;
  const candles=Array.from({length:60},(_,i)=>({...bar(i*60000,100+4*Math.sin(i*Math.PI/3)),closeTime:undefined}));
  const s=analyzeStructure({symbol:'NEARUSDT',source:'binance:spot',asOf,
    roles:{context:['1m'],setup:['1m'],entry:['1m','5m']},frames:{'1m':{symbol:'NEARUSDT',source:'binance:spot',candles}}});
  const r=classifyScenarios(s);
  assert.equal(r.decision,'WAIT');assert.ok(r.scenarios.length);
  assert.ok(r.scenarios.every(c=>c.lowerTrigger.confirmed===false));
  assert.equal(analyzeTimeframe(candles,{timeframe:'1m',asOf}).regime,'range');
});
test('compression exposes both pending boundary breakouts without approving timing',()=>{
  const {f,previous}=state({closes:[100,100],direction:0,regime:'compression'});
  previous.boundaries={support:{valid:true,anchorTime:0,anchorPrice:90,slope:.000001},
    resistance:{valid:true,anchorTime:0,anchorPrice:110,slope:-.000001}};
  const c=classifyFrameScenarios(f,previous);
  assert.deepEqual(c.filter(c=>c.type==='breakout').map(c=>c.side).sort(),['long','short']);
  assert.ok(c.every(c=>c.setupConfirmed===false));
});
