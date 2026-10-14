import { attachSocketListener, decodeSocketJson, resolveWebSocketFactory, socketIsOpen } from './ws-utils.js';

const normalizeSymbol = value => String(value ?? '').trim().toUpperCase();
const finite = value => { const n = Number(value); return Number.isFinite(n) ? n : null; };
const sortLevels = (map, descending) => [...map.entries()].map(([p,q])=>[Number(p),Number(q)]).sort((a,b)=>descending ? b[0]-a[0] : a[0]-b[0]);

export function createBybitFeed({
  market = 'linear',
  websocketFactory,
  reconnect = true,
  logger = { warn() {}, error() {} },
  reconnectDelayMs = 1000,
  heartbeatIntervalMs = 20_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
} = {}) {
  if (!['spot','linear'].includes(market)) throw new Error('invalid_bybit_market');
  const family = `bybit:${market}`;
  const endpoint = `wss://stream.bybit.com/v5/public/${market}`;
  let handlers={}; let factory=websocketFactory; let socket=null; let stopped=true; let reconnectTimer=null; let heartbeatTimer=null;
  const desired=new Set(); const books=new Map();
  const status=()=>({family,connected:socketIsOpen(socket),activeSymbols:desired.size,endpoint});
  const emitStatus=(extra={})=>handlers.onStatus?.({...status(),...extra,family});
  const stopHeartbeat=()=>{ if(heartbeatTimer!==null) clearIntervalImpl(heartbeatTimer); heartbeatTimer=null; };
  const startHeartbeat=()=>{ stopHeartbeat(); heartbeatTimer=setIntervalImpl(()=>{ if(socketIsOpen(socket)) socket.send(JSON.stringify({op:'ping'})); },heartbeatIntervalMs); heartbeatTimer?.unref?.(); };

  function argsFor(symbol) {
    const args=[`orderbook.50.${symbol}`,`publicTrade.${symbol}`];
    if (market==='linear') args.push(`allLiquidation.${symbol}`);
    return args;
  }
  function send(op,symbol){ if(socketIsOpen(socket)) socket.send(JSON.stringify({op,args:argsFor(symbol)})); }
  function invalidate(symbol,reason,ts=Date.now(),sequence=null){ books.delete(symbol); handlers.onBook?.({family,symbol,ts,state:'unhealthy',reason,sequence}); }
  function markDisconnected(reason){ for(const symbol of desired) invalidate(symbol,reason); }
  function apply(levelMap, rows) {
    for (const [priceRaw,sizeRaw] of Array.isArray(rows)?rows:[]) {
      const price=finite(priceRaw); const size=finite(sizeRaw);
      if (!Number.isFinite(price)||!Number.isFinite(size)) continue;
      const key=String(priceRaw);
      if (size===0) levelMap.delete(key); else levelMap.set(key,size);
    }
  }
  function emitBook(symbol, state, ts) {
    handlers.onBook?.({family,symbol,ts,state:'healthy',sequence:state.seq,bids:sortLevels(state.bids,true),asks:sortLevels(state.asks,false)});
  }

  function handleOrderBook(message) {
    const data=message.data??{}; const symbol=normalizeSymbol(data.s); const ts=finite(message.cts ?? message.ts) ?? Date.now();
    if(!symbol) return;
    const updateId=finite(data.u); const seq=finite(data.seq);
    if(message.type==='snapshot' || updateId===1) {
      const state={bids:new Map(),asks:new Map(),u:updateId,seq}; apply(state.bids,data.b); apply(state.asks,data.a); books.set(symbol,state); emitBook(symbol,state,ts); return;
    }
    const state=books.get(symbol);
    if(!state){ invalidate(symbol,'delta_without_snapshot',ts,seq); return; }
    // Bybit publishes batched deltas; update IDs need not be consecutive.
    if(Number.isFinite(state.u)&&Number.isFinite(updateId)&&updateId<=state.u) return;
    if(Number.isFinite(state.seq)&&Number.isFinite(seq)&&seq<state.seq) return;
    apply(state.bids,data.b); apply(state.asks,data.a); state.u=updateId; state.seq=seq; emitBook(symbol,state,ts);
  }

  function handlePayload(raw) {
    const message=decodeSocketJson(raw); if(!message||typeof message!=='object'||!message.topic) return;
    const topic=String(message.topic);
    if(topic.startsWith('orderbook.')) { handleOrderBook(message); return; }
    if(topic.startsWith('publicTrade.')) {
      for(const row of Array.isArray(message.data)?message.data:[]) {
        const symbol=normalizeSymbol(row.s); const price=finite(row.p); const quantity=finite(row.v); const side=String(row.S??'').toLowerCase();
        if(symbol&&Number.isFinite(price)&&Number.isFinite(quantity)&&['buy','sell'].includes(side)) handlers.onTrade?.({family,symbol,eventTs:finite(row.T)??finite(message.ts)??Date.now(),price,quantity,notional:price*quantity,aggressorSide:side});
      }
      return;
    }
    if(topic.startsWith('allLiquidation.')) {
      for(const row of Array.isArray(message.data)?message.data:[]) {
        const symbol=normalizeSymbol(row.s); const price=finite(row.p); const quantity=finite(row.v); const positionSide=String(row.S??'').toLowerCase();
        const forcedSide=positionSide==='buy'?'sell':positionSide==='sell'?'buy':null;
        if(symbol&&forcedSide&&Number.isFinite(price)&&Number.isFinite(quantity)) handlers.onLiquidation?.({family,symbol,eventTs:finite(row.T)??finite(message.ts)??Date.now(),side:forcedSide,notional:price*quantity});
      }
    }
  }

  async function connect(){
    if(stopped)return;
    if(!factory) factory=await resolveWebSocketFactory();
    const current=factory(endpoint); socket=current;
    attachSocketListener(current,'open',()=>{if(current!==socket)return;startHeartbeat();emitStatus({connected:true});for(const symbol of desired)send('subscribe',symbol);});
    attachSocketListener(current,'message',handlePayload);
    attachSocketListener(current,'error',error=>logger.warn?.({event:'bybit_ws_error',family,message:error?.message??String(error)}));
    attachSocketListener(current,'close',()=>{if(current!==socket)return;stopHeartbeat();socket=null;books.clear();markDisconnected('disconnected');emitStatus({connected:false});if(!stopped&&reconnect)reconnectTimer=setTimeout(()=>{connect().catch(error=>logger.error?.({event:'bybit_ws_reconnect_failed',family,message:error?.message}));},reconnectDelayMs);});
  }

  return {
    family,
    setHandlers(value={}){handlers=value;},
    async start(){if(!stopped)return;stopped=false;await connect();},
    stop(){stopped=true;stopHeartbeat();if(reconnectTimer)clearTimeout(reconnectTimer);reconnectTimer=null;const current=socket;socket=null;current?.close?.();},
    async ensureSymbol(value){const symbol=normalizeSymbol(value);if(!symbol)throw new Error('invalid_symbol');const added=!desired.has(symbol);desired.add(symbol);if(added)send('subscribe',symbol);},
    removeSymbol(value){const symbol=normalizeSymbol(value);if(!desired.delete(symbol))return;books.delete(symbol);send('unsubscribe',symbol);},
    status
  };
}
