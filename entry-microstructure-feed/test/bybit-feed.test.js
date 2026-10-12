import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBybitFeed } from '../bybit-feed.js';

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url) { super(); this.url=url; this.sent=[]; this.readyState=1; FakeSocket.instances.push(this); }
  send(v) { this.sent.push(JSON.parse(v)); }
  close() { if (this.readyState === 3) return; this.readyState=3; this.emit('close'); }
  open() { this.readyState=1; this.emit('open'); }
  message(v) { this.emit('message', Buffer.from(JSON.stringify(v))); }
}
FakeSocket.OPEN = 1;
const flush = () => new Promise(resolve => setImmediate(resolve));

test('subscribes publicTrade/orderbook and parses spot trade plus linear liquidation', async () => {
  FakeSocket.instances=[];
  const trades=[]; const liqs=[];
  const feed=createBybitFeed({ WebSocketImpl:FakeSocket, onTrade:x=>trades.push(x), onLiquidation:x=>liqs.push(x) });
  feed.start(); FakeSocket.instances.forEach(s=>s.open()); feed.ensureSymbol('BTCUSDT');
  const spot=FakeSocket.instances.find(s=>s.url.endsWith('/spot'));
  const linear=FakeSocket.instances.find(s=>s.url.endsWith('/linear'));
  assert.ok(spot.sent.some(x=>x.args?.includes('publicTrade.BTCUSDT')));
  assert.ok(spot.sent.some(x=>x.args?.includes('orderbook.50.BTCUSDT')));
  assert.ok(linear.sent.some(x=>x.args?.includes('allLiquidation.BTCUSDT')));
  spot.message({ topic:'publicTrade.BTCUSDT', ts:10, data:[{ T:9,s:'BTCUSDT',S:'Buy',v:'2',p:'100' }] });
  linear.message({ topic:'allLiquidation.BTCUSDT', ts:11, data:[{ T:10,s:'BTCUSDT',S:'Buy',v:'3',p:'99' }] });
  await flush();
  assert.equal(trades[0].market,'spot'); assert.equal(trades[0].side,'buy');
  assert.equal(liqs[0].side,'long');
  feed.stop();
});

test('snapshot then delta creates healthy local book', async () => {
  FakeSocket.instances=[]; const states=[];
  const feed=createBybitFeed({ WebSocketImpl:FakeSocket, onBookState:x=>states.push(x) });
  feed.start(); FakeSocket.instances.forEach(s=>s.open()); feed.ensureSymbol('BTCUSDT');
  const spot=FakeSocket.instances.find(s=>s.url.endsWith('/spot'));
  spot.message({ topic:'orderbook.50.BTCUSDT', type:'snapshot', ts:100, cts:99, data:{ s:'BTCUSDT',b:[['100','2']],a:[['101','2']],u:10,seq:100 } });
  spot.message({ topic:'orderbook.50.BTCUSDT', type:'delta', ts:110, cts:109, data:{ s:'BTCUSDT',b:[['100','3']],a:[],u:11,seq:101 } });
  await flush();
  const latest=states.filter(x=>x.market==='spot').at(-1);
  assert.equal(latest.state,'healthy');
  assert.equal(latest.book.bids[0][1],3);
  feed.stop();
});

test('new snapshot resets old book state rather than carrying old deltas', async () => {
  FakeSocket.instances=[]; const states=[];
  const feed=createBybitFeed({ WebSocketImpl:FakeSocket, onBookState:x=>states.push(x) });
  feed.start(); FakeSocket.instances.forEach(s=>s.open()); feed.ensureSymbol('ETHUSDT');
  const linear=FakeSocket.instances.find(s=>s.url.endsWith('/linear'));
  linear.message({ topic:'orderbook.50.ETHUSDT', type:'snapshot', ts:1, cts:1, data:{ s:'ETHUSDT',b:[['200','2'],['199','5']],a:[['201','2']],u:1,seq:10 } });
  linear.message({ topic:'orderbook.50.ETHUSDT', type:'delta', ts:2, cts:2, data:{ s:'ETHUSDT',b:[['198','7']],a:[],u:2,seq:11 } });
  linear.message({ topic:'orderbook.50.ETHUSDT', type:'snapshot', ts:3, cts:3, data:{ s:'ETHUSDT',b:[['205','1']],a:[['206','1']],u:1,seq:20 } });
  await flush();
  const latest=states.filter(x=>x.market==='linear').at(-1).book;
  assert.deepEqual(latest.bids,[[205,1]]);
  assert.deepEqual(latest.asks,[[206,1]]);
  feed.stop();
});

test('stale connection invalidates books, reconnects, and requires fresh snapshot', async () => {
  FakeSocket.instances=[]; let now=0; const intervals=[]; const timers=[]; const states=[];
  const feed=createBybitFeed({
    WebSocketImpl:FakeSocket,
    clock:{now:()=>now},
    onBookState:x=>states.push(x),
    setIntervalImpl:(fn,ms)=>{intervals.push({fn,ms});return intervals.length;}, clearIntervalImpl:()=>{},
    setTimeoutImpl:(fn,ms)=>{timers.push({fn,ms});return timers.length;}, clearTimeoutImpl:()=>{}, staleAfterMs:30_000
  });
  feed.start(); FakeSocket.instances.forEach(s=>s.open()); feed.ensureSymbol('SOLUSDT');
  const spot=FakeSocket.instances.find(s=>s.url.endsWith('/spot'));
  spot.message({ topic:'orderbook.50.SOLUSDT', type:'snapshot', ts:0, cts:0, data:{ s:'SOLUSDT',b:[['100','1']],a:[['101','1']],u:1,seq:1 } });
  await flush(); assert.equal(states.filter(x=>x.market==='spot').at(-1).state,'healthy');
  now=31_000; intervals.forEach(x=>x.fn());
  assert.ok(states.some(x=>x.market==='spot' && x.state==='WARMING_UP'));
  assert.ok(timers.length>0);
  const count=FakeSocket.instances.length; timers[0].fn();
  const replacement=FakeSocket.instances.slice(count).find(s=>s.url.endsWith('/spot'));
  assert.ok(replacement); replacement.open();
  assert.ok(replacement.sent.some(x=>x.args?.includes('orderbook.50.SOLUSDT')));
  replacement.message({ topic:'orderbook.50.SOLUSDT', type:'snapshot', ts:31_100, cts:31_099, data:{ s:'SOLUSDT',b:[['100','1']],a:[['101','1']],u:1,seq:5 } });
  await flush(); assert.equal(states.filter(x=>x.market==='spot').at(-1).state,'healthy');
  feed.stop();
});
