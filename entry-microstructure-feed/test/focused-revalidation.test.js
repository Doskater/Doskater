import test from 'node:test';
import assert from 'node:assert/strict';
import {candidate,context,snapshot,NOW} from './helpers/entry-fixtures.js';
let mod;try{mod=await import('../focused-revalidation.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
function evaluate(c,s,ctx,options={}) {
  assert.equal(typeof mod?.evaluateFocusedEntry,'function');
  return mod.evaluateFocusedEntry(c,s,ctx,{now:()=>NOW,...options});
}
for(const [target,want] of [[4.83,'ENTER_NOW'],[4.855,'ENTER_REDUCED'],[4.856,'WAIT_RETEST']]) {
  test('short RR boundary '+want+' has no public ENTER before live gate',()=>{
    const r=evaluate(candidate(),snapshot(),context({targets:[target],tickSize:'0.001'}));
    assert.equal(r.eligibleDecision,want);assert.equal(r.decision,'WAIT_RETEST');assert.equal(r.terminalCommand,undefined);
  });
}
for(const [target,want] of [[104,'ENTER_NOW'],[103,'ENTER_REDUCED'],[102.98,'WAIT_RETEST']]) {
  test('long RR boundary '+want,()=>{
    const c=candidate({side:'long',triggerPrice:99,observedPrice:100});
    const s=snapshot(100);s.windows['60000'].aggressor.imbalance=0.5;s.windows['60000'].impactAsymmetry.direction='buy_more_efficient';s.windows['60000'].refill.absorptionDirection='buy';
    const r=evaluate(c,s,context({side:'long',invalidationPrice:98,targets:[target]}));
    assert.equal(r.eligibleDecision,want);assert.equal(r.decision,'WAIT_RETEST');
  });
}
test('delayed short recomputes entry, current RR and structure from fresh context',()=>{
  const c=candidate();
  const r=evaluate(c,snapshot(4.91),context());
  assert.equal(r.entry,4.91);assert.ok(Math.abs(r.currentRR-13/7)<1e-10);assert.equal(r.eligibleDecision,'ENTER_REDUCED');assert.equal(r.qty,'5');
  const late=evaluate(c,snapshot(4.88),context());assert.equal(late.eligibleDecision,'WAIT_RETEST');assert.ok(Math.abs(late.currentRR-1)<1e-10);
  const stopped=evaluate(c,snapshot(4.99),context());assert.equal(stopped.decision,'INVALIDATED');assert.equal(stopped.reason,'invalidation_crossed');
  const changed=evaluate(c,snapshot(4.91),context({invalidationPrice:5,targets:[4.7]}));
  assert.ok(Math.abs(changed.currentRR-7/3)<1e-10);assert.equal(changed.eligibleDecision,'ENTER_NOW');
});
test('broken structure or revoked thesis invalidates; unknown structure/risk or lost trigger waits',()=>{
  for(const ctx of [context({structure:'broken'}),context({thesisValid:false})])assert.equal(evaluate(candidate(),snapshot(),ctx).decision,'INVALIDATED');
  for(const ctx of [context({structure:'unknown'}),context({marketRiskAllowed:undefined}),context({thesisValid:undefined})]) {
    const r=evaluate(candidate(),snapshot(),ctx);assert.equal(r.eligibleDecision,'WAIT_RETEST');assert.equal(r.decision,'WAIT_RETEST');
  }
  assert.equal(evaluate(candidate(),snapshot(4.95),context()).reason,'trigger_lost');
});
test('old candidate with live data remains eligible independent of age',()=>{
  const r=evaluate(candidate({detectedAt:0}),snapshot(),context());
  assert.equal(r.eligibleDecision,'ENTER_NOW');assert.equal(r.freshness.candidateAgeMs,NOW);
});
test('first reached target cannot be discarded to chase distant second target',()=>{
  const r=evaluate(candidate(),snapshot(4.77),context({targets:[4.60,4.78]}));
  assert.equal(r.eligibleDecision,'WAIT_RETEST');assert.equal(r.reason,'target_reached');assert.equal(r.terminalCommand,undefined);
});
test('conservative tick rounding rechecks RR and decimal reduced size rounds down',()=>{
  const r=evaluate(candidate(),snapshot(4.909),context({qty:'1.1',qtyStep:'0.1',tickSize:'0.01'}));
  assert.equal(r.entry,4.91);assert.equal(r.eligibleDecision,'ENTER_REDUCED');assert.equal(r.qty,'0.5');
  const l=candidate({side:'long',triggerPrice:99,observedPrice:100});
  const s=snapshot(100.009);s.windows['60000'].aggressor.imbalance=0.5;s.windows['60000'].impactAsymmetry.direction='buy_more_efficient';s.windows['60000'].refill.absorptionDirection='buy';
  const long=evaluate(l,s,context({side:'long',invalidationPrice:98.006,targets:[104.006]}));
  assert.equal(long.entry,100);assert.equal(long.invalidationPrice,98);assert.equal(long.targets[0].price,104);assert.ok(Math.abs(long.currentRR-2)<1e-10);
});
test('zero reduced size or missing execution sizing data cannot authorize entry',()=>{
  for(const changes of [{qty:'0.1',qtyStep:'0.1'},{qty:undefined},{qtyStep:undefined},{tickSize:undefined}]) {
    const r=evaluate(candidate(),snapshot(4.91),context(changes));assert.equal(r.eligibleDecision,'WAIT_RETEST');
  }
});
test('identity mismatches, invalid prices/geometry and future candidate time are rejected',()=>{
  for(const changes of [{symbol:'BTCUSDT'},{side:'long'},{setupId:'other'},{invalidationPrice:NaN},{invalidationPrice:Infinity},{targets:[4.99]},{qty:'$(touch /tmp/bad)'},{qtyStep:0},{reducedSizeFactor:2},{positionIdx:1}]) {
    assert.throws(()=>evaluate(candidate(),snapshot(),context(changes)),/invalid_|mismatch/);
  }
  assert.throws(()=>evaluate(candidate({detectedAt:NOW+1}),snapshot(),context()),/invalid_candidate/);
});

async function run(c=candidate(),ctx=context(),live=snapshot(),options={}) {
  assert.equal(typeof mod?.runFocusedRevalidation,'function');
  const events=[];
  const r=await mod.runFocusedRevalidation(c,ctx,{initialSnapshot:snapshot(),getLiveSnapshot:async(symbol,{signal})=>{
    assert.equal(symbol,'NEARUSDT');assert.ok(signal instanceof AbortSignal);return live;
  },appendEvent:async e=>events.push(e),now:()=>NOW,...options});
  return {r,events};
}
test('final live price overrides preliminary approval and journals current RR',async()=>{
  const late=await run(candidate(),context(),snapshot(4.88));
  assert.equal(late.r.decision,'WAIT_RETEST');assert.equal(late.r.terminalCommand,undefined);
  assert.equal(late.r.preliminary.eligibleDecision,'ENTER_NOW');
  const delayed=await run(candidate(),context(),snapshot(4.91));
  assert.equal(delayed.r.decision,'ENTER_REDUCED');assert.equal(delayed.r.entry,4.91);assert.ok(delayed.r.terminalCommand);
  assert.equal(delayed.events.length,1);assert.equal(delayed.events[0].event,'REVALIDATION_DECISION');
  assert.equal(delayed.events[0].decision,'ENTER_REDUCED');assert.ok(Math.abs(delayed.events[0].currentRR-13/7)<1e-10);
  assert.equal(delayed.events[0].candidateId,'candidate-1');assert.equal(delayed.events[0].reason,'rr_reduced');
  const full=await run();assert.equal(full.r.decision,'ENTER_NOW');
});
for(const [name,change] of [
  ['stale snapshot',s=>s.asOf=NOW-5001],['future snapshot',s=>s.asOf=NOW+1],
  ['missing freshness',s=>delete s.freshness],['missing primary family',s=>delete s.primaryFamily],
  ['stale trades with live book',s=>s.freshness.eventsByFamily['binance:spot'].lastTradeAt=NOW-5001],
  ['future trades',s=>s.freshness.eventsByFamily['binance:spot'].lastTradeAt=NOW+1],
  ['missing book event',s=>s.freshness.eventsByFamily['binance:spot'].lastBookAt=null],
  ['stale book',s=>s.freshness.eventsByFamily['binance:spot'].lastBookAt=NOW-5001],
  ['partial runtime',s=>s.runtime='PARTIAL'],['wrong symbol',s=>s.symbol='BTCUSDT'],
  ['missing price',s=>s.currentMid=null],['nan price',s=>s.currentMid='NaN'],
  ['flipped imbalance',s=>s.windows['60000'].aggressor.imbalance=0.5],
  ['weak imbalance',s=>s.windows['60000'].aggressor.imbalance=-0.2],
  ['bad aggressor quality',s=>s.windows['60000'].aggressor.quality='low_volume'],
  ['opposite impact',s=>s.windows['60000'].impactAsymmetry.direction='buy_more_efficient'],
  ['bad impact quality',s=>s.windows['60000'].impactAsymmetry.quality='partial'],
  ['buy absorption',s=>s.windows['60000'].refill.absorptionDirection='buy'],
  ['unknown refill',s=>s.windows['60000'].refill.absorptionDirection='unknown'],
  ['bad refill quality',s=>s.windows['60000'].refill.quality='invalid_book']
])test('final gate vetoes '+name,async()=>{
  const s=snapshot();change(s);
  const {r,events}=await run(candidate(),context(),s);
  assert.equal(r.decision,'WAIT_RETEST');assert.equal(r.terminalCommand,undefined);assert.equal(events.length,1);
  assert.ok(r.reason);
});
test('final gate rejects stale/missing/future context without expiring candidate',async()=>{
  for(const asOf of [NOW-900001,undefined,NOW+1]){
    const {r}=await run(candidate({detectedAt:0}),context({asOf}));
    assert.equal(r.decision,'WAIT_RETEST');assert.equal(r.terminalCommand,undefined);
  }
  const {r}=await run(candidate({detectedAt:0}));assert.equal(r.decision,'ENTER_NOW');
});
test('final gate honors boundaries and does not use unrelated maxAge to reject primary flow',async()=>{
  const s=snapshot();s.freshness.maxAgeMs=9999999;s.freshness.eventsByFamily['binance:spot']={lastTradeAt:NOW-5000,lastBookAt:NOW-5000};
  const {r}=await run(candidate(),context({asOf:NOW-900000}),s);
  assert.equal(r.decision,'ENTER_NOW');
});
test('final evaluation catches context expiring while live request is in progress',async()=>{
  let time=NOW;
  const {r}=await run(candidate(),context({asOf:NOW-900000}),snapshot(),{
    now:()=>time,getLiveSnapshot:async()=>{time=NOW+1;return {...snapshot(),asOf:time};}
  });
  assert.equal(r.decision,'WAIT_RETEST');assert.equal(r.terminalCommand,undefined);
});
test('live reject or ignored abort timeout yields WAIT and journal failure never returns ENTER',async()=>{
  for(const getLiveSnapshot of [async()=>{throw Error('secret from upstream');},()=>new Promise(()=>{})]) {
    const {r,events}=await run(candidate(),context(),snapshot(),{getLiveSnapshot,policy:{liveTimeoutMs:10}});
    assert.equal(r.decision,'WAIT_RETEST');assert.equal(r.terminalCommand,undefined);assert.equal(events.length,1);
    assert.equal(JSON.stringify(r).includes('secret from upstream'),false);
  }
  await assert.rejects(run(candidate(),context(),snapshot(),{appendEvent:async()=>{throw Error('disk_failed');}}),/disk_failed/);
});
test('successful append finishes before ENTER becomes observable',async()=>{
  let resolveAppend;let entered=false;
  const result=run(candidate(),context(),snapshot(),{appendEvent:()=>new Promise(resolve=>{resolveAppend=resolve;})}).then(x=>{entered=true;return x;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(entered,false);assert.equal(typeof resolveAppend,'function');
  resolveAppend();const {r}=await result;assert.equal(r.decision,'ENTER_NOW');assert.equal(entered,true);
});
test('final gate rejects permissive watcher flags for required impact and absorption',async()=>{
  const c=candidate({watcherPolicy:{minImbalance:0.3,requireImpact:false,absorptionVeto:false}});
  const s=snapshot();s.windows['60000'].refill.absorptionDirection='buy';
  assert.equal((await run(c,context(),s)).r.decision,'WAIT_RETEST');
});

test('fresh fetch cannot replay a pre-request snapshot even within age allowance',async()=>{
  const {r}=await run(candidate(),context(),snapshot(4.93,{asOf:NOW-1}));
  assert.equal(r.decision,'WAIT_RETEST');assert.equal(r.reason,'snapshot_predates_live_request');
});
test('journal latency cannot return ENTER after live/context freshness expires',async()=>{
  let time=NOW;const rows=[];
  const {r}=await run(candidate(),context(),snapshot(),{now:()=>time,appendEvent:async e=>{rows.push(e);time=NOW+5001;}});
  assert.equal(r.decision,'WAIT_RETEST');assert.equal(r.terminalCommand,undefined);
  assert.equal(rows.at(-1).decision,'WAIT_RETEST');assert.equal(rows.at(-1).reason,'freshness_expired_before_output');
});
test('async caller mutation cannot replace the thesis context during final check',async()=>{
  const c=candidate(),ctx=context();
  const {r}=await run(c,ctx,snapshot(),{getLiveSnapshot:async()=>{ctx.qty='9999';return snapshot();}});
  assert.equal(r.decision,'ENTER_NOW');assert.equal(r.qty,'10');
});

test('fresh structural stops are validated against current delayed entry on both sides',async()=>{
  const short=await run(candidate(),context({invalidationPrice:4.92}),snapshot(4.91));
  assert.equal(short.r.decision,'ENTER_NOW');assert.ok(Math.abs(short.r.currentRR-13)<1e-10);
  const c=candidate({side:'long',triggerPrice:99,observedPrice:100});
  const s=snapshot(107);s.windows['60000'].aggressor.imbalance=0.5;s.windows['60000'].impactAsymmetry.direction='buy_more_efficient';s.windows['60000'].refill.absorptionDirection='buy';
  const ctx=context({side:'long',invalidationPrice:105,targets:[110]});
  const {r}=await run(c,ctx,s,{initialSnapshot:s});
  assert.equal(r.decision,'ENTER_REDUCED');assert.equal(r.currentRR,1.5);
});
test('real book midpoint floating residue works for initial and live snapshots',async()=>{
  const {createOrderBook}=await import('../order-book.js');
  const book=createOrderBook({venue:'binance',market:'spot',symbol:'NEARUSDT'});
  book.reset({bids:[[4.903,100]],asks:[[4.904,100]],sequence:1});
  const mid=book.snapshot().mid;
  const c=candidate({observedPrice:mid,microstructure:snapshot(mid)});
  const {r}=await run(c,context(),snapshot(mid),{initialSnapshot:c.microstructure});
  assert.equal(r.decision,'ENTER_REDUCED');assert.equal(r.entry,4.91);
});
test('fresh invalidation outranks opposing flow and non-full entry runtime',async()=>{
  for(const [changes,price,reason] of [[{structure:'broken'},4.93,'structure_broken'],[{thesisValid:false},4.93,'thesis_revoked'],[{},4.99,'invalidation_crossed']]) {
    const s=snapshot(price);s.windows['60000'].aggressor.imbalance=0.5;s.runtime='PARTIAL';
    const {r}=await run(candidate(),context(changes),s);
    assert.equal(r.decision,'INVALIDATED');assert.equal(r.reason,reason);assert.equal(r.terminalCommand,undefined);
  }
  const stale=snapshot(4.99,{asOf:NOW-5001});
  assert.equal((await run(candidate(),context(),stale)).r.decision,'WAIT_RETEST');
});
test('excess decimal strings cannot silently round quantity up by an instrument step',()=>{
  assert.throws(()=>evaluate(candidate(),snapshot(),context({qty:'1.09999999999999999',qtyStep:'0.1'})),/invalid_qty_precision/);
  assert.throws(()=>evaluate(candidate(),snapshot(),context({invalidationPrice:'4.98000000000000001'})),/invalid_.*precision/);
});
