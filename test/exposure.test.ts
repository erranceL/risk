import assert from "node:assert/strict";
import test from "node:test";
import { ExposureBook } from "../src/core/exposure.js";
import type { RiskEvent } from "../src/core/types.js";

function event(sequence: number, orderId: string, type: RiskEvent["type"] = "ORDER_ACCEPTED"): RiskEvent {
  return {
    eventId: `evt-${sequence}-${type}`,
    sequence,
    occurredAt: 1_000 + sequence,
    publishedAt: 1_000 + sequence,
    type,
    payload: {
      orderId,
      symbol: "BTC",
      period: "30s",
      direction: "LONG",
      stake: 10,
      eventEndTime: 10_000,
    },
  };
}

test("applies events idempotently", () => {
  const book = new ExposureBook();
  const first = event(1, "order-1");
  assert.equal(book.applyEvent(first).accepted, true);
  assert.equal(book.applyEvent(first).duplicate, true);
  assert.equal(book.getExposure("BTC", "30s").longStake, 10);
});

test("removes positions on terminal events", () => {
  const book = new ExposureBook();
  book.applyEvent(event(1, "order-1"));
  book.applyEvent(event(2, "order-1", "ORDER_SETTLED"));
  assert.equal(book.getExposure("BTC", "30s").longStake, 0);
});

test("detects sequence gap and clears it once filled", () => {
  const book = new ExposureBook();
  const gapped = book.applyEvent(event(3, "order-3"));
  assert.equal(gapped.sequenceGap, true);
  assert.equal(book.needsResync(), true);
  // cursor stays at the safe contiguous watermark (0) while the gap is open
  assert.equal(book.getExposure("BTC", "30s").cursor, "event-seq-0");

  book.applyEvent(event(1, "order-1"));
  assert.equal(book.needsResync(), true);
  const filled = book.applyEvent(event(2, "order-2"));
  assert.equal(filled.sequenceGap, false);
  assert.equal(book.needsResync(), false);
  assert.equal(book.getExposure("BTC", "30s").cursor, "event-seq-3");
});

test("out-of-order terminal before open does not resurrect position", () => {
  const book = new ExposureBook();
  // Settle arrives first (seq 2), then the late accept (seq 1).
  book.applyEvent(event(2, "order-1", "ORDER_SETTLED"));
  book.applyEvent(event(1, "order-1", "ORDER_ACCEPTED"));
  assert.equal(book.getExposure("BTC", "30s").longStake, 0);
  assert.equal(book.getOpenCount(), 0);
});

test("rejects invalid sequence and does not mutate exposure", () => {
  const book = new ExposureBook();
  const invalid: RiskEvent = {
    ...event(1, "order-invalid"),
    sequence: Number.NaN,
  };
  const result = book.applyEvent(invalid);
  assert.equal(result.accepted, false);
  assert.equal(book.getOpenCount(), 0);
});

test("rebuild from snapshot resets resync state", () => {
  const book = new ExposureBook();
  book.applyEvent(event(5, "order-5"));
  assert.equal(book.needsResync(), true);
  book.rebuildFromSnapshot({ snapshotCursor: "event-seq-5", positions: [] });
  assert.equal(book.needsResync(), false);
  assert.equal(book.getExposure("BTC", "30s").longStake, 0);
});

test("rebuilds from snapshot", () => {
  const book = new ExposureBook();
  book.rebuildFromSnapshot({
    snapshotCursor: "event-seq-7",
    positions: [
      {
        orderId: "order-1",
        symbol: "BTC",
        period: "30s",
        direction: "SHORT",
        stake: 12,
      },
    ],
  });
  const exposure = book.getExposure("BTC", "30s");
  assert.equal(exposure.shortStake, 12);
  assert.equal(exposure.cursor, "event-seq-7");
});
