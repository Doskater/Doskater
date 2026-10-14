import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNeutralPayload } from '../schema-guard.js';

test('accepts nested neutral market data', () => {
  const payload = {
    symbol: 'BTCUSDT',
    rows: [{ timestamp: 1, close: 100, fundingRate: 0.0001 }],
    coverage: { binanceSpot: false }
  };
  assert.doesNotThrow(() => assertNeutralPayload(payload));
});

test('rejects prohibited recommendation keys at any depth', () => {
  assert.throws(
    () => assertNeutralPayload({ rows: [{ symbol: 'BTCUSDT', trade_score: 91 }] }),
    /prohibited_recommendation_field:trade_score/
  );
  assert.throws(
    () => assertNeutralPayload({ nested: { signal: 'LONG' } }),
    /prohibited_recommendation_field:signal/
  );
});
