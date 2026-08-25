const currency = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "THB",
  maximumFractionDigits: 2,
});
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

let dashboard;
let selectedMonth = "all";
let categoryQuery = "";
let currentGroups = [];
let currentHistoryGroups = [];
let currentSurgeGroups = [];
let closeTimer;

const byId = (id) => document.getElementById(id);
const money = (value) => currency.format(Number(value || 0)).replace("THB", "฿");
const esc = (value) => String(value ?? "—").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);
const fmtMonth = (value) => !value || value === "unknown" ? "未指定" : `${value.slice(0, 4)}-${value.slice(4, 6)}`;
const fmtDate = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return esc(value);
  return date.toLocaleDateString("zh-CN", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" });
};
const categoryOf = (row) => String(row.category || "未分类").trim() || "未分类";
const amountOf = (rows) => rows.reduce((sum, row) => sum + Number(row.amount_thb || 0), 0);

function previousMonth(month) {
  const year = Number(String(month).slice(0, 4));
  const monthNumber = Number(String(month).slice(4, 6));
  if (!year || !monthNumber) return "unknown";
  const previousYear = monthNumber === 1 ? year - 1 : year;
  const previousNumber = monthNumber === 1 ? 12 : monthNumber - 1;
  return `${previousYear}${String(previousNumber).padStart(2, "0")}`;
}

function currentBusinessMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}${month}`;
}

function changeOf(current, previous) {
  if (!previous) {
    return current > 0
      ? { value: null, label: "新增", kind: "new" }
      : { value: null, label: "—", kind: "flat" };
  }
  const value = (current - previous) / previous;
  return {
    value,
    label: `${value > 0 ? "+" : ""}${percent.format(value)}`,
    kind: value > 0 ? "up" : value < 0 ? "down" : "flat",
  };
}

function shareOf(cost, revenue) {
  return revenue > 0 ? cost / revenue : null;
}

function publicPurchases() {
  return (dashboard?.details?.purchases || []).filter((row) => !row.excluded_from_shared_cost);
}

function categoryMatches(row) {
  const query = categoryQuery.trim().toLocaleLowerCase();
  return !query || categoryOf(row).toLocaleLowerCase().includes(query);
}

function filteredPurchases() {
  return publicPurchases().filter((row) =>
    (selectedMonth === "all" || row.month === selectedMonth) && categoryMatches(row));
}

function revenueForMonth(month) {
  return Number((dashboard?.monthly || []).find((row) => row.month === month)?.revenue_thb || 0);
}

function availableMonths() {
  return [...new Set(publicPurchases().map((row) => row.month).filter(Boolean))].sort();
}

function analysisMonth() {
  if (selectedMonth !== "all") return selectedMonth;
  const months = availableMonths();
  const current = currentBusinessMonth();
  if (months.includes(current)) return current;
  return months.filter((month) => month <= current).at(-1) || months.at(-1) || "unknown";
}

function scopeMonths() {
  return selectedMonth === "all" ? availableMonths() : [selectedMonth];
}

function rowsForMonth(month, applyCategory = true) {
  return publicPurchases().filter((row) => row.month === month && (!applyCategory || categoryMatches(row)));
}

function groupPurchases(rows) {
  const grouped = new Map();
  rows.forEach((row) => {
    const category = categoryOf(row);
    const key = `${row.month}|${category}`;
    const saved = grouped.get(key) || { month: row.month, category, count: 0, amount_thb: 0, rows: [] };
    saved.count += 1;
    saved.amount_thb += Number(row.amount_thb || 0);
    saved.rows.push(row);
    grouped.set(key, saved);
  });
  return [...grouped.values()].map((group) => {
    const priorMonth = previousMonth(group.month);
    const previousAmount = amountOf(publicPurchases().filter((row) => row.month === priorMonth && categoryOf(row) === group.category));
    return {
      ...group,
      previousMonth: priorMonth,
      previousAmount,
      change: changeOf(group.amount_thb, previousAmount),
      salesRevenue: revenueForMonth(group.month),
      revenueShare: shareOf(group.amount_thb, revenueForMonth(group.month)),
    };
  }).sort((a, b) => String(b.month).localeCompare(String(a.month)) || b.amount_thb - a.amount_thb);
}

function buildHistoryRanking() {
  const cutoff = selectedMonth === "all" ? null : selectedMonth;
  const baseRows = publicPurchases().filter((row) => !cutoff || row.month <= cutoff);
  const grouped = new Map();
  baseRows.forEach((row) => {
    const category = categoryOf(row);
    const saved = grouped.get(category) || { category, amount_thb: 0, count: 0, rows: [] };
    saved.amount_thb += Number(row.amount_thb || 0);
    saved.count += 1;
    saved.rows.push(row);
    grouped.set(category, saved);
  });
  const denominator = amountOf(baseRows);
  const query = categoryQuery.trim().toLocaleLowerCase();
  return [...grouped.values()]
    .sort((a, b) => b.amount_thb - a.amount_thb || a.category.localeCompare(b.category, "zh-CN"))
    .map((group, index) => ({ ...group, rank: index + 1, share: denominator ? group.amount_thb / denominator : null }))
    .filter((group) => !query || group.category.toLocaleLowerCase().includes(query));
}

function buildSurgeRanking(month) {
  const priorMonth = previousMonth(month);
  const currentRows = rowsForMonth(month, false);
  const previousRows = rowsForMonth(priorMonth, false);
  const currentMap = new Map();
  const previousMap = new Map();

  currentRows.forEach((row) => {
    const category = categoryOf(row);
    const saved = currentMap.get(category) || { amount: 0, rows: [] };
    saved.amount += Number(row.amount_thb || 0);
    saved.rows.push(row);
    currentMap.set(category, saved);
  });
  previousRows.forEach((row) => {
    const category = categoryOf(row);
    previousMap.set(category, (previousMap.get(category) || 0) + Number(row.amount_thb || 0));
  });

  const query = categoryQuery.trim().toLocaleLowerCase();
  return [...currentMap.entries()].map(([category, current]) => {
    const previousAmount = previousMap.get(category) || 0;
    return {
      month,
      previousMonth: priorMonth,
      category,
      currentAmount: current.amount,
      previousAmount,
      increaseAmount: current.amount - previousAmount,
      change: changeOf(current.amount, previousAmount),
      rows: current.rows,
    };
  }).filter((group) => group.increaseAmount > 0 && (!query || group.category.toLocaleLowerCase().includes(query)))
    .sort((a, b) => b.increaseAmount - a.increaseAmount || b.currentAmount - a.currentAmount);
}

async function loadData(preserveMonth = true) {
  const button = byId("refresh");
  button.disabled = true;
  button.textContent = "刷新中…";
  try {
    const response = await fetch(`/data/dashboard.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dashboard = await response.json();
    const months = new Set(availableMonths());
    if (!preserveMonth || (selectedMonth !== "all" && !months.has(selectedMonth))) selectedMonth = "all";
    render();
  } catch (error) {
    byId("sync-status").textContent = `读取失败：${error.message}`;
    byId("sync-dot").className = "status-dot stale";
  } finally {
    button.disabled = false;
    button.textContent = "立即刷新";
  }
}

