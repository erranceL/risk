import type { Period, RiskConfig } from "../core/types.js";

export const SUPPORTED_PRODUCTS: Array<{ symbol: string; period: Period }> = [
  ...["BTC", "ETH", "XAU"].flatMap((symbol) =>
    (["30s", "1m", "5m", "10m", "15m", "30m", "1h"] as Period[]).map((period) => ({
      symbol,
      period,
    })),
  ),
];

export function defaultRiskConfig(symbol: string, period: Period): RiskConfig {
  return {
    symbol,
    period,
    platformEdge: 0.05,
    probabilitySkewMax: 0.05,
    probabilitySkewSensitivity: 0.05,
    minExposureForSkew: 100,
    probabilityMin: 0.35,
    probabilityMax: 0.65,
    payoutRateFloor: 0.6,
    payoutRateCeiling: 1.2,
    publishMinReturnRate: 0.65,
    publishMaxReturnRate: 0.95,
    payoutMaxChangePerSecond: 0.02,
    payoutMaxChangePerOrder: 0.01,
    quoteTtlMs: Number(process.env.QUOTE_TTL_MS || 300),
    modelVersion: "risk-payout-v1",
    configVersion: "cfg-default",
  };
}
