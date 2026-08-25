# 简道云利润看板同步程序

当前版本完成三张表的自动拉取、自动分页、业务状态筛选、Import tax 附件下载、报关单解析、利润计算和本地 HTTP 看板。

## Render 服务器部署

项目已支持部署为一个受密码保护的 Render Web Service。服务启动后会每 5 分钟在后台同步简道云、解析附件并更新网页，重要数据保存在挂载到 `/app/data` 的持久磁盘中。

1. 将项目推送到私有 GitHub/GitLab/Bitbucket 仓库，仓库中不要包含 `data/`、`logs/` 或 `config/api-key.dpapi`。
2. 在 Render 创建 Blueprint，并选择仓库根目录的 `render.yaml`。
3. 创建时设置 `JIANDAOYUN_API_KEY`、`DASHBOARD_USERNAME`、`DASHBOARD_PASSWORD` 三个机密变量。
4. 部署完成后使用 Render 分配的 HTTPS 地址访问；浏览器会先要求输入网页账号和密码。

Render 健康检查使用 `/api/health`，该接口不返回经营数据。服务器模式下若未设置 API Key 或网页账号密码，程序会拒绝启动，防止误把看板公开。

## 打开利润网页

双击 `启动利润网页.cmd`。浏览器会打开：

`http://127.0.0.1:8765/`

网页每 60 秒检查一次新数据；计划任务每 5 分钟从简道云同步并重新生成看板。电脑重启后，需要查看时再次双击该文件即可。

## 临时分享给别人

不需要长期服务器时，双击 `临时分享看板.cmd`。首次使用会从 Cloudflare 官方地址下载项目本地的 `cloudflared.exe`，随后显示一个随机 HTTPS 访问地址、账号和密码，并自动把地址复制到剪贴板。

- 把访问地址、账号和密码发给需要查看的人。
- 分享期间本机必须保持开机并联网，临时分享窗口也必须保持打开。
- 关闭窗口、按 `Ctrl+C`，或双击 `停止临时分享.cmd` 即可停止外部访问。
- 每次重新启动会得到一个新的随机地址，适合不频繁使用的临时预览。
- 本机的 5 分钟同步任务保持不变，别人看到的是同一份最新看板数据。

看板支持数据穿透：点击顶部四个金额、月度表格行、型号明细行或报关汇总，右侧会打开来源菜单，显示原始表单记录 ID、业务日期、计算链路和报关附件。

## 首次使用

1. 双击 `设置API密钥.cmd`。
2. 输入简道云 API Key。输入时屏幕不会显示字符。
3. 双击 `立即同步.cmd` 进行首次同步。
4. 首次同步成功后，双击 `安装5分钟计划任务.cmd`。

API Key 使用 Windows DPAPI 加密保存在 `config/api-key.dpapi`，只有设置密钥的 Windows 用户可以解密。不要把该文件复制给其他人。

## 当前业务筛选

- 申购：支付状态为 `PAYMENT SUCCESS/支付完成` 且流程不是驳回状态；已支付但仍处于记账流转中的记录照常计入。
- 出库：出库类型为 `销售出库การขาย` 且状态为 `确认ยืนยัน`。
- 单价：使用“使用中”的泰国含税价 7%，并执行已确认的客户、型号别名和人工例外价。
- 附件：只下载支付成功且物品信息包含 `Import tax` 的申购附件。
- 报关附件：每条支付成功的 Import tax 申购记录只读取“相关资料”字段中的唯一PDF，不读取“VAT附件”。
- 扫描版报关单：无文字层且无法自动提取时，可在 `config/manual-customs-lines.json` 中按PDF哈希补录已人工核对的产品行；如果将来PDF可以自动提取，则自动结果优先。
- 产品成本：从报关单读取型号、C62 数量和泰铢货值，按型号计算加权单位成本，再乘销售出库数量。
- 公共费用：按申购单年月汇总已支付金额；Import tax 付款额另列展示，不重复计入公共费用。
- 美元金额：只作参考，不参与计算。
- 数据审计：每次同步后自动运行独立复算，检查出库重复、单价匹配、付款状态、报关PDF覆盖、月度汇总和网页结果；审计失败时本次同步会报错。

## 自动运行

计划任务名称为 `简道云利润数据同步`，每5分钟运行一次，使用设置API Key时的同一Windows账户运行。若同步失败，程序保留上一次成功数据并在日志中记录原因。

## 输出位置

- `data/raw/purchases.json`
- `data/raw/outbound.json`
- `data/raw/prices.json`
- `data/attachments/manifest.json`
- `data/parsed/pdf-inventory.json`
- `data/parsed/customs-lines.json`
- `data/parsed/customs-summary.json`
- `data/dashboard.json`
- `data/audit-report.json`
- `data/sync-state.json`
- `logs/sync-YYYY-MM-DD.log`

接口请求失败时不会覆盖上一次成功数据，错误信息写入 `data/last-error.json`。

## 当前待确认成本

销售收入已经全部匹配单价。下列销售型号没有足够的报关单位成本依据，因此涉及月份显示“暂算利润”：

- `GX100-120V-1790W`
- `GX100-230V-1790W`
