import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeTimeframe,analyzeStructure,projectBoundary,timeframeMs} from '../mtf-structure.js';

export function candles(values,{interval=60000,scale=1,start=0}={}) {
  return values.map((close,i)=>({time:start+i*interval,open:close*scale,high:(close+0.2)*scale,
    low:(close-0.2)*scale,close:close*scale,volume:10}));
}
const wave=Array.from({length:60},(_,i)=>100+i*.3+Math.sin(i*Math.PI/3)*3);
const frame=(rows,extra={})=>analyzeTimeframe(rows,{timeframe:'1m',asOf:rows.at(-1).time+60000,...extra});

test('confirmed pivots label HH/HL and mirrored LH/LL at every price scale',()=>{
  for(const scale of [.001,1,1000]) {
    const up=frame(candles(wave,{scale}));
    assert.equal(up.ok,true);assert.equal(up.swings.high,'HH');assert.equal(up.swings.low,'HL');
    assert.equal(up.regime,'trend');assert.equal(up.direction,1);
    const down=frame(candles(wave.map(x=>220-x),{scale}));
    assert.equal(down.swings.high,'LH');assert.equal(down.swings.low,'LL');assert.equal(down.direction,-1);
  }
});
test('pivots are confirmed causally and plateau ties select the last extremum',()=>{
  const rows=candles(Array.from({length:30},(_,i)=>100+Math.sin(i)*3));
  const full=frame(rows);
  for(let n=20;n<=rows.length;n++) {
    const prefix=frame(rows.slice(0,n));
    assert.deepEqual(full.pivots.filter(p=>p.confirmedAt<=n*60000),prefix.pivots);
    assert.ok(prefix.pivots.every(p=>p.confirmedAt<=n*60000));
  }
  const plateau=candles([...Array(20).fill(100),101,104,104,101,100,99]);
  const highs=frame(plateau).pivots.filter(p=>p.kind==='high');
  assert.equal(highs.at(-1).index,22);
});
test('three-touch sloping boundary has provenance, projection and closed-break invalidation',()=>{
  const up=frame(candles(wave));
  const b=up.boundaries.support;
  assert.equal(b.valid,true);assert.ok(b.touches.length>=3);assert.ok(b.slope>0);
  assert.equal(projectBoundary(b,b.anchorTime),b.anchorPrice);
  const broken=frame(candles([...wave,90]));
  assert.equal(broken.boundaries.support.valid,false);
  assert.equal(broken.boundaries.support.invalidatedAt,61*60000);
  const sparse=frame(candles(wave.slice(0,20)),{right:4});
  assert.equal(sparse.boundaries.support?.valid ?? false,false);
});
test('horizontal repeated pivots yield range zones; converging boundaries yield compression',()=>{
  const range=frame(candles(Array.from({length:60},(_,i)=>100+Math.sin(i*Math.PI/3)*4)));
  assert.equal(range.regime,'range');assert.ok(range.zones.some(z=>z.touches.length>=3));
  const squeeze=frame(candles(Array.from({length:90},(_,i)=>100+Math.sin(i*Math.PI/3)*(10-i*.08))));
  assert.equal(squeeze.regime,'compression');assert.equal(squeeze.boundaries.support.valid,true);
  assert.equal(squeeze.boundaries.resistance.valid,true);
});
test('bad, gapped, stale and insufficient candles fail closed; an open candle is ignored',()=>{
  const rows=candles(wave);
  const bads=[rows.slice(0,8),rows.filter((_,i)=>i!==20),rows.map((r,i)=>i===20?{...r,time:rows[19].time}:r),
    rows.map((r,i)=>i===20?{...r,high:r.low}:r),rows.map((r,i)=>i===20?{...r,close:NaN}:r)];
  for(const bad of bads)assert.equal(frame(bad).ok,false);
  assert.equal(frame(rows,{asOf:rows.at(-1).time+60000*4}).ok,false);
  const open=candles([...wave,500]);
  assert.deepEqual(frame(open,{asOf:60*60000}),frame(rows));
});
test('roles overlap without counting a timeframe twice; missing roles reduce coverage',()=>{
  const roles={context:['1h','15m'],setup:['15m'],entry:['15m','1m']};
  const asOf=100*3600000;
  const frames=Object.fromEntries(['1h','15m','1m'].map(tf=>[tf,{symbol:'NEARUSDT',source:'binance:spot',
    candles:candles(wave,{interval:timeframeMs(tf),start:asOf-wave.length*timeframeMs(tf)})}]));
  const input={symbol:'NEARUSDT',source:'binance:spot',asOf,frames,roles};
  const a=analyzeStructure(input);
  assert.equal(a.status,'FULL');assert.equal(a.agreement.votes.length,3);assert.equal(a.agreement.coverage,1);
  assert.equal(a.agreement.signed,1);
  const partial=analyzeStructure({...input,frames:{'1h':frames['1h']}});
  assert.equal(partial.status,'PARTIAL');assert.ok(partial.agreement.coverage<1);
  assert.equal(partial.entryReady,false);
  const wrong=analyzeStructure({...input,frames:{...frames,'1m':{...frames['1m'],symbol:'ETHUSDT'}}});
  assert.equal(wrong.frames['1m'].ok,false);
});
test('invalid timeframe options are rejected rather than silently changing the model',()=>{
  assert.throws(()=>timeframeMs('nonsense'),/timeframe/);
  assert.equal(timeframeMs('1D'),86400000);
  assert.equal(frame(candles(wave),{right:0}).ok,false);
});