function changeBadge(change) {
  return `<span class="cost-change ${change.kind}">${esc(change.label)}</span>`;
}

function renderKpis(rows) {
  const total = amountOf(rows);
  const categories = new Set(rows.map(categoryOf));
  const month = analysisMonth();
  const previous = previousMonth(month);
  const currentAmount = amountOf(rowsForMonth(month));
  const previousAmount = amountOf(rowsForMonth(previous));
  const monthChange = changeOf(currentAmount, previousAmount);
  const months = scopeMonths();
  const revenue = months.reduce((sum, value) => sum + revenueForMonth(value), 0);
  const revenueShare = shareOf(total, revenue);
  const monthLabel = selectedMonth === "all" ? "全部月份" : fmtMonth(selectedMonth);

  byId("cost-total").textContent = money(total);
  byId("cost-scope-note").textContent = `${monthLabel} · ${categoryQuery.trim() ? `类型包含“${categoryQuery.trim()}”` : "全部类型"}`;
  byId("category-count").textContent = number.format(categories.size);
  byId("record-count").textContent = number.format(rows.length);
  byId("cost-mom-change").textContent = monthChange.label;
  byId("cost-mom-change").className = `metric-change ${monthChange.kind}`;
  byId("cost-mom-note").textContent = `${fmtMonth(month)} ${money(currentAmount)} / ${fmtMonth(previous)} ${money(previousAmount)}`;
  byId("cost-revenue-share").textContent = revenueShare == null ? "—" : percent.format(revenueShare);
  byId("cost-revenue-note").textContent = revenue > 0
    ? `${money(total)} ÷ 同期销售收入 ${money(revenue)}`
    : "同期没有销售收入，无法计算占比";
}

