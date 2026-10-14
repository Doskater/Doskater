import test from 'node:test';
import assert from 'node:assert/strict';
import { createBybitFeed } from '../microstructure/bybit-feed.js';

function socketHarness() {
  const sockets=[];
  const factory=url=>{
    const listeners=new Map(); const sent=[];
    const socket={url,sent,readyState:0,on(n,f){listeners.set(n,f)},send(v){sent.push(JSON.parse(String(v)))},close(){this.readyState=3;listeners.get('close')?.()},open(){this.readyState=1;listeners.get('open')?.()},message(v){listeners.get('message')?.(Buffer.from(JSON.stringify(v)))}};
    sockets.push(socket); return socket;
  };
  return {factory,sockets};
}

test('Bybit linear feed rebuilds snapshot then applies deltas', async () => {
  const {factory,sockets}=socketHarness();
  const feed=createBybitFeed({market:'linear',websocketFactory:factory,reconnect:false});
  const books=[];
  feed.setHandlers({onTrade(){},onBook:x=>books.push(x),onLiquidation(){},onStatus(){}});
  feed.start(); sockets[0].open(); await feed.ensureSymbol('BTCUSDT');
  const subscribe=sockets[0].sent.find(x=>x.op==='subscribe');
  assert.ok(subscribe.args.includes('orderbook.50.BTCUSDT'));
  assert.ok(subscribe.args.includes('publicTrade.BTCUSDT'));
  assert.ok(subscribe.args.includes('allLiquidation.BTCUSDT'));

  sockets[0].message({topic:'orderbook.50.BTCUSDT',type:'snapshot',ts:1000,data:{s:'BTCUSDT',b:[['99','2']],a:[['101','3']],u:10,seq:20}});
  sockets[0].message({topic:'orderbook.50.BTCUSDT',type:'delta',ts:1001,data:{s:'BTCUSDT',b:[['99','0'],['98','4']],a:[['101','5']],u:11,seq:21}});

  assert.equal(books[0].state,'healthy');
  assert.deepEqual(books.at(-1).bids,[[98,4]]);
  assert.deepEqual(books.at(-1).asks,[[101,5]]);
  assert.equal(books.at(-1).sequence,21);
});

test('Bybit feed accepts increasing non-contiguous update ids and resets on snapshot', async () => {
  const {factory,sockets}=socketHarness();
  const feed=createBybitFeed({market:'linear',websocketFactory:factory,reconnect:false});
  const books=[];
  feed.setHandlers({onTrade(){},onBook:x=>books.push(x),onLiquidation(){},onStatus(){}});
  feed.start(); sockets[0].open(); await feed.ensureSymbol('BTCUSDT');
  sockets[0].message({topic:'orderbook.50.BTCUSDT',type:'snapshot',ts:1000,data:{s:'BTCUSDT',b:[['99','1']],a:[['101','1']],u:5,seq:10}});
  sockets[0].message({topic:'orderbook.50.BTCUSDT',type:'delta',ts:1001,data:{s:'BTCUSDT',b:[['99','2']],a:[],u:7,seq:12}});
  assert.equal(books.at(-1).state,'healthy');
  assert.deepEqual(books.at(-1).bids,[[99,2]]);
  sockets[0].message({topic:'orderbook.50.BTCUSDT',type:'snapshot',ts:1002,data:{s:'BTCUSDT',b:[['100','1']],a:[['102','1']],u:1,seq:13}});
  assert.equal(books.at(-1).state,'healthy');
  assert.deepEqual(books.at(-1).bids,[[100,1]]);
});

test('Bybit trades use taker side and liquidation position side is inverted to forced-flow side', async () => {
  const {factory,sockets}=socketHarness();
  const feed=createBybitFeed({market:'linear',websocketFactory:factory,reconnect:false});
  const trades=[]; const liqs=[];
  feed.setHandlers({onTrade:x=>trades.push(x),onBook(){},onLiquidation:x=>liqs.push(x),onStatus(){}});
  feed.start(); sockets[0].open(); await feed.ensureSymbol('SOLUSDT');
  sockets[0].message({topic:'publicTrade.SOLUSDT',type:'snapshot',ts:2000,data:[{T:1999,s:'SOLUSDT',S:'Buy',v:'2',p:'10'}]});
  sockets[0].message({topic:'allLiquidation.SOLUSDT',type:'snapshot',ts:2001,data:[{T:2000,s:'SOLUSDT',S:'Buy',v:'3',p:'9'}]});
  assert.deepEqual(trades[0],{family:'bybit:linear',symbol:'SOLUSDT',eventTs:1999,price:10,quantity:2,notional:20,aggressorSide:'buy'});
  assert.deepEqual(liqs[0],{family:'bybit:linear',symbol:'SOLUSDT',eventTs:2000,side:'sell',notional:27});
});

test('Bybit feed sends JSON ping heartbeat every 20 seconds and clears it on stop', async () => {
  const {factory,sockets}=socketHarness();
  let heartbeatCallback=null;
  let cleared=null;
  let unrefCount=0;
  const timerHandle={unref(){unrefCount+=1;}};
  const feed=createBybitFeed({
    market:'linear',
    websocketFactory:factory,
    reconnect:false,
    setIntervalImpl(fn,ms){ assert.equal(ms,20_000); heartbeatCallback=fn; return timerHandle; },
    clearIntervalImpl(id){ cleared=id; }
  });
  feed.setHandlers({onTrade(){},onBook(){},onLiquidation(){},onStatus(){}});
  await feed.start();
  sockets[0].open();
  assert.equal(typeof heartbeatCallback,'function');
  assert.equal(unrefCount,1);
  heartbeatCallback();
  assert.deepEqual(sockets[0].sent.at(-1),{op:'ping'});
  feed.stop();
  assert.equal(cleared,timerHandle);
});
