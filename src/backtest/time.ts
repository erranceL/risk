import type { Period } from "../core/types.js";

const PERIOD_MS: Record<string, number> = {
  "30s": 30_000,
  "1m": 60_000,
  "5m": 5 * 60_000,
  "10m": 10 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
};

export function periodToMs(period: Period): number {
  const ms = PERIOD_MS[String(period)];
  if (!ms) throw new Error(`Unsupported period: ${period}`);
  return ms;
}

export function alignToSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

export function formatIso(ms: number): string {
  return new Date(ms).toISOString();
}

