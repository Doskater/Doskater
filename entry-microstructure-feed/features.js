function sum(values) {
  return values.reduce((acc, value) => acc + value, 0);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function eventTs(event) {
  return Number(event?.eventTs ?? event?.ts);
}

function healthySamples(samples) {
  return Array.isArray(samples) && samples.length >= 2 && samples.every(sample => sample?.healthy !== false);
}

function nearestBefore(series, ts) {
  let found = null;
  for (const point of series ?? []) {
    if (Number(point.ts) <= ts && (!found || point.ts >= found.ts)) found = point;
  }
  return found;
}

function nearestAfter(series, ts) {
  let found = null;
  for (const point of series ?? []) {
    if (Number(point.ts) >= ts && (!found || point.ts <= found.ts)) found = point;
  }
  return found;
}

export function computeAggressorImbalance(events = [], { minNotional = 0 } = {}) {
  const buyNotional = sum(events.filter(e => e.side === 'buy').map(e => Number(e.notional) || 0));
  const sellNotional = sum(events.filter(e => e.side === 'sell').map(e => Number(e.notional) || 0));
  const totalNotional = buyNotional + sellNotional;
  const imbalance = totalNotional > 0 ? (buyNotional - sellNotional) / totalNotional : 0;
  return {
    buyNotional,
    sellNotional,
    totalNotional,
    imbalance,
    sampleCount: events.length,
    quality: totalNotional < minNotional ? 'low_volume' : 'ok'
  };
}

function refillForSide(samples, field) {
  const initial = Number(samples[0][field]);
  if (!Number.isFinite(initial) || initial <= 0) return { refillRatio: null, halfLifeMs: null, persistence: null };
  let minIndex = 0;
  for (let i = 1; i < samples.length; i++) {
    if (Number(samples[i][field]) < Number(samples[minIndex][field])) minIndex = i;
  }
  const minimum = Number(samples[minIndex][field]);
  const final = Number(samples.at(-1)[field]);
  const depletion = Math.max(0, initial - minimum);
  if (depletion === 0) return { refillRatio: 0, halfLifeMs: null, persistence: final / initial };
  const refill = Math.max(0, final - minimum);
  const target = minimum + depletion * 0.5;
  let halfLifeMs = null;
  for (let i = minIndex + 1; i < samples.length; i++) {
    if (Number(samples[i][field]) >= target) {
      halfLifeMs = Number(samples[i].ts) - Number(samples[minIndex].ts);
      break;
    }
  }
  return {
    refillRatio: clamp01(refill / depletion),
    halfLifeMs,
    persistence: final / initial,
    initial,
    minimum,
    final
  };
}

export function computeRefill(samples = []) {
  if (!healthySamples(samples)) {
    return {
      bid: { refillRatio: null, halfLifeMs: null, persistence: null },
      ask: { refillRatio: null, halfLifeMs: null, persistence: null },
      absorptionDirection: 'unknown',
      quality: 'invalid_book'
    };
  }
  const bid = refillForSide(samples, 'bidNotional');
  const ask = refillForSide(samples, 'askNotional');
  let absorptionDirection = 'neutral';
  if (bid.refillRatio >= 0.6 && ask.refillRatio < 0.4) absorptionDirection = 'buy';
  else if (ask.refillRatio >= 0.6 && bid.refillRatio < 0.4) absorptionDirection = 'sell';
  return { bid, ask, absorptionDirection, quality: 'ok' };
}

export function computeLiquidityVoid(samples = [], trades = []) {
  if (!healthySamples(samples)) {
    return { upVoidScore: null, downVoidScore: null, aggressorConfirmation: null, spreadExpansion: null, quality: 'invalid_book' };
  }
  const first = samples[0];
  const last = samples.at(-1);
  const askInitial = Math.max(Number(first.askNotional) || 0, 1);
  const bidInitial = Math.max(Number(first.bidNotional) || 0, 1);
  const askRemoved = Math.max(0, askInitial - (Number(last.askNotional) || 0));
  const bidRemoved = Math.max(0, bidInitial - (Number(last.bidNotional) || 0));
  const buyAggressor = sum(trades.filter(e => e.side === 'buy').map(e => Number(e.notional) || 0));
  const sellAggressor = sum(trades.filter(e => e.side === 'sell').map(e => Number(e.notional) || 0));
  const upVoidScore = clamp01(Math.max(0, askRemoved - buyAggressor) / askInitial);
  const downVoidScore = clamp01(Math.max(0, bidRemoved - sellAggressor) / bidInitial);
  const initialSpread = Number(first.spread) || 0;
  const finalSpread = Number(last.spread) || initialSpread;
  const spreadExpansion = initialSpread > 0 ? (finalSpread - initialSpread) / initialSpread : 0;
  return {
    upVoidScore,
    downVoidScore,
    aggressorConfirmation: { buyNotional: buyAggressor, sellNotional: sellAggressor },
    spreadExpansion,
    quality: 'ok'
  };
}

function impactForSide(trades, mids, side, standardNotional, minNotional) {
  const sideTrades = trades.filter(t => t.side === side).sort((a, b) => eventTs(a) - eventTs(b));
  const notional = sum(sideTrades.map(t => Number(t.notional) || 0));
  if (!sideTrades.length || notional <= 0) return { notional, bps: 0, bpsPerStandardNotional: 0, quality: 'unavailable' };
  const start = nearestBefore(mids, eventTs(sideTrades[0]));
  const end = nearestAfter(mids, eventTs(sideTrades.at(-1)));
  if (!start || !end || !Number.isFinite(Number(start.mid)) || !Number.isFinite(Number(end.mid)) || Number(start.mid) <= 0) {
    return { notional, bps: 0, bpsPerStandardNotional: 0, quality: 'unavailable' };
  }
  const raw = ((Number(end.mid) - Number(start.mid)) / Number(start.mid)) * 10_000;
  const bps = side === 'buy' ? Math.max(0, raw) : Math.max(0, -raw);
  return {
    notional,
    bps,
    bpsPerStandardNotional: notional > 0 ? bps * (standardNotional / notional) : 0,
    quality: notional < minNotional ? 'low_volume' : 'ok'
  };
}

export function computePriceImpact(trades = [], mids = [], { standardNotional = 100_000, minNotional = 1_000 } = {}) {
  const buy = impactForSide(trades, mids, 'buy', standardNotional, minNotional);
  const sell = impactForSide(trades, mids, 'sell', standardNotional, minNotional);
  const qualities = [buy.quality, sell.quality];
  const quality = qualities.every(q => q === 'ok') ? 'ok' : qualities.includes('low_volume') ? 'low_volume' : 'partial';
  return { buy, sell, standardNotional, quality };
}

export function computeImpactAsymmetry(impact) {
  if (!impact || impact.quality === 'unavailable') return { direction: 'unavailable', ratio: null, quality: 'unavailable' };
  const buy = Number(impact.buy?.bpsPerStandardNotional) || 0;
  const sell = Number(impact.sell?.bpsPerStandardNotional) || 0;
  if (buy === 0 && sell === 0) return { direction: 'balanced', ratio: 1, quality: impact.quality ?? 'partial' };
  if (buy > sell * 1.5) return { direction: 'buy_more_efficient', ratio: sell > 0 ? buy / sell : Infinity, quality: impact.quality ?? 'ok' };
  if (sell > buy * 1.5) return { direction: 'sell_more_efficient', ratio: buy > 0 ? sell / buy : Infinity, quality: impact.quality ?? 'ok' };
  return { direction: 'balanced', ratio: buy && sell ? Math.max(buy, sell) / Math.min(buy, sell) : 1, quality: impact.quality ?? 'ok' };
}

export function computeLiquidationResponse(liquidations = [], mids = [], { thresholdBps = 20 } = {}) {
  if (!liquidations.length) return { classification: 'unavailable', dominantSide: null, totalNotional: 0, moveBps: null, quality: 'unavailable' };
  const ordered = [...liquidations].sort((a, b) => eventTs(a) - eventTs(b));
  const longNotional = sum(ordered.filter(x => x.side === 'long').map(x => Number(x.notional) || 0));
  const shortNotional = sum(ordered.filter(x => x.side === 'short').map(x => Number(x.notional) || 0));
  const dominantSide = longNotional >= shortNotional ? 'long' : 'short';
  const totalNotional = longNotional + shortNotional;
  const start = nearestBefore(mids, eventTs(ordered[0]));
  const end = nearestAfter(mids, eventTs(ordered.at(-1)));
  if (!start || !end || Number(start.mid) <= 0) return { classification: 'unavailable', dominantSide, totalNotional, moveBps: null, quality: 'unavailable' };
  const moveBps = ((Number(end.mid) - Number(start.mid)) / Number(start.mid)) * 10_000;
  let classification = 'mixed';
  if (dominantSide === 'long') {
    if (moveBps <= -thresholdBps) classification = 'continuation';
    else if (moveBps >= -thresholdBps / 2) classification = 'absorbed';
  } else {
    if (moveBps >= thresholdBps) classification = 'continuation';
    else if (moveBps <= thresholdBps / 2) classification = 'absorbed';
  }
  return { classification, dominantSide, totalNotional, moveBps, quality: 'ok' };
}

function firstBreak(series, thresholdBps) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const first = Number(series[0].mid ?? series[0].price);
  if (!Number.isFinite(first) || first <= 0) return null;
  for (let i = 1; i < series.length; i++) {
    const value = Number(series[i].mid ?? series[i].price);
    const moveBps = ((value - first) / first) * 10_000;
    if (Math.abs(moveBps) >= thresholdBps) return { ts: Number(series[i].ts), direction: Math.sign(moveBps), moveBps };
  }
  return null;
}

