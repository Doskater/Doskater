import WebSocket from 'ws';
import { normalizeSymbol } from './config.js';
import { createOrderBook } from './order-book.js';
import { fromBinanceAggTrade, fromBinanceLiquidation, normalizeBookDelta } from './normalizers.js';

const FAMILIES = {
  spot: {
    wsUrl: 'wss://stream.binance.com:9443/ws',
    depthUrl: symbol => `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=1000`,
    streams: symbol => [`${symbol.toLowerCase()}@aggTrade`, `${symbol.toLowerCase()}@depth@100ms`]
  },
  perp: {
    wsUrl: 'wss://fstream.binance.com/ws',
    depthUrl: symbol => `https://fapi.binance.com/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=1000`,
    streams: symbol => [`${symbol.toLowerCase()}@aggTrade`, `${symbol.toLowerCase()}@depth@100ms`, `${symbol.toLowerCase()}@forceOrder`]
  }
};

export function createBinanceFeed({
  WebSocketImpl = WebSocket,
  fetchImpl = fetch,
  clock = Date,
  logger = { info() {}, warn() {}, error() {} },
  onTrade = () => {},
  onBookState = () => {},
  onLiquidation = () => {},
  onStatus = () => {},
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout
} = {}) {
  const watched = new Set();
  const sockets = new Map();
  const reconnectTimers = new Map();
  const attempts = new Map();
  const books = new Map();
  let requestId = 1;
  let stopped = true;

  const now = () => typeof clock.now === 'function' ? clock.now() : Date.now();
  const key = (family, symbol) => `${family}:${symbol}`;

  function familyState(family, symbol) {
    const k = key(family, symbol);
    if (!books.has(k)) {
      books.set(k, {
        book: createOrderBook({ venue: 'binance', market: family, symbol, maxLevels: 1000 }),
        loading: false,
        buffered: [],
        rebuildPromise: null,
        needsBridge: false
      });
    }
    return books.get(k);
  }

  function emitBook(family, symbol, stateOverride) {
    const state = familyState(family, symbol);
    const snap = state.book.snapshot();
    onBookState({
      venue: 'binance', market: family, symbol,
      state: stateOverride ?? (snap.healthy ? 'healthy' : 'WARMING_UP'),
      book: snap,
      ts: now()
    });
  }

  function sendSubscription(family, symbol, method) {
    const socket = sockets.get(family);
    if (!socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify({ method, params: FAMILIES[family].streams(symbol), id: requestId++ }));
  }

  function subscribeAll(family) {
    for (const symbol of watched) sendSubscription(family, symbol, 'SUBSCRIBE');
  }

  function scheduleReconnect(family) {
    if (stopped || reconnectTimers.has(family)) return;
    const attempt = (attempts.get(family) ?? 0) + 1;
    attempts.set(family, attempt);
    const delay = Math.min(30_000, 250 * 2 ** (attempt - 1));
    const timer = setTimeoutImpl(() => {
      reconnectTimers.delete(family);
      connectFamily(family);
    }, delay);
    reconnectTimers.set(family, timer);
    onStatus({ venue: 'binance', market: family, state: 'reconnecting', delayMs: delay, ts: now() });
  }

  function connectFamily(family) {
    if (stopped) return;
    const socket = new WebSocketImpl(FAMILIES[family].wsUrl);
    sockets.set(family, socket);
    onStatus({ venue: 'binance', market: family, state: 'connecting', ts: now() });
    socket.on('open', () => {
      attempts.set(family, 0);
      onStatus({ venue: 'binance', market: family, state: 'connected', ts: now() });
      subscribeAll(family);
    });
    socket.on('message', data => handleMessage(family, data));
    socket.on('error', error => logger.warn?.({ event: 'binance_socket_error', family, message: error?.message }));
    socket.on('close', () => {
      if (sockets.get(family) === socket) sockets.delete(family);
      for (const symbol of watched) {
        familyState(family, symbol).book.invalidate('socket_disconnected');
        emitBook(family, symbol, 'WARMING_UP');
      }
      onStatus({ venue: 'binance', market: family, state: 'disconnected', ts: now() });
      scheduleReconnect(family);
    });
  }

  async function fetchSnapshot(family, symbol) {
    const response = await fetchImpl(FAMILIES[family].depthUrl(symbol));
    if (!response?.ok) throw new Error(`binance_snapshot_http_${response?.status ?? 'error'}`);
    const json = await response.json();
    if (!Number.isInteger(Number(json.lastUpdateId)) || !Array.isArray(json.bids) || !Array.isArray(json.asks)) throw new Error('invalid_binance_snapshot');
    return json;
  }

  async function rebuildBook(family, symbol) {
    const state = familyState(family, symbol);
    if (state.rebuildPromise) return state.rebuildPromise;
    state.loading = true;
    state.book.invalidate('warming_up');
    emitBook(family, symbol, 'WARMING_UP');
    state.rebuildPromise = (async () => {
      try {
        const snapshot = await fetchSnapshot(family, symbol);
        state.book.reset({
          bids: snapshot.bids,
          asks: snapshot.asks,
          sequence: Number(snapshot.lastUpdateId),
          eventTs: Number(snapshot.E ?? snapshot.T ?? now()),
          receiveTs: now()
        });
        state.needsBridge = true;
        const buffered = state.buffered.sort((a, b) => (a.finalUpdateId ?? a.sequence ?? 0) - (b.finalUpdateId ?? b.sequence ?? 0));
        state.buffered = [];
        for (const delta of buffered) {
          const applied = applyDepthEvent(family, state, delta);
          if (!applied.ok) throw new Error(applied.reason || 'buffered_depth_invalid');
        }
        state.loading = false;
        emitBook(family, symbol, state.book.health().valid && !state.needsBridge ? 'healthy' : 'WARMING_UP');
      } catch (error) {
        state.loading = false;
        state.book.invalidate(error?.message || 'snapshot_rebuild_failed');
        emitBook(family, symbol, 'WARMING_UP');
        logger.warn?.({ event: 'binance_book_rebuild_failed', family, symbol, message: error?.message });
      } finally {
        state.rebuildPromise = null;
      }
    })();
    return state.rebuildPromise;
  }

  function applyDepthEvent(family, state, delta) {
    const sequence = state.book.health().sequence;
    if (state.needsBridge && sequence !== null && delta.finalUpdateId !== undefined) {
      if (delta.finalUpdateId < sequence) return { ok: true, stale: true };
      const target = family === 'perp' ? sequence : sequence + 1;
      if (delta.finalUpdateId < target) return { ok: true, stale: true };
      if (delta.firstUpdateId !== undefined && delta.firstUpdateId > target) {
        return { ok: false, reason: 'sequence_gap_bridge' };
      }
      state.needsBridge = false;
      if (delta.finalUpdateId === sequence) return { ok: true, stale: true };
      const bridge = { ...delta };
      delete bridge.previousFinalUpdateId;
      return state.book.apply(bridge);
    }
    if (family === 'perp') {
      if (sequence !== null && delta.finalUpdateId !== undefined && delta.finalUpdateId <= sequence) return { ok: true, stale: true };
      const continuation = { ...delta };
      delete continuation.firstUpdateId;
      return state.book.apply(continuation);
    }
    return state.book.apply(delta);
  }

  function parseDepth(family, message) {
    return normalizeBookDelta({
      venue: 'binance', market: family, symbol: message.s,
      eventTs: message.E ?? now(), receiveTs: now(),
      bids: message.b ?? [], asks: message.a ?? [],
      firstUpdateId: message.U, finalUpdateId: message.u,
      previousFinalUpdateId: message.pu
    });
  }

  function handleMessage(family, raw) {
    let message;
    try {
      message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
      if (message?.data && message?.stream) message = message.data;
    } catch { return; }
    if (!message?.e) return;
    if (message.e === 'aggTrade') {
      try { onTrade(fromBinanceAggTrade(message, { market: family, receiveTs: now() })); } catch (error) { logger.warn?.({ event: 'binance_trade_parse_error', family, message: error.message }); }
      return;
    }
    if (message.e === 'forceOrder' && family === 'perp') {
      try { onLiquidation(fromBinanceLiquidation(message, { receiveTs: now() })); } catch (error) { logger.warn?.({ event: 'binance_liquidation_parse_error', message: error.message }); }
      return;
    }
    if (message.e === 'depthUpdate') {
      let delta;
      try { delta = parseDepth(family, message); } catch (error) { logger.warn?.({ event: 'binance_depth_parse_error', family, message: error.message }); return; }
      const symbol = delta.symbol;
      if (!watched.has(symbol)) return;
      const state = familyState(family, symbol);
      if (state.loading) {
        state.buffered.push(delta);
        return;
      }
      const result = applyDepthEvent(family, state, delta);
      if (!result.ok) {
        emitBook(family, symbol, 'WARMING_UP');
        void rebuildBook(family, symbol);
      } else if (!result.stale) emitBook(family, symbol, 'healthy');
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    connectFamily('spot');
    connectFamily('perp');
  }

  function stop() {
    stopped = true;
    for (const timer of reconnectTimers.values()) clearTimeoutImpl(timer);
    reconnectTimers.clear();
    for (const socket of sockets.values()) {
      try { socket.close(); } catch {}
    }
    sockets.clear();
  }

  async function ensureSymbol(value) {
    const symbol = normalizeSymbol(value);
    const isNew = !watched.has(symbol);
    watched.add(symbol);
    familyState('spot', symbol);
    familyState('perp', symbol);
    if (isNew) {
      sendSubscription('spot', symbol, 'SUBSCRIBE');
      sendSubscription('perp', symbol, 'SUBSCRIBE');
    }
    await Promise.all([rebuildBook('spot', symbol), rebuildBook('perp', symbol)]);
    return status();
  }

  function removeSymbol(value) {
    const symbol = normalizeSymbol(value);
    if (!watched.has(symbol)) return;
    sendSubscription('spot', symbol, 'UNSUBSCRIBE');
    sendSubscription('perp', symbol, 'UNSUBSCRIBE');
    watched.delete(symbol);
    books.delete(key('spot', symbol));
    books.delete(key('perp', symbol));
  }

  function status() {
    const connection = {};
    for (const family of Object.keys(FAMILIES)) {
      const socket = sockets.get(family);
      connection[family] = socket?.readyState === 1 ? 'connected' : socket ? 'connecting' : 'disconnected';
    }
    const bookStates = {};
    for (const [k, value] of books) bookStates[k] = value.book.health();
    return { venue: 'binance', connection, watched: [...watched], books: bookStates };
  }

  function setHandlers(next = {}) {
    if (typeof next.onTrade === 'function') onTrade = next.onTrade;
    if (typeof next.onBookState === 'function') onBookState = next.onBookState;
    if (typeof next.onLiquidation === 'function') onLiquidation = next.onLiquidation;
    if (typeof next.onStatus === 'function') onStatus = next.onStatus;
  }

  return { start, stop, ensureSymbol, removeSymbol, status, setHandlers };
}
