const PROHIBITED = new Set([
  'signal','tradeSignal','trade_score','tradeScore','long_probability','short_probability',
  'best_trade','bestTrade','recommendation','entry','stop','stopLoss','target','takeProfit'
]);

export function assertNeutralPayload(value) {
  const visit = current => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      if (PROHIBITED.has(key)) throw new Error(`prohibited_recommendation_field:${key}`);
      visit(child);
    }
  };
  visit(value);
}
