export function createTimedRingBuffer({ retentionMs, maxItems, now = Date.now }) {
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new Error('invalid_retention');
  if (!Number.isInteger(maxItems) || maxItems <= 0) throw new Error('invalid_max_items');
  let items = [];

  function prune() {
    const cutoff = now() - retentionMs;
    items = items.filter(item => item.ts >= cutoff);
    if (items.length > maxItems) items = items.slice(items.length - maxItems);
  }

  function push(event) {
    if (!event || !Number.isFinite(event.ts)) throw new Error('invalid_event_timestamp');
    items.push(event);
    items.sort((a, b) => a.ts - b.ts);
    prune();
  }

  function between(startMs, endMs) {
    return items.filter(item => item.ts >= startMs && item.ts <= endMs);
  }

  function since(startMs) {
    return items.filter(item => item.ts >= startMs);
  }

  return { push, prune, between, since, size: () => items.length };
}
