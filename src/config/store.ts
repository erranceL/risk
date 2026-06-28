import type { Period, RiskConfig } from "../core/types.js";

function productKey(symbol: string, period: Period): string {
  return `${symbol}::${period}`;
}

export class VersionedConfigStore {
  private readonly active = new Map<string, RiskConfig>();
  private readonly history = new Map<string, RiskConfig[]>();

  constructor(initialConfigs: RiskConfig[]) {
    for (const config of initialConfigs) {
      this.put(config);
    }
  }

  list(): RiskConfig[] {
    return [...this.active.values()];
  }

  get(symbol: string, period: Period): RiskConfig | null {
    return this.active.get(productKey(symbol, period)) ?? null;
  }

  put(config: RiskConfig): RiskConfig {
    this.validate(config);
    const key = productKey(config.symbol, config.period);
    const previous = this.active.get(key);
    if (previous) {
      const versions = this.history.get(key) ?? [];
      versions.push(previous);
      this.history.set(key, versions.slice(-20));
    }
    this.active.set(key, config);
    return config;
  }

  rollback(symbol: string, period: Period): RiskConfig {
    const key = productKey(symbol, period);
    const versions = this.history.get(key) ?? [];
    const previous = versions.pop();
    if (!previous) throw new Error("no previous config version");
    const current = this.active.get(key);
    if (current) {
      versions.push(current);
    }
    this.history.set(key, versions.slice(-20));
    this.active.set(key, previous);
    return previous;
  }

  private validate(config: RiskConfig): void {
    if (!config.symbol || !config.period) throw new Error("symbol and period are required");

    const numericFields: Array<keyof RiskConfig> = [
      "platformEdge",
      "probabilitySkewMax",
      "probabilitySkewSensitivity",
      "minExposureForSkew",
      "probabilityMin",
      "probabilityMax",
      "payoutRateFloor",
      "payoutRateCeiling",
      "publishMinReturnRate",
      "publishMaxReturnRate",
      "payoutMaxChangePerSecond",
      "payoutMaxChangePerOrder",
      "quoteTtlMs",
    ];
    for (const field of numericFields) {
      const value = config[field];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${field} must be a finite number`);
      }
    }

    if (config.platformEdge <= 0 || config.platformEdge >= 0.5) {
      throw new Error("platformEdge must be between 0 and 0.5");
    }
    if (config.probabilityMin <= 0 || config.probabilityMax >= 1) {
      throw new Error("probabilityMin/probabilityMax must be within (0, 1)");
    }
    if (config.probabilityMin >= config.probabilityMax) {
      throw new Error("probabilityMin must be < probabilityMax");
    }
    if (config.probabilitySkewMax < 0 || config.probabilitySkewMax >= 0.5) {
      throw new Error("probabilitySkewMax must be within [0, 0.5)");
    }
    if (config.probabilitySkewSensitivity < 0) {
      throw new Error("probabilitySkewSensitivity must be >= 0");
    }
    if (config.minExposureForSkew <= 0) {
      throw new Error("minExposureForSkew must be > 0");
    }
    if (config.payoutRateFloor < 0 || config.payoutRateCeiling <= config.payoutRateFloor) {
      throw new Error("invalid payout guardrails");
    }
    if (config.publishMinReturnRate > config.publishMaxReturnRate) {
      throw new Error("publishMinReturnRate must be <= publishMaxReturnRate");
    }
    if (config.publishMinReturnRate < config.payoutRateFloor) {
      throw new Error("publishMinReturnRate must be >= payoutRateFloor");
    }
    if (config.publishMaxReturnRate > config.payoutRateCeiling) {
      throw new Error("publishMaxReturnRate must be <= payoutRateCeiling");
    }
    if (config.payoutMaxChangePerSecond < 0 || config.payoutMaxChangePerOrder < 0) {
      throw new Error("payout change limits must be >= 0");
    }
    if (config.quoteTtlMs <= 0) {
      throw new Error("quoteTtlMs must be > 0");
    }
  }
}
