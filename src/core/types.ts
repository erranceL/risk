export type Direction = "LONG" | "SHORT";

export type RiskSignal = "normal" | "degraded" | "fallback" | "paused";

export type Period = "30s" | "1m" | "5m" | "10m" | "15m" | "30m" | "1h" | string;

export interface RiskConfig {
  symbol: string;
  period: Period;
  platformEdge: number;
  probabilitySkewMax: number;
  probabilitySkewSensitivity: number;
  minExposureForSkew: number;
  probabilityMin: number;
  probabilityMax: number;
  payoutRateFloor: number;
  payoutRateCeiling: number;
  publishMinReturnRate: number;
  publishMaxReturnRate: number;
  payoutMaxChangePerSecond: number;
  payoutMaxChangePerOrder: number;
  quoteTtlMs: number;
  modelVersion: string;
  configVersion: string;
}

export interface ExposureState {
  symbol: string;
  period: Period;
  longStake: number;
  shortStake: number;
  cursor: string;
  updatedAt: number;
}

export interface PreviousQuote {
  rUp: number;
  rDown: number;
  generatedAt: number;
}

export interface Quote {
  quoteId: string;
  symbol: string;
  period: Period;
  rUp: number;
  rDown: number;
  platformEdge: number;
  houseEdge: number;
  generatedAt: number;
  expiresAt: number;
  exposureCursor: string;
  configVersion: string;
  modelVersion: string;
  clampReason: string | null;
  riskSignal: RiskSignal;
}

export type RiskEventType =
  | "ORDER_ACCEPTED"
  | "ORDER_PRICED"
  | "ORDER_SETTLED"
  | "ORDER_REFUNDED"
  | "ORDER_CANCELED"
  | "ORDER_HELD";

export interface RiskEventPayload {
  orderId: string;
  symbol: string;
  period: Period;
  direction: Direction;
  stake: number;
  payoutRateSnapshot?: number;
  eventEndTime?: number;
  status?: string;
}

export interface RiskEvent {
  eventId: string;
  sequence: number;
  occurredAt: number;
  publishedAt: number;
  type: RiskEventType;
  payload: RiskEventPayload;
}

export interface OpenPositionSnapshot {
  snapshotCursor: string;
  positions: RiskEventPayload[];
}

export interface EventApplyResult {
  accepted: boolean;
  duplicate: boolean;
  sequenceGap: boolean;
  cursor: string;
}
