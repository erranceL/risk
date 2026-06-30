import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RiskConfig } from "../core/types.js";

import { loadDataset } from "./dataset.js";
import { pickSafeEdge, sweep, type EdgeResult, type GroupMetrics, type SweepResult } from "./edge-sweep.js";

interface CliArgs {
  input: string | null;
  edges: number[];
  byDirection: boolean;
  out: string;
  margin: number;
  rateLimit: boolean;
  configOverrides: Partial<RiskConfig>;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    input: null,
    edges: defaultEdges(),
    byDirection: false,
    out: "sim-out",
    margin: 0,
    rateLimit: false,
    configOverrides: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--input" || a === "-i") args.input = next() ?? null;
    else if (a === "--edges") args.edges = parseEdges(next());
    else if (a === "--by-direction") args.byDirection = true;
    else if (a === "--rate-limit") args.rateLimit = true;
    else if (a === "--out" || a === "-o") args.out = next() ?? args.out;
    else if (a === "--margin") args.margin = Number(next());
    else if (a === "--publish-min") args.configOverrides.publishMinReturnRate = Number(next());
    else if (a === "--publish-max") args.configOverrides.publishMaxReturnRate = Number(next());
    else if (a === "--floor") args.configOverrides.payoutRateFloor = Number(next());
    else if (a === "--ceiling") args.configOverrides.payoutRateCeiling = Number(next());
    else if (!a.startsWith("-") && !args.input) args.input = a;
  }
  return args;
}

function defaultEdges(): number[] {
  const edges: number[] = [];
  for (let e = 0.02; e <= 0.1500001; e += 0.01) edges.push(Math.round(e * 1000) / 1000);
  return edges;
}

function parseEdges(spec: string | undefined): number[] {
  if (!spec) return defaultEdges();
  return spec
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 1);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function csvRows(result: SweepResult): string {
  const header = [
    "edge",
    "symbol",
    "period",
    "direction",
    "decided",
    "win",
    "lose",
    "draw",
    "observedWinRate",
    "meanPayoutRate",
    "settledStake",
    "platformPnl",
    "platformReturn",
    "clampedQuotes",
  ].join(",");

  const lines = [header];
  const addRows = (edgeLabel: string, rows: GroupMetrics[]) => {
    for (const g of rows) {
      lines.push(
        [
          edgeLabel,
          g.symbol,
          g.period,
          g.direction ?? "",
          g.decided,
          g.win,
          g.lose,
          g.draw,
          g.observedWinRate.toFixed(6),
          g.meanPayoutRate.toFixed(6),
          g.settledStake.toFixed(4),
          g.platformPnl.toFixed(4),
          g.platformReturn.toFixed(6),
          g.clampedQuotes,
        ].join(","),
      );
    }
  };

  addRows(result.staticBaseline.label, [...result.staticBaseline.groups, result.staticBaseline.overall]);
  for (const r of result.results) addRows(r.label, [...r.groups, r.overall]);
  return lines.join("\n");
}

function overallTable(result: SweepResult): string {
  const lines: string[] = [];
  lines.push("| edge | mean payout | user win-rate | platform return | platform PnL |");
  lines.push("|---|---|---|---|---|");
  const row = (r: EdgeResult) =>
    `| ${r.label} | ${r.overall.meanPayoutRate.toFixed(4)} | ${pct(r.overall.observedWinRate)} | ${pct(r.overall.platformReturn)} | ${r.overall.platformPnl.toFixed(2)} |`;
  lines.push(row(result.staticBaseline));
  for (const r of result.results) lines.push(row(r));
  return lines.join("\n");
}

function markdownReport(result: SweepResult, margin: number): string {
  const lines: string[] = [];
  lines.push(`# Edge sweep — offline replay`);
  lines.push("");
  lines.push(`- Generated: ${result.generatedAt}`);
  lines.push(`- Settled orders replayed: ${result.orderCount}`);
  lines.push(`- Edges: ${result.edges.map((e) => e.toFixed(3)).join(", ")}`);
  lines.push(`- Group by direction: ${result.byDirection ? "yes" : "no"} · Rate limiter: ${result.rateLimit ? "on" : "off"}`);
  lines.push("");
  lines.push(`> User win-rate is a price-driven observation and does not change with edge.`);
  lines.push(`> Platform return = PnL / settled stake; >= 0 means the platform does not lose.`);
  lines.push("");
  lines.push(`## Overall (all windows)`);
  lines.push("");
  lines.push(overallTable(result));
  lines.push("");

  lines.push(`## Smallest edge with platform return >= ${pct(margin)} per window`);
  lines.push("");
  const safe = pickSafeEdge(result, margin);
  lines.push("| window | user win-rate (static ref) | chosen edge | mean payout | platform return |");
  lines.push("|---|---|---|---|---|");
  const refByKey = new Map(result.staticBaseline.groups.map((g) => [g.key, g]));
  for (const [key, choice] of [...safe.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ref = refByKey.get(key);
    const winRef = ref ? pct(ref.observedWinRate) : "n/a";
    if (choice) {
      lines.push(
        `| ${key} | ${winRef} | ${choice.edge.toFixed(3)} | ${choice.meanPayoutRate.toFixed(4)} | ${pct(choice.platformReturn)} |`,
      );
    } else {
      lines.push(`| ${key} | ${winRef} | none in range | - | - |`);
    }
  }
  lines.push("");
  lines.push(`## Per-window detail`);
  lines.push("");
  for (const r of [result.staticBaseline, ...result.results]) {
    lines.push(`### ${r.label}`);
    lines.push("");
    lines.push("| window | decided | win-rate | mean payout | platform return | platform PnL |");
    lines.push("|---|---|---|---|---|---|");
    for (const g of r.groups) {
      lines.push(
        `| ${g.key} | ${g.decided} | ${pct(g.observedWinRate)} | ${g.meanPayoutRate.toFixed(4)} | ${pct(g.platformReturn)} | ${g.platformPnl.toFixed(2)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      "usage: npm run sim -- --input <events.jsonl> [--edges 0.02,0.05,0.1] [--by-direction] [--margin 0.01] [--rate-limit] [--out sim-out]",
    );
    process.exit(1);
  }

  const ds = loadDataset(args.input);
  console.error(
    `loaded ${ds.settledOrders} settled orders (of ${ds.acceptedRecords} accepted, ${ds.totalRecords} attempts; dropped ${ds.droppedUnsettled} unsettled, ${ds.droppedMalformed} malformed)`,
  );
  if (ds.orders.length === 0) {
    console.error("no settled orders to replay; aborting");
    process.exit(2);
  }

  const result = sweep(ds.orders, {
    edges: args.edges,
    byDirection: args.byDirection,
    rateLimit: args.rateLimit,
    configOverrides: args.configOverrides,
  });

  const stamp = result.generatedAt.replace(/[:.]/g, "-");
  const outDir = join(args.out, stamp);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "sweep.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(outDir, "by-window.csv"), csvRows(result));
  const md = markdownReport(result, args.margin);
  writeFileSync(join(outDir, "summary.md"), md);

  // Console summary for quick reading.
  console.log("");
  console.log(overallTable(result));
  console.log("");
  console.log(`wrote: ${join(outDir, "summary.md")}`);
  console.log(`wrote: ${join(outDir, "by-window.csv")}`);
  console.log(`wrote: ${join(outDir, "sweep.json")}`);
}

main();
