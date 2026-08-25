const currency = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "THB", maximumFractionDigits: 2 });
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 });

let dashboard;
let selectedMonth = "all";
let selectedCustomer = "all";
let modelQuery = "";
let currentGroups = [];
let closeTimer;

const byId = (id) => document.getElementById(id);
const money = (value) => value == null ? "待确认" : currency.format(Number(value)).replace("THB", "฿");
const esc = (value) => String(value ?? "—").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const fmtMonth = (value) => !value || value === "unknown" ? "未指定" : `${value.slice(0, 4)}-${value.slice(4, 6)}`;
const fmtDate = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? esc(value) : date.toLocaleDateString("zh-CN", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" });
};

function salesRows() { return dashboard?.details?.sales || []; }
function filteredSales() {
  const query = modelQuery.trim().toLocaleLowerCase();
  return salesRows().filter((row) =>
    (selectedMonth === "all" || row.month === selectedMonth)
    && (selectedCustomer === "all" || row.customer === selectedCustomer)
    && (!query || `${row.model || ""} ${row.cost_family || ""}`.toLocaleLowerCase().includes(query)));
}

function groupSales(rows) {
  const grouped = new Map();
  rows.forEach((row) => {
    const key = `${row.customer}|${row.model}`;
    const saved = grouped.get(key) || {
      customer: row.customer, model: row.model, quantity: 0, revenue: 0, cost: 0,
      hasRevenue: true, hasCost: true, rows: [],
    };
    saved.quantity += Number(row.quantity || 0);
    if (row.revenue_thb == null) saved.hasRevenue = false; else saved.revenue += Number(row.revenue_thb);
    if (row.product_cost_thb == null) saved.hasCost = false; else saved.cost += Number(row.product_cost_thb);
    saved.rows.push(row);
    grouped.set(key, saved);
  });
  return [...grouped.values()].map((group) => {
    group.complete = group.hasRevenue && group.hasCost;
    group.gross = group.complete ? group.revenue - group.cost : null;
    group.margin = group.complete && group.revenue ? group.gross / group.revenue : null;
    group.avgPrice = group.hasRevenue && group.quantity ? group.revenue / group.quantity : null;
    group.avgCost = group.hasCost && group.quantity ? group.cost / group.quantity : null;
    return group;
  }).sort((a, b) => (b.gross ?? -Infinity) - (a.gross ?? -Infinity) || b.revenue - a.revenue);
}

