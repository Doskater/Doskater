import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../collector.js';
import { createWatchlist } from '../watchlist.js';
import { CORE_SYMBOLS, DYNAMIC_TTL_MS } from '../config.js';

class FakeFeed {
  constructor(venue) { this.venue=venue; this.handlers={}; this.ensured=[]; this.removed=[]; this.started=false; }
  setHandlers(h) { this.handlers={...this.handlers,...h}; }
  start() { this.started=true; }
  stop() { this.started=false; }
  async ensureSymbol(s) { this.ensured.push(s); }
  removeSymbol(s) { this.removed.push(s); }
  status() { return { venue:this.venue, connection:{} }; }
  book(market,symbol,state,book,ts) { this.handlers.onBookState?.({ venue:this.venue,market,symbol,state,book,ts }); }
  trade(market,symbol,side,notional,ts,price=100) { this.handlers.onTrade?.({ venue:this.venue,market,symbol,side,notional,eventTs:ts,receiveTs:ts,price,qty:notional/price }); }
  liq(symbol,side,notional,ts,price=100) { this.handlers.onLiquidation?.({ venue:this.venue,market:this.venue==='bybit'?'linear':'perp',symbol,side,notional,eventTs:ts,receiveTs:ts,price,qty:notional/price }); }
}

const book = (mid=100, healthy=true) => ({ healthy, mid, bestBid:mid-0.5, bestAsk:mid+0.5, spread:1, bids:[[mid-0.5,10],[mid-1,10]], asks:[[mid+0.5,10],[mid+1,10]] });

function setup(nowRef) {
  const binance=new FakeFeed('binance'); const bybit=new FakeFeed('bybit');
  const watchlist=createWatchlist({ coreSymbols:CORE_SYMBOLS, maxActive:12, dynamicTtlMs:DYNAMIC_TTL_MS, now:()=>nowRef.value });
  const collector=createCollector({ binanceFeed:binance, bybitFeed:bybit, watchlist, clock:{now:()=>nowRef.value} });
  return { collector,binance,bybit };
}

function emitAllHealthy(ctx,symbol,ts,midValue=100) {
  ctx.binance.book('spot',symbol,'healthy',book(midValue),ts);
  ctx.binance.book('perp',symbol,'healthy',book(midValue+0.01),ts);
  ctx.bybit.book('spot',symbol,'healthy',book(midValue+0.02),ts);
  ctx.bybit.book('linear',symbol,'healthy',book(midValue+0.03),ts);
  ctx.binance.trade('spot',symbol,'buy',100000,ts,midValue);
  ctx.binance.trade('perp',symbol,'buy',50000,ts,midValue+0.01);
  ctx.bybit.trade('spot',symbol,'buy',50000,ts,midValue+0.02);
  ctx.bybit.trade('linear',symbol,'buy',50000,ts,midValue+0.03);
}

test('core symbol reaches FULL_EVENT_STREAM only after 60s valid event history', async () => {
  const now={value:0}; const ctx=setup(now); await ctx.collector.start();
  emitAllHealthy(ctx,'BTCUSDT',0,100);
  assert.equal(ctx.collector.getSnapshot('BTCUSDT').runtime,'WARMING_UP');
  now.value=60_000; emitAllHealthy(ctx,'BTCUSDT',60_000,101);
  const snap=ctx.collector.getSnapshot('BTCUSDT');
  assert.equal(snap.runtime,'FULL_EVENT_STREAM');
  assert.equal(snap.missingCoverage.length,0);
  assert.equal(snap.coverage.filter(x=>x.healthy).length,4);
  assert.ok(snap.windows['60000']);
  ctx.collector.stop();
});

test('runtime states distinguish warming partial and unavailable', async () => {
  const now={value:0}; const ctx=setup(now); await ctx.collector.start();
  assert.equal(ctx.collector.getSnapshot('ETHUSDT').runtime,'WARMING_UP');
  ctx.binance.book('spot','ETHUSDT','healthy',book(),0);
  ctx.binance.trade('spot','ETHUSDT','buy',1000,0);
  assert.equal(ctx.collector.getSnapshot('ETHUSDT').runtime,'PARTIAL');
  ctx.binance.book('spot','ETHUSDT','unsupported',book(100,false),1);
  now.value=100_000;
  assert.equal(ctx.collector.getSnapshot('ETHUSDT').runtime,'UNAVAILABLE');
  ctx.collector.stop();
});

test('unsupported market coverage is listed and never synthesized', async () => {
  const now={value:0}; const ctx=setup(now); await ctx.collector.start();
  ctx.binance.book('spot','SOLUSDT','healthy',book(),0);
  ctx.binance.book('perp','SOLUSDT','healthy',book(),0);
  ctx.bybit.book('spot','SOLUSDT','healthy',book(),0);
  ctx.bybit.book('linear','SOLUSDT','unsupported',book(100,false),0);
  const snap=ctx.collector.getSnapshot('SOLUSDT');
  assert.equal(snap.runtime,'PARTIAL');
  assert.ok(snap.missingCoverage.includes('bybit:linear'));
  assert.equal(snap.coverage.find(x=>x.family==='bybit:linear').healthy,false);
  ctx.collector.stop();
});

test('dynamic ensure subscribes feeds, warms, then expiry unsubscribes', async () => {
  const now={value:0}; const ctx=setup(now); await ctx.collector.start();
  await ctx.collector.ensureSymbols(['STXUSDT']);
  assert.ok(ctx.binance.ensured.includes('STXUSDT'));
  assert.ok(ctx.bybit.ensured.includes('STXUSDT'));
  assert.equal(ctx.collector.getSnapshot('STXUSDT').runtime,'WARMING_UP');
  now.value=DYNAMIC_TTL_MS+1;
  const list=ctx.collector.getWatchlist();
  assert.ok(!list.some(x=>x.symbol==='STXUSDT'));
  assert.ok(ctx.binance.removed.includes('STXUSDT'));
  assert.ok(ctx.bybit.removed.includes('STXUSDT'));
  ctx.collector.stop();
});

test('snapshot exposes causal microstructure fields without inventing missing features', async () => {
  const now={value:0}; const ctx=setup(now); await ctx.collector.start();
  emitAllHealthy(ctx,'BTCUSDT',0,100);
  now.value=60_000; emitAllHealthy(ctx,'BTCUSDT',60_000,101);
  ctx.binance.liq('BTCUSDT','short',50000,59_000,100.8);
  const snap=ctx.collector.getSnapshot('BTCUSDT');
  assert.ok(snap.primaryFamily);
  assert.ok(snap.leader);
  assert.ok(snap.causalSummary);
  assert.equal(typeof snap.strongestContradiction,'string');
  assert.ok(snap.freshness);
  ctx.collector.stop();
});
