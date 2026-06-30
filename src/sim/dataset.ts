import { readFileSync } from "node:fs";

import type { Direction, Period } from "../core/types.js";

// A settled order distilled from a hedge-test `events.jsonl` record. We keep only
// what the offline replay needs. Win/lose is price-driven and payout-independent,
// so it is valid to reuse these real outcomes under any simulated platform_edge.
export interface SimOrder {
  orderId: string;
  symbol: string;
  period: Period;
  direction: Direction;
  stake: number;
  acceptAtMs: number;
  settleAtMs: number;
  result: "WIN" | "LOSE" | "DRAW";
  // The payout the live (staging) platform actually used for this order. Used only
  // as a "staging static" reference column, never for the edge sweep itself.
  staticPayoutRate: number;
}

export interface DatasetLoadResult {
  orders: SimOrder[];
  totalRecords: number;
  acceptedRecords: number;
  settledOrders: number;
  droppedUnsettled: number;
  droppedMalformed: number;
}

function toMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function asDirection(value: unknown): Direction | null {
  return value === "LONG" || value === "SHORT" ? value : null;
}

function asResult(value: unknown): SimOrder["result"] | null {
  return value === "WIN" || value === "LOSE" || value === "DRAW" ? value : null;
}

/**
 * Read a hedge-test `events.jsonl` file and return the accepted, settled orders.
 *
 * hedge-test writes one `order-attempt` record per placement and a later
 * `order-final` record once the order reaches a terminal status. We consume the
 * `order-final` records (they carry both placement and settlement fields). Records
 * still open / timed-out and malformed records are dropped so every order in the
 * timeline has both an accept and a release, keeping the replayed exposure book
 * internally consistent.
 */
export function loadDataset(path: string): DatasetLoadResult {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");

  const orders: SimOrder[] = [];
  let totalRecords = 0;
  let acceptedRecords = 0;
  let settledOrders = 0;
  let droppedUnsettled = 0;
  let droppedMalformed = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type !== "order-final") continue;
    totalRecords += 1;
    if (rec.accepted !== true) continue;
    acceptedRecords += 1;

    const result = asResult(rec.settlementResult);
    if (!result) {
      droppedUnsettled += 1;
      continue;
    }

    const request = rec.request as Record<string, unknown> | undefined;
    const orderId =
      typeof rec.platformOrderId === "string" && rec.platformOrderId
        ? rec.platformOrderId
        : typeof rec.localId === "string"
          ? rec.localId
          : null;
    const symbol = typeof request?.symbolId === "string" ? request.symbolId : null;
    const period = typeof request?.periodId === "string" ? (request.periodId as Period) : null;
    const direction = asDirection(request?.direction);
    const stake = request?.amount !== undefined ? Number(request.amount) : NaN;
    const acceptAtMs = toMs(rec.receivedAt) ?? toMs(rec.sentAt);
    const settleAtMs = toMs(rec.settledAt);
    const staticPayoutRate = Number(rec.payoutRateSnapshot ?? "0");

    if (
      !orderId ||
      !symbol ||
      !period ||
      !direction ||
      !Number.isFinite(stake) ||
      stake <= 0 ||
      acceptAtMs === null ||
      settleAtMs === null
    ) {
      droppedMalformed += 1;
      continue;
    }

    settledOrders += 1;
    orders.push({
      orderId,
      symbol,
      period,
      direction,
      stake,
      acceptAtMs,
      // Guard against a settle timestamp that predates accept (clock skew).
      settleAtMs: Math.max(settleAtMs, acceptAtMs),
      result,
      staticPayoutRate: Number.isFinite(staticPayoutRate) ? staticPayoutRate : 0,
    });
  }

  return { orders, totalRecords, acceptedRecords, settledOrders, droppedUnsettled, droppedMalformed };
}
