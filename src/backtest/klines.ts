import type { BacktestSymbol, IndexSeries } from "./types.js";

export class PriceTimeline {
  private readonly bySymbol = new Map<BacktestSymbol, IndexSeries>();

  constructor(series: IndexSeries[]) {
    for (const item of series) {
      if (item.interval !== "1s") continue;
      this.bySymbol.set(item.symbol, item);
    }
  }

  getSeries(symbol: BacktestSymbol): IndexSeries {
    const series = this.bySymbol.get(symbol);
    if (!series) throw new Error(`Missing 1s index series for ${symbol}`);
    return series;
  }

  priceAt(symbol: BacktestSymbol, atMs: number): number {
    const series = this.getSeries(symbol);
    const points = series.points;
    if (points.length === 0) throw new Error(`Empty index series for ${symbol}`);
    const idx = binarySearchFloor(points.map((p) => p.atMs), Math.floor(atMs / 1000) * 1000);
    if (idx < 0) throw new Error(`No price for ${symbol} at ${new Date(atMs).toISOString()}`);
    return points[idx]!.close;
  }

  realizedVol(symbol: BacktestSymbol, fromMs: number, toMs: number): number {
    const series = this.getSeries(symbol);
    const points = series.points.filter((p) => p.atMs >= fromMs && p.atMs <= toMs);
    if (points.length < 2) return 0;
    const returns: number[] = [];
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1]!.close;
      const curr = points[i]!.close;
      if (prev > 0 && curr > 0) returns.push(Math.log(curr / prev));
    }
    if (returns.length === 0) return 0;
    const mean = returns.reduce((sum, x) => sum + x, 0) / returns.length;
    const variance = returns.reduce((sum, x) => sum + (x - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }
}

function binarySearchFloor(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid]! <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

