const thbFormatter = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "THB", maximumFractionDigits: 2 });
const usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

let dashboard;
let selectedMonth = "all";
let modelQuery = "";
let currentGroups = [];
let closeTimer;

const byId = (id) => document.getElementById(id);
const money = (value) => thbFormatter.format(Number(value || 0)).replace("THB", "฿");
const usd = (value) => usdFormatter.format(Number(value || 0));
const esc = (value) => String(value ?? "—").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const fmtMonth = (value) => !value || value === "unknown" ? "未指定" : `${value.slice(0, 4)}-${value.slice(4, 6)}`;
const fmtDate = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? esc(value) : date.toLocaleDateString("zh-CN", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" });
};
const sourceId = (value) => `<code class="source-id" title="${esc(value)}">${esc(value)}</code>`;
const familyOf = (row) => String(row.cost_family || row.customs_model || "未归类").trim();
const monthOf = (row) => String(row.source_purchases?.[0]?.month || "unknown");

function customsRows() { return dashboard?.details?.customs || []; }
function filteredRows() {
  const query = modelQuery.trim().toLocaleLowerCase();
  return customsRows().filter((row) => {
    if (selectedMonth !== "all" && monthOf(row) !== selectedMonth) return false;
    if (!query) return true;
    return `${familyOf(row)} ${row.customs_model || ""}`.toLocaleLowerCase().includes(query);
  });
}

function groupRows(rows) {
  const grouped = new Map();
  rows.forEach((row) => {
    const family = familyOf(row);
    const saved = grouped.get(family) || { family, quantity: 0, thb: 0, usd: 0, rows: [] };
    saved.quantity += Number(row.quantity_c62 || 0);
    saved.thb += Number(row.value_thb || 0);
    saved.usd += Number(row.value_usd_reference || 0);
    saved.rows.push(row);
    grouped.set(family, saved);
  });
  return [...grouped.values()].sort((a, b) => b.thb - a.thb || a.family.localeCompare(b.family));
}