function renderLedger(rows) {
  currentGroups = groupPurchases(rows);
  const monthLabel = selectedMonth === "all" ? "全部月份" : fmtMonth(selectedMonth);
  const categoryLabel = categoryQuery.trim() ? `包含“${categoryQuery.trim()}”` : "全部类型";
  byId("ledger-title").textContent = `${monthLabel} · ${categoryLabel}`;
  byId("cost-ledger-body").innerHTML = currentGroups.length ? currentGroups.map((group, index) => `<tr data-index="${index}" title="点击查看原始申购记录">
    <td class="month-cell">${fmtMonth(group.month)}</td><td>${esc(group.category)}</td><td class="num">${number.format(group.count)}</td>
    <td class="num"><strong>${money(group.amount_thb)}</strong></td><td class="num">${changeBadge(group.change)}</td>
    <td class="num">${group.revenueShare == null ? "—" : percent.format(group.revenueShare)}</td>
  </tr>`).join("") : `<tr><td colspan="6">${categoryQuery.trim() ? `没有找到包含“${esc(categoryQuery.trim())}”的费用类型。` : "该月份没有公共成本记录。"}</td></tr>`;
  document.querySelectorAll("#cost-ledger-body tr[data-index]").forEach((node) => node.addEventListener("click", () => showGroupDetails(currentGroups[Number(node.dataset.index)])));
}

function renderHistoryRanking() {
  currentHistoryGroups = buildHistoryRanking();
  const rangeLabel = selectedMonth === "all" ? "历史至今" : `历史至 ${fmtMonth(selectedMonth)}`;
  byId("history-title").textContent = `${rangeLabel}费用类型排名`;
  byId("history-note").textContent = `${categoryQuery.trim() ? `仅显示包含“${categoryQuery.trim()}”的类型；` : ""}排名按累计金额由高到低，百分比以同期全部公摊费用为基准。`;
  byId("history-category-body").innerHTML = currentHistoryGroups.length ? currentHistoryGroups.map((group, index) => `<tr data-history-index="${index}" title="点击查看历史费用明细">
    <td><span class="rank-number ${group.rank <= 3 ? "top" : ""}">${group.rank}</span></td><td>${esc(group.category)}</td>
    <td class="num"><strong>${money(group.amount_thb)}</strong><small class="table-subline">${number.format(group.count)}条记录</small></td>
    <td class="num">${group.share == null ? "—" : percent.format(group.share)}</td>
  </tr>`).join("") : '<tr><td colspan="4">当前筛选范围没有费用类型。</td></tr>';
  document.querySelectorAll("#history-category-body tr[data-history-index]").forEach((node) => node.addEventListener("click", () => showHistoryDetails(currentHistoryGroups[Number(node.dataset.historyIndex)])));
}

function renderSurgeRanking() {
  const month = analysisMonth();
  currentSurgeGroups = buildSurgeRanking(month);
  byId("surge-title").textContent = `${fmtMonth(month)}上涨费用类型`;
  byId("surge-note").textContent = `与 ${fmtMonth(previousMonth(month))} 比较，按增加金额由高到低；上月为0时标记为“新增”。`;
  byId("cost-surge-body").innerHTML = currentSurgeGroups.length ? currentSurgeGroups.map((group, index) => `<tr data-surge-index="${index}" title="点击查看本月上涨费用明细">
    <td>${esc(group.category)}</td><td class="num"><strong>${money(group.currentAmount)}</strong><small class="table-subline">上月 ${money(group.previousAmount)}</small></td>
    <td class="num positive-value">+${money(group.increaseAmount)}</td><td class="num">${changeBadge(group.change)}</td>
  </tr>`).join("") : '<tr><td colspan="4">当前筛选范围没有较上月增加的费用类型。</td></tr>';
  document.querySelectorAll("#cost-surge-body tr[data-surge-index]").forEach((node) => node.addEventListener("click", () => showSurgeDetails(currentSurgeGroups[Number(node.dataset.surgeIndex)])));
}

