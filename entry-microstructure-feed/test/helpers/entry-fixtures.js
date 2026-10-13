export const NOW = 1_000_000;
export function snapshot(price=4.93, overrides={}) {
  return {symbol:'NEARUSDT',asOf:NOW,currentMid:price,runtime:'FULL_EVENT_STREAM',primaryFamily:'binance:spot',
    freshness:{maxAgeMs:0,byFamily:{'binance:spot':0},eventsByFamily:{'binance:spot':{lastTradeAt:NOW,lastBookAt:NOW}}},
    windows:{'60000':{aggressor:{quality:'ok',imbalance:-0.5},impactAsymmetry:{quality:'ok',direction:'sell_more_efficient'},refill:{quality:'ok',absorptionDirection:'sell'}}},...overrides};
}
export function candidate(overrides={}) {
  return {schemaVersion:1,candidateId:'candidate-1',setupId:'setup-1',symbol:'NEARUSDT',side:'short',triggerPrice:4.94,observedPrice:4.93,detectedAt:NOW-600_000,
    microstructure:snapshot(),watcherPolicy:{minImbalance:0.3,requireImpact:true,absorptionVeto:true},...overrides};
}
export function context(overrides={}) {
  return {symbol:'NEARUSDT',side:'short',setupId:'setup-1',asOf:NOW,thesisValid:true,structure:'valid',invalidationPrice:4.98,targets:[4.78],
    marketRiskAllowed:true,qty:'10',qtyStep:'0.1',tickSize:'0.01',positionIdx:0,...overrides};
}
