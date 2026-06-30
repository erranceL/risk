import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BacktestSymbol, ExchangeKline, IndexPoint, IndexSeries, KlineInterval } from "./types.js";

export const SYMBOL_TO_BINANCE: Record<BacktestSymbol, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  XAU: "PAXGUSDT",
};

export interface BuildIndexSeriesOptions {
  symbol: BacktestSymbol;
  interval: KlineInterval;
  startTimeMs: number;
  endTimeMs: number;
  weightSpot: number;
  weightPerp: number;
  cacheDir: string;
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
}

interface CachedKlines {
  fetchedAt: string;
  source: "spot" | "perp";
  symbol: BacktestSymbol;
  binanceSymbol: string;
  interval: KlineInterval;
  startTimeMs: number;
  endTimeMs: number;
  rows: ExchangeKline[];
}

function cachePath(
  cacheDir: string,
  source: "spot" | "perp",
  symbol: BacktestSymbol,
  interval: KlineInterval,
  startTimeMs: number,
  endTimeMs: number,
): string {
  return join(cacheDir, source, `${symbol}-${interval}-${startTimeMs}-${endTimeMs}.json`);
}

function parseKlineRow(row: unknown[]): ExchangeKline {
  const [openTimeMs, open, high, low, close, volume, closeTimeMs] = row as [
    number,
    string,
    string,
    string,
    string,
    string,
    number,
  ];
  return {
    openTimeMs,
    closeTimeMs,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  };
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadExchangeKlines(
  source: "spot" | "perp",
  options: BuildIndexSeriesOptions,
): Promise<ExchangeKline[]> {
  const binanceSymbol = SYMBOL_TO_BINANCE[options.symbol];
  const path = cachePath(
    options.cacheDir,
    source,
    options.symbol,
    options.interval,
    options.startTimeMs,
    options.endTimeMs,
  );
  if (!options.forceRefresh && existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, "utf8")) as CachedKlines;
    return cached.rows;
  }

  mkdirSync(join(options.cacheDir, source), { recursive: true });
  const fetchImpl = options.fetchImpl ?? fetch;
  const rows: ExchangeKline[] = [];
  let cursor = options.startTimeMs;
  const pageMs = options.interval === "1s" ? 1000 : 60_000;

  while (cursor <= options.endTimeMs) {
    const qs = new URLSearchParams({
      interval: options.interval,
      startTime: String(cursor),
      endTime: String(options.endTimeMs),
      limit: "1000",
    });
    let url: string;
    if (source === "spot") {
      qs.set("symbol", binanceSymbol);
      url = `https://api.binance.com/api/v3/klines?${qs.toString()}`;
    } else {
      qs.set("pair", binanceSymbol);
      qs.set("contractType", "PERPETUAL");
      url = `https://fapi.binance.com/fapi/v1/continuousKlines?${qs.toString()}`;
    }

    let payload: unknown;
    for (let attempt = 0; ; attempt += 1) {
      try {
        payload = await fetchJson(fetchImpl, url);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await sleep(250 * (attempt + 1));
      }
    }
    if (!Array.isArray(payload) || payload.length === 0) break;

    const page = payload.map((row) => parseKlineRow(row as unknown[]));
    rows.push(...page);
    const last = page[page.length - 1]!;
    const next = last.openTimeMs + pageMs;
    if (next <= cursor) break;
    cursor = next;

    if (page.length < 1000) break;
  }

  const deduped = [...new Map(rows.map((row) => [row.openTimeMs, row])).values()]
    .filter((row) => row.openTimeMs >= options.startTimeMs && row.openTimeMs <= options.endTimeMs)
    .sort((a, b) => a.openTimeMs - b.openTimeMs);

  const cached: CachedKlines = {
    fetchedAt: new Date().toISOString(),
    source,
    symbol: options.symbol,
    binanceSymbol,
    interval: options.interval,
    startTimeMs: options.startTimeMs,
    endTimeMs: options.endTimeMs,
    rows: deduped,
  };
  writeFileSync(path, JSON.stringify(cached));
  return deduped;
}

function expectedStep(interval: KlineInterval): number {
  return interval === "1s" ? 1000 : 60_000;
}

export function buildIndexSeriesFromKlines(params: {
  symbol: BacktestSymbol;
  interval: KlineInterval;
  spot: ExchangeKline[];
  perp: ExchangeKline[];
  weightSpot: number;
  weightPerp: number;
}): IndexSeries {
  const perpByTime = new Map(params.perp.map((row) => [row.openTimeMs, row]));
  const step = expectedStep(params.interval);
  const points: IndexPoint[] = [];
  let missing = 0;
  let lastPerp: ExchangeKline | null = null;

  for (const spot of params.spot) {
    const perp: ExchangeKline | null = perpByTime.get(spot.openTimeMs) ?? lastPerp;
    if (!perp) {
      missing += 1;
      continue;
    }
    if (!perpByTime.has(spot.openTimeMs)) missing += 1;
    lastPerp = perpByTime.get(spot.openTimeMs) ?? perp;
    points.push({
      atMs: spot.openTimeMs,
      close: params.weightSpot * spot.close + params.weightPerp * perp.close,
      spotClose: spot.close,
      perpClose: perp.close,
    });
  }

  let timeGaps = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i]!.atMs - points[i - 1]!.atMs !== step) timeGaps += 1;
  }

  return {
    symbol: params.symbol,
    interval: params.interval,
    weightSpot: params.weightSpot,
    weightPerp: params.weightPerp,
    points,
    gapRatio: points.length === 0 ? 1 : (missing + timeGaps) / (points.length + missing),
    source: {
      spot: "binance-spot",
      perp: "binance-usdm-perpetual-continuous",
    },
  };
}

export async function buildIndexSeries(options: BuildIndexSeriesOptions): Promise<IndexSeries> {
  if (Math.abs(options.weightSpot + options.weightPerp - 1) > 1e-9) {
    throw new Error("Index weights must sum to 1");
  }
  const [spot, perp] = await Promise.all([
    loadExchangeKlines("spot", options),
    loadExchangeKlines("perp", options),
  ]);
  return buildIndexSeriesFromKlines({
    symbol: options.symbol,
    interval: options.interval,
    spot,
    perp,
    weightSpot: options.weightSpot,
    weightPerp: options.weightPerp,
  });
}

