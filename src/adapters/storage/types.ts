import type { Quote, RiskConfig, RiskEvent } from "../../core/types.js";

export interface StorageAdapter {
  saveEvent(event: RiskEvent): Promise<void>;
  saveQuote(quote: Quote): Promise<void>;
  saveConfig(config: RiskConfig): Promise<void>;
  loadConfig(symbol: string, period: string): Promise<RiskConfig | null>;
  loadConfigs?(): Promise<RiskConfig[]>;
  close?(): Promise<void>;
}
