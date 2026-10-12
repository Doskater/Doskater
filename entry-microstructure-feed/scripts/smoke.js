import { createBinanceFeed } from '../binance-feed.js';
import { createBybitFeed } from '../bybit-feed.js';
import { createWatchlist } from '../watchlist.js';
import { createCollector } from '../collector.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

const compact = snapshot => ({
  symbol: snapshot.symbol,
  runtime: snapshot.runtime,
  primaryFamily: snapshot.primaryFamily,
  healthyCoverage: snapshot.coverage.filter(x => x.healthy).map(x => x.family),
  missingCoverage: snapshot.missingCoverage,
  maxAgeMs: snapshot.freshness.maxAgeMs,
  leader: snapshot.leader?.leader,
  causalSummary: snapshot.causalSummary,
  strongestContradiction: snapshot.strongestContradiction
});

const logs = [];
const logger = {
  info: event => logs.push({ level: 'info', ...event }),
  warn: event => logs.push({ level: 'warn', ...event }),
  error: event => logs.push({ level: 'error', ...event })
};

const binanceFeed = createBinanceFeed({ logger });
const bybitFeed = createBybitFeed({ logger });
const watchlist = createWatchlist();
const collector = createCollector({ binanceFeed, bybitFeed, watchlist, logger });

function snapshots() {
  return symbols.map(symbol => collector.getSnapshot(symbol));
}

function printState(label) {
  console.log(JSON.stringify({ label, at: new Date().toISOString(), snapshots: snapshots().map(compact) }, null, 2));
}

async function waitUntil(predicate, { timeoutMs, intervalMs = 500, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = snapshots();
    if (predicate(current)) return current;
    await wait(intervalMs);
  }
  printState(`timeout_${label}`);
  throw new Error(`smoke_timeout_${label}`);
}

async function main() {
  console.log('Entry Microstructure Feed live smoke: public market data only; no exchange credentials are used.');
  try {
    await collector.start();
    await waitUntil(rows => rows.every(x => x.coverage.filter(c => c.healthy).length === 4), { timeoutMs: 20_000, label: 'coverage' });
    await waitUntil(rows => rows.every(x => x.runtime === 'FULL_EVENT_STREAM'), { timeoutMs: 80_000, intervalMs: 1000, label: 'full_event_stream' });
    printState('full_event_stream');

    console.log('Forcing Binance adapter disconnect.');
    binanceFeed.stop();
    await waitUntil(rows => rows.every(x => x.runtime === 'PARTIAL' && x.missingCoverage.some(c => c.startsWith('binance:'))), { timeoutMs: 10_000, label: 'disconnect_degraded' });
    printState('after_binance_disconnect');

    console.log('Restarting Binance adapter.');
    binanceFeed.start();
    await waitUntil(rows => rows.every(x => x.coverage.filter(c => c.healthy).length === 4), { timeoutMs: 20_000, label: 'reconnect_coverage' });
    const recovered = snapshots();
    if (!recovered.every(x => x.runtime === 'WARMING_UP')) {
      printState('bad_reconnect_state');
      throw new Error('reconnect_must_require_fresh_warmup');
    }
    printState('after_binance_reconnect_warming');

    const errors = logs.filter(x => x.level === 'error' || /failed/.test(String(x.event ?? '')));
    if (errors.length) {
      console.log(JSON.stringify({ operationalErrors: errors.slice(-20) }, null, 2));
      throw new Error('operational_errors_seen');
    }
    console.log(JSON.stringify({ smoke: 'passed', publicStreams: true, credentialsUsed: false }));
  } finally {
    collector.stop();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ smoke: 'failed', message: error?.message ?? String(error) }));
  try { collector.stop(); } catch {}
  process.exitCode = 1;
});
