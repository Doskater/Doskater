const DEFAULT_CORE = Object.freeze(['BTCUSDT','ETHUSDT','SOLUSDT']);
const DEFAULT_RETENTION_MS = 120_000;
const DEFAULT_DYNAMIC_TTL_MS = 20 * 60 * 1000;
const DEFAULT_FRESHNESS_MS = 10_000;

const normalizeSymbol = value => {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,30}USDT$/.test(symbol)) throw new Error('invalid_symbol');
  return symbol;
};
const finite = value => { const n=Number(value); return Number.isFinite(n)?n:null; };

function bufferKey(family, symbol) { return `${family}:${symbol}`; }

function depthSnapshot(event) {
  const bids = Array.isArray(event.bids) ? event.bids.map(([p,q])=>[finite(p),finite(q)]).filter(([p,q])=>p>0&&q>=0).sort((a,b)=>b[0]-a[0]) : [];
  const asks = Array.isArray(event.asks) ? event.asks.map(([p,q])=>[finite(p),finite(q)]).filter(([p,q])=>p>0&&q>=0).sort((a,b)=>a[0]-b[0]) : [];
  const bestBid = finite(event.bestBid) ?? bids[0]?.[0] ?? null;
  const bestAsk = finite(event.bestAsk) ?? asks[0]?.[0] ?? null;
  const mid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid+bestAsk)/2 : null;
  const sumDepth = (levels, side, bps) => {
    if (!Number.isFinite(mid) || mid <= 0) return null;
    const edge = side==='bid' ? mid*(1-bps/10_000) : mid*(1+bps/10_000);
    return levels
      .filter(([price]) => side==='bid' ? price>=edge : price<=edge)
      .reduce((sum,[price,qty])=>sum+price*qty,0);
  };
  return {
    bestBid, bestAsk,
    spread: Number.isFinite(bestBid)&&Number.isFinite(bestAsk) ? bestAsk-bestBid : null,
    mid,
    bidDepth5bps: sumDepth(bids,'bid',5), askDepth5bps: sumDepth(asks,'ask',5),
    bidDepth10bps: sumDepth(bids,'bid',10), askDepth10bps: sumDepth(asks,'ask',10)
  };
}

