import { CORE_SYMBOLS, MAX_ACTIVE_SYMBOLS, DYNAMIC_TTL_MS, normalizeSymbol } from './config.js';

export function createWatchlist({
  coreSymbols = CORE_SYMBOLS,
  maxActive = MAX_ACTIVE_SYMBOLS,
  dynamicTtlMs = DYNAMIC_TTL_MS,
  now = Date.now,
  onAdd = () => {},
  onRemove = () => {}
} = {}) {
  const entries = new Map();
  const normalizedCore = coreSymbols.map(normalizeSymbol);
  if (normalizedCore.length > maxActive) throw new Error('watchlist_capacity_exceeded');

  for (const symbol of normalizedCore) {
    entries.set(symbol, { symbol, core: true, lastTouched: now() });
    onAdd(symbol);
  }

  function list() {
    return [...entries.values()].map(entry => ({ ...entry }));
  }

  function ensure(symbols = []) {
    if (!Array.isArray(symbols)) throw new Error('invalid_symbols');
    const normalized = [...new Set(symbols.map(normalizeSymbol))];
    const newSymbols = normalized.filter(symbol => !entries.has(symbol));
    if (entries.size + newSymbols.length > maxActive) throw new Error('watchlist_capacity_exceeded');
    const touchedAt = now();
    for (const symbol of normalized) {
      const existing = entries.get(symbol);
      if (existing) existing.lastTouched = touchedAt;
      else {
        entries.set(symbol, { symbol, core: false, lastTouched: touchedAt });
        onAdd(symbol);
      }
    }
    return list();
  }

  function touch(value) {
    const symbol = normalizeSymbol(value);
    const entry = entries.get(symbol);
    if (!entry) throw new Error('symbol_not_watched');
    entry.lastTouched = now();
    return { ...entry };
  }

  function expire() {
    const cutoff = now() - dynamicTtlMs;
    const removed = [];
    for (const [symbol, entry] of entries) {
      if (!entry.core && entry.lastTouched <= cutoff) {
        entries.delete(symbol);
        removed.push(symbol);
        onRemove(symbol);
      }
    }
    return removed;
  }

  return { ensure, touch, expire, list };
}
