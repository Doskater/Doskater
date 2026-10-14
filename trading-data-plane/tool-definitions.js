const readTool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false }
});

const snapshotId = { type: 'string', minLength: 1, maxLength: 128 };
const symbols = {
  type: 'array', minItems: 1, maxItems: 50, uniqueItems: true,
  items: { type: 'string', pattern: '^[A-Za-z0-9]{1,30}USDT$' }
};
const cursor = { type: 'string', minLength: 1, maxLength: 4096 };

export const TOOL_DEFINITIONS = Object.freeze([
  readTool('source_health', 'Read technical source freshness, latency, failures and coverage. Never returns market-direction conclusions.'),
  readTool('prepare_snapshot', 'Create an immutable market-analysis cutoff and return its snapshot id and expiration metadata.'),
  readTool('market_universe', 'Read paginated neutral metadata for the Bybit linear USDT-perpetual universe captured in an analysis snapshot.', {
    snapshotId, cursor, limit: { type: 'integer', minimum: 1, maximum: 1000 }
  }, ['snapshotId']),
  readTool('historical_market_data', 'Read snapshot-consistent bulk OHLCV/turnover history for ChatGPT-side calculations.', {
    snapshotId, symbols,
    timeframe: { type: 'string', enum: ['1m','5m','15m','1h','4h','1d'] },
    startMs: { type: 'integer', minimum: 0 }, endMs: { type: 'integer', minimum: 0 },
    fields: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['timestamp','open','high','low','close','volume','turnover'] } },
    cursor, maxRows: { type: 'integer', minimum: 1, maximum: 20000 }
  }, ['snapshotId','symbols','timeframe']),
  readTool('historical_derivatives_data', 'Read neutral OI, funding, mark/index, basis-input and liquidation history for ChatGPT-side analysis.', {
    snapshotId, symbols,
    resolution: { type: 'string', enum: ['5m','15m','30m','1h','4h','1d'] },
    startMs: { type: 'integer', minimum: 0 }, endMs: { type: 'integer', minimum: 0 },
    fields: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
    cursor, maxRows: { type: 'integer', minimum: 1, maximum: 20000 }
  }, ['snapshotId','symbols','resolution']),
  readTool('cross_market_data', 'Read synchronized Bybit/Binance spot/perpetual quotes or history without arbitrage recommendations.', {
    snapshotId, symbols,
    mode: { type: 'string', enum: ['snapshot','history'] },
    timeframe: { type: 'string', enum: ['1m','5m','15m','1h','4h','1d'] },
    startMs: { type: 'integer', minimum: 0 }, endMs: { type: 'integer', minimum: 0 },
    cursor, maxRows: { type: 'integer', minimum: 1, maximum: 20000 }
  }, ['snapshotId','symbols','mode']),
  readTool('microstructure_data', 'Read neutral event buckets for finalist symbols only. ChatGPT computes and interprets order-flow features.', {
    snapshotId,
    symbols: { ...symbols, maxItems: 10 },
    bucketMs: { type: 'integer', enum: [1000,5000,30000,60000] },
    lookbackMs: { type: 'integer', minimum: 1000, maximum: 120000 }
  }, ['snapshotId','symbols','bucketMs','lookbackMs'])
]);
