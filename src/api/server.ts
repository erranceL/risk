import http from "node:http";
import { URL } from "node:url";
import { ExposureBook } from "../core/exposure.js";
import { buildQuote, fallbackQuote } from "../core/pricing.js";
import type { OpenPositionSnapshot, Period, Quote, RiskConfig, RiskEvent, RiskEventType } from "../core/types.js";
import { defaultRiskConfig, SUPPORTED_PRODUCTS } from "../config/defaults.js";
import { VersionedConfigStore } from "../config/store.js";
import { initialMetrics } from "../monitor/metrics.js";
import { PostgresStorageAdapter } from "../adapters/storage/postgres.js";

const port = Number(process.env.PORT || 8787);
const quoteCadenceMs = Number(process.env.QUOTE_CADENCE_MS || 100);
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 1_048_576);
const eventToken = process.env.RISK_EVENT_TOKEN || "";
const controlToken = process.env.RISK_CONTROL_TOKEN || "";
const quoteToken = process.env.RISK_QUOTE_TOKEN || "";
const storage = process.env.DATABASE_URL
  ? new PostgresStorageAdapter(process.env.DATABASE_URL)
  : null;

const exposureBook = new ExposureBook();
const metrics = initialMetrics();
const configStore = new VersionedConfigStore(
  SUPPORTED_PRODUCTS.map((product) => defaultRiskConfig(product.symbol, product.period)),
);
const latestQuotes = new Map<string, Quote>();
const eventTypes = new Set<RiskEventType>([
  "ORDER_ACCEPTED",
  "ORDER_PRICED",
  "ORDER_SETTLED",
  "ORDER_REFUNDED",
  "ORDER_CANCELED",
  "ORDER_HELD",
]);

function productKey(symbol: string, period: Period): string {
  return `${symbol}::${period}`;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        aborted = true;
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : null);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function authorize(req: http.IncomingMessage, token: string): boolean {
  // Empty token => endpoint is open (local/dev). Set tokens in production.
  if (!token) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${token}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseEvent(raw: unknown, index: number): RiskEvent {
  if (!isObject(raw)) {
    throw new Error(`events[${index}] must be an object`);
  }
  const eventId = raw.eventId;
  const sequence = raw.sequence;
  const occurredAt = raw.occurredAt;
  const publishedAt = raw.publishedAt;
  const type = raw.type;
  const payloadRaw = raw.payload;
  if (typeof eventId !== "string" || !eventId.trim()) {
    throw new Error(`events[${index}].eventId must be non-empty string`);
  }
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error(`events[${index}].sequence must be positive integer`);
  }
  if (!isFiniteNumber(occurredAt) || occurredAt <= 0) {
    throw new Error(`events[${index}].occurredAt must be positive epoch ms`);
  }
  if (!isFiniteNumber(publishedAt) || publishedAt <= 0) {
    throw new Error(`events[${index}].publishedAt must be positive epoch ms`);
  }
  if (typeof type !== "string" || !eventTypes.has(type as RiskEventType)) {
    throw new Error(`events[${index}].type is invalid`);
  }
  if (!isObject(payloadRaw)) {
    throw new Error(`events[${index}].payload must be an object`);
  }
  const orderId = payloadRaw.orderId;
  const symbol = payloadRaw.symbol;
  const period = payloadRaw.period;
  const direction = payloadRaw.direction;
  const stake = payloadRaw.stake;
  if (typeof orderId !== "string" || !orderId.trim()) {
    throw new Error(`events[${index}].payload.orderId must be non-empty string`);
  }
  if (typeof symbol !== "string" || !symbol.trim()) {
    throw new Error(`events[${index}].payload.symbol must be non-empty string`);
  }
  if (typeof period !== "string" || !period.trim()) {
    throw new Error(`events[${index}].payload.period must be non-empty string`);
  }
  if (direction !== "LONG" && direction !== "SHORT") {
    throw new Error(`events[${index}].payload.direction must be LONG or SHORT`);
  }
  if (!isFiniteNumber(stake) || stake <= 0) {
    throw new Error(`events[${index}].payload.stake must be > 0`);
  }
  const eventEndTime = payloadRaw.eventEndTime;
  if (eventEndTime !== undefined && (!isFiniteNumber(eventEndTime) || eventEndTime <= 0)) {
    throw new Error(`events[${index}].payload.eventEndTime must be positive epoch ms`);
  }
  const payoutRateSnapshot = payloadRaw.payoutRateSnapshot;
  if (payoutRateSnapshot !== undefined && (!isFiniteNumber(payoutRateSnapshot) || payoutRateSnapshot < 0)) {
    throw new Error(`events[${index}].payload.payoutRateSnapshot must be >= 0`);
  }
  const status = payloadRaw.status;
  if (status !== undefined && typeof status !== "string") {
    throw new Error(`events[${index}].payload.status must be string`);
  }
  return {
    eventId,
    sequence: sequence,
    occurredAt,
    publishedAt,
    type: type as RiskEventType,
    payload: {
      orderId,
      symbol,
      period,
      direction,
      stake,
      payoutRateSnapshot,
      eventEndTime,
      status,
    },
  };
}

