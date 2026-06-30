import assert from "node:assert/strict";
import test from "node:test";

import { evaluateEdge, pickSafeEdge, sweep } from "../src/sim/edge-sweep.js";
import type { SimOrder } from "../src/sim/dataset.js";

// Build a balanced (long==short) order book so exposure skew stays ~0 and payouts
// are symmetric, making the PnL math hand-checkable.
function balancedOrders(
  count: number,
  winRate: number,
  stake = 10,
  period = "30s",
): SimOrder[] {
  const orders: SimOrder[] = [];
  const wins = Math.round(count * winRate);
  for (let i = 0; i < count; i++) {
    const base = 1_000_000 + i * 1000;
    orders.push({
      orderId: `o-${i}`,
      symbol: "BTC",
      period,
      // Alternate direction so the book is balanced over time.
      direction: i % 2 === 0 ? "LONG" : "SHORT",
      stake,
      acceptAtMs: base,
      // Settle quickly so positions release before they distort later quotes.
      settleAtMs: base + 100,
      result: i < wins ? "WIN" : "LOSE",
      staticPayoutRate: 0.85,
    });
  }
  return orders;
}

test("symmetric edge 0.05 yields ~0.9 payout and hand-checkable platform return", () => {
  // 100 orders, 50% win rate, edge 0.05 => payout 0.9 (1 - 2*edge), balanced book.
  const orders = balancedOrders(100, 0.5);
  const res = evaluateEdge(orders, 0.05, { edges: [0.05] });
  const o = res.overall;
  assert.equal(o.decided, 100);
  assert.ok(Math.abs(o.meanPayoutRate - 0.9) < 1e-6, `payout ${o.meanPayoutRate}`);
  // platformReturn = (1 - w) - w * payout = 0.5 - 0.5*0.9 = 0.05.
  assert.ok(Math.abs(o.platformReturn - 0.05) < 1e-6, `return ${o.platformReturn}`);
});

test("a higher edge raises platform return for the same outcomes", () => {
  const orders = balancedOrders(100, 0.5);
  const low = evaluateEdge(orders, 0.03, { edges: [0.03] }).overall.platformReturn;
  const high = evaluateEdge(orders, 0.1, { edges: [0.1] }).overall.platformReturn;
  assert.ok(high > low, `expected ${high} > ${low}`);
});

test("user win-rate is invariant to edge (price-driven observation)", () => {
  const orders = balancedOrders(80, 0.6);
  const a = evaluateEdge(orders, 0.02, { edges: [0.02] }).overall.observedWinRate;
  const b = evaluateEdge(orders, 0.12, { edges: [0.12] }).overall.observedWinRate;
  assert.equal(a, b);
  assert.ok(Math.abs(a - 0.6) < 1e-9);
});

test("platform loses at a 60% win-rate under a generous payout, profits as edge rises", () => {
  // w=0.6: break-even payout = (1-w)/w = 0.6667 => need edge >= ~0.1667.
  const orders = balancedOrders(100, 0.6);
  // Allow payouts below the default 0.65 publish floor so the search can reach
  // the break-even region.
  const result = sweep(orders, {
    edges: [0.05, 0.1, 0.15, 0.17, 0.2],
    configOverrides: { publishMinReturnRate: 0.4, payoutRateFloor: 0.4 },
  });
  const lowEdge = result.results.find((r) => r.edge === 0.05)!;
  assert.ok(lowEdge.overall.platformReturn < 0, "platform should lose at edge 0.05, w=0.6");

  const safe = pickSafeEdge(result, 0);
  const chosen = safe.get("BTC|30s");
  assert.ok(chosen, "expected a safe edge to exist within range");
  assert.ok(chosen!.platformReturn >= 0);
  assert.ok(chosen!.edge >= 0.15, `chosen edge ${chosen!.edge} should be in the break-even region`);
});

test("DRAW is excluded from win-rate and contributes 0 PnL", () => {
  const orders = balancedOrders(10, 0.5);
  orders.push({
    orderId: "draw-1",
    symbol: "BTC",
    period: "30s",
    direction: "LONG",
    stake: 50,
    acceptAtMs: 2_000_000,
    settleAtMs: 2_000_100,
    result: "DRAW",
    staticPayoutRate: 0.85,
  });
  const res = evaluateEdge(orders, 0.05, { edges: [0.05] });
  assert.equal(res.overall.decided, 10);
  assert.equal(res.overall.draw, 1);
});
