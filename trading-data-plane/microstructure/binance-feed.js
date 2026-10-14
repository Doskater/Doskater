import { attachSocketListener, decodeSocketJson, resolveWebSocketFactory, socketIsOpen } from './ws-utils.js';

const normalizeSymbol = value => String(value ?? '').trim().toUpperCase();
const finite = value => { const n = Number(value); return Number.isFinite(n) ? n : null; };
const levelRows = value => (Array.isArray(value) ? value : []).map(([p,q]) => [finite(p), finite(q)]).filter(([p,q]) => p > 0 && q >= 0);

export function createBinanceFeed({
  market = 'spot',
  websocketFactory,
  reconnect = true,
  logger = { warn() {}, error() {} },
  reconnectDelayMs = 1000
} = {}) {
  if (!['spot','perp'].includes(market)) throw new Error('invalid_binance_market');
  const family = `binance:${market}`;
  const endpoint = market === 'spot'
    ? 'wss://stream.binance.com:9443/stream'
    : 'wss://fstream.binance.com/stream';
  let handlers = {};
  let factory = websocketFactory;
  let socket = null;
  let starting = null;
  let stopped = true;
  let requestId = 1;
  let reconnectTimer = null;
  const desired = new Set();

  const status = () => ({ family, connected: socketIsOpen(socket), activeSymbols: desired.size, endpoint });
  const emitStatus = (extra = {}) => handlers.onStatus?.({ ...status(), ...extra, family });

  function streamParams(symbol) {
    const lower = symbol.toLowerCase();
    const params = [`${lower}@aggTrade`, `${lower}@depth20@100ms`];
    if (market === 'perp') params.push(`${lower}@forceOrder`);
    return params;
  }

  function sendSubscription(method, symbol) {
    if (!socketIsOpen(socket)) return;
    socket.send(JSON.stringify({ method, params: streamParams(symbol), id: requestId++ }));
  }

  function markDisconnected(reason) {
    for (const symbol of desired) handlers.onBook?.({ family, symbol, ts:Date.now(), state:'unhealthy', reason });
  }

  function handlePayload(raw) {
    const envelope = decodeSocketJson(raw);
    if (!envelope || typeof envelope !== 'object') return;
    const data = envelope.data ?? envelope;
    const stream = String(envelope.stream ?? '');
    if (data.e === 'aggTrade') {
      const symbol = normalizeSymbol(data.s || stream.split('@')[0]);
      const price = finite(data.p); const quantity = finite(data.q);
      if (!symbol || !Number.isFinite(price) || !Number.isFinite(quantity)) return;
      handlers.onTrade?.({ family, symbol, eventTs:finite(data.T ?? data.E) ?? Date.now(), price, quantity, notional:price*quantity, aggressorSide:data.m ? 'sell' : 'buy' });
      return;
    }
    if (data.e === 'forceOrder' && data.o) {
      const order = data.o; const symbol = normalizeSymbol(order.s || stream.split('@')[0]);
      const quantity = finite(order.z ?? order.q) ?? 0;
      const price = finite(order.ap ?? order.p) ?? 0;
      const side = String(order.S ?? '').toLowerCase();
      if (symbol && ['buy','sell'].includes(side)) handlers.onLiquidation?.({ family, symbol, eventTs:finite(order.T ?? data.E) ?? Date.now(), side, notional:price*quantity });
      return;
    }
    const isDepth = stream.includes('@depth') || 'lastUpdateId' in data || data.e === 'depthUpdate';
    if (isDepth) {
      const symbol = normalizeSymbol(data.s || stream.split('@')[0]);
      if (!symbol) return;
      handlers.onBook?.({
        family, symbol, ts:finite(data.E ?? data.T) ?? Date.now(), state:'healthy',
        sequence:finite(data.lastUpdateId ?? data.u),
        bids:levelRows(data.bids ?? data.b), asks:levelRows(data.asks ?? data.a)
      });
    }
  }

  async function connect() {
    if (stopped) return;
    if (!factory) factory = await resolveWebSocketFactory();
    const current = factory(endpoint);
    socket = current;
    attachSocketListener(current,'open',()=>{
      if (current !== socket) return;
      emitStatus({ connected:true });
      for (const symbol of desired) sendSubscription('SUBSCRIBE', symbol);
    });
    attachSocketListener(current,'message',handlePayload);
    attachSocketListener(current,'error',error=>{ logger.warn?.({event:'binance_ws_error',family,message:error?.message??String(error)}); });
    attachSocketListener(current,'close',()=>{
      if (current !== socket) return;
      socket = null; markDisconnected('disconnected'); emitStatus({connected:false});
      if (!stopped && reconnect) reconnectTimer = setTimeout(() => { connect().catch(error=>logger.error?.({event:'binance_ws_reconnect_failed',family,message:error?.message})); }, reconnectDelayMs);
    });
  }

  return {
    family,
    setHandlers(value={}) { handlers = value; },
    async start() {
      if (!stopped) return starting;
      stopped = false;
      starting = connect();
      return starting;
    },
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const current = socket; socket = null;
      current?.close?.();
    },
    async ensureSymbol(value) {
      const symbol = normalizeSymbol(value); if (!symbol) throw new Error('invalid_symbol');
      const added = !desired.has(symbol); desired.add(symbol);
      if (added) sendSubscription('SUBSCRIBE',symbol);
    },
    removeSymbol(value) {
      const symbol = normalizeSymbol(value); if (!desired.delete(symbol)) return;
      sendSubscription('UNSUBSCRIBE',symbol);
    },
    status
  };
}
