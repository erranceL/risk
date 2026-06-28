import type { Period, RiskConfig } from "../../core/types.js";

export interface ProductAdapter {
  listProducts(): Array<{ symbol: string; period: Period }>;
  configFor(symbol: string, period: Period): RiskConfig;
}
