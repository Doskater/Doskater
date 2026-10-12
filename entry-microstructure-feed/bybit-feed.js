import WebSocket from 'ws';
import { normalizeSymbol } from './config.js';
import { createOrderBook } from './order-book.js';
import { fromBybitPublicTrade, fromBybitLiquidation, normalizeBookDelta } from './normalizers.js';

const FAMILIES = {
  spot: { url: 'wss://stream.bybit.com/v5/public/spot' },
  linear: { url: 'wss://stream.bybit.com/v5/public/linear' }
};

export function createBybitFeed({
  WebSocketImpl = WebSocket,
  clock = Date,
  logger = { info() {}, warn() {}, error() {} },
  onTrade = () => {},
  onBookState = () => {},
  onLiquidation = () => {},
  onStatus = () => {},
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  staleAfterMs = 30_000
} = {}) {
  const watched = new Set();
  const sockets = new Map();
  const books = new Map();
  const lastMessage = new Map();
  const reconnectTimers = new Map();
  const attempts = new Map();
  let heartbeatTimer = null;
  let stopped = true;
  let requestId = 1;

  const now = () => typeof clock.now === 'function' ? clock.now() : Date.now();
  const key = (family, symbol) => `${family}:${symbol}`;

  function stateFor(family, symbol) {
    const k = key(family, symbol);
    if (!books.has(k)) books.set(k, { book: createOrderBook({ venue: 'bybit', market: family, symbol, maxLevels: 200 }) });
    return books.get(k);
  }

  function emitBook(family, symbol, stateOverride) {
    const snap = stateFor(family, symbol).book.snapshot();
    onBookState({ venue: 'bybit', market: family, symbol, state: stateOverride ?? (snap.healthy ? 'healthy' : 'WARMING_UP'), book: snap, ts: now() });
  }

  function topics(family, symbol) {
    const result = [`publicTrade.${symbol}`, `orderbook.50.${symbol}`];
    if (family === 'linear') result.push(`allLiquidation.${symbol}`);
    return result;
  }

  function sendSubscription(family, symbol, op) {
    const socket = sockets.get(family);
    if (!socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify({ op, req_id: String(requestId++), args: topics(family, symbol) }));
  }

  function subscribeAll(family) {
    for (const symbol of watched) sendSubscription(family, symbol, 'subscribe');
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
    onStatus({ venue: 'bybit', market: family, state: 'reconnecting', delayMs: delay, ts: now() });
  }

  function connectFamily(family) {
    if (stopped) return;
    const socket = new WebSocketImpl(FAMILIES[family].url);
    sockets.set(family, socket);
    lastMessage.set(family, now());
    onStatus({ venue: 'bybit', market: family, state: 'connecting', ts: now() });
    socket.on('open', () => {
      attempts.set(family, 0);
      lastMessage.set(family, now());
      onStatus({ venue: 'bybit', market: family, state: 'connected', ts: now() });
      subscribeAll(family);
    });
    socket.on('message', raw => handleMessage(family, raw));
    socket.on('error', error => logger.warn?.({ event: 'bybit_socket_error', family, message: error?.message }));
    socket.on('close', () => {
      if (sockets.get(family) === socket) sockets.delete(family);
      for (const symbol of watched) {
        stateFor(family, symbol).book.invalidate('socket_disconnected');
        emitBook(family, symbol, 'WARMING_UP');
      }
      onStatus({ venue: 'bybit', market: family, state: 'disconnected', ts: now() });
      scheduleReconnect(family);
    });
  }

  function handleBook(family, message) {
    const data = message?.data;
    const symbol = data?.s ? normalizeSymbol(data.s) : null;
    if (!symbol || !watched.has(symbol)) return;
    const state = stateFor(family, symbol);
    if (message.type === 'snapshot') {
      state.book.reset({
        bids: data.b ?? [], asks: data.a ?? [],
        sequence: Number(data.seq ?? data.u),
        eventTs: Number(message.cts ?? message.ts ?? now()),
        receiveTs: now()
      });
      emitBook(family, symbol, state.book.health().valid ? 'healthy' : 'WARMING_UP');
      return;
    }
    if (message.type === 'delta') {
      const delta = normalizeBookDelta({
        venue: 'bybit', market: family, symbol,
        eventTs: Number(message.cts ?? message.ts ?? now()), receiveTs: now(),
        bids: data.b ?? [], asks: data.a ?? [], sequence: data.seq
      });
      const result = state.book.apply(delta);
      if (!result.ok) emitBook(family, symbol, 'WARMING_UP');
      else emitBook(family, symbol, 'healthy');
    }
  }

  function handleMessage(family, raw) {
    let message;
    try { message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); }
    catch { return; }
    lastMessage.set(family, now());
    if (message?.op === 'pong' || message?.ret_msg === 'pong') return;
    const topic = String(message?.topic ?? '');
    if (topic.startsWith('publicTrade.')) {
      for (const row of message.data ?? []) {
        try { onTrade(fromBybitPublicTrade(row, { market: family, receiveTs: now() })); }
        catch (error) { logger.warn?.({ event: 'bybit_trade_parse_error', family, message: error.message }); }
      }
      return;
    }
    if (topic.startsWith('allLiquidation.') && family === 'linear') {
      for (const row of message.data ?? []) {
        try { onLiquidation(fromBybitLiquidation(row, { receiveTs: now() })); }
        catch (error) { logger.warn?.({ event: 'bybit_liquidation_parse_error', message: error.message }); }
      }
      return;
    }
    if (topic.startsWith('orderbook.')) {
      try { handleBook(family, message); }
      catch (error) { logger.warn?.({ event: 'bybit_book_parse_error', family, message: error.message }); }
    }
  }

  function heartbeatTick() {
    const current = now();
    for (const family of Object.keys(FAMILIES)) {
      const socket = sockets.get(family);
      if (!socket || socket.readyState !== 1) continue;
      const age = current - (lastMessage.get(family) ?? current);
      if (age > staleAfterMs) {
        for (const symbol of watched) {
          stateFor(family, symbol).book.invalidate('stale_stream');
          emitBook(family, symbol, 'WARMING_UP');
        }
        try { socket.close(); } catch {}
        continue;
      }
      try { socket.send(JSON.stringify({ op: 'ping' })); } catch {}
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    connectFamily('spot');
    connectFamily('linear');
    heartbeatTimer = setIntervalImpl(heartbeatTick, 5_000);
  }

  function stop() {
    stopped = true;
    if (heartbeatTimer !== null) clearIntervalImpl(heartbeatTimer);
    heartbeatTimer = null;
    for (const timer of reconnectTimers.values()) clearTimeoutImpl(timer);
    reconnectTimers.clear();
    for (const socket of sockets.values()) {
      try { socket.close(); } catch {}
    }
    sockets.clear();
  }

  function ensureSymbol(value) {
    const symbol = normalizeSymbol(value);
    const isNew = !watched.has(symbol);
    watched.add(symbol);
    for (const family of Object.keys(FAMILIES)) {
      const state = stateFor(family, symbol);
      if (!state.book.health().valid) emitBook(family, symbol, 'WARMING_UP');
      if (isNew) sendSubscription(family, symbol, 'subscribe');
    }
    return status();
  }

  function removeSymbol(value) {
    const symbol = normalizeSymbol(value);
    if (!watched.has(symbol)) return;
    for (const family of Object.keys(FAMILIES)) sendSubscription(family, symbol, 'unsubscribe');
    watched.delete(symbol);
    books.delete(key('spot', symbol));
    books.delete(key('linear', symbol));
  }

  function status() {
    const connection = {};
    for (const family of Object.keys(FAMILIES)) {
      const socket = sockets.get(family);
      connection[family] = socket?.readyState === 1 ? 'connected' : socket ? 'connecting' : 'disconnected';
    }
    const bookStates = {};
    for (const [k, value] of books) bookStates[k] = value.book.health();
    return { venue: 'bybit', connection, watched: [...watched], books: bookStates, lastMessage: Object.fromEntries(lastMessage) };
  }

  function setHandlers(next = {}) {
    if (typeof next.onTrade === 'function') onTrade = next.onTrade;
    if (typeof next.onBookState === 'function') onBookState = next.onBookState;
    if (typeof next.onLiquidation === 'function') onLiquidation = next.onLiquidation;
    if (typeof next.onStatus === 'function') onStatus = next.onStatus;
  }

  return { start, stop, ensureSymbol, removeSymbol, status, setHandlers };
}