export function computeLeadLag(seriesByVenue = {}, { thresholdBps = 1, minLeadMs = 50 } = {}) {
  const breaks = Object.entries(seriesByVenue)
    .map(([venue, series]) => ({ venue, brk: firstBreak(series, thresholdBps) }))
    .filter(x => x.brk)
    .sort((a, b) => a.brk.ts - b.brk.ts);
  if (breaks.length < 2) return { leader: 'no_clear_leader', lagMs: null, stability: 0, quality: 'unavailable' };
  const direction = breaks[0].brk.direction;
  if (!breaks.every(x => x.brk.direction === direction)) return { leader: 'no_clear_leader', lagMs: null, stability: 0, quality: 'mixed_direction' };
  const lagMs = breaks[1].brk.ts - breaks[0].brk.ts;
  if (lagMs < minLeadMs) return { leader: 'no_clear_leader', lagMs, stability: 0.5, quality: 'ambiguous' };
  return { leader: breaks[0].venue, lagMs, stability: Math.min(1, lagMs / Math.max(minLeadMs, 1)), direction: direction > 0 ? 'up' : 'down', quality: 'ok' };
}

export function buildCausalSummary(features = {}) {
  const parts = [];
  const contradictions = [];
  if (features.leadLag?.leader && features.leadLag.leader !== 'no_clear_leader') parts.push(`${features.leadLag.leader} leads`);
  if (features.aggressor?.quality === 'ok') {
    if (features.aggressor.imbalance > 0.2) parts.push('aggressive buy flow');
    else if (features.aggressor.imbalance < -0.2) parts.push('aggressive sell flow');
  }
  if (features.impactAsymmetry?.direction === 'buy_more_efficient') parts.push('buy impact rising');
  if (features.impactAsymmetry?.direction === 'sell_more_efficient') parts.push('sell impact rising');
  if (features.refill?.absorptionDirection === 'buy') parts.push('bid refill supports buyers');
  if (features.refill?.absorptionDirection === 'sell') parts.push('ask refill absorbs buyers');
  if (features.aggressor?.imbalance > 0.2 && features.refill?.absorptionDirection === 'sell') contradictions.push('sell-side absorption against buy flow');
  if (features.aggressor?.imbalance < -0.2 && features.refill?.absorptionDirection === 'buy') contradictions.push('buy-side absorption against sell flow');
  if ((features.void?.upVoidScore ?? 0) > 0.4 && (features.aggressor?.imbalance ?? 0) <= 0.2) contradictions.push('upward liquidity void lacks buy-flow confirmation');
  if ((features.void?.downVoidScore ?? 0) > 0.4 && (features.aggressor?.imbalance ?? 0) >= -0.2) contradictions.push('downward liquidity void lacks sell-flow confirmation');
  return {
    summary: parts.length ? parts.join(' -> ') : 'no clear microstructure chain',
    strongestContradiction: contradictions[0] ?? 'none'
  };
}