async function loadData(preserveFilters = true) {
  const button = byId("refresh");
  button.disabled = true;
  button.textContent = "刷新中…";
  try {
    const response = await fetch(`/data/dashboard.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dashboard = await response.json();
    const months = new Set(salesRows().map((row) => row.month));
    const customers = new Set(salesRows().map((row) => row.customer));
    if (!preserveFilters || (selectedMonth !== "all" && !months.has(selectedMonth))) selectedMonth = "all";
    if (!preserveFilters || (selectedCustomer !== "all" && !customers.has(selectedCustomer))) selectedCustomer = "all";
    if (!preserveFilters) modelQuery = "";
    render();
  } catch (error) {
    byId("sync-status").textContent = `读取失败：${error.message}`;
    byId("sync-dot").className = "status-dot stale";
  } finally {
    button.disabled = false;
    button.textContent = "立即刷新";
  }
}

function render() {
  const generated = new Date(dashboard.generated_at_utc);
  const ageMinutes = (Date.now() - generated.getTime()) / 60000;
  byId("sync-dot").className = `status-dot ${ageMinutes <= 10 ? "ok" : "stale"}`;
  byId("sync-status").textContent = ageMinutes <= 10 ? "已同步，数据正常" : "数据超过10分钟未更新";
  byId("generated-at").textContent = `页面数据生成：${generated.toLocaleString("zh-CN")}`;

  const months = [...new Set(salesRows().map((row) => row.month))].sort().reverse();
  const customers = [...new Set(salesRows().map((row) => row.customer))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  byId("profit-month-select").innerHTML = `<option value="all">全部月份</option>${months.map((value) => `<option value="${esc(value)}" ${value === selectedMonth ? "selected" : ""}>${fmtMonth(value)}</option>`).join("")}`;
  byId("profit-customer-select").innerHTML = `<option value="all">全部客户</option>${customers.map((value) => `<option value="${esc(value)}" ${value === selectedCustomer ? "selected" : ""}>${esc(value)}</option>`).join("")}`;

  const rows = filteredSales();
  currentGroups = groupSales(rows);
  const visibleModelCount = new Set(currentGroups.map((group) => group.model)).size;
  byId("profit-filter-count").textContent = modelQuery.trim() ? `找到 ${visibleModelCount} 个型号` : `共 ${visibleModelCount} 个型号`;
  const completeRows = rows.filter((row) => row.revenue_thb != null && row.product_cost_thb != null);
  const revenue = completeRows.reduce((sum, row) => sum + Number(row.revenue_thb), 0);
  const cost = completeRows.reduce((sum, row) => sum + Number(row.product_cost_thb), 0);
  const gross = revenue - cost;
  byId("profit-revenue").textContent = money(revenue);
  byId("profit-cost").textContent = money(cost);
  byId("profit-gross").textContent = money(gross);
  byId("profit-margin").textContent = revenue ? percent.format(gross / revenue) : "—";

  const incomplete = rows.filter((row) => row.revenue_thb == null || row.product_cost_thb == null);
  const warning = byId("profit-warning");
  warning.hidden = incomplete.length === 0;
  if (incomplete.length) {
    const missingPrice = new Set(incomplete.filter((row) => row.revenue_thb == null).map((row) => row.model));
    const missingCost = new Set(incomplete.filter((row) => row.product_cost_thb == null).map((row) => row.model));
    const qty = incomplete.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    byId("profit-warning-text").textContent = `${missingPrice.size}个型号缺销售单价，${missingCost.size}个型号缺报关单台成本，共涉及${number.format(qty)}件；顶部金额只汇总完整明细。`;
  }

  const monthLabel = selectedMonth === "all" ? "全部月份" : fmtMonth(selectedMonth);
  const customerLabel = selectedCustomer === "all" ? "全部客户" : selectedCustomer;
  const modelLabel = modelQuery.trim() ? `型号包含“${modelQuery.trim()}”` : "全部型号";
  byId("profit-ledger-title").textContent = `${monthLabel} · ${customerLabel} · ${modelLabel}`;
  byId("profit-ledger-body").innerHTML = currentGroups.length ? currentGroups.map((group, index) => `<tr data-index="${index}" title="点击查看出库、售价和成本来源">
    <td><span class="model-customer">${esc(group.customer)}</span><span class="model-name">${esc(group.model)}</span></td>
    <td class="num">${number.format(group.quantity)}</td><td class="num">${money(group.avgPrice)}</td><td class="num">${group.hasRevenue ? money(group.revenue) : '<span class="missing">缺单价</span>'}</td>
    <td class="num">${money(group.avgCost)}</td><td class="num">${group.hasCost ? money(group.cost) : '<span class="missing">缺成本</span>'}</td>
    <td class="num ${group.gross != null && group.gross < 0 ? "negative-value" : ""}">${group.complete ? money(group.gross) : "—"}</td><td class="num ${group.margin != null && group.margin < 0 ? "negative-value" : ""}">${group.margin == null ? "—" : percent.format(group.margin)}</td>
    <td>${group.complete ? '<span class="pill ok">完整</span>' : '<span class="pill warn">待补数据</span>'}</td>
  </tr>`).join("") : `<tr><td colspan="9">${modelQuery.trim() ? `没有找到包含“${esc(modelQuery.trim())}”的产品型号。` : "当前筛选范围没有销售出库记录。"}</td></tr>`;
  document.querySelectorAll("#profit-ledger-body tr[data-index]").forEach((node) => node.addEventListener("click", () => showGroupDetails(currentGroups[Number(node.dataset.index)])));
}

function detailTable(rows) {
  return `<div class="drawer-table"><table><thead><tr><th>出库日期</th><th class="num">数量</th><th class="num">销售单价</th><th class="num">销售收入</th><th class="num">报关单台成本</th><th class="num">报关总成本</th><th class="num">产品毛利</th></tr></thead><tbody>${rows.slice().sort((a, b) => String(b.source_date).localeCompare(String(a.source_date))).map((row) => {
    const gross = row.revenue_thb == null || row.product_cost_thb == null ? null : Number(row.revenue_thb) - Number(row.product_cost_thb);
    return `<tr><td>${fmtDate(row.source_date)}</td><td class="num">${number.format(row.quantity)}</td><td class="num">${money(row.unit_price_thb)}</td><td class="num">${money(row.revenue_thb)}</td><td class="num">${money(row.weighted_unit_cost_thb)}</td><td class="num">${money(row.product_cost_thb)}</td><td class="num">${money(gross)}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function openDrawer(title, subtitle, html) {
  clearTimeout(closeTimer);
  byId("drawer-title").textContent = title;
  byId("drawer-subtitle").textContent = subtitle;
  byId("drawer-content").innerHTML = html;
  byId("drawer-backdrop").hidden = false;
  byId("source-drawer").setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
  requestAnimationFrame(() => byId("source-drawer").classList.add("open"));
}

function closeDrawer() {
  byId("source-drawer").classList.remove("open");
  byId("source-drawer").setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  closeTimer = setTimeout(() => { byId("drawer-backdrop").hidden = true; }, 260);
}

function showGroupDetails(group) {
  const grossLabel = group.complete ? money(group.gross) : "待补数据";
  openDrawer(`${group.model} · 产品毛利来源`, `${group.customer} · ${selectedMonth === "all" ? "全部月份" : fmtMonth(selectedMonth)}`,
    `<div class="source-chain"><div class="source-node"><strong>销售出库</strong><span>${number.format(group.quantity)}件</span></div><span class="source-arrow">→</span><div class="source-node"><strong>销售收入</strong><span>${group.hasRevenue ? money(group.revenue) : "待确认"}</span></div><span class="source-arrow">→</span><div class="source-node"><strong>减：报关总成本</strong><span>${group.hasCost ? money(group.cost) : "待确认"}</span></div><span class="source-arrow">→</span><div class="source-node"><strong>产品毛利</strong><span>${grossLabel}</span></div></div>
    <div class="drawer-summary"><div><span>销售收入</span><strong>${group.hasRevenue ? money(group.revenue) : "待确认"}</strong></div><div><span>报关总成本</span><strong>${group.hasCost ? money(group.cost) : "待确认"}</strong></div><div><span>产品毛利</span><strong>${grossLabel}</strong></div><div><span>毛利率</span><strong>${group.margin == null ? "待确认" : percent.format(group.margin)}</strong></div></div>
    <section class="drawer-section"><h3>逐条出库与计算来源</h3><p>销售收入来自销售出库数量与销售单价；报关总成本为销售出库数量乘以当前报关单台成本。</p>${detailTable(group.rows)}</section>`);
}

byId("profit-month-select").addEventListener("change", (event) => { selectedMonth = event.target.value; render(); });
byId("profit-customer-select").addEventListener("change", (event) => { selectedCustomer = event.target.value; render(); });
byId("profit-model-search").addEventListener("input", (event) => { modelQuery = event.target.value; render(); });
FilterPreview.attach(byId("profit-model-search"), () => {
  const options = [];
  salesRows().filter((row) => (selectedMonth === "all" || row.month === selectedMonth)
    && (selectedCustomer === "all" || row.customer === selectedCustomer))
    .forEach((row) => options.push(row.model, row.cost_family));
  return options;
}, { label: "可选销售型号" });
byId("refresh").addEventListener("click", () => loadData(true));
byId("drawer-close").addEventListener("click", closeDrawer);
byId("drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawer(); });

loadData(false);
setInterval(() => loadData(true), 60000);
