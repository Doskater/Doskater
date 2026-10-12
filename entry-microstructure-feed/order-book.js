function finiteLevel(level) {
  if (!Array.isArray(level) || level.length < 2) throw new Error('invalid_level');
  const price = Number(level[0]);
  const qty = Number(level[1]);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty < 0) throw new Error('invalid_level');
  return [price, qty];
}

function sortedEntries(map, side, maxLevels) {
  const entries = [...map.entries()].map(([price, qty]) => [Number(price), qty]);
  entries.sort((a, b) => side === 'bid' ? b[0] - a[0] : a[0] - b[0]);
  return entries.slice(0, maxLevels);
}

export function createOrderBook({ venue, market, symbol, maxLevels = 100 }) {
  const bids = new Map();
  const asks = new Map();
  let valid = false;
  let reason = 'uninitialized';
  let sequence = null;
  let lastEventTs = null;
  let lastReceiveTs = null;

  function invalidate(nextReason) {
    valid = false;
    reason = String(nextReason || 'invalid');
    return { ok: false, reason };
  }

  function top() {
    const bidRows = sortedEntries(bids, 'bid', maxLevels);
    const askRows = sortedEntries(asks, 'ask', maxLevels);
    const bestBid = bidRows[0]?.[0] ?? null;
    const bestAsk = askRows[0]?.[0] ?? null;
    return { bidRows, askRows, bestBid, bestAsk };
  }

  function validateCrossed() {
    const { bestBid, bestAsk } = top();
    if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) return invalidate('crossed_book');
    return { ok: true };
  }

  function applyLevels(target, levels) {
    for (const raw of levels ?? []) {
      const [price, qty] = finiteLevel(raw);
      if (qty === 0) target.delete(price);
      else target.set(price, qty);
    }
  }

  function reset(snapshot) {
    bids.clear();
    asks.clear();
    applyLevels(bids, snapshot?.bids ?? []);
    applyLevels(asks, snapshot?.asks ?? []);
    sequence = snapshot?.sequence ?? snapshot?.lastUpdateId ?? snapshot?.finalUpdateId ?? null;
    lastEventTs = snapshot?.eventTs ?? null;
    lastReceiveTs = snapshot?.receiveTs ?? null;
    valid = true;
    reason = null;
    const crossed = validateCrossed();
    if (!crossed.ok) return crossed;
    return { ok: true };
  }

  function apply(delta) {
    if (!valid) return { ok: false, reason: reason || 'book_invalid' };

    if (delta?.previousFinalUpdateId !== undefined && sequence !== null && delta.previousFinalUpdateId !== sequence) {
      return invalidate('sequence_gap_previous');
    }
    if (delta?.firstUpdateId !== undefined && delta?.finalUpdateId !== undefined && sequence !== null) {
      if (delta.finalUpdateId <= sequence) return { ok: true, stale: true };
      if (delta.firstUpdateId > sequence + 1) return invalidate('sequence_gap_first');
    }
    if (delta?.sequence !== undefined && sequence !== null && delta.sequence <= sequence) {
      return invalidate('sequence_regression');
    }

    applyLevels(bids, delta?.bids ?? []);
    applyLevels(asks, delta?.asks ?? []);
    if (delta?.finalUpdateId !== undefined) sequence = delta.finalUpdateId;
    else if (delta?.sequence !== undefined) sequence = delta.sequence;
    lastEventTs = delta?.eventTs ?? lastEventTs;
    lastReceiveTs = delta?.receiveTs ?? lastReceiveTs;

    const crossed = validateCrossed();
    if (!crossed.ok) return crossed;
    return { ok: true };
  }

  function snapshot() {
    const { bidRows, askRows, bestBid, bestAsk } = top();
    const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
    return {
      venue,
      market,
      symbol,
      healthy: valid,
      reason,
      sequence,
      lastEventTs,
      lastReceiveTs,
      bids: bidRows,
      asks: askRows,
      bestBid,
      bestAsk,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      mid
    };
  }

  function depthWithinBps(bps) {
    const snap = snapshot();
    if (!snap.healthy || snap.mid === null) return { healthy: false, reason: snap.reason };
    const fraction = Number(bps) / 10_000;
    if (!Number.isFinite(fraction) || fraction < 0) throw new Error('invalid_bps');
    const bidFloor = snap.mid * (1 - fraction);
    const askCeiling = snap.mid * (1 + fraction);
    const bidRows = snap.bids.filter(([price]) => price >= bidFloor);
    const askRows = snap.asks.filter(([price]) => price <= askCeiling);
    const sum = rows => ({ qty: rows.reduce((acc, [, qty]) => acc + qty, 0), notional: rows.reduce((acc, [price, qty]) => acc + price * qty, 0) });
    const bid = sum(bidRows);
    const ask = sum(askRows);
    return { healthy: true, bps, bidQty: bid.qty, askQty: ask.qty, bidNotional: bid.notional, askNotional: ask.notional };
  }

  function health() {
    return { valid, reason, lastEventTs, lastReceiveTs, sequence };
  }

  return { reset, apply, invalidate, snapshot, depthWithinBps, health };
}
