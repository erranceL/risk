import assert from "node:assert/strict";
import test from "node:test";
import { buildQuote, fallbackQuote, houseEdgeForRates } from "../src/core/pricing.js";
import { defaultRiskConfig } from "../src/config/defaults.js";

test("platform edge derives symmetric base payout", () => {
  const config = defaultRiskConfig("BTC", "30s");
  const quote = buildQuote({
    config,
    exposure: {
      symbol: "BTC",
      period: "30s",
      longStake: 0,
      shortStake: 0,
      cursor: "event-seq-0",
      updatedAt: 0,
    },
    now: 1_000,
  });

  assert.equal(quote.rUp, 0.9);
  assert.equal(quote.rDown, 0.9);
  assert.ok(quote.houseEdge >= 0);
});

test("crowded long side receives lower up payout", () => {
  const config = defaultRiskConfig("BTC", "30s");
  const quote = buildQuote({
    config,
    exposure: {
      symbol: "BTC",
      period: "30s",
      longStake: 900,
      shortStake: 100,
      cursor: "event-seq-10",
      updatedAt: 0,
    },
    now: 2_000,
  });

  assert.ok(quote.rUp < quote.rDown);
  assert.ok(houseEdgeForRates(quote.rUp, quote.rDown) >= 0);
});

test("payout guardrails clamp extreme settings", () => {
  const config = {
    ...defaultRiskConfig("BTC", "30s"),
    platformEdge: 0.01,
    probabilitySkewSensitivity: 0.5,
    probabilitySkewMax: 0.45,
    probabilityMin: 0.05,
    probabilityMax: 0.95,
  };
  const quote = buildQuote({
    config,
    exposure: {
      symbol: "BTC",
      period: "30s",
      longStake: 10_000,
      shortStake: 0,
      cursor: "event-seq-20",
      updatedAt: 0,
    },
    now: 3_000,
  });

  assert.ok(quote.rUp >= config.publishMinReturnRate);
  assert.ok(quote.rDown <= config.publishMaxReturnRate);
  assert.ok(quote.clampReason);
});

test("fallback quote is symmetric, conservative and non-negative edge", () => {
  const config = defaultRiskConfig("BTC", "30s");
  const quote = fallbackQuote({
    config,
    exposure: {
      symbol: "BTC",
      period: "30s",
      longStake: 5_000,
      shortStake: 0,
      cursor: "event-seq-0",
      updatedAt: 0,
    },
    now: 4_000,
    reason: "exposure_gap",
  });

  assert.equal(quote.rUp, quote.rDown);
  assert.equal(quote.rUp, config.publishMinReturnRate);
  assert.equal(quote.riskSignal, "fallback");
  assert.equal(quote.clampReason, "exposure_gap");
  assert.ok(quote.houseEdge >= 0);
});
