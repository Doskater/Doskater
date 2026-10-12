export const RUNTIME_STATES = Object.freeze(['FULL_EVENT_STREAM', 'WARMING_UP', 'PARTIAL', 'UNAVAILABLE']);
export const CORE_SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
export const MAX_ACTIVE_SYMBOLS = 12;
export const DYNAMIC_TTL_MS = 20 * 60 * 1000;
export const WINDOW_MS = Object.freeze([1000, 5000, 30000, 60000]);

const SYMBOL_RE = /^[A-Z0-9]{2,30}USDT$/;

export function isSupportedSymbol(value) {
  if (typeof value !== 'string') return false;
  const symbol = value.trim().toUpperCase();
  return SYMBOL_RE.test(symbol);
}

export function normalizeSymbol(value) {
  if (!isSupportedSymbol(value)) throw new Error('invalid_symbol');
  return value.trim().toUpperCase();
}
