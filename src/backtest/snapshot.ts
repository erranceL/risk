import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SUPPORTED_PRODUCTS, defaultRiskConfig } from "../config/defaults.js";
import { buildQuote } from "../core/pricing.js";
import type { ExposureState, Period } from "../core/types.js";
import { evaluateEdge, type GroupMetrics } from "../sim/edge-sweep.js";

import { generateSyntheticOrders, productKey } from "./flow.js";
import { buildIndexSeries } from "./index-price.js";
import { PriceTimeline } from "./klines.js";
import { scoreRisk, type RiskScore } from "./risk-score.js";
import { settleSyntheticOrders, type SettledBacktestOrder } from "./settle.js";
import { alignToSecond, formatIso, periodToMs } from "./time.js";
import type { BacktestConfig, BacktestProduct, BacktestSymbol, IndexSeries } from "./types.js";

export interface EdgeScenario {
  edge: number;
  platformReturn: number;
  meanPayoutRate: number;
  userWinRate: number;
  riskLevel: number;
  houseEdge: number;
  rUp: number;
  rDown: number;
  clampedQuotes: number;
  clampReason: string | null;
}

export interface WindowSnapshot {
  key: string;
  symbol: BacktestSymbol;
  period: Period;
  orders: number;
  decided: number;
  win: number;
  lose: number;
  draw: number;
  notional: number;
  longStake: number;
  shortStake: number;
  imbalance: number;
  peakOpenInterest: number;
  peakLongStake: number;
  peakShortStake: number;
  userWinRate: number;
  realizedVol: number;
  configuredPlatformEdge: number;
  suggestedPlatformEdge: number | null;
  suggestedEdgeStatus: "ok" | "none";
  configured: EdgeScenario;
  scenarios: EdgeScenario[];
  risk: RiskScore;
  confidence: "low" | "medium" | "normal";
}

export interface BacktestSnapshot {
  generatedAt: string;
  config: {
    ordersPerProductWindow: number;
    minOrdersPerProductWindow: number;
    seed: number;
    startTime: string;
    endTime: string;
    weightSpot: number;
    weightPerp: number;
    targetRiskLevel: number;
    minReturnBuffer: number;
    candidateEdges: number[];
  };
  dataQuality: Array<{
    symbol: BacktestSymbol;
    interval: string;
    points: number;
    gapRatio: number;
  }>;
  windows: WindowSnapshot[];
}

interface ExposureStats {
  longStake: number;
  shortStake: number;
  peakOpenInterest: number;
  peakLongStake: number;
  peakShortStake: number;
}

const DEFAULT_PERIODS = ["30s", "1m", "5m", "10m", "15m", "30m", "1h"] as Period[];
const DEFAULT_SYMBOLS = ["BTC", "ETH", "XAU"] as BacktestSymbol[];

export function defaultBacktestConfig(now = Date.now()): BacktestConfig {
  const endTimeMs = alignToSecond(now - 2 * 60_000);
  const startTimeMs = endTimeMs - 6 * 60 * 60_000;
  const products = DEFAULT_SYMBOLS.flatMap((symbol) =>
    DEFAULT_PERIODS.map((period) => ({ symbol, period })),
  );
  const candidateEdges: number[] = [];
  for (let e = 0.02; e <= 0.200001; e += 0.01) candidateEdges.push(Math.round(e * 1000) / 1000);
  return {
    products,
    ordersPerProductWindow: 2000,
    minOrdersPerProductWindow: 2000,
    seed: 20260630,
    startTimeMs,
    endTimeMs,
    weightSpot: 0.2,
    weightPerp: 0.8,
    configuredEdges: Object.fromEntries(products.map((p) => [productKey(p), 0.05])),
    candidateEdges,
    targetRiskLevel: 6,
    minReturnBuffer: 0,
    cacheDir: "backtest-cache",
  };
}

export function loadBacktestConfig(path?: string): BacktestConfig {
  const base = defaultBacktestConfig();
  if (!path) return base;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BacktestConfig>;
  return {
    ...base,
    ...raw,
    products: raw.products ?? base.products,
    configuredEdges: { ...base.configuredEdges, ...(raw.configuredEdges ?? {}) },
    candidateEdges: raw.candidateEdges ?? base.candidateEdges,
  };
}

function uniqueSymbols(products: BacktestProduct[]): BacktestSymbol[] {
  return [...new Set(products.map((p) => p.symbol))];
}

