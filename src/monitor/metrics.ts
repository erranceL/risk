export interface RiskMetrics {
  quoteAgeMs: number | null;
  eventLagMs: number | null;
  exposureDrift: number | null;
  publishSuccessRate: number;
  quoteClampCount: number;
  negativeEdgeBlockCount: number;
  fallbackQuoteCount: number;
  sequenceGapCount: number;
  configRejectCount: number;
  storageErrorCount: number;
  resyncRequestCount: number;
}

export function initialMetrics(): RiskMetrics {
  return {
    quoteAgeMs: null,
    eventLagMs: null,
    exposureDrift: null,
    publishSuccessRate: 1,
    quoteClampCount: 0,
    negativeEdgeBlockCount: 0,
    fallbackQuoteCount: 0,
    sequenceGapCount: 0,
    configRejectCount: 0,
    storageErrorCount: 0,
    resyncRequestCount: 0,
  };
}
