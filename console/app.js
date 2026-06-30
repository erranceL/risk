const state = {
  snapshot: null,
  edgeOverrides: new Map(),
};

const fmtPct = (x) => `${(x * 100).toFixed(2)}%`;
const fmtNum = (x) => Number(x).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const keyOf = (w) => `${w.symbol}|${w.period}`;

function closestScenario(window, edge) {
  return window.scenarios.reduce((best, item) =>
    Math.abs(item.edge - edge) < Math.abs(best.edge - edge) ? item : best,
  );
}

function activeScenario(window) {
  const override = state.edgeOverrides.get(keyOf(window));
  if (override === undefined) return window.configured;
  return closestScenario(window, override);
}

function riskClass(level) {
  if (level >= 8) return "bad";
  if (level >= 6) return "warn";
  return "";
}

function confidenceText(value) {
  if (value === "low") return "低置信";
  if (value === "medium") return "样本偏少";
  return "样本正常";
}

function renderSummary(snapshot) {
  const totalOrders = snapshot.windows.reduce((sum, w) => sum + w.orders, 0);
  const avgRisk = snapshot.windows.reduce((sum, w) => sum + w.risk.level, 0) / snapshot.windows.length;
  const gaps = snapshot.dataQuality.map((q) => q.gapRatio).reduce((sum, x) => sum + x, 0) / snapshot.dataQuality.length;
  document.querySelector("#summary").innerHTML = `
    <div class="metric"><span>回测窗口</span><strong>${snapshot.config.startTime.slice(0, 10)} 至 ${snapshot.config.endTime.slice(0, 10)}</strong></div>
    <div class="metric"><span>每格样本</span><strong>${snapshot.config.ordersPerProductWindow}</strong></div>
    <div class="metric"><span>总订单</span><strong>${fmtNum(totalOrders)}</strong></div>
    <div class="metric"><span>平均风险</span><strong>${avgRisk.toFixed(1)} / 10</strong></div>
    <div class="metric"><span>指数权重</span><strong>${fmtPct(snapshot.config.weightSpot)} / ${fmtPct(snapshot.config.weightPerp)}</strong></div>
    <div class="metric"><span>平均缺口率</span><strong>${fmtPct(gaps)}</strong></div>
  `;
}

function metric(label, value) {
  return `<div class="cell"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderCard(window) {
  const scenario = activeScenario(window);
  const level = scenario.riskLevel;
  const suggested = window.suggestedPlatformEdge === null ? "无建议" : fmtPct(window.suggestedPlatformEdge);
  const clamp = scenario.clampReason ? scenario.clampReason : scenario.clampedQuotes > 0 ? "部分报价触达护栏" : "无";
  return `
    <article class="card ${riskClass(level)}">
      <div class="card-head">
        <div>
          <div class="title">${window.symbol} · ${window.period}</div>
          <div class="muted">${confidenceText(window.confidence)} · ${window.orders} 笔</div>
        </div>
        <div class="risk">${level}</div>
      </div>
      <div class="grid">
        ${metric("人工 edge", fmtPct(scenario.edge))}
        ${metric("建议 edge", suggested)}
        ${metric("实际 house edge", fmtPct(scenario.houseEdge))}
        ${metric("平台 return", fmtPct(scenario.platformReturn))}
        ${metric("LONG 赔率", scenario.rUp.toFixed(4))}
        ${metric("SHORT 赔率", scenario.rDown.toFixed(4))}
        ${metric("用户胜率", fmtPct(window.userWinRate))}
        ${metric("平均 payout", scenario.meanPayoutRate.toFixed(4))}
        ${metric("多/空本金", `${fmtNum(window.longStake)} / ${fmtNum(window.shortStake)}`)}
        ${metric("峰值 open", fmtNum(window.peakOpenInterest))}
        ${metric("风险 max loss", fmtNum(window.risk.maxLossAmount))}
        ${metric("护栏/fallback", clamp)}
      </div>
      <div class="bar" title="风险等级"><div style="width:${level * 10}%"></div></div>
    </article>
  `;
}

function currentWindows() {
  const symbol = document.querySelector("#symbolFilter").value;
  const period = document.querySelector("#periodFilter").value;
  return state.snapshot.windows.filter(
    (w) => (symbol === "ALL" || w.symbol === symbol) && (period === "ALL" || w.period === period),
  );
}

function renderCards() {
  document.querySelector("#cards").innerHTML = currentWindows().map(renderCard).join("");
}

function fillFilters(snapshot) {
  const symbols = [...new Set(snapshot.windows.map((w) => w.symbol))];
  const periods = [...new Set(snapshot.windows.map((w) => w.period))];
  document.querySelector("#symbolFilter").innerHTML =
    `<option value="ALL">全部</option>` + symbols.map((s) => `<option value="${s}">${s}</option>`).join("");
  document.querySelector("#periodFilter").innerHTML =
    `<option value="ALL">全部</option>` + periods.map((p) => `<option value="${p}">${p}</option>`).join("");
}

async function main() {
  const res = await fetch("./snapshot.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("无法加载 snapshot.json，请先运行 npm run backtest");
  state.snapshot = await res.json();
  fillFilters(state.snapshot);
  renderSummary(state.snapshot);
  renderCards();

  document.querySelector("#symbolFilter").addEventListener("change", renderCards);
  document.querySelector("#periodFilter").addEventListener("change", renderCards);
  document.querySelector("#applyEdge").addEventListener("click", () => {
    const edge = Number(document.querySelector("#edgeInput").value);
    if (!Number.isFinite(edge) || edge <= 0 || edge >= 1) return;
    for (const window of currentWindows()) state.edgeOverrides.set(keyOf(window), edge);
    renderCards();
  });
}

main().catch((err) => {
  document.querySelector("#cards").innerHTML = `<article class="card bad"><div class="title">加载失败</div><p>${err.message}</p></article>`;
});

