import test from 'node:test';
import assert from 'node:assert/strict';
import {runStructureCli} from '../scripts/analyze-structure.js';

test('offline CLI analyzes candles and outputs WAIT without execution or watcher writes',async()=>{
  const calls=[],outputs=[];
  const rows=Array.from({length:60},(_,i)=>{
    const close=100+Math.sin(i*Math.PI/3)*4;
    return {time:i*60000,open:close,high:close+.5,low:close-.5,close,volume:10};
  });
  const input={symbols:['NEARUSDT'],source:'binance:spot',asOf:3600000,
    roles:{context:['1m'],setup:['1m'],entry:['1m']},
    framesBySymbol:{NEARUSDT:{'1m':{symbol:'NEARUSDT',source:'binance:spot',candles:rows}}}};
  await runStructureCli(['--input','fixture.json'],{
    fsImpl:{readFile:async p=>{calls.push(p);return JSON.stringify(input);}},stdout:x=>outputs.push(x)});
  const output=JSON.parse(outputs[0]);assert.equal(output.results[0].decision,'WAIT');
  assert.equal(output.results[0].status,'FULL');assert.equal(output.watcher,undefined);
  assert.equal(output.terminalCommand,undefined);assert.deepEqual(calls,['fixture.json']);
});
test('CLI rejects execution-shaped or ambiguous flags without side effects',async()=>{
  for(const args of [['--execute'],['--source'],['--symbols','NEARUSDT','--symbols','BTCUSDT'],['--context','x']])
    await assert.rejects(runStructureCli(args),/usage/);
});
