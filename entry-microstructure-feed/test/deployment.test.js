import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startService } from '../server.js';
import { createLogger } from '../logger.js';

function collectorStub() {
  let started=0; let stopped=0;
  return {
    start: async()=>{started++;}, stop:()=>{stopped++;},
    getStatus:()=>({started:true,activeSymbols:3,runtimeCounts:{FULL_EVENT_STREAM:1,WARMING_UP:1,PARTIAL:1,UNAVAILABLE:0},feeds:{binance:{connection:{spot:'connected',perp:'connected'}},bybit:{connection:{spot:'connected',linear:'connected'}}}}),
    getWatchlist:()=>[{symbol:'BTCUSDT'},{symbol:'ETHUSDT'},{symbol:'SOLUSDT'}],
    ensureSymbols:async()=>[], getSnapshot:s=>({symbol:s,runtime:'WARMING_UP'}), getSummary:s=>({symbol:s}),
    counts:()=>({started,stopped})
  };
}

test('startService defaults to loopback and localhost API works without bearer', async()=>{
  const collector=collectorStub();
  const runtime=await startService({env:{PORT:'0'},collector,installSignalHandlers:false});
  try {
    assert.equal(runtime.server.address().address,'127.0.0.1');
    assert.ok(runtime.server.address().port>0);
    assert.equal(collector.counts().started,1);
    const port=runtime.server.address().port;
    const status=await fetch(`http://127.0.0.1:${port}/v1/status`);
    assert.equal(status.status,200);
  } finally { await runtime.stop(); }
  assert.equal(collector.counts().stopped,1);
});

test('explicit public bind still fails closed without bearer configuration', async()=>{
  const collector=collectorStub();
  const runtime=await startService({env:{PORT:'0'},host:'0.0.0.0',collector,installSignalHandlers:false});
  try {
    const port=runtime.server.address().port;
    const health=await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status,200);
    const status=await fetch(`http://127.0.0.1:${port}/v1/status`);
    assert.equal(status.status,503);
  } finally { await runtime.stop(); }
});

test('SIGTERM invokes graceful stop exactly once', async()=>{
  const collector=collectorStub(); const signals=new EventEmitter();
  const runtime=await startService({env:{PORT:'0'},collector,signalTarget:signals,installSignalHandlers:true});
  signals.emit('SIGTERM');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(collector.counts().stopped,1);
  assert.equal(runtime.server.listening,false);
  await runtime.stop();
  assert.equal(collector.counts().stopped,1);
});

test('structured logger redacts secrets and does not emit raw event payloads',()=>{
  const lines=[];
  const logger=createLogger({sink:line=>lines.push(line),env:{MICROSTRUCTURE_FEED_TOKEN:'super-secret'}});
  logger.info({event:'connected',venue:'binance'});
  logger.warn({event:'book_gap',symbol:'BTCUSDT',message:'bad super-secret',raw:{huge:'trade payload'}});
  assert.equal(lines.length,2);
  for(const line of lines){ const parsed=JSON.parse(line); assert.equal(typeof parsed.ts,'string'); assert.equal(line.includes('super-secret'),false); assert.equal('raw' in parsed,false); }
  assert.equal(JSON.parse(lines[1]).message,'bad REDACTED');
});
