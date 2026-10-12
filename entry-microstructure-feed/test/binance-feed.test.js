import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBinanceFeed } from '../binance-feed.js';

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url) { super(); this.url = url; this.sent = []; this.readyState = 1; FakeSocket.instances.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit('close'); }
  open() { this.emit('open'); }
  message(payload) { this.emit('message', Buffer.from(JSON.stringify(payload))); }
}
FakeSocket.OPEN = 1;

const jsonResponse = body => ({ ok: true, json: async () => body });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('subscribes spot/perp and forwards normalized agg trades', async () => {
  FakeSocket.instances = [];
  const trades = [];
  const feed = createBinanceFeed({ WebSocketImpl: FakeSocket, fetchImpl: async url => jsonResponse({ lastUpdateId: 10, bids: [['100','2']], asks: [['101','2']] }), onTrade: x => trades.push(x) });
  feed.start();
  for (const socket of FakeSocket.instances) socket.open();
  await feed.ensureSymbol('BTCUSDT');
  const spot = FakeSocket.instances.find(x => x.url.includes('stream.binance'));
  const perp = FakeSocket.instances.find(x => x.url.includes('fstream'));
  assert.ok(spot.sent.some(x => x.params?.includes('btcusdt@aggTrade')));
  assert.ok(perp.sent.some(x => x.params?.includes('btcusdt@depth@100ms')));
  assert.ok(perp.sent.some(x => x.params?.includes('btcusdt@forceOrder')));
  spot.message({ e:'aggTrade', E:2, T:1, s:'BTCUSDT', p:'100', q:'2', m:false });
  perp.message({ e:'aggTrade', E:3, T:2, s:'BTCUSDT', p:'100', q:'1', m:true });
  await flush();
  assert.deepEqual(trades.map(x => [x.market, x.side]), [['spot','buy'],['perp','sell']]);
  feed.stop();
});

test('buffers depth deltas while snapshot loads then applies valid update range', async () => {
  FakeSocket.instances = [];
  let resolveSpot;
  const fetchImpl = async url => {
    if (url.startsWith('https://api.binance.com/')) return new Promise(resolve => { resolveSpot = () => resolve(jsonResponse({ lastUpdateId: 10, bids:[['100','2']], asks:[['101','2']] })); });
    return jsonResponse({ lastUpdateId: 20, bids:[['100','2']], asks:[['101','2']] });
  };
  const states = [];
  const feed = createBinanceFeed({ WebSocketImpl: FakeSocket, fetchImpl, onBookState: x => states.push(x) });
  feed.start(); for (const s of FakeSocket.instances) s.open();
  const pending = feed.ensureSymbol('BTCUSDT');
  const spot = FakeSocket.instances.find(x => x.url.includes('stream.binance'));
  spot.message({ e:'depthUpdate', E:11, s:'BTCUSDT', U:11, u:11, b:[['100','3']], a:[] });
  resolveSpot();
  await pending; await flush();
  const latest = states.filter(x => x.market === 'spot' && x.symbol === 'BTCUSDT').at(-1);
  assert.equal(latest.state, 'healthy');
  assert.equal(latest.book.bestBid, 100);
  assert.equal(latest.book.bids[0][1], 3);
  feed.stop();
});

test('sequence gap triggers warming state and deterministic snapshot rebuild', async () => {
  FakeSocket.instances = [];
  let spotCalls = 0;
  const fetchImpl = async url => {
    if (url.startsWith('https://api.binance.com/')) {
      spotCalls++;
      return jsonResponse({ lastUpdateId: spotCalls === 1 ? 10 : 20, bids:[['100','2']], asks:[['101','2']] });
    }
    return jsonResponse({ lastUpdateId: 10, bids:[['100','2']], asks:[['101','2']] });
  };
  const states = [];
  const feed = createBinanceFeed({ WebSocketImpl: FakeSocket, fetchImpl, onBookState: x => states.push(x) });
  feed.start(); for (const s of FakeSocket.instances) s.open(); await feed.ensureSymbol('BTCUSDT');
  const spot = FakeSocket.instances.find(x => x.url.includes('stream.binance'));
  spot.message({ e:'depthUpdate', E:12, s:'BTCUSDT', U:12, u:12, b:[['100','1']], a:[] });
  await flush(); await flush();
  assert.ok(states.some(x => x.market === 'spot' && x.state === 'WARMING_UP'));
  assert.ok(spotCalls >= 2);
  feed.stop();
});

test('reconnect schedules backoff and resubscribes watched symbols', async () => {
  FakeSocket.instances = [];
  const timers = [];
  const feed = createBinanceFeed({
    WebSocketImpl: FakeSocket,
    fetchImpl: async () => jsonResponse({ lastUpdateId: 1, bids:[['100','1']], asks:[['101','1']] }),
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl: () => {}
  });
  feed.start(); for (const s of FakeSocket.instances) s.open(); await feed.ensureSymbol('BTCUSDT');
  const before = FakeSocket.instances.length;
  FakeSocket.instances[0].emit('close');
  assert.ok(timers.some(t => t.ms >= 250));
  timers.at(-1).fn();
  const created = FakeSocket.instances.slice(before);
  assert.ok(created.length >= 1);
  created[0].open();
  assert.ok(created[0].sent.some(x => x.params?.some(p => p.startsWith('btcusdt@'))));
  feed.stop();
});