export function createNeutralMicrostructureCollector({
  feeds = [],
  clock = Date,
  coreSymbols = DEFAULT_CORE,
  maxActiveSymbols = 12,
  dynamicTtlMs = DEFAULT_DYNAMIC_TTL_MS,
  retentionMs = DEFAULT_RETENTION_MS,
  freshnessMs = DEFAULT_FRESHNESS_MS,
  warmupMs = 5_000,
  sourceHealth
} = {}) {
  const now = () => typeof clock.now==='function' ? clock.now() : Date.now();
  const active = new Map();
  const trades = new Map(); const books = new Map(); const liquidations = new Map();
  const coverage = new Map(); const statuses = new Map();
  let started = false;
  const core = new Set(coreSymbols.map(normalizeSymbol));

  function listFor(map,key) { if(!map.has(key)) map.set(key,[]); return map.get(key); }
  function pruneList(list) { const cutoff=now()-retentionMs; while(list.length && Number(list[0].ts)<cutoff) list.shift(); }
  function push(map,key,row) { const list=listFor(map,key); list.push(row); pruneList(list); }
  function clearFamily(family,symbol) { const key=bufferKey(family,symbol); trades.delete(key); books.delete(key); liquidations.delete(key); }

  function onTrade(event) {
    const family=String(event.family); const symbol=normalizeSymbol(event.symbol); const ts=finite(event.eventTs ?? event.ts);
    if(!Number.isFinite(ts)) return;
    const price=finite(event.price); const quantity=finite(event.quantity) ?? 0;
    const notional=finite(event.notional) ?? (Number.isFinite(price)?price*quantity:0);
    const aggressorSide=String(event.aggressorSide ?? '').toLowerCase();
    if(!['buy','sell'].includes(aggressorSide)) return;
    push(trades,bufferKey(family,symbol),{ts,price,quantity,notional,aggressorSide});
  }
  function onLiquidation(event) {
    const family=String(event.family); const symbol=normalizeSymbol(event.symbol); const ts=finite(event.eventTs ?? event.ts);
    if(!Number.isFinite(ts)) return;
    const side=String(event.side ?? '').toLowerCase(); if(!['buy','sell'].includes(side)) return;
    push(liquidations,bufferKey(family,symbol),{ts,side,notional:finite(event.notional)??0});
  }
  function onBook(event) {
    const family=String(event.family); const symbol=normalizeSymbol(event.symbol); const ts=finite(event.ts ?? event.eventTs) ?? now();
    const key=bufferKey(family,symbol); const previous=coverage.get(key);
    if(event.state!=='healthy') {
      clearFamily(family,symbol);
      coverage.set(key,{ state:'unhealthy', lastTs:ts, healthySince:null, reason:String(event.reason ?? 'book_unhealthy'), sequence:event.sequence ?? null });
      return;
    }
    const snap=depthSnapshot(event);
    if(!Number.isFinite(snap.bestBid)||!Number.isFinite(snap.bestAsk)||snap.bestBid>=snap.bestAsk) {
      clearFamily(family,symbol);
      coverage.set(key,{ state:'unhealthy', lastTs:ts, healthySince:null, reason:'invalid_book', sequence:event.sequence ?? null });
      return;
    }
    const healthySince=previous?.state==='healthy' && Number.isFinite(previous.healthySince) ? previous.healthySince : ts;
    coverage.set(key,{ state:'healthy', lastTs:ts, healthySince, reason:null, sequence:event.sequence ?? null });
    push(books,key,{ts,...snap});
    sourceHealth?.record?.(`microstructure_${family.replace(':','_')}`,{ok:true,at:now()});
  }
  function onStatus(event) {
    const family=String(event.family);
    const at=finite(event.at)??now();
    statuses.set(family,{...event,at});
    if(sourceHealth?.record){
      const source=`microstructure_${family.replace(':','_')}`;
      sourceHealth.record(source,{ok:Boolean(event.connected),at,reason:event.connected?null:String(event.reason??'disconnected')});
    }
  }

  for(const feed of feeds) {
    if(typeof feed?.setHandlers!=='function') throw new Error('feed_handlers_not_supported');
    feed.setHandlers({onTrade,onBook,onLiquidation,onStatus});
  }

  function expireDynamic() {
    const current=now();
    for(const [symbol,row] of [...active.entries()]) {
      if(row.core || row.expiresAt>current) continue;
      active.delete(symbol);
      for(const feed of feeds) { feed.removeSymbol?.(symbol); clearFamily(feed.family,symbol); coverage.delete(bufferKey(feed.family,symbol)); }
    }
  }

  async function ensureSymbols(values) {
    expireDynamic();
    const symbols=[...new Set(values.map(normalizeSymbol))];
    for(const symbol of symbols) {
      const existing=active.get(symbol);
      if(existing) { if(!existing.core) existing.expiresAt=now()+dynamicTtlMs; continue; }
      if(active.size>=maxActiveSymbols) throw new Error('watchlist_capacity_exceeded');
      active.set(symbol,{core:core.has(symbol),expiresAt:core.has(symbol)?Infinity:now()+dynamicTtlMs});
      await Promise.all(feeds.map(feed=>feed.ensureSymbol?.(symbol)));
    }
    return [...active.keys()];
  }

  async function start() {
    if(started) return; started=true;
    await Promise.all(feeds.map(feed=>feed.start?.()));
    if(core.size) await ensureSymbols([...core]);
  }
  function stop() { started=false; for(const feed of feeds) feed.stop?.(); }

  function familyCoverage(family,symbol) {
    const state=coverage.get(bufferKey(family,symbol));
    if(!state || state.state!=='healthy') return {state:'UNAVAILABLE',reason:state?.reason??'no_healthy_book',ageMs:state?Math.max(0,now()-state.lastTs):null,healthyForMs:0};
    const ageMs=Math.max(0,now()-state.lastTs);
    if(ageMs>freshnessMs) return {state:'UNAVAILABLE',reason:'stale',ageMs,healthyForMs:Math.max(0,now()-state.healthySince)};
    const healthyForMs=Math.max(0,now()-state.healthySince);
    if(healthyForMs<warmupMs) return {state:'WARMING_UP',reason:'warmup',ageMs,healthyForMs};
    return {state:'GOOD',reason:null,ageMs,healthyForMs};
  }

  function bucketsFor(family,symbol,bucketMs,lookbackMs) {
    const key=bufferKey(family,symbol); const start=now()-lookbackMs;
    const tradeRows=(trades.get(key)??[]).filter(x=>x.ts>=start&&x.ts<=now());
    const bookRows=(books.get(key)??[]).filter(x=>x.ts>=start&&x.ts<=now());
    const liqRows=(liquidations.get(key)??[]).filter(x=>x.ts>=start&&x.ts<=now());
    const byBucket=new Map();
    const getBucket=ts=>{
      const startTs=Math.floor(ts/bucketMs)*bucketMs;
      if(!byBucket.has(startTs)) byBucket.set(startTs,{timestamp:startTs,marketBuyQty:0,marketSellQty:0,marketBuyNotional:0,marketSellNotional:0,liquidationBuyNotional:0,liquidationSellNotional:0,bestBid:null,bestAsk:null,spread:null,bidDepth5bps:null,askDepth5bps:null,bidDepth10bps:null,askDepth10bps:null,_bookTs:-Infinity,_prices:[]});
      return byBucket.get(startTs);
    };
    for(const row of tradeRows) {
      const b=getBucket(row.ts); b._prices.push([row.ts,row.price]);
      if(row.aggressorSide==='buy'){b.marketBuyQty+=row.quantity;b.marketBuyNotional+=row.notional;}else{b.marketSellQty+=row.quantity;b.marketSellNotional+=row.notional;}
    }
    for(const row of bookRows) {
      const b=getBucket(row.ts); if(Number.isFinite(row.mid)) b._prices.push([row.ts,row.mid]);
      if(row.ts>=b._bookTs){b._bookTs=row.ts; for(const field of ['bestBid','bestAsk','spread','bidDepth5bps','askDepth5bps','bidDepth10bps','askDepth10bps']) b[field]=row[field];}
    }
    for(const row of liqRows) { const b=getBucket(row.ts); if(row.side==='buy')b.liquidationBuyNotional+=row.notional;else b.liquidationSellNotional+=row.notional; }
    return [...byBucket.values()].sort((a,b)=>a.timestamp-b.timestamp).map(b=>{
      const prices=b._prices.filter(([,p])=>Number.isFinite(p)).sort((a,c)=>a[0]-c[0]).map(([,p])=>p);
      const { _bookTs,_prices,...clean }=b;
      return {...clean,open:prices[0]??null,high:prices.length?Math.max(...prices):null,low:prices.length?Math.min(...prices):null,close:prices.at(-1)??null};
    });
  }

  function getNeutralBuckets(value,{bucketMs=1000,lookbackMs=60_000}={}) {
    expireDynamic(); const symbol=normalizeSymbol(value);
    if(!active.has(symbol)) throw new Error('symbol_not_watched');
    const families={};
    for(const feed of feeds) {
      const family=feed.family;
      const cov=familyCoverage(family,symbol);
      cov.observedDurationMs=Math.min(retentionMs,cov.healthyForMs);
      cov.fullWindowCovered=cov.state==='GOOD' && cov.observedDurationMs>=lookbackMs;
      cov.observedFrom=now()-cov.observedDurationMs;
      cov.observedTo=now();
      if(cov.state==='GOOD' && !cov.fullWindowCovered){cov.state='PARTIAL';cov.reason='incomplete_window';}
      families[family]={coverage:cov,buckets:cov.state==='UNAVAILABLE'?[]:bucketsFor(family,symbol,bucketMs,lookbackMs)};
    }
    return {symbol,capturedAt:now(),families};
  }

  function getStatus() {
    expireDynamic();
    return {started,activeSymbols:[...active.keys()],feeds:Object.fromEntries(feeds.map(feed=>[feed.family,feed.status?.()??statuses.get(feed.family)??null]))};
  }
  return {start,stop,ensureSymbols,getNeutralBuckets,getStatus};
}
