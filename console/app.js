const state = {
  snapshot: null,
  edgeOverrides: new Map(),
  selectedSymbol: null,
  selectedPeriod: null,
  targetRiskLevel: 6,
  minReturnBuffer: 0,
};

const fmtPct = (x) => `${(x * 100).toFixed(2)}%`;
const fmtNum = (x) => Number(x).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const keyOf = (w) => `${w.symbol}|${w.period}`;
const periodOrder = ["30s", "1m", "5m", "10m", "15m", "30m", "1h"];

function windows() {
  return state.snapshot.windows;
}

function symbols() {
  return [...new Set(windows().map((w) => w.symbol))];
}

function periodsFor(symbol) {
  return windows()
    .filter((w) => w.symbol === symbol)
    .map((w) => w.period)
    .sort((a, b) => periodOrder.indexOf(a) - periodOrder.indexOf(b));
}

function selectedWindow() {
  return (
    windows().find((w) => w.symbol === state.selectedSymbol && w.period === state.selectedPeriod) ??
    windows()[0]
  );
}

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

function suggestedScenario(window) {
  return (
    window.scenarios.find(
      (s) => s.platformReturn >= state.minReturnBuffer && s.riskLevel <= state.targetRiskLevel,
    ) ?? null
  );
}

function riskClass(level) {
  if (level >= 8) return "bad";
  if (level >= 6) return "warn";
  return "";
}

function riskLabel(level) {
  if (level >= 8) return "高风险";
  if (level >= 6) return "偏高";
  if (level >= 4) return "可观察";
  return "较稳";
}

function confidenceText(value) {
  if (value === "low") return "低置信";
  if (value === "medium") return "样本偏少";
  return "样本正常";
}

function renderSummary() {
  const totalOrders = windows().reduce((sum, w) => sum + w.orders, 0);
  const avgRisk = windows().reduce((sum, w) => sum + activeScenario(w).riskLevel, 0) / windows().length;
  const gaps = state.snapshot.dataQuality
    .map((q) => q.gapRatio)
    .reduce((sum, x) => sum + x, 0) / state.snapshot.dataQuality.length;
  document.querySelector("#summary").innerHTML = `
    <div class="metric"><span>回测窗口</span><strong>${state.snapshot.config.startTime.slice(0, 10)} 至 ${state.snapshot.config.endTime.slice(0, 10)}</strong></div>
    <div class="metric"><span>每格样本</span><strong>${state.snapshot.config.ordersPerProductWindow}</strong></div>
    <div class="metric"><span>总订单</span><strong>${fmtNum(totalOrders)}</strong></div>
    <div class="metric"><span>平均风险</span><strong>${avgRisk.toFixed(1)} / 10</strong></div>
    <div class="metric"><span>指数权重</span><strong>${fmtPct(state.snapshot.config.weightSpot)} / ${fmtPct(state.snapshot.config.weightPerp)}</strong></div>
    <div class="metric"><span>平均缺口率</span><strong>${fmtPct(gaps)}</strong></div>
  `;
}

function renderProductTabs() {
  document.querySelector("#productTabs").innerHTML = symbols()
    .map((symbol) => {
      const productWindows = windows().filter((w) => w.symbol === symbol);
      const avgRisk =
        productWindows.reduce((sum, w) => sum + activeScenario(w).riskLevel, 0) / productWindows.length;
      const active = symbol === state.selectedSymbol ? "active" : "";
      return `
        <button class="product-tab ${active}" data-symbol="${symbol}">
          <span>${symbol}</span>
          <strong>${avgRisk.toFixed(1)}</strong>
          <small>平均风险</small>
        </button>
      `;
    })
    .join("");

  document.querySelectorAll(".product-tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSymbol = button.dataset.symbol;
      state.selectedPeriod = periodsFor(state.selectedSymbol)[0];
      syncEdgeInputFromSelection();
      render();
    });
  });
}

function metric(label, value, help = "") {
  return `<div class="cell"><span>${label}</span><strong>${value}</strong>${help ? `<em>${help}</em>` : ""}</div>`;
}

