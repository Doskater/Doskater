import test from 'node:test';
import assert from 'node:assert/strict';
import { createBinanceFeed } from '../microstructure/binance-feed.js';

function socketHarness() {
  const sockets = [];
  const factory = url => {
    const listeners = new Map();
    const sent = [];
    const socket = {
      url, sent, readyState:0,
      on(name, fn){ listeners.set(name, fn); },
      send(value){ sent.push(JSON.parse(String(value))); },
      close(){ this.readyState=3; listeners.get('close')?.(); },
      open(){ this.readyState=1; listeners.get('open')?.(); },
      message(value){ listeners.get('message')?.(Buffer.from(JSON.stringify(value))); }
    };
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

test('Binance spot feed maps combined aggTrade and depth snapshots to neutral handlers', async () => {
  const { factory, sockets } = socketHarness();
  const feed = createBinanceFeed({ market:'spot', websocketFactory:factory, reconnect:false });
  const trades=[]; const books=[];
  feed.setHandlers({ onTrade:x=>trades.push(x), onBook:x=>books.push(x), onLiquidation(){}, onStatus(){} });
  feed.start();
  sockets[0].open();
  await feed.ensureSymbol('BTCUSDT');
  assert.ok(sockets[0].sent.some(x => x.method==='SUBSCRIBE' && x.params.includes('btcusdt@aggTrade')));
  assert.ok(sockets[0].sent.some(x => x.method==='SUBSCRIBE' && x.params.includes('btcusdt@depth20@100ms')));

  sockets[0].message({ stream:'btcusdt@aggTrade', data:{ e:'aggTrade', E:1010, s:'BTCUSDT', p:'100', q:'2', T:1009, m:true } });
  sockets[0].message({ stream:'btcusdt@depth20@100ms', data:{ lastUpdateId:7, bids:[['99','2']], asks:[['101','3']] } });

  assert.deepEqual(trades[0], { family:'binance:spot', symbol:'BTCUSDT', eventTs:1009, price:100, quantity:2, notional:200, aggressorSide:'sell' });
  assert.equal(books[0].state, 'healthy');
  assert.equal(books[0].sequence, 7);
  assert.deepEqual(books[0].bids, [[99,2]]);
  assert.deepEqual(books[0].asks, [[101,3]]);
});

test('Binance perp feed maps forceOrder execution side to liquidation side', async () => {
  const { factory, sockets } = socketHarness();
  const feed = createBinanceFeed({ market:'perp', websocketFactory:factory, reconnect:false });
  const liqs=[];
  feed.setHandlers({ onTrade(){}, onBook(){}, onLiquidation:x=>liqs.push(x), onStatus(){} });
  feed.start(); sockets[0].open(); await feed.ensureSymbol('ETHUSDT');
  assert.ok(sockets[0].sent.some(x => x.params.includes('ethusdt@forceOrder')));
  sockets[0].message({ stream:'ethusdt@forceOrder', data:{ e:'forceOrder', E:2000, o:{ s:'ETHUSDT', S:'SELL', q:'3', ap:'50', p:'51', T:1999 } } });
  assert.deepEqual(liqs[0], { family:'binance:perp', symbol:'ETHUSDT', eventTs:1999, side:'sell', notional:150 });
});
