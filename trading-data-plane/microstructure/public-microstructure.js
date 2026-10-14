import { createBinanceFeed } from './binance-feed.js';
import { createBybitFeed } from './bybit-feed.js';
import { createNeutralMicrostructureCollector } from './neutral-collector.js';

export function createPublicMicrostructure({ websocketFactory, clock = Date, logger, coreSymbols, sourceHealth } = {}) {
  const feeds = [
    createBinanceFeed({ market:'spot', websocketFactory, logger }),
    createBinanceFeed({ market:'perp', websocketFactory, logger }),
    createBybitFeed({ market:'spot', websocketFactory, logger }),
    createBybitFeed({ market:'linear', websocketFactory, logger })
  ];
  const collector = createNeutralMicrostructureCollector({ feeds, clock, coreSymbols, sourceHealth });
  return {
    feeds,
    collector,
    async start(){ await collector.start(); },
    stop(){ collector.stop(); }
  };
}
