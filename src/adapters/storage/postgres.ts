import pg from "pg";
import type { Quote, RiskConfig, RiskEvent } from "../../core/types.js";
import type { StorageAdapter } from "./types.js";

const { Pool } = pg;

export class PostgresStorageAdapter implements StorageAdapter {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async saveEvent(event: RiskEvent): Promise<void> {
    await this.pool.query(
      `insert into risk_events (event_id, sequence, type, occurred_at, published_at, payload)
       values ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), $6)
       on conflict (event_id) do nothing`,
      [event.eventId, event.sequence, event.type, event.occurredAt, event.publishedAt, event.payload],
    );
  }

  async saveQuote(quote: Quote): Promise<void> {
    await this.pool.query(
      `insert into risk_quotes (
        quote_id, symbol, period, r_up, r_down, platform_edge, house_edge,
        generated_at, expires_at, exposure_cursor, config_version, model_version,
        clamp_reason, risk_signal, payload
      ) values (
        $1, $2, $3, $4, $5, $6, $7,
        to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0), $10, $11, $12,
        $13, $14, $15
      )
      on conflict (quote_id) do nothing`,
      [
        quote.quoteId,
        quote.symbol,
        quote.period,
        quote.rUp,
        quote.rDown,
        quote.platformEdge,
        quote.houseEdge,
        quote.generatedAt,
        quote.expiresAt,
        quote.exposureCursor,
        quote.configVersion,
        quote.modelVersion,
        quote.clampReason,
        quote.riskSignal,
        quote,
      ],
    );
  }

  async saveConfig(config: RiskConfig): Promise<void> {
    await this.pool.query(
      `insert into risk_configs (symbol, period, config_version, payload)
       values ($1, $2, $3, $4)
       on conflict (symbol, period, config_version) do update set payload = excluded.payload`,
      [config.symbol, config.period, config.configVersion, config],
    );
  }

  async loadConfig(symbol: string, period: string): Promise<RiskConfig | null> {
    const result = await this.pool.query(
      `select payload from risk_configs
       where symbol = $1 and period = $2
       order by created_at desc
       limit 1`,
      [symbol, period],
    );
    return (result.rows[0]?.payload as RiskConfig | undefined) ?? null;
  }

  async loadConfigs(): Promise<RiskConfig[]> {
    const result = await this.pool.query(
      `select distinct on (symbol, period) payload
       from risk_configs
       order by symbol, period, created_at desc`,
    );
    return result.rows.map((row) => row.payload as RiskConfig);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
