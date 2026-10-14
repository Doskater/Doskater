export async function resolveWebSocketFactory(customFactory) {
  if (typeof customFactory === 'function') return customFactory;
  if (typeof globalThis.WebSocket === 'function') return url => new globalThis.WebSocket(url);
  const mod = await import('ws');
  const WebSocketImpl = mod.WebSocket ?? mod.default;
  return url => new WebSocketImpl(url);
}

export function attachSocketListener(socket, name, handler) {
  if (typeof socket?.on === 'function') {
    socket.on(name, handler);
    return;
  }
  if (typeof socket?.addEventListener === 'function') {
    socket.addEventListener(name, event => handler(name === 'message' ? event.data : event));
    return;
  }
  throw new Error('websocket_listener_api_unsupported');
}

export function socketIsOpen(socket) {
  return Boolean(socket) && socket.readyState === 1;
}

export function decodeSocketJson(raw) {
  if (raw == null) return null;
  const text = typeof raw === 'string'
    ? raw
    : Buffer.isBuffer(raw)
      ? raw.toString('utf8')
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw).toString('utf8')
        : ArrayBuffer.isView(raw)
          ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
          : String(raw);
  try { return JSON.parse(text); }
  catch { return null; }
}
