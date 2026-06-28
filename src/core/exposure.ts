import type {
  Direction,
  EventApplyResult,
  ExposureState,
  OpenPositionSnapshot,
  Period,
  RiskEvent,
  RiskEventPayload,
} from "./types.js";

interface Position {
  orderId: string;
  symbol: string;
  period: Period;
  direction: Direction;
  stake: number;
  eventEndTime?: number;
}

interface Aggregate {
  longStake: number;
  shortStake: number;
}

const OPEN_EVENT_TYPES = new Set(["ORDER_ACCEPTED", "ORDER_PRICED", "ORDER_HELD"]);
const TERMINAL_EVENT_TYPES = new Set(["ORDER_SETTLED", "ORDER_REFUNDED", "ORDER_CANCELED"]);

function keyFor(symbol: string, period: Period): string {
  return `${symbol}::${period}`;
}

function cursorFromSequence(sequence: number): string {
  return `event-seq-${sequence}`;
}

function sequenceFromCursor(cursor: string): number {
  const match = /^event-seq-(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}

// FIFO-bounded membership set to keep dedup/closed-order tracking memory bounded.
class BoundedSet {
  private readonly set = new Set<string>();
  private readonly queue: string[] = [];

  constructor(private readonly max: number) {}

  has(key: string): boolean {
    return this.set.has(key);
  }

  add(key: string): void {
    if (this.set.has(key)) return;
    this.set.add(key);
    this.queue.push(key);
    if (this.queue.length > this.max) {
      const evicted = this.queue.shift();
      if (evicted !== undefined) this.set.delete(evicted);
    }
  }

  clear(): void {
    this.set.clear();
    this.queue.length = 0;
  }

  get size(): number {
    return this.set.size;
  }
}

export class ExposureBook {
  private readonly positions = new Map<string, Position>();
  private readonly aggregates = new Map<string, Aggregate>();
  private readonly seenEvents: BoundedSet;
  private readonly closedOrders: BoundedSet;

  // Highest sequence with no gaps below it; the safe cursor we advertise.
  private contiguousSequence = 0;
  private highestSequence = 0;
  // Sequences seen above the contiguous watermark (the gap buffer).
  private readonly pendingSequences = new Set<number>();
  private updatedAt = Date.now();

  constructor(options: { dedupCapacity?: number; closedCapacity?: number } = {}) {
    this.seenEvents = new BoundedSet(options.dedupCapacity ?? 200_000);
    this.closedOrders = new BoundedSet(options.closedCapacity ?? 200_000);
  }

  rebuildFromSnapshot(snapshot: OpenPositionSnapshot): void {
    this.positions.clear();
    this.aggregates.clear();
    this.pendingSequences.clear();
    this.seenEvents.clear();
    this.closedOrders.clear();
    for (const payload of snapshot.positions) {
      this.upsertPosition(payload);
    }
    const seq = sequenceFromCursor(snapshot.snapshotCursor);
    this.contiguousSequence = seq;
    this.highestSequence = seq;
    this.updatedAt = Date.now();
  }

  applyEvent(event: RiskEvent): EventApplyResult {
    if (!event.eventId || !Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
      return this.result(false, false);
    }
    if (this.seenEvents.has(event.eventId)) {
      return this.result(false, true);
    }
    this.seenEvents.add(event.eventId);

    // Operations are applied commutatively so that out-of-order arrivals
    // (e.g. a settle that lands before its accept) still converge correctly.
    this.applyOperation(event);
    this.trackSequence(event.sequence);
    this.updatedAt = Date.now();

    return this.result(true, false);
  }

  getExposure(symbol: string, period: Period): ExposureState {
    const aggregate = this.aggregates.get(keyFor(symbol, period));
    return {
      symbol,
      period,
      longStake: aggregate?.longStake ?? 0,
      shortStake: aggregate?.shortStake ?? 0,
      cursor: cursorFromSequence(this.contiguousSequence),
      updatedAt: this.updatedAt,
    };
  }

  getOpenCount(): number {
    return this.positions.size;
  }

  // True when there is at least one missing sequence below the highest seen.
  needsResync(): boolean {
    return this.highestSequence > this.contiguousSequence;
  }

  getGapDepth(): number {
    return Math.max(0, this.highestSequence - this.contiguousSequence);
  }

  getCursor(): string {
    return cursorFromSequence(this.contiguousSequence);
  }

  private result(accepted: boolean, duplicate: boolean): EventApplyResult {
    return {
      accepted,
      duplicate,
      sequenceGap: this.needsResync(),
      cursor: cursorFromSequence(this.contiguousSequence),
    };
  }

  private applyOperation(event: RiskEvent): void {
    const { orderId } = event.payload;
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      this.removePosition(orderId);
      this.closedOrders.add(orderId);
      return;
    }
    if (OPEN_EVENT_TYPES.has(event.type)) {
      // A terminal event already seen for this order wins regardless of order.
      if (this.closedOrders.has(orderId)) return;
      this.upsertPosition(event.payload);
    }
  }

  private trackSequence(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return;
    if (sequence > this.highestSequence) this.highestSequence = sequence;
    if (sequence <= this.contiguousSequence) return;

    this.pendingSequences.add(sequence);
    // Drain contiguous run starting just above the watermark.
    while (this.pendingSequences.has(this.contiguousSequence + 1)) {
      this.pendingSequences.delete(this.contiguousSequence + 1);
      this.contiguousSequence += 1;
    }
  }

  private upsertPosition(payload: RiskEventPayload): void {
    const existing = this.positions.get(payload.orderId);
    if (existing) {
      this.adjustAggregate(existing, -1);
    }
    const position: Position = {
      orderId: payload.orderId,
      symbol: payload.symbol,
      period: payload.period,
      direction: payload.direction,
      stake: payload.stake,
      eventEndTime: payload.eventEndTime,
    };
    this.positions.set(payload.orderId, position);
    this.adjustAggregate(position, 1);
  }

  private removePosition(orderId: string): void {
    const existing = this.positions.get(orderId);
    if (!existing) return;
    this.adjustAggregate(existing, -1);
    this.positions.delete(orderId);
  }

  private adjustAggregate(position: Position, sign: 1 | -1): void {
    const key = keyFor(position.symbol, position.period);
    const aggregate = this.aggregates.get(key) ?? { longStake: 0, shortStake: 0 };
    if (position.direction === "LONG") {
      aggregate.longStake += sign * position.stake;
    } else {
      aggregate.shortStake += sign * position.stake;
    }
    // Guard against tiny negative drift from float arithmetic.
    if (aggregate.longStake < 0) aggregate.longStake = 0;
    if (aggregate.shortStake < 0) aggregate.shortStake = 0;
    if (aggregate.longStake === 0 && aggregate.shortStake === 0) {
      this.aggregates.delete(key);
    } else {
      this.aggregates.set(key, aggregate);
    }
  }
}
