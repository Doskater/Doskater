import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicMicrostructure } from '../microstructure/public-microstructure.js';

function socketHarness() {
  const sockets=[];
  const factory=url=>{
    const listeners=new Map(); const sent=[];
    const socket={url,sent,readyState:0,on(n,f){listeners.set(n,f)},send(v){sent.push(JSON.parse(String(v)))},close(){this.readyState=3;listeners.get('close')?.()},open(){this.readyState=1;listeners.get('open')?.()}};
    sockets.push(socket); return socket;
  };
  return {factory,sockets};
}

test('public microstructure composes four public venue feeds with one neutral collector', async () => {
  const {factory,sockets}=socketHarness();
  const runtime=createPublicMicrostructure({websocketFactory:factory,coreSymbols:['BTCUSDT']});
  await runtime.start();
  assert.equal(runtime.feeds.length,4);
  assert.deepEqual(runtime.feeds.map(x=>x.family).sort(),['binance:perp','binance:spot','bybit:linear','bybit:spot']);
  assert.equal(sockets.length,4);
  sockets.forEach(x=>x.open());
  assert.ok(sockets.every(x=>x.sent.length>0));
  const status=runtime.collector.getStatus();
  assert.deepEqual(status.activeSymbols,['BTCUSDT']);
  runtime.stop();
});

import { createSourceHealth } from '../source-health.js';

test('public microstructure records technical websocket health without trading interpretation', async () => {
  const {factory,sockets}=socketHarness();
  const clock={value:5000,now(){return this.value;}};
  const health=createSourceHealth({clock});
  const runtime=createPublicMicrostructure({websocketFactory:factory,coreSymbols:[],clock,sourceHealth:health});
  await runtime.start();
  sockets.forEach(x=>x.open());
  const out=health.snapshot();
  assert.equal(out.microstructure_binance_spot.state,'GOOD');
  assert.equal(out.microstructure_binance_perp.state,'GOOD');
  assert.equal(out.microstructure_bybit_spot.state,'GOOD');
  assert.equal(out.microstructure_bybit_linear.state,'GOOD');
  assert.equal(JSON.stringify(out).includes('signal'), false);
  runtime.stop();
});
