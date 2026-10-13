import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runStructurePipeline,deriveWatcherSet,syncStructureWatchers,buildStructuralContext,readPublicCandles} from '../mtf-pipeline.js';
import {normalizeSetup,createSetupState,evaluateSetup} from '../trigger-watcher.js';
import {createCandidate} from '../entry-journal.js';
import {runFocusedRevalidation} from '../focused-revalidation.js';

const NOW=60*60000;
const rows=Array.from({length:60},(_,i)=>{
  const p=100+Math.sin(i*Math.PI/3)*4;
  return {time:i*60000,open:p,high:p+.5,low:p-.5,close:p,volume:10};
});
const roles={context:['1m'],setup:['1m'],entry:['1m']};
const scenario=(side,trigger,extra={})=>({symbol:'NEARUSDT',source:'binance:spot',side,triggerPrice:trigger,
  zone:{lower:trigger-.5,upper:trigger+.5},invalidationPrice:side==='long'?trigger-2:trigger+2,
  targets:[side==='long'?trigger+6:trigger-6],confidence:.8,type:'breakout',scenarioId:'scenario-'+side,
  timeframe:'1m',asOf:NOW,setupConfirmed:true,lowerTrigger:{confirmed:true,timeframe:'1m',confirmedAt:NOW},...extra});
const result=(scenarios)=>({symbol:'NEARUSDT',source:'binance:spot',asOf:NOW,status:'FULL',regime:'trend',
  roles,frames:{'1m':{ok:true,last:rows.at(-1),atr:2}},agreement:{coverage:1},scenarios});

