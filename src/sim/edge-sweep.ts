import { defaultRiskConfig } from "../config/defaults.js";
import { ExposureBook } from "../core/exposure.js";
import { buildQuote, fallbackQuote } from "../core/pricing.js";
import type { PreviousQuote, RiskConfig, RiskEvent } from "../core/types.js";

import type { SimOrder } from "./dataset.js";

export interface SweepOptions {
  // platform_edge values to evaluate.
  edges: number[];
  // Group results by direction too (symbol|period|dir) on top of symbol|period.
  byDirection?: boolean;
  // Overrides applied on top of defaultRiskConfig for every product (lets us
  // explore payouts beyond the default publish clamp, e.g. lower publishMinReturnRate).
  configOverrides?: Partial<RiskConfig>;
  // Apply the vendor per-quote rate limiter during replay. Off by default so the
  // sweep shows each edge's steady-state target payout without path dependence.
  rateLimit?: boolean;
}

export interface GroupMetrics {
  key: string;
  symbol: string;
  period: string;
  direction: string | null;
  decided: number; // WIN + LOSE
  win: number;
  lose: number;
  draw: number;
  settledStake: number; // WIN + LOSE stake (DRAW excluded)
  observedWinRate: number; // win / decided
  meanPayoutRate: number; // mean assigned payout over decided orders
  platformPnl: number; // Σ lose stake − Σ win stake × payout
  platformReturn: number; // pnl / settledStake
  clampedQuotes: number; // how many quotes hit a guardrail / fallback
}

export interface EdgeResult {
  edge: number; // the platform_edge used (NaN for the staging-static reference row)
  label: string; // "edge=0.0500" or "staging-static"
  groups: GroupMetrics[];
  overall: GroupMetrics;
}

interface TimelineEvent {
  at: number;
  kind: "accept" | "release";
  order: SimOrder;
}

function groupKey(o: SimOrder, byDirection: boolean): string {
  return byDirection ? `${o.symbol}|${o.period}|${o.direction}` : `${o.symbol}|${o.period}`;
}

function buildTimeline(orders: SimOrder[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const order of orders) {
    events.push({ at: order.acceptAtMs, kind: "accept", order });
    events.push({ at: order.settleAtMs, kind: "release", order });
  }
  // Chronological; on ties an accept is applied before a release so a same-instant
  // open is visible to peers, and sequence numbers stay strictly increasing.
  events.sort((a, b) => (a.at !== b.at ? a.at - b.at : a.kind === "accept" ? -1 : 1));
  return events;
}

function configFor(
  symbol: string,
  period: string,
  edge: number,
  overrides?: Partial<RiskConfig>,
): RiskConfig {
  return {
    ...defaultRiskConfig(symbol, period),
    platformEdge: edge,
    ...overrides,
  };
}

function emptyGroup(key: string, symbol: string, period: string, direction: string | null): GroupMetrics {
  return {
    key,
    symbol,
    period,
    direction,
    decided: 0,
    win: 0,
    lose: 0,
    draw: 0,
    settledStake: 0,
    observedWinRate: 0,
    meanPayoutRate: 0,
    platformPnl: 0,
    platformReturn: 0,
    clampedQuotes: 0,
  };
}

// Per-order assigned payout for a given edge, derived by replaying the real order
// timeline through the vendor exposure book + pricing. The payout each order faces
// is quoted from the book state *before* that order is added (the book it arrived
// into), then the order's open position affects everyone after it.
function assignPayouts(
  orders: SimOrder[],
  edge: number,
  opts: SweepOptions,
): Map<string, { payout: number; clamped: boolean }> {
  const book = new ExposureBook();
  const timeline = buildTimeline(orders);
  const assigned = new Map<string, { payout: number; clamped: boolean }>();
  const prevQuote = new Map<string, PreviousQuote>();
  let seq = 0;

  for (const ev of timeline) {
    seq += 1;
    const { order } = ev;
    const pkey = `${order.symbol}::${order.period}`;

    if (ev.kind === "accept") {
      const config = configFor(order.symbol, order.period, edge, opts.configOverrides);
      const exposure = book.getExposure(order.symbol, order.period);
      const previousQuote = opts.rateLimit ? prevQuote.get(pkey) : undefined;
      let payout: number;
      let clamped: boolean;
      try {
        const quote = buildQuote({ config, exposure, previousQuote, now: ev.at });
        payout = order.direction === "LONG" ? quote.rUp : quote.rDown;
        clamped = quote.clampReason !== null;
        prevQuote.set(pkey, { rUp: quote.rUp, rDown: quote.rDown, generatedAt: quote.generatedAt });
      } catch {
        const quote = fallbackQuote({ config, exposure, now: ev.at, reason: "sweep_fallback" });
        payout = order.direction === "LONG" ? quote.rUp : quote.rDown;
        clamped = true;
      }
      assigned.set(order.orderId, { payout, clamped });

      const acceptEvent: RiskEvent = {
        eventId: `${order.orderId}:ACCEPTED`,
        sequence: seq,
        occurredAt: ev.at,
        publishedAt: ev.at,
        type: "ORDER_ACCEPTED",
        payload: {
          orderId: order.orderId,
          symbol: order.symbol,
          period: order.period,
          direction: order.direction,
          stake: order.stake,
        },
      };
      book.applyEvent(acceptEvent);
    } else {
      const releaseEvent: RiskEvent = {
        eventId: `${order.orderId}:RELEASE`,
        sequence: seq,
        occurredAt: ev.at,
        publishedAt: ev.at,
        type: order.result === "DRAW" ? "ORDER_REFUNDED" : "ORDER_SETTLED",
        payload: {
          orderId: order.orderId,
          symbol: order.symbol,
          period: order.period,
          direction: order.direction,
          stake: order.stake,
        },
      };
      book.applyEvent(releaseEvent);
    }
  }

  return assigned;
}

