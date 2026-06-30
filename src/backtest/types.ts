import type { Direction, Period } from "../core/types.js";

export type BacktestSymbol = "BTC" | "ETH" | "XAU";
export type KlineInterval = "1s" | "1m";

export interface ExchangeKline {
  openTimeMs: number;
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndexPoint {
  atMs: number;
  close: number;
  spotClose: number;
  perpClose: number;
}

export interface IndexSeries {
  symbol: BacktestSymbol;
  interval: KlineInterval;
  weightSpot: number;
  weightPerp: number;
  points: IndexPoint[];
  gapRatio: number;
  source: {
    spot: string;
    perp: string;
  };
}

export interface SyntheticOrder {
  orderId: string;
  symbol: BacktestSymbol;
  period: Period;
  direction: Direction;
  stake: number;
  acceptAtMs: number;
}

export interface BacktestProduct {
  symbol: BacktestSymbol;
  period: Period;
}

export interface BacktestConfig {
  products: BacktestProduct[];
  ordersPerProductWindow: number;
  minOrdersPerProductWindow: number;
  seed: number;
  startTimeMs: number;
  endTimeMs: number;
  weightSpot: number;
  weightPerp: number;
  configuredEdges: Record<string, number>;
  candidateEdges: number[];
  targetRiskLevel: number;
  minReturnBuffer: number;
  cacheDir: string;
}