test('injectable reader analyzes every unique role once and reports source failure',async()=>{
  const calls=[];
  const r=await runStructurePipeline({symbols:['nearusdt','ETHUSDT'],source:'binance:spot',asOf:NOW,roles,
    reader:async x=>{calls.push(x);if(x.symbol==='ETHUSDT')throw Error('upstream secret');return {symbol:x.symbol,source:x.source,candles:rows};}});
  assert.equal(calls.length,2);assert.equal(r[0].status,'FULL');assert.equal(r[1].status,'DEGRADED');
  assert.equal(JSON.stringify(r).includes('upstream secret'),false);
});
test('complete watcher derivation preserves failed/unrelated symbols and supports both sides',()=>{
  const existing=[normalizeSetup({symbol:'ETHUSDT',side:'long',triggerPrice:200}),
    normalizeSetup({symbol:'SOLUSDT',side:'short',triggerPrice:50}),normalizeSetup({symbol:'NEARUSDT',side:'long',triggerPrice:99})];
  const wanted=deriveWatcherSet([result([scenario('long',100),scenario('short',95)]),
    {symbol:'ETHUSDT',status:'DEGRADED',scenarios:[]}],existing);
  assert.equal(wanted.setups.length,4);
  assert.ok(wanted.setups.some(s=>s.symbol==='ETHUSDT'&&s.triggerPrice===200));
  assert.deepEqual(wanted.setups.filter(s=>s.symbol==='NEARUSDT').map(s=>s.side).sort(),['long','short']);
  assert.equal(wanted.evidence.length,2);
  assert.equal(wanted.setups.find(s=>s.symbol==='NEARUSDT').holdMs,30000);
  assert.equal(deriveWatcherSet([{...result([]),status:'PARTIAL'}],existing).setups.length,3);
});
test('atomic structural sync updates both sides and removes stale levels with logged reason',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'mtf-watch-'));
  const config={stateDir:dir,setupsFile:path.join(dir,'setups.json'),logFile:path.join(dir,'watcher.log')};
  try {
    const one=await syncStructureWatchers([result([scenario('long',100),scenario('short',95)])],{config,reason:'structure_refresh'});
    assert.equal(one.changes.added.length,2);
    const two=await syncStructureWatchers([result([scenario('long',101)])],{config,reason:'new_pivot'});
    assert.deepEqual(two.changes.updated,['NEARUSDT:long']);assert.deepEqual(two.changes.removed,['NEARUSDT:short']);
    const three=await syncStructureWatchers([result([scenario('long',101)])],{config});
    assert.deepEqual(three.changes,{added:[],updated:[],removed:[]});
    const log=await readFile(config.logFile,'utf8');assert.match(log,/new_pivot/);assert.match(log,/NEARUSDT:short/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('unchanged normalized watcher retains latching and adverse micro only delays notification',()=>{
  const setup=deriveWatcherSet([result([scenario('long',100)])],[]).setups[0];
  const s={currentMid:101,runtime:'FULL_EVENT_STREAM',windows:{'60000':{aggressor:{quality:'ok',imbalance:-.5}}}};
  const wait=evaluateSetup(setup,s,{...createSetupState(),levelSince:0},40000);
  assert.equal(wait.reason,'micro_not_confirmed');
  const unchanged=deriveWatcherSet([result([scenario('long',100)])],[setup]).setups[0];
  assert.deepEqual(unchanged,setup);
  assert.equal(evaluateSetup(unchanged,s,{...createSetupState(),latched:true},40000).reason,'latched');
});
test('structural context binds watcher hash, scenario identity, stop, source and independent timing',()=>{
  const sc=scenario('long',100),r=result([sc]);
  const setup=deriveWatcherSet([r],[]).setups[0];
  const c=createCandidate(setup,{currentMid:101},{now:()=>NOW,randomUUID:()=> 'c'});
  const ctx=buildStructuralContext(r,c,{qty:'1',qtyStep:'0.1',tickSize:'0.01',marketRiskAllowed:true});
  assert.equal(ctx.setupId,c.setupId);assert.equal(ctx.mtf.scenarioId,sc.scenarioId);
  assert.equal(ctx.invalidationPrice,98);assert.equal(ctx.mtf.lowerTrigger.confirmed,true);
  assert.throws(()=>buildStructuralContext(r,{...c,triggerPrice:105}),/scenario/);
});
test('read-only public adapter uses GET, closed normalized candles and explicit source',async()=>{
  const calls=[];
  const reader=async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>rows.map(c=>[c.time,''+c.open,''+c.high,''+c.low,''+c.close,''+c.volume])};};
  const r=await readPublicCandles({symbol:'NEARUSDT',timeframe:'1m',source:'binance:spot',fetchImpl:reader});
  assert.equal(r.symbol,'NEARUSDT');assert.deepEqual(r.candles,rows);assert.equal(calls[0].opts.method,'GET');
  assert.match(calls[0].url,/api.binance.com\/api\/v3\/klines/);
  const bybit=await readPublicCandles({symbol:'NEARUSDT',timeframe:'1m',source:'bybit:linear',fetchImpl:async()=>({ok:true,json:async()=>({retCode:0,result:{list:rows.slice().reverse().map(c=>[c.time,''+c.open,''+c.high,''+c.low,''+c.close,''+c.volume])}})})});
  assert.deepEqual(bybit.candles,rows);
});
test('unchanged horizontal structural levels survive ATR changes without watcher hash drift',async()=>{
  const run=async candles=>(await runStructurePipeline({symbols:['NEARUSDT'],source:'binance:spot',asOf:candles.length*60000,
    roles,framesBySymbol:{NEARUSDT:{'1m':{symbol:'NEARUSDT',source:'binance:spot',candles}}}}))[0];
  const first=await run(rows),second=await run([...rows,{time:NOW,open:100,high:101,low:99,close:100,volume:10}]);
  const short=r=>deriveWatcherSet([r],[]).setups.find(s=>s.side==='short');
  assert.deepEqual(short(first),short(second));
});
test('real structural prices quantize safely through the existing final DEMO gate',async()=>{
  const prices=[...rows.map(c=>c.close),104.6,105.1];
  const candles=prices.map((p,i)=>({time:i*60000,open:p,high:p+.2,low:p-.2,close:p,volume:10}));
  const asOf=candles.length*60000;
  const [r]=await runStructurePipeline({symbols:['NEARUSDT'],source:'binance:spot',asOf,roles,
    framesBySymbol:{NEARUSDT:{'1m':{symbol:'NEARUSDT',source:'binance:spot',candles}}}});
  const setup=deriveWatcherSet([r]).setups.find(s=>s.side==='long');
  const c=createCandidate(setup,{currentMid:105.1},{now:()=>asOf});
  const ctx=buildStructuralContext(r,c,{marketRiskAllowed:true,qty:'1',qtyStep:'0.01',tickSize:'0.01'});
  const snap={symbol:'NEARUSDT',asOf,currentMid:105.1,runtime:'FULL_EVENT_STREAM',primaryFamily:'binance:spot',
    freshness:{eventsByFamily:{'binance:spot':{lastBookAt:asOf,lastTradeAt:asOf}}},windows:{'60000':{
      aggressor:{quality:'ok',imbalance:.5},impactAsymmetry:{quality:'ok',direction:'buy_more_efficient'},
      refill:{quality:'ok',absorptionDirection:'buy'}}}};
  const events=[];
  const decision=await runFocusedRevalidation(c,ctx,{now:()=>asOf,getLiveSnapshot:async()=>snap,appendEvent:async e=>events.push(e)});
  assert.ok(['ENTER_NOW','ENTER_REDUCED'].includes(decision.decision),decision.reason);
  assert.ok(decision.terminalCommand);assert.equal(events.length,1);
  assert.equal(Number.isInteger(Number(ctx.invalidationPrice)*100),true);
  assert.ok(ctx.mtf.rawInvalidationPrice>=ctx.invalidationPrice);
});
