import type { Direction } from "../core/types.js";

import { SeededRandom } from "./random.js";
import { periodToMs } from "./time.js";
import type { BacktestProduct, SyntheticOrder } from "./types.js";

export interface GenerateFlowOptions {
  products: BacktestProduct[];
  startTimeMs: number;
  endTimeMs: number;
  ordersPerProductWindow: number;
  minOrdersPerProductWindow: number;
  seed: number;
  minStake?: number;
  maxStake?: number;
}

export function productKey(product: BacktestProduct): string {
  return `${product.symbol}|${product.period}`;
}

export function generateSyntheticOrders(options: GenerateFlowOptions): SyntheticOrder[] {
  if (options.ordersPerProductWindow < options.minOrdersPerProductWindow) {
    throw new Error(
      `ordersPerProductWindow ${options.ordersPerProductWindow} must be >= ${options.minOrdersPerProductWindow}`,
    );
  }

  const rng = new SeededRandom(options.seed);
  const minStake = options.minStake ?? 10;
  const maxStake = options.maxStake ?? 100;
  const orders: SyntheticOrder[] = [];

  for (const product of options.products) {
    const durationMs = periodToMs(product.period);
    const latestAccept = options.endTimeMs - durationMs - 1000;
    if (latestAccept <= options.startTimeMs) {
      throw new Error(`Not enough price history for ${productKey(product)}`);
    }

    for (let i = 0; i < options.ordersPerProductWindow; i += 1) {
      const at = options.startTimeMs + rng.int(0, Math.floor((latestAccept - options.startTimeMs) / 1000)) * 1000;
      const direction: Direction = rng.next() < 0.5 ? "LONG" : "SHORT";
      const stake = Math.round((minStake + rng.next() * (maxStake - minStake)) * 100) / 100;
      orders.push({
        orderId: `${product.symbol}-${product.period}-${i}-${options.seed}`,
        symbol: product.symbol,
        period: product.period,
        direction,
        stake,
        acceptAtMs: at,
      });
    }
  }

  return orders.sort((a, b) => a.acceptAtMs - b.acceptAtMs || a.orderId.localeCompare(b.orderId));
}

