const currency = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "THB",
  maximumFractionDigits: 2,
});
const usdCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

let dashboard;
let selectedMonth;
let currentComparisonGroups = [];
let comparisonQuery = "";
let closeTimer;

const byId = (id) => document.getElementById(id);
const money = (value) => value == null ? "待确认" : currency.format(value).replace("THB", "฿");
const usd = (value) => value == null ? "待确认" : usdCurrency.format(value);
const costPair = (thb, usdReference) => `<span class="primary-amount">${money(thb)}</span>${usdReference == null ? "" : `<small class="amount-reference">${usd(usdReference)} 参考</small>`}`;
const fmtMonth = (value) => value === "unknown" ? "未指定" : `${value.slice(0, 4)}-${value.slice(4, 6)}`;
const esc = (value) => String(value ?? "—").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);
const sourceId = (value) => `<code class="source-id" title="${esc(value)}">${esc(value)}</code>`;
const fmtDate = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return esc(value);
  return date.toLocaleDateString("zh-CN", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" });
};

async function loadData(preserveMonth = true) {
  const button = byId("refresh");
  button.disabled = true;
  button.textContent = "刷新中…";
  try {
    const response = await fetch(`/data/dashboard.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dashboard = await response.json();
    const available = dashboard.monthly.filter((row) => row.outbound_quantity > 0);
    const preferred = available.at(-1)?.month || dashboard.monthly.at(-1)?.month;
    if (!preserveMonth || !dashboard.monthly.some((row) => row.month === selectedMonth)) selectedMonth = preferred;
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
  byId("sync-status").textContent = ageMinutes <= 10 ? "已同步，数据正常" : "数据超过 10 分钟未更新";
  byId("generated-at").textContent = `页面数据生成：${generated.toLocaleString("zh-CN")}`;
  byId("month-select").innerHTML = dashboard.monthly.slice().reverse().map((row) =>
    `<option value="${row.month}" ${row.month === selectedMonth ? "selected" : ""}>${fmtMonth(row.month)}</option>`
  ).join("");
  renderMonth();
  renderTrend();
  renderMonthlyTable();
  renderComparison();
}

function setCostSummaryOpen(open) {
  const toggle = byId("cost-summary-toggle");
  const menu = byId("cost-summary-menu");
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "收起公共成本汇总" : "展开公共成本汇总");
  menu.hidden = !open;
}

const currentMonthRow = () => dashboard.monthly.find((item) => item.month === selectedMonth);
const missingSalesForMonth = (month) => salesForMonth(month).filter((row) => row.revenue_thb == null || row.product_cost_thb == null);

function missingStatus(month) {
  const rows = missingSalesForMonth(month);
  const costModels = new Set(rows.filter((row) => row.product_cost_thb == null).map((row) => row.model));
  const priceModels = new Set(rows.filter((row) => row.revenue_thb == null).map((row) => row.model));
  const quantity = rows.reduce((sum, row) => sum + row.quantity, 0);
  const labels = [];
  if (costModels.size) labels.push(`${costModels.size}型号缺成本`);
  if (priceModels.size) labels.push(`${priceModels.size}型号缺单价`);
  return { rows, quantity, label: `${labels.join("、")} · ${number.format(quantity)}件` };
}

function renderMonth() {
  const row = currentMonthRow();
  if (!row) return;
  byId("kpi-revenue").textContent = money(row.revenue_thb);
  byId("kpi-product-cost").textContent = money(row.known_product_cost_thb);
  byId("kpi-product-cost-usd").textContent = `美元参考 ${usd(row.known_product_cost_usd_reference)}`;
  byId("kpi-shared-cost").textContent = money(row.shared_cost_thb);
  byId("kpi-profit").textContent = money(row.profit_thb ?? row.profit_before_missing_cost_thb);
  const warning = byId("warning");
  if (row.complete) {
    warning.hidden = true;
    byId("profit-title").textContent = "利润";
    byId("profit-note").textContent = "收入 − 产品成本 − 公共费用";
  } else {
    warning.hidden = false;
    byId("profit-title").textContent = "暂算利润";
    byId("profit-note").textContent = "尚未扣除缺失型号成本";
    const parts = [];
    if (row.unpriced_revenue_quantity) parts.push(`${number.format(row.unpriced_revenue_quantity)} 件尚无销售单价`);
    if (row.uncosted_quantity) parts.push(`${number.format(row.uncosted_quantity)} 件尚无报关单位成本`);
    byId("warning-text").textContent = `${parts.join("；")}。当前金额只作暂算，确认成本后会自动转为完整利润。`;
  }
}

function renderTrend() {
  const rows = dashboard.monthly.filter((row) => row.outbound_quantity > 0).slice(-12);
  const peak = Math.max(...rows.flatMap((row) => [row.revenue_thb || 0, (row.known_product_cost_thb || 0) + (row.shared_cost_thb || 0)]), 1);
  byId("trend").innerHTML = rows.map((row) => {
    const revenueHeight = Math.max(2, Math.round((row.revenue_thb || 0) / peak * 108));
    const cost = (row.known_product_cost_thb || 0) + (row.shared_cost_thb || 0);
    const costHeight = Math.max(2, Math.round(cost / peak * 108));
    return `<div class="trend-month" data-month="${row.month}" title="点击穿透 ${fmtMonth(row.month)}">
      <div class="bars"><i class="bar revenue" style="height:${revenueHeight}px"></i><i class="bar cost" style="height:${costHeight}px"></i></div>
      <span class="trend-label">${row.month.slice(2, 4)}.${row.month.slice(4, 6)}</span>
    </div>`;
  }).join("");
  document.querySelectorAll(".trend-month").forEach((node) => node.addEventListener("click", () => {
    selectedMonth = node.dataset.month;
    render();
    showProfitDetails(selectedMonth);
  }));
}

function renderMonthlyTable() {
  byId("monthly-body").innerHTML = dashboard.monthly.slice().reverse().map((row) => {
    const shownProfit = row.profit_thb ?? row.profit_before_missing_cost_thb;
    const missing = row.complete ? null : missingStatus(row.month);
    return `<tr class="${row.month === selectedMonth ? "selected-row" : ""}" data-month="${row.month}" title="点击查看本月数据来源">
      <td>${fmtMonth(row.month)}</td><td class="num">${money(row.revenue_thb)}</td>
      <td class="num">${costPair(row.known_product_cost_thb, row.known_product_cost_usd_reference)}</td><td class="num">${money(row.shared_cost_thb)}</td>
      <td class="num">${money(shownProfit)}${row.complete ? "" : " *"}</td>
      <td>${row.complete
        ? '<span class="pill ok">完整</span>'
        : `<button class="pill warn missing-data-button" type="button" data-missing-month="${row.month}" title="点击查看待补型号明细">${esc(missing.label)}</button>`}</td>
    </tr>`;
  }).join("");
  document.querySelectorAll("#monthly-body tr").forEach((node) => node.addEventListener("click", () => {
    selectedMonth = node.dataset.month;
    render();
    showProfitDetails(selectedMonth);
  }));
  document.querySelectorAll("[data-missing-month]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    selectedMonth = button.dataset.missingMonth;
    render();
    showMissingDataDetails(selectedMonth);
  }));
}

function customsMonth(row) {
  return String(row.source_purchases?.[0]?.month || "unknown");
}

function comparisonStatus(row) {
  if (!row.outboundQuantity) return { label: "当月未出库", kind: "neutral" };
  if (!row.customsQuantity) return { label: "当月无报关", kind: "warn" };
  if (row.difference === 0) return { label: "数量相等", kind: "ok" };
  return row.difference > 0
    ? { label: "报关多于出库", kind: "neutral" }
    : { label: "出库多于报关", kind: "warn" };
}

function renderComparison() {
  const grouped = new Map();
  dashboard.details.sales.filter((row) => row.month === selectedMonth).forEach((row) => {
    const key = row.cost_family || row.model;
    const saved = grouped.get(key) || { model: key, outboundQuantity: 0, customsQuantity: 0, customsCount: 0, salesRows: [], customsRows: [], salesModels: new Set(), customsModels: new Set() };
    saved.outboundQuantity += Number(row.quantity || 0);
    saved.salesRows.push(row);
    saved.salesModels.add(row.model);
    grouped.set(key, saved);
  });
  (dashboard.details.customs || []).filter((row) => customsMonth(row) === selectedMonth).forEach((row) => {
    const key = row.cost_family || row.customs_model;
    const saved = grouped.get(key) || { model: key, outboundQuantity: 0, customsQuantity: 0, customsCount: 0, salesRows: [], customsRows: [], salesModels: new Set(), customsModels: new Set() };
    saved.customsQuantity += Number(row.quantity_c62 || 0);
    saved.customsCount += 1;
    saved.customsRows.push(row);
    saved.customsModels.add(row.customs_model);
    grouped.set(key, saved);
  });
  const allGroups = [...grouped.values()].map((row) => {
    row.difference = row.customsQuantity - row.outboundQuantity;
    row.status = comparisonStatus(row);
    return row;
  }).sort((a, b) => Math.max(b.outboundQuantity, b.customsQuantity) - Math.max(a.outboundQuantity, a.customsQuantity) || a.model.localeCompare(b.model));

  const query = comparisonQuery.trim().toLocaleLowerCase();
  currentComparisonGroups = query ? allGroups.filter((row) => {
    const searchable = [row.model, ...row.salesModels, ...row.customsModels].join(" ").toLocaleLowerCase();
    return searchable.includes(query);
  }) : allGroups;
  byId("comparison-result-count").textContent = query ? `找到 ${currentComparisonGroups.length} 个型号` : `共 ${allGroups.length} 个型号`;

  byId("comparison-body").innerHTML = currentComparisonGroups.length ? currentComparisonGroups.map((row, index) => {
    const actualModels = [...row.salesModels].filter((model) => model !== row.model);
    const modelNote = actualModels.length ? `<small class="comparison-alias">销售型号：${esc(actualModels.join(" / "))}</small>` : "";
    const difference = `${row.difference > 0 ? "+" : ""}${number.format(row.difference)}`;
    return `<tr data-index="${index}" title="点击查看本月出库与报关明细">
      <td><span class="model-name">${esc(row.model)}</span>${modelNote}</td>
      <td class="num">${number.format(row.outboundQuantity)}</td><td class="num">${number.format(row.customsQuantity)}</td>
      <td class="num ${row.difference < 0 ? "negative-value" : ""}">${difference}</td><td class="num">${number.format(row.customsCount)} 条</td>
      <td><span class="pill ${row.status.kind}">${row.status.label}</span></td>
    </tr>`;
  }).join("") : `<tr><td colspan="6">${query ? `没有找到包含“${esc(comparisonQuery.trim())}”的型号。` : `${fmtMonth(selectedMonth)}没有销售出库或报关数据。`}</td></tr>`;
  document.querySelectorAll("#comparison-body tr[data-index]").forEach((node) => node.addEventListener("click", () => showComparisonDetails(currentComparisonGroups[Number(node.dataset.index)])));
}

function sourceChain(nodes) {
  return `<div class="source-chain">${nodes.map((node, index) => `${index ? '<span class="source-arrow">→</span>' : ''}<div class="source-node"><strong>${esc(node.title)}</strong><span>${esc(node.detail)}</span></div>`).join("")}</div>`;
}

function summaryCards(cards) {
  return `<div class="drawer-summary">${cards.map((card) => `<div><span>${esc(card.label)}</span><strong>${esc(card.value)}</strong></div>`).join("")}</div>`;
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

function priceEvidence(row) {
  if (row.price_source === "confirmed_override") {
    const rule = row.price_source_records?.[0]?.rule_key || "人工确认规则";
    return `<span class="source-tag">人工确认价</span>${sourceId(rule)}`;
  }
  const alias = row.price_source?.startsWith("model_alias:") ? `<span class="source-tag">型号映射 ${esc(row.price_source.split(":")[1])}</span>` : "";
  const records = (row.price_source_records || []).map((item) => `${sourceId(item.record_id)} <small>${fmtDate(item.date)}</small>`).join("<br>");
  return `${alias}<span class="source-tag">单价表·使用中</span>${records}`;
}

function salesTable(rows, costMode = false) {
  if (!rows.length) return `<p>没有对应的销售出库明细。</p>`;
  return `<div class="drawer-table"><table><thead><tr><th>出库日期</th><th>客户 / 型号</th><th class="num">数量</th>
    <th class="num">${costMode ? "单位成本" : "含税单价"}</th><th class="num">${costMode ? "产品成本" : "销售收入"}</th>
  </tr></thead><tbody>${rows.map((row) => `<tr><td class="source-date">${fmtDate(row.source_date)}</td>
    <td><span class="model-customer">${esc(row.customer)}</span><span class="model-name">${esc(row.model)}</span></td>
    <td class="num">${number.format(row.quantity)}</td><td class="num">${costMode ? money(row.weighted_unit_cost_thb) : money(row.unit_price_thb)}</td>
    <td class="num">${costMode ? money(row.product_cost_thb) : money(row.revenue_thb)}</td>
  </tr>`).join("")}</tbody></table></div>`;
}

function missingDataTable(rows) {
  if (!rows.length) return `<p>本月没有待补数据。</p>`;
  return `<div class="drawer-table"><table><thead><tr><th>出库日期</th><th>客户 / 型号</th><th class="num">数量</th><th class="num">销售单价</th><th class="num">报关单位成本</th><th>缺失项目</th><th>原始来源</th>
  </tr></thead><tbody>${rows.map((row) => {
    const missing = [];
    if (row.revenue_thb == null) missing.push("销售单价");
    if (row.product_cost_thb == null) missing.push("报关成本");
    return `<tr><td class="source-date">${fmtDate(row.source_date)}</td>
      <td><span class="model-customer">${esc(row.customer)}</span><span class="model-name">${esc(row.model)}</span></td>
      <td class="num">${number.format(row.quantity)}</td><td class="num">${money(row.unit_price_thb)}</td><td class="num">${money(row.weighted_unit_cost_thb)}</td>
      <td><span class="missing-status">${esc(missing.join(" + "))}</span></td>
      <td><span class="source-tag">产品出库表</span>${sourceId(row.record_id)}<br><small>子表行 ${sourceId(row.source_line_id)}</small></td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function attachmentLinks(files) {
  const unique = new Map();
  (files || []).forEach((file) => unique.set(file.path, file));
  return `<div class="evidence-links">${[...unique.values()].map((file) => {
    const label = file.original_names?.join(" / ") || file.path;
    return `<a href="/data/attachments/${encodeURIComponent(file.path)}" target="_blank" rel="noopener">打开：${esc(label)}</a>`;
  }).join("") || "—"}</div>`;
}

function customsTable(rows) {
  if (!rows.length) return `<p>该型号暂时没有可用的报关成本明细。</p>`;
  return `<div class="drawer-table"><table><thead><tr><th>报关月份</th><th>报关型号</th><th class="num">C62数量</th><th class="num">泰铢货值</th><th class="num">单位成本</th>
  </tr></thead><tbody>${rows.map((row) => {
    return `<tr><td>${esc(row.source_purchases?.[0]?.month || "—")}</td><td>${esc(row.customs_model)}</td>
      <td class="num">${number.format(row.quantity_c62)}</td><td class="num">${money(row.value_thb)}</td><td class="num">${money(row.line_unit_cost_thb)}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function chineseCategory(value) {
  const parts = String(value || "").split("/").map((part) => part.trim()).filter((part) => /[\u3400-\u9fff]/.test(part));
  return parts.join("/") || "未分类";
}

function purchaseTable(rows) {
  if (!rows.length) return `<p>没有对应的申购费用记录。</p>`;
  return `<div class="drawer-table"><table><thead><tr><th>支付日期</th><th>费用类型</th><th class="num">金额</th>
  </tr></thead><tbody>${rows.map((row) => `<tr><td class="source-date">${fmtDate(row.source_date)}</td><td>${esc(chineseCategory(row.category))}</td><td class="num">${money(row.amount_thb)}</td>
  </tr>`).join("")}</tbody></table></div>`;
}

const salesForMonth = (month) => dashboard.details.sales.filter((row) => row.month === month);
const purchasesForMonth = (month, excluded) => dashboard.details.purchases.filter((row) => row.month === month && row.excluded_from_shared_cost === excluded).sort((a, b) => b.amount_thb - a.amount_thb);
function customsForSales(sales) {
  const families = new Set(sales.map((row) => row.cost_family).filter(Boolean));
  return (dashboard.details.customs || []).filter((row) => families.has(row.cost_family));
}

function showRevenueDetails(month, filter = {}) {
  let rows = salesForMonth(month);
  if (filter.customer) rows = rows.filter((row) => row.customer === filter.customer);
  if (filter.model) rows = rows.filter((row) => row.model === filter.model);
  const totalQty = rows.reduce((sum, row) => sum + row.quantity, 0);
  const total = rows.reduce((sum, row) => sum + (row.revenue_thb || 0), 0);
  openDrawer(filter.model ? `${filter.model} · 收入来源` : `${fmtMonth(month)} 销售收入来源`, `${rows.length} 条出库子表明细`,
    sourceChain([{ title: "产品出库表", detail: "销售出库 + 已确认；出库日期决定月份" }, { title: "销售单价表 / 人工规则", detail: "使用中泰国含税价7%" }, { title: "销售收入", detail: "出库数量 × 单价" }])
    + summaryCards([{ label: "明细条数", value: `${rows.length} 条` }, { label: "出库数量", value: `${number.format(totalQty)} 件` }, { label: "收入合计", value: money(total) }])
    + `<section class="drawer-section"><h3>销售明细</h3>${salesTable(rows)}</section>`
  );
}

function showProductCostDetails(month, filter = {}) {
  let sales = salesForMonth(month);
  if (filter.customer) sales = sales.filter((row) => row.customer === filter.customer);
  if (filter.model) sales = sales.filter((row) => row.model === filter.model);
  const customsRows = customsForSales(sales);
  const total = sales.reduce((sum, row) => sum + (row.product_cost_thb || 0), 0);
  const totalQty = sales.reduce((sum, row) => sum + (row.quantity || 0), 0);
  const modelCount = new Set(customsRows.map((row) => row.cost_family || row.customs_model)).size;
  openDrawer(filter.model ? `${filter.model} · 成本来源` : `${fmtMonth(month)} 产品成本来源`, "查看产品成本所依据的报关明细",
    sourceChain([{ title: "产品出库表", detail: "确定当月实际销售型号与数量" }, { title: "Import tax 报关附件", detail: "提取型号、C62数量、泰铢货值" }, { title: "产品成本", detail: "出库数量 × 历史加权单位成本" }])
    + summaryCards([{ label: "报关明细", value: `${customsRows.length} 条` }, { label: "涉及型号", value: `${modelCount} 个` }, { label: "当月销售出库", value: `${number.format(totalQty)} 件` }, { label: "产品成本（泰铢）", value: money(total) }])
    + `<section class="drawer-section"><h3>报关明细</h3><p>本页只展示参与单位成本计算的泰铢报关数据；美元参考值仅保留在经营利润总表。</p>${customsTable(customsRows)}</section>`
  );
}

function showSharedCostDetails(month, excluded = false) {
  const rows = purchasesForMonth(month, excluded);
  const total = rows.reduce((sum, row) => sum + (row.amount_thb || 0), 0);
  const label = excluded ? "另列 Import tax 付款" : "公共费用";
  openDrawer(`${fmtMonth(month)} ${label}来源`, `${rows.length} 条支付成功且未驳回记录`,
    sourceChain([{ title: "申购费用表", detail: "仅统计支付完成且未驳回的记录" }, { title: "费用所属月份", detail: "按照申购单填写的年月归集" }, { title: label, detail: excluded ? "单独展示，不计入公共费用" : "按月汇总" }])
    + summaryCards([{ label: "记录数量", value: `${rows.length} 条` }, { label: "归属月份", value: fmtMonth(month) }, { label: "金额合计", value: money(total) }])
    + `<section class="drawer-section"><h3>费用明细</h3>${purchaseTable(rows)}</section>`
  );
}

function showMissingDataDetails(month) {
  const missing = missingStatus(month);
  const costModels = new Set(missing.rows.filter((row) => row.product_cost_thb == null).map((row) => row.model));
  const priceModels = new Set(missing.rows.filter((row) => row.revenue_thb == null).map((row) => row.model));
  openDrawer(`${fmtMonth(month)} 待补数据`, "缺失项不会计入完整利润；补齐后看板会自动重算",
    sourceChain([{ title: "产品出库表", detail: `${number.format(missing.quantity)} 件待核对` }, { title: "销售单价 / 报关PDF", detail: "检查对应数据是否匹配" }, { title: "利润完整性", detail: "当前利润仅为暂算" }])
    + summaryCards([{ label: "待补明细", value: `${missing.rows.length} 条` }, { label: "缺成本型号", value: `${costModels.size} 个` }, { label: "缺单价型号", value: `${priceModels.size} 个` }, { label: "涉及数量", value: `${number.format(missing.quantity)} 件` }])
    + `<section class="missing-callout"><strong>当前缺失内容</strong><span>${esc(missing.label)}</span></section>`
    + `<section class="drawer-section"><h3>待补型号与来源</h3><p>“待确认”表示该项尚未进入利润计算。点击型号所在月份的完整性标签可随时回到这里。</p>${missingDataTable(missing.rows)}</section>`
  );
}

function showProfitDetails(month) {
  const row = dashboard.monthly.find((item) => item.month === month);
  const shownProfit = row.profit_thb ?? row.profit_before_missing_cost_thb;
  openDrawer(`${fmtMonth(month)} 利润来源`, row.complete ? "本月收入和成本均有完整来源" : "存在尚未匹配报关成本的型号，当前为暂算利润",
    sourceChain([{ title: "销售收入", detail: money(row.revenue_thb) }, { title: "减：产品成本", detail: money(row.known_product_cost_thb) }, { title: "减：公共费用", detail: money(row.shared_cost_thb) }, { title: row.complete ? "利润" : "暂算利润", detail: money(shownProfit) }])
    + summaryCards([{ label: "销售收入", value: money(row.revenue_thb) }, { label: "总成本", value: money(row.known_product_cost_thb + row.shared_cost_thb) }, { label: row.complete ? "利润" : "暂算利润", value: money(shownProfit) }])
    + `${row.complete ? "" : `<section class="missing-callout"><strong>本月数据尚未完整</strong><span>${esc(missingStatus(month).label)}</span><button class="missing-detail-link" type="button" data-action="missing">查看待补型号</button></section>`}`
    + `<section class="drawer-section"><h3>继续穿透</h3><div class="drawer-actions"><button class="drawer-action" data-action="revenue"><strong>销售收入来源</strong><span>查看出库记录和单价记录</span></button><button class="drawer-action" data-action="cost"><strong>产品成本来源</strong><span>查看出库数量和报关PDF</span></button><button class="drawer-action" data-action="shared"><strong>公共费用来源</strong><span>查看支付成功的申购记录</span></button></div></section>`
  );
  document.querySelector('[data-action="revenue"]').addEventListener("click", () => showRevenueDetails(month));
  document.querySelector('[data-action="cost"]').addEventListener("click", () => showProductCostDetails(month));
  document.querySelector('[data-action="shared"]').addEventListener("click", () => showSharedCostDetails(month));
  document.querySelector('[data-action="missing"]')?.addEventListener("click", () => showMissingDataDetails(month));
}

function showComparisonDetails(group) {
  const difference = `${group.difference > 0 ? "+" : ""}${number.format(group.difference)}`;
  openDrawer(`${group.model} · 出库与报关`, `${fmtMonth(selectedMonth)} · 当月流入流出对比`,
    sourceChain([{ title: "销售出库", detail: `${number.format(group.outboundQuantity)} 件` }, { title: "当月报关", detail: `${number.format(group.customsQuantity)} C62` }, { title: "数量差额", detail: difference }])
    + summaryCards([{ label: "销售出库数量", value: `${number.format(group.outboundQuantity)} 件` }, { label: "报关数量", value: `${number.format(group.customsQuantity)} C62` }, { label: "数量差额", value: difference }, { label: "报关明细", value: `${group.customsCount} 条` }])
    + `<section class="customs-note"><strong>说明</strong><span>数量差额只比较所选月份的报关与销售出库，不等于库存增减；当月出库可能来自以前报关的库存。</span></section>`
    + `<section class="drawer-section"><h3>销售出库明细</h3>${salesTable(group.salesRows)}</section>`
    + `<section class="drawer-section"><h3>报关明细</h3>${customsTable(group.customsRows)}</section>`
  );
}

function showCustomsDetails() {
  const rows = dashboard.details.customs || [];
  openDrawer("全部报关成本来源", "从 Import tax 申购记录的【相关资料】PDF提取",
    sourceChain([{ title: "申购费用表", detail: "物品信息包含 Import tax" }, { title: "报关PDF", detail: `${dashboard.customs_totals.pdf_files} 个PDF文件` }, { title: "有效产品明细", detail: `${rows.length} 条` }])
    + summaryCards([{ label: "产品数量", value: `${number.format(dashboard.customs_totals.total_quantity_c62)} C62` }, { label: "泰铢货值", value: money(dashboard.customs_totals.total_value_thb) }, { label: "美元货值（参考）", value: usd(dashboard.customs_totals.total_value_usd_reference) }, { label: "产品明细", value: `${rows.length} 条` }])
    + `<section class="drawer-section"><h3>全部报关明细</h3>${customsTable(rows)}</section>`
  );
}

function activateDrill(element, handler) {
  if (!element) return;
  element.addEventListener("click", handler);
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handler(); }
  });
}

byId("month-select").addEventListener("change", (event) => { selectedMonth = event.target.value; render(); });
byId("comparison-model-search").addEventListener("input", (event) => { comparisonQuery = event.target.value; renderComparison(); });
FilterPreview.attach(byId("comparison-model-search"), () => {
  const options = [];
  dashboard?.details?.sales?.filter((row) => row.month === selectedMonth).forEach((row) => options.push(row.model, row.cost_family));
  (dashboard?.details?.customs || []).filter((row) => customsMonth(row) === selectedMonth).forEach((row) => options.push(row.customs_model, row.cost_family));
  return options;
}, { label: "本月可选型号" });
byId("refresh").addEventListener("click", () => loadData(true));
byId("cost-summary-toggle").addEventListener("click", (event) => {
  event.stopPropagation();
  setCostSummaryOpen(byId("cost-summary-toggle").getAttribute("aria-expanded") !== "true");
});
byId("cost-summary-menu").addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => setCostSummaryOpen(false));
byId("drawer-close").addEventListener("click", closeDrawer);
byId("drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { setCostSummaryOpen(false); closeDrawer(); } });
activateDrill(document.querySelector('[data-drill="revenue"]'), () => showRevenueDetails(selectedMonth));
activateDrill(document.querySelector('[data-drill="product-cost"]'), () => showProductCostDetails(selectedMonth));
activateDrill(document.querySelector('[data-drill="shared-cost"]'), () => showSharedCostDetails(selectedMonth));
activateDrill(document.querySelector('[data-drill="profit"]'), () => showProfitDetails(selectedMonth));
document.querySelectorAll('[data-drill="customs"]').forEach((element) => activateDrill(element, showCustomsDetails));
activateDrill(document.querySelector('[data-drill="excluded-tax"]'), () => showSharedCostDetails(selectedMonth, true));

loadData(false);
setInterval(() => loadData(true), 60000);