function groupOrders(orders: SettledBacktestOrder[]): Map<string, SettledBacktestOrder[]> {
  const groups = new Map<string, SettledBacktestOrder[]>();
  for (const order of orders) {
    const key = `${order.symbol}|${order.period}`;
    const existing = groups.get(key) ?? [];
    existing.push(order);
    groups.set(key, existing);
  }
  return groups;
}

function exposureStats(orders: SettledBacktestOrder[]): ExposureStats {
  const events = orders.flatMap((order) => [
    { at: order.acceptAtMs, sign: 1 as const, order },
    { at: order.settleAtMs, sign: -1 as const, order },
  ]);
  events.sort((a, b) => a.at - b.at || b.sign - a.sign);

  let currentLong = 0;
  let currentShort = 0;
  let totalLong = 0;
  let totalShort = 0;
  let peakOpenInterest = 0;
  let peakLongStake = 0;
  let peakShortStake = 0;

  for (const ev of events) {
    const delta = ev.sign * ev.order.stake;
    if (ev.order.direction === "LONG") currentLong += delta;
    else currentShort += delta;
    if (ev.sign === 1) {
      if (ev.order.direction === "LONG") totalLong += ev.order.stake;
      else totalShort += ev.order.stake;
    }
    const open = currentLong + currentShort;
    if (open > peakOpenInterest) {
      peakOpenInterest = open;
      peakLongStake = currentLong;
      peakShortStake = currentShort;
    }
  }

  return {
    longStake: totalLong,
    shortStake: totalShort,
    peakOpenInterest,
    peakLongStake,
    peakShortStake,
  };
}

function quoteScenario(edge: number, stats: ExposureStats, symbol: BacktestSymbol, period: Period): {
  houseEdge: number;
  rUp: number;
  rDown: number;
  clampReason: string | null;
} {
  const config = { ...defaultRiskConfig(symbol, period), platformEdge: edge };
  const exposure: ExposureState = {
    symbol,
    period,
    longStake: stats.peakLongStake,
    shortStake: stats.peakShortStake,
    cursor: "backtest",
    updatedAt: Date.now(),
  };
  const quote = buildQuote({ config, exposure, now: Date.now() });
  return {
    houseEdge: quote.houseEdge,
    rUp: quote.rUp,
    rDown: quote.rDown,
    clampReason: quote.clampReason,
  };
}

function confidence(decided: number): WindowSnapshot["confidence"] {
  if (decided < 200) return "low";
  if (decided < 2000) return "medium";
  return "normal";
}

function edgeScenario(
  group: GroupMetrics,
  edge: number,
  stats: ExposureStats,
  realizedVol: number,
): EdgeScenario {
  const quote = quoteScenario(edge, stats, group.symbol as BacktestSymbol, group.period);
  const risk = scoreRisk({
    payoutRate: group.meanPayoutRate,
    winRate: group.observedWinRate,
    longStake: stats.peakLongStake,
    shortStake: stats.peakShortStake,
    realizedVol,
    maxLossCap: Math.max(stats.peakOpenInterest * 0.2, 1),
  });
  return {
    edge,
    platformReturn: group.platformReturn,
    meanPayoutRate: group.meanPayoutRate,
    userWinRate: group.observedWinRate,
    riskLevel: risk.level,
    houseEdge: quote.houseEdge,
    rUp: quote.rUp,
    rDown: quote.rDown,
    clampedQuotes: group.clampedQuotes,
    clampReason: quote.clampReason,
  };
}

