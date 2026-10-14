import { createHttpServer } from './server.js';
import { createSnapshotStore } from './snapshot-store.js';
import { createSourceHealth } from './source-health.js';
import { createSnapshotService } from './services/snapshot-service.js';
import { createUniverseService } from './services/universe-service.js';
import { createMarketHistoryService } from './services/market-history-service.js';
import { createDerivativesService } from './services/derivatives-service.js';
import { createCrossMarketService } from './services/cross-market-service.js';
import { createMicrostructureService } from './services/microstructure-service.js';
import { createPublicMicrostructure } from './microstructure/public-microstructure.js';
import { createBybitRestClient } from './upstream/bybit-rest.js';
import { createBinanceRestClient } from './upstream/binance-rest.js';

export function createApp({ bybit, binance, microstructure = {}, env = process.env, clock = Date, logger, fetchImpl = fetch } = {}) {
  const snapshotStore = createSnapshotStore({ ttlMs: 900_000, clock });
  const sourceHealth = createSourceHealth({ clock });
  const bybitClient = bybit ?? createBybitRestClient({ fetchImpl, health:sourceHealth, clock });
  const binanceClient = binance ?? createBinanceRestClient({ fetchImpl, health:sourceHealth, clock });
  const universeService = typeof bybitClient.listLinearInstruments === 'function' && typeof binanceClient.getSpotExchangeInfo === 'function'
    ? createUniverseService({ bybit:bybitClient, binance:binanceClient, snapshotStore })
    : null;
  const captureUniverse = universeService
    ? cutoff => universeService.captureBundle(cutoff)
    : (typeof bybitClient.captureUniverse === 'function' ? cutoff => bybitClient.captureUniverse(cutoff) : async () => []);
  const snapshotService = createSnapshotService({ snapshotStore, sourceHealth, captureUniverse, clock });
  const marketHistoryService = typeof bybitClient.getKlines === 'function'
    ? createMarketHistoryService({ bybit:bybitClient, snapshotStore })
    : null;
  const derivativesService = typeof bybitClient.getOpenInterest === 'function'
    ? createDerivativesService({ bybit:bybitClient, snapshotStore, liquidationProvider: microstructure?.liquidationProvider })
    : null;
  const crossMarketService = createCrossMarketService({ bybit:bybitClient, binance:binanceClient, snapshotStore });
  const publicMicrostructure = microstructure?.collector ? null : createPublicMicrostructure({ websocketFactory:microstructure?.websocketFactory, clock, logger, sourceHealth });
  const microstructureCollector = microstructure?.collector ?? publicMicrostructure.collector;
  const microstructureService = createMicrostructureService({ collector:microstructureCollector, snapshotStore, clock });

  const unavailable = name => async () => { throw new Error(`${name}_not_implemented`); };
  const toolHandlers = {
    source_health: async () => snapshotService.sourceHealth(),
    prepare_snapshot: async () => snapshotService.prepareSnapshot(),
    market_universe: universeService ? async args => universeService.getUniverse(args) : unavailable('market_universe'),
    historical_market_data: marketHistoryService ? async args => marketHistoryService.getHistoricalMarketData(args) : unavailable('historical_market_data'),
    historical_derivatives_data: derivativesService ? async args => derivativesService.getHistoricalDerivativesData(args) : unavailable('historical_derivatives_data'),
    cross_market_data: async args => crossMarketService.getCrossMarketData(args),
    microstructure_data: microstructureService ? async args => microstructureService.getMicrostructureData(args) : unavailable('microstructure_data')
  };

  const server = createHttpServer({ env, toolHandlers, logger, clock });
  return {
    server,
    toolHandlers,
    services: { snapshotStore, sourceHealth, snapshotService, universeService, marketHistoryService, derivativesService, crossMarketService, microstructureService, publicMicrostructure, bybit:bybitClient, binance:binanceClient },
    async start() { await publicMicrostructure?.start(); },
    async stop() { publicMicrostructure?.stop(); }
  };
}
