export interface RiskScoreInput {
  payoutRate: number;
  winRate: number;
  longStake: number;
  shortStake: number;
  realizedVol: number;
  maxLossCap: number;
  marginRef?: number;
  volRef?: number;
}

export interface RiskScore {
  payoutErosion: number;
  imbalance: number;
  maxLoss: number;
  volatility: number;
  composite: number;
  level: number;
  maxLossAmount: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function maxLoss(longStake: number, shortStake: number, payoutRate: number): number {
  return Math.max(longStake * payoutRate - shortStake, shortStake * payoutRate - longStake, 0);
}

export function scoreRisk(input: RiskScoreInput): RiskScore {
  const marginRef = input.marginRef ?? 0.05;
  const volRef = input.volRef ?? 0.001;
  const breakEvenWinRate = 1 / (1 + input.payoutRate);
  const payoutErosion =
    input.winRate >= breakEvenWinRate
      ? 1
      : clamp(1 - (breakEvenWinRate - input.winRate) / marginRef, 0, 1);
  const totalStake = input.longStake + input.shortStake;
  const imbalance = totalStake > 0 ? Math.abs(input.longStake - input.shortStake) / totalStake : 0;
  const lossAmount = maxLoss(input.longStake, input.shortStake, input.payoutRate);
  const maxLossScore = clamp(lossAmount / Math.max(input.maxLossCap, 1), 0, 1);
  const volatility = clamp(input.realizedVol / volRef, 0, 1);
  const composite = 0.5 * payoutErosion + 0.2 * imbalance + 0.2 * maxLossScore + 0.1 * volatility;
  return {
    payoutErosion,
    imbalance,
    maxLoss: maxLossScore,
    volatility,
    composite,
    level: clamp(Math.ceil(composite * 10), 1, 10),
    maxLossAmount: lossAmount,
  };
}