export async function buildBacktestSnapshot(config: BacktestConfig): Promise<BacktestSnapshot> {
  if (config.ordersPerProductWindow < 2000 || config.minOrdersPerProductWindow < 2000) {
    throw new Error("每产品×窗口样本数量必须严格 >= 2000");
  }

  const series: IndexSeries[] = [];
  for (const symbol of uniqueSymbols(config.products)) {
    series.push(
      await buildIndexSeries({
        symbol,
        interval: "1s",
        startTimeMs: config.startTimeMs,
        endTimeMs: config.endTimeMs,
        weightSpot: config.weightSpot,
        weightPerp: config.weightPerp,
        cacheDir: config.cacheDir,
      }),
    );
  }

  const prices = new PriceTimeline(series);
  const synthetic = generateSyntheticOrders({
    products: config.products,
    startTimeMs: config.startTimeMs,
    endTimeMs: config.endTimeMs,
    ordersPerProductWindow: config.ordersPerProductWindow,
    minOrdersPerProductWindow: config.minOrdersPerProductWindow,
    seed: config.seed,
  });
  const settled = settleSyntheticOrders(synthetic, prices);
  const byWindow = groupOrders(settled);
  const allEdges = [...new Set([...config.candidateEdges, ...Object.values(config.configuredEdges)])].sort(
    (a, b) => a - b,
  );
  const edgeResults = new Map(allEdges.map((edge) => [edge, evaluateEdge(settled, edge, { edges: [edge] })]));

  const windows: WindowSnapshot[] = [];
  for (const product of config.products) {
    const key = productKey(product);
    const orders = byWindow.get(key) ?? [];
    if (orders.length < 2000) {
      throw new Error(`${key} settled order count ${orders.length} is below strict minimum 2000`);
    }
    const stats = exposureStats(orders);
    const realizedVol = prices.realizedVol(product.symbol, config.startTimeMs, config.endTimeMs);
    const configuredEdge = config.configuredEdges[key] ?? 0.05;
    const scenarios = allEdges.map((edge) => {
      const result = edgeResults.get(edge);
      const group = result?.groups.find((g) => g.key === key);
      if (!group) throw new Error(`Missing group ${key} for edge ${edge}`);
      return edgeScenario(group, edge, stats, realizedVol);
    });
    const configured = scenarios.find((s) => s.edge === configuredEdge) ?? scenarios[0]!;
    const risk = scoreRisk({
      payoutRate: configured.meanPayoutRate,
      winRate: configured.userWinRate,
      longStake: stats.peakLongStake,
      shortStake: stats.peakShortStake,
      realizedVol,
      maxLossCap: Math.max(stats.peakOpenInterest * 0.2, 1),
    });
    const suggested =
      scenarios.find(
        (s) => s.platformReturn >= config.minReturnBuffer && s.riskLevel <= config.targetRiskLevel,
      ) ?? null;
    const notional = orders.reduce((sum, order) => sum + order.stake, 0);
    const decided = orders.filter((order) => order.result !== "DRAW").length;
    const win = orders.filter((order) => order.result === "WIN").length;
    const lose = orders.filter((order) => order.result === "LOSE").length;
    const draw = orders.length - decided;
    const totalStake = stats.longStake + stats.shortStake;
    windows.push({
      key,
      symbol: product.symbol,
      period: product.period,
      orders: orders.length,
      decided,
      win,
      lose,
      draw,
      notional,
      longStake: stats.longStake,
      shortStake: stats.shortStake,
      imbalance: totalStake > 0 ? Math.abs(stats.longStake - stats.shortStake) / totalStake : 0,
      peakOpenInterest: stats.peakOpenInterest,
      peakLongStake: stats.peakLongStake,
      peakShortStake: stats.peakShortStake,
      userWinRate: decided > 0 ? win / decided : 0,
      realizedVol,
      configuredPlatformEdge: configuredEdge,
      suggestedPlatformEdge: suggested?.edge ?? null,
      suggestedEdgeStatus: suggested ? "ok" : "none",
      configured,
      scenarios,
      risk,
      confidence: confidence(decided),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    config: {
      ordersPerProductWindow: config.ordersPerProductWindow,
      minOrdersPerProductWindow: config.minOrdersPerProductWindow,
      seed: config.seed,
      startTime: formatIso(config.startTimeMs),
      endTime: formatIso(config.endTimeMs),
      weightSpot: config.weightSpot,
      weightPerp: config.weightPerp,
      targetRiskLevel: config.targetRiskLevel,
      minReturnBuffer: config.minReturnBuffer,
      candidateEdges: allEdges,
    },
    dataQuality: series.map((s) => ({
      symbol: s.symbol,
      interval: s.interval,
      points: s.points.length,
      gapRatio: s.gapRatio,
    })),
    windows,
  };
}

function parseCli(argv: string[]): { configPath?: string; out: string } {
  const args: { configPath?: string; out: string } = { out: "console/snapshot.json" };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--config") args.configPath = argv[++i];
    else if (current === "--out") args.out = argv[++i] ?? args.out;
  }
  return args;
}

export async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const config = loadBacktestConfig(args.configPath);
  const snapshot = await buildBacktestSnapshot(config);
  const outPath = join(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`wrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

