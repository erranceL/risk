import type { OpenPositionSnapshot, Quote, RiskEvent } from "../../core/types.js";

export interface PlatformAdapter {
  name: string;
  verifyEventRequest(headers: Record<string, string | string[] | undefined>, body: string): boolean;
  parseEvents(body: unknown): RiskEvent[];
  fetchOpenPositions(): Promise<OpenPositionSnapshot>;
  publishQuotes(quotes: Quote[]): Promise<void>;
}
