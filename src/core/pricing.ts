import type { ExposureState, PreviousQuote, Quote, RiskConfig, RiskSignal } from "./types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
}

function roundRate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function houseEdgeForRates(rUp: number, rDown: number): number {
  assertFinite("rUp", rUp);
  assertFinite("rDown", rDown);
  const gross = 1 / ((1 / (1 + rUp)) + (1 / (1 + rDown)));
  return 1 - gross;
}

function clampPayoutRate(raw: number, config: RiskConfig): { value: number; clamped: boolean } {
  const payoutClamped = clamp(raw, config.payoutRateFloor, config.payoutRateCeiling);
  const published = clamp(payoutClamped, config.publishMinReturnRate, config.publishMaxReturnRate);
  return {
    value: roundRate(published),
    clamped: Math.abs(raw - published) > 1e-12,
  };
}

function applyRateLimit(raw: number, previous: number, maxDelta: number): number {
  if (!Number.isFinite(previous) || maxDelta <= 0) return raw;
  return clamp(raw, previous - maxDelta, previous + maxDelta);
}

export interface QuoteInput {
  config: RiskConfig;
  exposure: ExposureState;
  previousQuote?: PreviousQuote;
  now?: number;
  riskSignal?: RiskSignal;
}

export function buildQuote(input: QuoteInput): Quote {
  const now = input.now ?? Date.now();
  const { config, exposure } = input;
  for (const [name, value] of Object.entries({
    platformEdge: config.platformEdge,
    probabilitySkewMax: config.probabilitySkewMax,
    probabilitySkewSensitivity: config.probabilitySkewSensitivity,
    minExposureForSkew: config.minExposureForSkew,
    probabilityMin: config.probabilityMin,
    probabilityMax: config.probabilityMax,
    payoutRateFloor: config.payoutRateFloor,
    payoutRateCeiling: config.payoutRateCeiling,
    publishMinReturnRate: config.publishMinReturnRate,
    publishMaxReturnRate: config.publishMaxReturnRate,
  })) {
    assertFinite(name, value);
  }

  const gross = 1 - config.platformEdge;
  if (gross <= 0 || gross >= 1) {
    throw new Error("platformEdge must produce 0 < gross < 1");
  }

  const totalExposure = exposure.longStake + exposure.shortStake;
  const denominator = Math.max(totalExposure, config.minExposureForSkew);
  const imbalanceRatio = clamp((exposure.longStake - exposure.shortStake) / denominator, -1, 1);
  const payoutSkew = clamp(
    imbalanceRatio * config.probabilitySkewSensitivity,
    -config.probabilitySkewMax,
    config.probabilitySkewMax,
  );

  const pUp = clamp(0.5 + payoutSkew, config.probabilityMin, config.probabilityMax);
  const pDown = 1 - pUp;
  if (pDown <= 0) throw new Error("pDown must be positive");

  const rawUp = gross / pUp - 1;
  const rawDown = gross / pDown - 1;

  const elapsedSeconds = input.previousQuote
    ? Math.max(0, (now - input.previousQuote.generatedAt) / 1000)
    : 0;
  const maxTimeDelta = config.payoutMaxChangePerSecond * elapsedSeconds;
  const maxDelta = input.previousQuote
    ? Math.min(
      config.payoutMaxChangePerOrder,
      maxTimeDelta > 0 ? maxTimeDelta : config.payoutMaxChangePerOrder,
    )
    : 0;
  const limitedUp = input.previousQuote
    ? applyRateLimit(rawUp, input.previousQuote.rUp, maxDelta)
    : rawUp;
  const limitedDown = input.previousQuote
    ? applyRateLimit(rawDown, input.previousQuote.rDown, maxDelta)
    : rawDown;

  const up = clampPayoutRate(limitedUp, config);
  const down = clampPayoutRate(limitedDown, config);
  const houseEdge = houseEdgeForRates(up.value, down.value);
  if (houseEdge < -1e-9) {
    throw new Error("negative house edge quote blocked");
  }

  const clampReasons: string[] = [];
  if (up.clamped) clampReasons.push("r_up_clamped");
  if (down.clamped) clampReasons.push("r_down_clamped");

  return {
    quoteId: `risk-${config.symbol}-${config.period}-${now}`,
    symbol: config.symbol,
    period: config.period,
    rUp: up.value,
    rDown: down.value,
    platformEdge: config.platformEdge,
    houseEdge: roundRate(houseEdge),
    generatedAt: now,
    expiresAt: now + config.quoteTtlMs,
    exposureCursor: exposure.cursor,
    configVersion: config.configVersion,
    modelVersion: config.modelVersion,
    clampReason: clampReasons.length ? clampReasons.join(",") : null,
    riskSignal: input.riskSignal ?? "normal",
  };
}

export interface FallbackQuoteInput {
  config: RiskConfig;
  exposure: ExposureState;
  now?: number;
  riskSignal?: RiskSignal;
  reason?: string;
}

// Most conservative quote for the platform: a symmetric payout at the lowest
// publishable return rate (i.e. the highest house edge). Used when the normal
// pricing path throws or when the exposure mirror is known to be stale.
export function fallbackQuote(input: FallbackQuoteInput): Quote {
  const now = input.now ?? Date.now();
  const { config, exposure } = input;
  const floor = Math.min(config.publishMinReturnRate, config.publishMaxReturnRate);
  const rate = roundRate(clamp(floor, config.payoutRateFloor, config.payoutRateCeiling));
  const reason = input.reason ?? "fallback";
  return {
    quoteId: `risk-fallback-${config.symbol}-${config.period}-${now}`,
    symbol: config.symbol,
    period: config.period,
    rUp: rate,
    rDown: rate,
    platformEdge: config.platformEdge,
    houseEdge: roundRate(houseEdgeForRates(rate, rate)),
    generatedAt: now,
    expiresAt: now + config.quoteTtlMs,
    exposureCursor: exposure.cursor,
    configVersion: config.configVersion,
    modelVersion: config.modelVersion,
    clampReason: reason,
    riskSignal: input.riskSignal ?? "fallback",
  };
}