async function loadData(preserveFilters = true) {
  const button = byId("refresh");
  button.disabled = true;
  button.textContent = "刷新中…";
  try {
    const response = await fetch(`/data/dashboard.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dashboard = await response.json();
    const months = new Set(customsRows().map(monthOf));
    if (!preserveFilters || (selectedMonth !== "all" && !months.has(selectedMonth))) selectedMonth = "all";
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

  const months = [...new Set(customsRows().map(monthOf))].sort().reverse();
  byId("customs-month-select").innerHTML = `<option value="all">全部月份</option>${months.map((month) => `<option value="${esc(month)}" ${month === selectedMonth ? "selected" : ""}>${fmtMonth(month)}</option>`).join("")}`;

  const rows = filteredRows();
  currentGroups = groupRows(rows);
  const totalQty = rows.reduce((sum, row) => sum + Number(row.quantity_c62 || 0), 0);
  const totalThb = rows.reduce((sum, row) => sum + Number(row.value_thb || 0), 0);
  const totalUsd = rows.reduce((sum, row) => sum + Number(row.value_usd_reference || 0), 0);
  byId("customs-thb-total").textContent = money(totalThb);
  byId("customs-qty-total").textContent = `${number.format(totalQty)} C62`;
  byId("customs-usd-total").textContent = usd(totalUsd);
  byId("customs-model-count").textContent = number.format(new Set(rows.map(familyOf)).size);
  byId("customs-filter-count").textContent = modelQuery.trim() ? `找到 ${currentGroups.length} 个型号` : `共 ${currentGroups.length} 个型号`;
  byId("customs-ledger-title").textContent = `${selectedMonth === "all" ? "全部月份" : fmtMonth(selectedMonth)} · ${modelQuery.trim() ? `包含“${modelQuery.trim()}”` : "全部型号"}`;

  byId("customs-ledger-body").innerHTML = currentGroups.length ? currentGroups.map((group, index) => `<tr data-index="${index}" title="点击查看报关批次与PDF">
    <td class="customs-model-cell"><strong>${esc(group.family)}</strong><small>${group.rows.length}条报关明细</small></td>
    <td class="num">${number.format(group.rows.length)}</td><td class="num">${number.format(group.quantity)}</td><td class="num"><strong>${money(group.thb)}</strong></td><td class="num">${usd(group.usd)}</td><td class="num">${group.quantity ? money(group.thb / group.quantity) : "—"}</td>
  </tr>`).join("") : `<tr><td colspan="6">${modelQuery.trim() ? `没有找到包含“${esc(modelQuery.trim())}”的报关型号。` : "当前筛选范围没有报关成本记录。"}</td></tr>`;
  document.querySelectorAll("#customs-ledger-body tr[data-index]").forEach((node) => node.addEventListener("click", () => showGroupDetails(currentGroups[Number(node.dataset.index)])));
}

function attachmentLinks(files) {
  const unique = new Map();
  (files || []).forEach((file) => unique.set(file.path, file));
  return `<div class="evidence-links">${[...unique.values()].map((file) => `<a href="/data/attachments/${encodeURIComponent(file.path)}" target="_blank" rel="noopener">打开：${esc(file.original_names?.join(" / ") || file.path)}</a>`).join("") || "—"}</div>`;
}

function batchTable(rows) {
  return `<div class="drawer-table"><table><thead><tr><th>报关月份</th><th>报关型号</th><th class="num">C62数量</th><th class="num">泰铢货值</th><th class="num">美元参考</th><th class="num">单位货值</th><th>申购记录 / PDF</th></tr></thead><tbody>${rows.slice().sort((a, b) => monthOf(b).localeCompare(monthOf(a))).map((row) => {
    const purchases = (row.source_purchases || []).map((item) => `${fmtMonth(item.month)} · ${fmtDate(item.date)}<br>${sourceId(item.record_id)}`).join("<br>") || "—";
    return `<tr><td>${fmtMonth(monthOf(row))}</td><td>${esc(row.customs_model)}</td><td class="num">${number.format(row.quantity_c62)}</td><td class="num">${money(row.value_thb)}</td><td class="num">${usd(row.value_usd_reference)}</td><td class="num">${money(row.line_unit_cost_thb)}</td><td>${purchases}${attachmentLinks(row.source_files)}</td></tr>`;
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
  const unit = group.quantity ? group.thb / group.quantity : 0;
  openDrawer(`${group.family} · 报关来源`, `${group.rows.length}条报关明细`,
    `<div class="source-chain"><div class="source-node"><strong>Import tax申购</strong><span>定位报关附件</span></div><span class="source-arrow">→</span><div class="source-node"><strong>报关PDF</strong><span>提取型号、C62与货值</span></div><span class="source-arrow">→</span><div class="source-node"><strong>型号汇总</strong><span>${esc(group.family)}</span></div></div>
    <div class="drawer-summary"><div><span>报关批次</span><strong>${group.rows.length} 条</strong></div><div><span>C62数量</span><strong>${number.format(group.quantity)}</strong></div><div><span>泰铢货值</span><strong>${money(group.thb)}</strong></div><div><span>加权单位货值</span><strong>${money(unit)}</strong></div></div>
    <section class="drawer-section"><h3>报关批次与原始附件</h3>${batchTable(group.rows)}</section>`
  );
}

byId("customs-month-select").addEventListener("change", (event) => { selectedMonth = event.target.value; render(); });
byId("customs-model-search").addEventListener("input", (event) => { modelQuery = event.target.value; render(); });
FilterPreview.attach(byId("customs-model-search"), () => {
  const options = [];
  customsRows().filter((row) => selectedMonth === "all" || monthOf(row) === selectedMonth)
    .forEach((row) => options.push(familyOf(row), row.customs_model));
  return options;
}, { label: "可选报关型号" });
byId("refresh").addEventListener("click", () => loadData(true));
byId("drawer-close").addEventListener("click", closeDrawer);
byId("drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawer(); });

loadData(false);
setInterval(() => loadData(true), 60000);