function verdict(window, scenario, suggestion) {
  if (scenario.platformReturn < 0) return "当前人工 edge 下平台回测为亏损，建议先提高 edge 或降低赔率上限。";
  if (scenario.riskLevel >= 8) return "平台 return 为正，但综合风险高，主要需要关注赔率压力和敞口集中。";
  if (suggestion && scenario.edge < suggestion.edge) return "当前 edge 低于系统建议值，风险/收益缓冲不足。";
  if (scenario.clampedQuotes > window.orders * 0.5) return "大量报价触达护栏，说明赔率上下限正在强行限制模型输出。";
  return "当前人工 edge 在这段回测里表现可接受，可继续观察真实订单分布。";
}

function renderPeriodRows() {
  const productWindows = windows()
    .filter((w) => w.symbol === state.selectedSymbol)
    .sort((a, b) => periodOrder.indexOf(a.period) - periodOrder.indexOf(b.period));
  document.querySelector("#productTitle").textContent = `${state.selectedSymbol} 产品概览`;
  document.querySelector("#periodRows").innerHTML = productWindows
    .map((window) => {
      const scenario = activeScenario(window);
      const suggestion = suggestedScenario(window);
      const isActive = window.period === state.selectedPeriod ? "active" : "";
      const clamp = scenario.clampReason ?? (scenario.clampedQuotes > 0 ? "触达" : "无");
      return `
        <tr class="${isActive}" data-period="${window.period}">
          <td><strong>${window.period}</strong><span>${confidenceText(window.confidence)} · ${window.orders} 笔</span></td>
          <td><b class="${riskClass(scenario.riskLevel)}">${scenario.riskLevel}</b><span>${riskLabel(scenario.riskLevel)}</span></td>
          <td>${fmtPct(scenario.edge)}</td>
          <td>${suggestion ? fmtPct(suggestion.edge) : "无合格建议"}</td>
          <td class="${scenario.platformReturn < 0 ? "bad" : ""}">${fmtPct(scenario.platformReturn)}</td>
          <td>${fmtPct(window.userWinRate)}</td>
          <td>${clamp}</td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll("#periodRows tr").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedPeriod = row.dataset.period;
      syncEdgeInputFromSelection();
      render();
    });
  });
}

function renderDetail() {
  const window = selectedWindow();
  const scenario = activeScenario(window);
  const suggestion = suggestedScenario(window);
  const suggested = suggestion === null ? "无合格建议" : fmtPct(suggestion.edge);
  const clamp = scenario.clampReason ? scenario.clampReason : scenario.clampedQuotes > 0 ? "部分报价触达护栏" : "无";
  const selectedOverride = state.edgeOverrides.get(keyOf(window));
  const edgeNote =
    scenario.edge !== (selectedOverride ?? window.configuredPlatformEdge)
      ? "已使用最接近的候选 edge"
      : "当前生效值";

  document.querySelector("#detailPanel").innerHTML = `
    <article class="card detail-card ${riskClass(scenario.riskLevel)}">
      <div class="card-head">
        <div>
          <div class="title">${window.symbol} · ${window.period} 周期详情</div>
          <div class="muted">${confidenceText(window.confidence)} · ${window.orders} 笔 · 当前只看这一个窗口</div>
        </div>
        <div class="risk-box">
          <span>风险</span>
          <strong>${scenario.riskLevel}</strong>
          <small>${riskLabel(scenario.riskLevel)}</small>
        </div>
      </div>
      <p class="verdict">${verdict(window, scenario, suggestion)}</p>
      <div class="detail-layout">
        <div>
          <h3>赔率和 edge</h3>
          <div class="grid">
            ${metric("人工 edge", fmtPct(scenario.edge), edgeNote)}
            ${metric("建议 edge", suggested, suggestion ? "仅供参考，不自动生效" : "当前目标下无解")}
            ${metric("LONG 赔率", scenario.rUp.toFixed(4), "用户买涨赢时的 payout")}
            ${metric("SHORT 赔率", scenario.rDown.toFixed(4), "用户买跌赢时的 payout")}
            ${metric("实际 house edge", fmtPct(scenario.houseEdge), "护栏后真实抽水")}
            ${metric("平均 payout", scenario.meanPayoutRate.toFixed(4), "本窗口成交平均赔率")}
          </div>
        </div>
        <div>
          <h3>回测表现</h3>
          <div class="grid">
            ${metric("平台 return", fmtPct(scenario.platformReturn), "平台盈亏 / 成交本金")}
            ${metric("用户胜率", fmtPct(window.userWinRate), "随机方向订单历史结果")}
            ${metric("多/空本金", `${fmtNum(window.longStake)} / ${fmtNum(window.shortStake)}`, "合成订单本金分布")}
            ${metric("峰值 open", fmtNum(window.peakOpenInterest), "同时待结算最高本金")}
            ${metric("风险 max loss", fmtNum(window.risk.maxLossAmount), "峰值持仓下理论最大亏损")}
            ${metric("护栏状态", clamp, scenario.clampedQuotes ? `${scenario.clampedQuotes} 笔触达` : "没有明显限制")}
          </div>
        </div>
      </div>
      <div class="bar" title="风险等级"><div style="width:${scenario.riskLevel * 10}%"></div></div>
    </article>
  `;
}

function renderControlHint() {
  const window = selectedWindow();
  const nearest = closestScenario(window, Number(document.querySelector("#edgeInput").value)).edge;
  document.querySelector("#controlHint").textContent =
    `当前选中：${window.symbol} · ${window.period}。edge 候选范围为 ${fmtPct(state.snapshot.config.candidateEdges[0])} - ${fmtPct(state.snapshot.config.candidateEdges.at(-1))}，步长约 1%；输入值会自动匹配最近候选值（当前约 ${fmtPct(nearest)}）。`;
}

function syncEdgeInputFromSelection() {
  const scenario = activeScenario(selectedWindow());
  document.querySelector("#edgeInput").value = String(scenario.edge);
}

function syncControlsFromSnapshot() {
  state.selectedSymbol = symbols()[0];
  state.selectedPeriod = periodsFor(state.selectedSymbol)[0];
  state.targetRiskLevel = state.snapshot.config.targetRiskLevel;
  state.minReturnBuffer = state.snapshot.config.minReturnBuffer;
  document.querySelector("#targetRiskInput").value = String(state.targetRiskLevel);
  document.querySelector("#minReturnInput").value = String(state.minReturnBuffer);
  syncEdgeInputFromSelection();
}

function render() {
  renderSummary();
  renderProductTabs();
  renderPeriodRows();
  renderDetail();
  renderControlHint();
}

async function main() {
  const res = await fetch("./snapshot.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("无法加载 snapshot.json，请先运行 npm run backtest");
  state.snapshot = await res.json();
  syncControlsFromSnapshot();
  render();

  document.querySelector("#targetRiskInput").addEventListener("input", (event) => {
    state.targetRiskLevel = Math.max(1, Math.min(10, Number(event.target.value) || 1));
    render();
  });
  document.querySelector("#minReturnInput").addEventListener("input", (event) => {
    state.minReturnBuffer = Number(event.target.value) || 0;
    render();
  });
  document.querySelector("#edgeInput").addEventListener("input", renderControlHint);
  document.querySelector("#applyEdgeSelected").addEventListener("click", () => {
    const edge = Number(document.querySelector("#edgeInput").value);
    if (!Number.isFinite(edge) || edge <= 0 || edge >= 1) return;
    const window = selectedWindow();
    state.edgeOverrides.set(keyOf(window), closestScenario(window, edge).edge);
    render();
  });
  document.querySelector("#applyEdgeProduct").addEventListener("click", () => {
    const edge = Number(document.querySelector("#edgeInput").value);
    if (!Number.isFinite(edge) || edge <= 0 || edge >= 1) return;
    for (const window of windows().filter((w) => w.symbol === state.selectedSymbol)) {
      state.edgeOverrides.set(keyOf(window), closestScenario(window, edge).edge);
    }
    render();
  });
  document.querySelector("#resetControls").addEventListener("click", () => {
    state.edgeOverrides.clear();
    syncControlsFromSnapshot();
    render();
  });
}

main().catch((err) => {
  document.querySelector("#detailPanel").innerHTML = `<article class="card bad"><div class="title">加载失败</div><p>${err.message}</p></article>`;
});

