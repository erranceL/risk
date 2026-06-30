import assert from "node:assert/strict";
import test from "node:test";

import { generateSyntheticOrders } from "../src/backtest/flow.js";
import { buildIndexSeriesFromKlines } from "../src/backtest/index-price.js";
import { PriceTimeline } from "../src/backtest/klines.js";
import { scoreRisk } from "../src/backtest/risk-score.js";
import { settleSyntheticOrders } from "../src/backtest/settle.js";
import type { ExchangeKline, IndexSeries } from "../src/backtest/types.js";

function row(openTimeMs: number, close: number): ExchangeKline {
  return {
    openTimeMs,
    closeTimeMs: openTimeMs + 999,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  };
}

test("index price combines spot and perpetual closes by configured weights", () => {
  const series = buildIndexSeriesFromKlines({
    symbol: "BTC",
    interval: "1s",
    spot: [row(1000, 100), row(2000, 110)],
    perp: [row(1000, 200), row(2000, 210)],
    weightSpot: 0.2,
    weightPerp: 0.8,
  });
  assert.equal(series.points[0]!.close, 180);
  assert.equal(series.points[1]!.close, 190);
  assert.equal(series.gapRatio, 0);
});

test("flow enforces at least 2000 orders per product window", () => {
  assert.throws(() =>
    generateSyntheticOrders({
      products: [{ symbol: "BTC", period: "30s" }],
      startTimeMs: 0,
      endTimeMs: 120_000,
      ordersPerProductWindow: 1999,
      minOrdersPerProductWindow: 2000,
      seed: 1,
    }),
  );

  const orders = generateSyntheticOrders({
    products: [{ symbol: "BTC", period: "30s" }],
    startTimeMs: 0,
    endTimeMs: 120_000,
    ordersPerProductWindow: 2000,
    minOrdersPerProductWindow: 2000,
    seed: 1,
  });
  assert.equal(orders.length, 2000);
});

test("settlement uses entry plus one second and product duration", () => {
  const points = Array.from({ length: 40 }, (_, i) => ({
    atMs: i * 1000,
    close: 100 + i,
    spotClose: 100 + i,
    perpClose: 100 + i,
  }));
  const series: IndexSeries = {
    symbol: "BTC",
    interval: "1s",
    weightSpot: 0.2,
    weightPerp: 0.8,
    points,
    gapRatio: 0,
    source: { spot: "test", perp: "test" },
  };
  const [settled] = settleSyntheticOrders(
    [
      {
        orderId: "o-1",
        symbol: "BTC",
        period: "30s",
        direction: "LONG",
        stake: 10,
        acceptAtMs: 0,
      },
    ],
    new PriceTimeline([series]),
  );
  assert.equal(settled!.entryPrice, 101);
  assert.equal(settled!.settlementPrice, 130);
  assert.equal(settled!.result, "WIN");
});

test("risk score stays within 1-10 and rises at break-even pressure", () => {
  const low = scoreRisk({
    payoutRate: 0.8,
    winRate: 0.45,
    longStake: 100,
    shortStake: 100,
    realizedVol: 0,
    maxLossCap: 100,
  });
  const high = scoreRisk({
    payoutRate: 0.8,
    winRate: 1 / 1.8,
    longStake: 100,
    shortStake: 10,
    realizedVol: 0.001,
    maxLossCap: 100,
  });
  assert.ok(low.level >= 1 && low.level <= 10);
  assert.ok(high.level >= low.level);
});