function asEvents(payload: unknown): RiskEvent[] {
  if (Array.isArray(payload)) return payload.map((item, index) => parseEvent(item, index));
  if (payload && typeof payload === "object" && Array.isArray((payload as { events?: unknown }).events)) {
    return (payload as { events: unknown[] }).events.map((item, index) => parseEvent(item, index));
  }
  throw new Error("payload must be an array of events or an object with events[]");
}

function ensureAuthSafety(): void {
  const isProd = process.env.NODE_ENV === "production";
  const allowInsecure = process.env.RISK_ALLOW_INSECURE_NO_AUTH === "true";
  if (!isProd || allowInsecure) return;
  const missing = [
    ["RISK_EVENT_TOKEN", eventToken],
    ["RISK_CONTROL_TOKEN", controlToken],
    ["RISK_QUOTE_TOKEN", quoteToken],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `refuse to start in production without auth tokens: ${missing.join(", ")}; set tokens or RISK_ALLOW_INSECURE_NO_AUTH=true`,
    );
  }
}

function rebuildQuotes(): void {
  const now = Date.now();
  const degraded = exposureBook.needsResync();
  for (const config of configStore.list()) {
    const key = productKey(config.symbol, config.period);
    const exposure = exposureBook.getExposure(config.symbol, config.period);
    const previous = latestQuotes.get(key);
    let quote: Quote;
    if (degraded) {
      // Exposure mirror has a sequence gap; price conservatively until resynced.
      quote = fallbackQuote({ config, exposure, now, riskSignal: "degraded", reason: "exposure_gap" });
      metrics.fallbackQuoteCount += 1;
    } else {
      try {
        quote = buildQuote({
          config,
          exposure,
          previousQuote: previous
            ? { rUp: previous.rUp, rDown: previous.rDown, generatedAt: previous.generatedAt }
            : undefined,
          now,
        });
        if (quote.clampReason) metrics.quoteClampCount += 1;
      } catch (error) {
        metrics.negativeEdgeBlockCount += 1;
        console.error(error);
        quote = fallbackQuote({ config, exposure, now, riskSignal: "fallback", reason: "pricing_error" });
        metrics.fallbackQuoteCount += 1;
      }
    }
    latestQuotes.set(key, quote);
    void persistQuote(quote);
  }
}

async function persistQuote(quote: Quote): Promise<void> {
  if (!storage) return;
  try {
    await storage.saveQuote(quote);
  } catch (error) {
    metrics.storageErrorCount += 1;
    console.error(error);
  }
}

