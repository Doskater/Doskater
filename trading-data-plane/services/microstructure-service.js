const BUCKETS = new Set([1000,5000,30000,60000]);
export function createMicrostructureService({collector,snapshotStore,clock=Date}={}) {
  if(!collector?.ensureSymbols||!collector?.getNeutralBuckets) throw new Error('neutral_collector_required');
  if(!snapshotStore) throw new Error('snapshot_store_required');
  const now=()=>typeof clock.now==='function'?clock.now():Date.now();
  async function getMicrostructureData({snapshotId,symbols,bucketMs,lookbackMs}={}) {
    const snapshot=snapshotStore.require(snapshotId);
    if(!Array.isArray(symbols)||symbols.length<1||symbols.length>10) throw new Error('invalid_symbols');
    const unique=[...new Set(symbols.map(String))]; if(unique.length!==symbols.length) throw new Error('duplicate_symbols');
    if(!BUCKETS.has(Number(bucketMs))) throw new Error('invalid_bucket');
    if(!Number.isFinite(Number(lookbackMs))||Number(lookbackMs)<1000||Number(lookbackMs)>120000) throw new Error('invalid_lookback');
    const universe=new Set((snapshot.universe??[]).map(row=>row.symbol));
    for(const symbol of unique) if(!universe.has(symbol)) throw new Error(`symbol_not_in_snapshot:${symbol}`);
    await collector.ensureSymbols(unique);
    const result={}; for(const symbol of unique) result[symbol]=collector.getNeutralBuckets(symbol,{bucketMs:Number(bucketMs),lookbackMs:Number(lookbackMs)});
    return {snapshotId:snapshot.snapshotId,analysisCutoff:snapshot.dataCutoff,microstructureCapturedAt:now(),bucketMs:Number(bucketMs),lookbackMs:Number(lookbackMs),symbols:result};
  }
  return {getMicrostructureData};
}
