import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFocusedEntry,runFocusedRevalidation} from '../focused-revalidation.js';
import {candidate,context,snapshot,NOW} from './helpers/entry-fixtures.js';

function mtf(changes={}) {
  return {schemaVersion:1,symbol:'NEARUSDT',side:'short',source:'binance:spot',asOf:NOW,scenarioId:'s1',
    setupId:'setup-1',triggerPrice:4.94,timeframe:'15m',regime:'trend',coverage:1,confidence:.8,
    zone:{lower:4.93,upper:4.95},setupConfirmed:true,structureValid:true,invalidationPrice:4.98,targets:[4.78],
    entryTimeframes:['5m','1m'],setupConfirmedAt:NOW-60000,
    lowerTrigger:{confirmed:true,timeframe:'1m',confirmedAt:NOW,price:4.93,
      candle:{time:NOW-60000,closeTime:NOW,high:4.95,low:4.92,close:4.93},
      previous:{time:NOW-120000,closeTime:NOW-60000,high:4.97,low:4.94},atr:.01},...changes};
}
const evaluate=(m,s=snapshot(),ctx={})=>evaluateFocusedEntry(candidate(),s,context({...ctx,mtf:m}),{now:()=>NOW});
test('MTF lower trigger gates entry ahead of microstructure without cancelling the thesis',()=>{
  assert.equal(evaluate(mtf()).eligibleDecision,'ENTER_NOW');
  for(const changes of [{setupConfirmed:false},{lowerTrigger:{confirmed:false,timeframe:'1m',confirmedAt:NOW}},
    {lowerTrigger:{confirmed:true,timeframe:'1m',confirmedAt:NOW-120001}}]) {
    const r=evaluate(mtf(changes));assert.equal(r.decision,'WAIT_RETEST');assert.equal(r.terminalCommand,undefined);
    assert.match(r.reason,/mtf_/);
  }
  const bad=snapshot();bad.windows['60000'].aggressor.imbalance=.6;
  assert.equal(evaluate(mtf(),bad).reason,'flow_not_confirmed');
  assert.equal(evaluate(mtf(),bad).decision,'WAIT_RETEST');
});
test('MTF rejects stale identity, missing provenance and mismatched geometry or price source',()=>{
  for(const changes of [{scenarioId:''},{source:'bybit:linear'},{symbol:'ETHUSDT'},{setupId:'other'},
    {triggerPrice:4.95},{schemaVersion:2},{coverage:.5},{regime:'unknown'},{asOf:NOW-1},
    {invalidationPrice:4.97},{targets:[4.5]}, {lowerTrigger:{confirmed:true,timeframe:'unknown',confirmedAt:NOW}},
    {lowerTrigger:{confirmed:true,timeframe:'1m',confirmedAt:NOW+1}}]) {
    assert.equal(evaluate(mtf(changes)).eligibleDecision,'WAIT_RETEST',JSON.stringify(changes));
  }
  assert.equal(evaluate(null).decision,'WAIT_RETEST');
});
test('MTF structural invalidation outranks temporary opposing flow; fresh live gate alone emits command',async()=>{
  const bad=snapshot();bad.windows['60000'].aggressor.imbalance=.5;
  assert.equal(evaluate(mtf({structureValid:false}),bad).decision,'INVALIDATED');
  const events=[];
  const run=m=>runFocusedRevalidation(candidate(),context({mtf:m}),{now:()=>NOW,
    getLiveSnapshot:async()=>snapshot(),appendEvent:async e=>events.push(e)});
  const entered=await run(mtf());assert.equal(entered.decision,'ENTER_NOW');assert.ok(entered.terminalCommand);
  const waited=await run(mtf({setupConfirmed:false}));assert.equal(waited.decision,'WAIT_RETEST');
  assert.equal(waited.terminalCommand,undefined);assert.equal(events.length,2);
});
test('MTF lower evidence must match an entry frame, chronology, price break and live zone',()=>{
  const good=mtf().lowerTrigger;
  for(const t of [{...good,timeframe:'1D'}, {...good,price:100},
    {...good,candle:{...good.candle,close:4.95}}, {...good,previous:{...good.previous,low:4.92}},
    {...good,candle:{...good.candle,time:NOW-120000}}, {...good,atr:null}]) {
    assert.equal(evaluate(mtf({lowerTrigger:t})).eligibleDecision,'WAIT_RETEST');
  }
  assert.equal(evaluate(mtf({setupConfirmedAt:NOW})).eligibleDecision,'WAIT_RETEST');
  assert.equal(evaluate(mtf(),snapshot(4.88)).eligibleDecision,'WAIT_RETEST');
});