async function bootstrap(): Promise<void> {
  if (!storage) return;
  try {
    const configs = storage.loadConfigs
      ? await storage.loadConfigs()
      : (await Promise.all(
          SUPPORTED_PRODUCTS.map((p) => storage.loadConfig(p.symbol, p.period)),
        )).filter((c): c is RiskConfig => c !== null);
    for (const config of configs) {
      try {
        configStore.put(config);
      } catch (error) {
        console.error(`skip invalid persisted config ${config.symbol}/${config.period}:`, error);
      }
    }
    if (configs.length) {
      console.log(`restored ${configs.length} config(s) from storage`);
    }
  } catch (error) {
    console.error("config bootstrap failed:", error);
  }
  // NOTE: open-position exposure is rebuilt via POST /v1/exposure/snapshot
  // (pushed by the main platform on vendor startup / after a sequence gap).
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "risk",
      now: Date.now(),
      needsResync: exposureBook.needsResync(),
      gapDepth: exposureBook.getGapDepth(),
      cursor: exposureBook.getCursor(),
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/metrics") {
    const newest = [...latestQuotes.values()].sort((a, b) => b.generatedAt - a.generatedAt)[0];
    sendJson(res, 200, {
      ...metrics,
      quoteAgeMs: newest ? Date.now() - newest.generatedAt : null,
      openPositions: exposureBook.getOpenCount(),
      needsResync: exposureBook.needsResync(),
      gapDepth: exposureBook.getGapDepth(),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/events") {
    if (!authorize(req, eventToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    readJson(req)
      .then(async (payload) => {
        const events = asEvents(payload);
        const results = [];
        for (const event of events) {
          // Persist before applying so the durable log never trails the mirror.
          if (storage) {
            try {
              await storage.saveEvent(event);
            } catch (error) {
              metrics.storageErrorCount += 1;
              console.error(error);
              sendJson(res, 503, { error: "event persistence failed", eventId: event.eventId });
              return;
            }
          }
          const result = exposureBook.applyEvent(event);
          metrics.eventLagMs = Math.max(0, Date.now() - event.publishedAt);
          if (result.sequenceGap) metrics.sequenceGapCount += 1;
          results.push({ eventId: event.eventId, ...result });
        }
        rebuildQuotes();
        sendJson(res, 202, {
          accepted: results.length,
          needsResync: exposureBook.needsResync(),
          results,
        });
      })
      .catch((error: Error) => sendJson(res, 400, { error: error.message }));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/v1/exposure/snapshot") {
    if (!authorize(req, controlToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    readJson(req)
      .then((payload) => {
        const snapshot = payload as OpenPositionSnapshot;
        if (!snapshot || !Array.isArray(snapshot.positions) || typeof snapshot.snapshotCursor !== "string") {
          throw new Error("snapshot must have snapshotCursor and positions[]");
        }
        exposureBook.rebuildFromSnapshot(snapshot);
        metrics.resyncRequestCount += 1;
        rebuildQuotes();
        sendJson(res, 200, {
          ok: true,
          cursor: exposureBook.getCursor(),
          openPositions: exposureBook.getOpenCount(),
        });
      })
      .catch((error: Error) => sendJson(res, 400, { error: error.message }));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/v1/quotes") {
    if (!authorize(req, quoteToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const symbol = requestUrl.searchParams.get("symbol") || "BTC";
    const period = requestUrl.searchParams.get("period") || "30s";
    const quote = latestQuotes.get(productKey(symbol, period));
    if (!quote) {
      sendJson(res, 404, { error: "quote not found" });
      return;
    }
    sendJson(res, 200, quote);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/v1/exposure") {
    if (!authorize(req, quoteToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const symbol = requestUrl.searchParams.get("symbol") || "BTC";
    const period = requestUrl.searchParams.get("period") || "30s";
    sendJson(res, 200, exposureBook.getExposure(symbol, period));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/v1/config") {
    if (!authorize(req, controlToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    sendJson(res, 200, { configs: configStore.list() });
    return;
  }

  if (req.method === "PUT" && requestUrl.pathname === "/v1/config") {
    if (!authorize(req, controlToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    readJson(req)
      .then(async (payload) => {
        const config = payload as RiskConfig;
        const current = configStore.get(config.symbol, config.period);
        configStore.put(config);
        if (storage) {
          try {
            await storage.saveConfig(config);
          } catch (error) {
            metrics.storageErrorCount += 1;
            console.error(error);
            try {
              // Revert in-memory state when persistence fails.
              if (current) {
                configStore.rollback(config.symbol, config.period);
              }
            } catch (rollbackError) {
              console.error(rollbackError);
            }
            sendJson(res, 503, { error: "config persistence failed" });
            return;
          }
        }
        rebuildQuotes();
        sendJson(res, 200, { config });
      })
      .catch((error: Error) => {
        metrics.configRejectCount += 1;
        sendJson(res, 400, { error: error.message });
      });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/v1/config/rollback") {
    if (!authorize(req, controlToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    readJson(req)
      .then(async (payload) => {
        const body = payload as { symbol?: string; period?: Period };
        if (!body.symbol || !body.period) throw new Error("symbol and period are required");
        const config = configStore.rollback(body.symbol, body.period);
        if (storage) {
          try {
            await storage.saveConfig(config);
          } catch (error) {
            metrics.storageErrorCount += 1;
            console.error(error);
            try {
              // Roll forward to previous active config if persistence fails.
              configStore.rollback(body.symbol, body.period);
            } catch (rollbackError) {
              console.error(rollbackError);
            }
            sendJson(res, 503, { error: "config persistence failed" });
            return;
          }
        }
        rebuildQuotes();
        sendJson(res, 200, { config });
      })
      .catch((error: Error) => sendJson(res, 400, { error: error.message }));
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

const quoteTimer = setInterval(rebuildQuotes, quoteCadenceMs);
quoteTimer.unref();

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  clearInterval(quoteTimer);
  server.close();
  if (storage?.close) {
    try {
      await storage.close();
    } catch (error) {
      console.error(error);
    }
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

ensureAuthSafety();

bootstrap()
  .catch((error) => console.error(error))
  .finally(() => {
    rebuildQuotes();
    server.listen(port, () => {
      console.log(`risk vendor listening on :${port}`);
    });
  });