function render() {
  const generated = new Date(dashboard.generated_at_utc);
  const ageMinutes = (Date.now() - generated.getTime()) / 60000;
  byId("sync-dot").className = `status-dot ${ageMinutes <= 10 ? "ok" : "stale"}`;
  byId("sync-status").textContent = ageMinutes <= 10 ? "已同步，数据正常" : "数据超过 10 分钟未更新";
  byId("generated-at").textContent = `页面数据生成：${generated.toLocaleString("zh-CN")}`;

  const months = availableMonths().reverse();
  byId("cost-month-select").innerHTML = `<option value="all">全部月份</option>${months.map((month) => `<option value="${esc(month)}" ${month === selectedMonth ? "selected" : ""}>${fmtMonth(month)}</option>`).join("")}`;
  const rows = filteredPurchases();
  byId("cost-filter-count").textContent = categoryQuery.trim() ? `找到 ${rows.length} 条记录` : `共 ${rows.length} 条记录`;
  renderKpis(rows);
  renderLedger(rows);
  renderHistoryRanking();
  renderSurgeRanking();
}

function purchaseTable(rows) {
  return `<div class="drawer-table"><table><thead><tr><th>归属月份</th><th>实际支付日期</th><th>费用类型</th><th class="num">金额</th></tr></thead><tbody>${rows.slice().sort((a, b) => Number(b.amount_thb || 0) - Number(a.amount_thb || 0)).map((row) => `<tr>
    <td>${fmtMonth(row.month)}</td><td class="source-date">${fmtDate(row.source_date)}</td><td>${esc(categoryOf(row))}</td><td class="num">${money(row.amount_thb)}</td>
  </tr>`).join("")}</tbody></table></div>`;
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
  const scopeLabel = fmtMonth(group.month);
  openDrawer(`${scopeLabel} · ${group.category}`, `${group.count} 条支付成功且未驳回的公共费用记录`,
    `<div class="source-chain"><div class="source-node"><strong>申购费用表</strong><span>支付完成且未驳回</span></div><span class="source-arrow">→</span><div class="source-node"><strong>费用类型</strong><span>${esc(group.category)}</span></div><span class="source-arrow">→</span><div class="source-node"><strong>月度累计</strong><span>${money(group.amount_thb)}</span></div></div>
    <div class="drawer-summary"><div><span>本月累计</span><strong>${money(group.amount_thb)}</strong></div><div><span>较上月</span><strong>${esc(group.change.label)}</strong></div><div><span>占本月销售收入</span><strong>${group.revenueShare == null ? "—" : percent.format(group.revenueShare)}</strong></div><div><span>记录数量</span><strong>${group.count} 条</strong></div></div>
    <section class="drawer-section"><h3>费用明细</h3>${purchaseTable(group.rows)}</section>`
  );
}

function showHistoryDetails(group) {
  const rangeLabel = selectedMonth === "all" ? "历史至今" : `历史至 ${fmtMonth(selectedMonth)}`;
  openDrawer(`${group.category} · 历史累计`, `${rangeLabel}第 ${group.rank} 名`,
    `<div class="drawer-summary"><div><span>历史排名</span><strong>第 ${group.rank} 名</strong></div><div><span>累计金额</span><strong>${money(group.amount_thb)}</strong></div><div><span>占全部公摊费用</span><strong>${group.share == null ? "—" : percent.format(group.share)}</strong></div><div><span>记录数量</span><strong>${group.count} 条</strong></div></div>
    <section class="drawer-section"><h3>历史费用明细</h3>${purchaseTable(group.rows)}</section>`);
}

function showSurgeDetails(group) {
  openDrawer(`${fmtMonth(group.month)} · ${group.category}`, `较 ${fmtMonth(group.previousMonth)} ${group.change.label}`,
    `<div class="drawer-summary"><div><span>本月金额</span><strong>${money(group.currentAmount)}</strong></div><div><span>上月金额</span><strong>${money(group.previousAmount)}</strong></div><div><span>增加金额</span><strong>+${money(group.increaseAmount)}</strong></div><div><span>涨幅</span><strong>${esc(group.change.label)}</strong></div></div>
    <section class="drawer-section"><h3>本月费用明细</h3>${purchaseTable(group.rows)}</section>`);
}

byId("cost-month-select").addEventListener("change", (event) => { selectedMonth = event.target.value; render(); });
byId("cost-category-search").addEventListener("input", (event) => { categoryQuery = event.target.value; render(); });
FilterPreview.attach(byId("cost-category-search"), () => publicPurchases().map(categoryOf), { label: "全部目录类型" });
byId("refresh").addEventListener("click", () => loadData(true));
byId("drawer-close").addEventListener("click", closeDrawer);
byId("drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawer(); });

loadData(false);
setInterval(() => loadData(true), 60000);
