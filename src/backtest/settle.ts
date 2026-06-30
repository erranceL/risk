import type { SimOrder } from "../sim/dataset.js";

import { PriceTimeline } from "./klines.js";
import { periodToMs } from "./time.js";
import type { SyntheticOrder } from "./types.js";

export interface SettledBacktestOrder extends SimOrder {
  entryPrice: number;
  settlementPrice: number;
}

export function settleSyntheticOrders(
  orders: SyntheticOrder[],
  prices: PriceTimeline,
): SettledBacktestOrder[] {
  return orders.map((order) => {
    const entryAtMs = order.acceptAtMs + 1000;
    const settleAtMs = order.acceptAtMs + periodToMs(order.period);
    const entryPrice = prices.priceAt(order.symbol, entryAtMs);
    const settlementPrice = prices.priceAt(order.symbol, settleAtMs);
    const compare =
      settlementPrice > entryPrice ? "UP" : settlementPrice < entryPrice ? "DOWN" : "DRAW";
    const result =
      compare === "DRAW"
        ? "DRAW"
        : (compare === "UP" && order.direction === "LONG") ||
            (compare === "DOWN" && order.direction === "SHORT")
          ? "WIN"
          : "LOSE";

    return {
      ...order,
      settleAtMs,
      result,
      staticPayoutRate: 0,
      entryPrice,
      settlementPrice,
    };
  });
}