function aggregate(
  orders: SimOrder[],
  payoutOf: (o: SimOrder) => { payout: number; clamped: boolean },
  byDirection: boolean,
): { groups: GroupMetrics[]; overall: GroupMetrics } {
  const groups = new Map<string, GroupMetrics>();
  const overall = emptyGroup("ALL", "ALL", "ALL", null);
  let overallPayoutSum = 0;

  // Per-group running payout sum (over decided orders) for the mean.
  const payoutSum = new Map<string, number>();

  for (const o of orders) {
    const key = groupKey(o, byDirection);
    let g = groups.get(key);
    if (!g) {
      g = emptyGroup(key, o.symbol, o.period, byDirection ? o.direction : null);
      groups.set(key, g);
      payoutSum.set(key, 0);
    }
    const { payout, clamped } = payoutOf(o);
    if (clamped) {
      g.clampedQuotes += 1;
      overall.clampedQuotes += 1;
    }

    if (o.result === "DRAW") {
      g.draw += 1;
      overall.draw += 1;
      continue;
    }

    g.decided += 1;
    overall.decided += 1;
    g.settledStake += o.stake;
    overall.settledStake += o.stake;
    payoutSum.set(key, (payoutSum.get(key) ?? 0) + payout);
    overallPayoutSum += payout;

    if (o.result === "WIN") {
      g.win += 1;
      overall.win += 1;
      g.platformPnl -= o.stake * payout;
      overall.platformPnl -= o.stake * payout;
    } else {
      g.lose += 1;
      overall.lose += 1;
      g.platformPnl += o.stake;
      overall.platformPnl += o.stake;
    }
  }

  for (const [key, g] of groups) {
    g.observedWinRate = g.decided > 0 ? g.win / g.decided : 0;
    g.meanPayoutRate = g.decided > 0 ? (payoutSum.get(key) ?? 0) / g.decided : 0;
    g.platformReturn = g.settledStake > 0 ? g.platformPnl / g.settledStake : 0;
  }
  overall.observedWinRate = overall.decided > 0 ? overall.win / overall.decided : 0;
  overall.meanPayoutRate = overall.decided > 0 ? overallPayoutSum / overall.decided : 0;
  overall.platformReturn = overall.settledStake > 0 ? overall.platformPnl / overall.settledStake : 0;

  const sortedGroups = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { groups: sortedGroups, overall };
}

// One edge evaluated against the dataset.
export function evaluateEdge(orders: SimOrder[], edge: number, opts: SweepOptions): EdgeResult {
  const assigned = assignPayouts(orders, edge, opts);
  const payoutOf = (o: SimOrder) =>
    assigned.get(o.orderId) ?? { payout: 0, clamped: false };
  const { groups, overall } = aggregate(orders, payoutOf, opts.byDirection ?? false);
  return { edge, label: `edge=${edge.toFixed(4)}`, groups, overall };
}

// Reference row: what the live staging static payout table actually produced. Lets
// us compare the vendor edge regimes against the current platform configuration.
export function evaluateStaticBaseline(orders: SimOrder[], opts: SweepOptions): EdgeResult {
  const payoutOf = (o: SimOrder) => ({ payout: o.staticPayoutRate, clamped: false });
  const { groups, overall } = aggregate(orders, payoutOf, opts.byDirection ?? false);
  return { edge: Number.NaN, label: "staging-static", groups, overall };
}

export interface SweepResult {
  generatedAt: string;
  orderCount: number;
  edges: number[];
  byDirection: boolean;
  rateLimit: boolean;
  staticBaseline: EdgeResult;
  results: EdgeResult[];
}

export function sweep(orders: SimOrder[], opts: SweepOptions): SweepResult {
  const sortedEdges = [...opts.edges].sort((a, b) => a - b);
  return {
    generatedAt: new Date().toISOString(),
    orderCount: orders.length,
    edges: sortedEdges,
    byDirection: opts.byDirection ?? false,
    rateLimit: opts.rateLimit ?? false,
    staticBaseline: evaluateStaticBaseline(orders, opts),
    results: sortedEdges.map((edge) => evaluateEdge(orders, edge, opts)),
  };
}

// Smallest edge whose overall platform return clears `minReturn` (margin), per
// window key. Returns null for a window that never clears within the swept edges.
export function pickSafeEdge(
  result: SweepResult,
  minReturn = 0,
): Map<string, { edge: number; platformReturn: number; meanPayoutRate: number } | null> {
  const byWindow = new Map<string, { edge: number; platformReturn: number; meanPayoutRate: number } | null>();
  const windowKeys = new Set<string>();
  for (const r of result.results) for (const g of r.groups) windowKeys.add(g.key);

  for (const key of windowKeys) {
    let chosen: { edge: number; platformReturn: number; meanPayoutRate: number } | null = null;
    for (const r of result.results) {
      const g = r.groups.find((x) => x.key === key);
      if (g && g.decided > 0 && g.platformReturn >= minReturn) {
        chosen = { edge: r.edge, platformReturn: g.platformReturn, meanPayoutRate: g.meanPayoutRate };
        break; // results are edge-ascending, so the first hit is the smallest edge
      }
    }
    byWindow.set(key, chosen);
  }
  return byWindow;
}
