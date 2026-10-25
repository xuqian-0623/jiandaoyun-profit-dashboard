from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import secrets
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

import export_work_hours as exporter


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "outputs"
TOKEN_FILE = ROOT / "service_token.txt"


def service_token() -> str:
    configured = os.environ.get("EXPORT_TOKEN", "").strip()
    if configured:
        return configured
    if not TOKEN_FILE.exists():
        TOKEN_FILE.write_text(secrets.token_urlsafe(24), encoding="ascii")
    return TOKEN_FILE.read_text(encoding="ascii").strip()


def load_config() -> dict:
    """Load local settings, with Render environment variables taking priority."""
    config_path = ROOT / "config.local.json"
    config = {}
    if config_path.exists():
        config = json.loads(config_path.read_text(encoding="utf-8"))
    overrides = {
        "app_id": os.environ.get("JIANDAYUN_APP_ID", "").strip(),
        "entry_id": os.environ.get("JIANDAYUN_ENTRY_ID", "").strip(),
        "api_key": os.environ.get("JIANDAYUN_API_KEY", "").strip(),
    }
    config.update({key: value for key, value in overrides.items() if value})
    config.setdefault("flow_state", 1)
    missing = [key for key in ("app_id", "entry_id", "api_key") if not config.get(key)]
    if missing:
        raise RuntimeError("Missing configuration: " + ", ".join(missing))
    return config


HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>异常工时 Excel 导出</title>
<style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;max-width:1280px;margin:30px auto;padding:0 28px;color:#222}
h2{margin-bottom:24px}.row{margin:14px 0}label{display:block;font-weight:600;margin-bottom:6px}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:5px;font-size:14px}
button{padding:10px 22px;background:#08a89d;color:white;border:0;border-radius:5px;cursor:pointer}
small{color:#777}.result{margin-top:20px;padding:12px;background:#f4f8f8;display:none}
.tableWrap{max-height:560px;overflow:auto;margin:18px 0;border:1px solid #ddd}
table{width:100%;border-collapse:collapse;font-size:14px;min-width:980px}th,td{padding:9px;border-bottom:1px solid #eee;text-align:left;white-space:nowrap}th{position:sticky;top:0;background:#eef5f5}
</style></head>
<body>
<h2>异常工时 Excel 导出</h2>
<div class="row" id="tokenRow"><label>访问令牌</label><input id="token" type="password" placeholder="从 service_token.txt 复制"></div>
<div class="row"><label>日期筛选（可选）</label><input id="start_date" type="date"><input id="end_date" type="date" style="margin-top:6px"><small>留空表示全部已完成记录</small></div>
<div class="row"><label>责任部门筛选（可选）</label><input id="department" placeholder="留空表示所有部门"></div>
<button onclick="loadRecords()">加载记录</button>
<button onclick="selectAll(true)" style="background:#777">全选</button>
<button onclick="selectAll(false)" style="background:#777">取消全选</button>
<div id="count" class="result" style="display:block">请先点击“加载记录”。</div>
<button onclick="runExport()">导出勾选记录</button>
<div id="result" class="result"></div>
<div id="tableWrap" class="tableWrap"></div>
<script>
let records=[];
const params=new URLSearchParams(location.search);if(params.get('token')){document.getElementById('token').value=params.get('token');document.getElementById('tokenRow').style.display='none';}
async function loadRecords(){
 const box=document.getElementById('tableWrap'); box.innerHTML='正在加载已完成记录...';
 const q=new URLSearchParams(); for(const k of ['start_date','end_date','department']){const v=document.getElementById(k).value.trim();if(v)q.set(k,v)}
 try{const r=await fetch('/api/records?'+q.toString(),{headers:{'X-Export-Token':document.getElementById('token').value.trim()}});const x=await r.json();if(!r.ok)throw new Error(x.error||'Load failed');records=x.records||[];render();}
 catch(e){box.textContent='加载失败：'+e.message;}
}
function render(){
 const box=document.getElementById('tableWrap');
 if(!records.length){box.textContent='没有符合条件的已完成记录。';return;}
 box.innerHTML='<table><thead><tr><th></th><th>流水号</th><th>日期</th><th>提交人</th><th>线体</th><th>异常类型</th><th>责任部门</th><th>产品型号</th></tr></thead><tbody>'+records.map((x,i)=>`<tr><td><input class="pick" type="checkbox" data-i="${i}"></td><td>${x.serial||''}</td><td>${x.date||''}</td><td>${x.submitter||''}</td><td>${x.line||''}</td><td>${x.types||''}</td><td>${x.departments||''}</td><td>${x.models||''}</td></tr>`).join('')+'</tbody></table>';
 document.getElementById('count').textContent=`已加载 ${records.length} 条记录`;
}
function selectAll(value){document.querySelectorAll('.pick').forEach(x=>x.checked=value)}
async function runExport(){
 const selected=[...document.querySelectorAll('.pick:checked')].map(x=>records[Number(x.dataset.i)].serial);
 if(!selected.length){alert('请先勾选要导出的记录');return;}
 const result=document.getElementById('result'); result.style.display='block'; result.textContent='正在生成 Excel...';
 const body={serials:selected.join(','),department:document.getElementById('department').value.trim(),token:document.getElementById('token').value.trim()};
 try{const r=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json','X-Export-Token':document.getElementById('token').value.trim()},body:JSON.stringify(body)});const x=await r.json();if(!r.ok)throw new Error(x.error||'Export failed');result.innerHTML=`完成：${x.records} 条记录，${x.detail_rows} 条明细。<br><a href="${x.download_url}?token=${encodeURIComponent(document.getElementById('token').value.trim())}">下载 Excel</a>`;}
 catch(e){result.textContent='失败：'+e.message;}
}
</script>
</body></html>"""


def select_records(records, field_map, request_data):
    serial_text = str(request_data.get("serials") or "").strip()
    if serial_text:
        selected = {
            x.strip()
            for x in re.split(r"[,;，；\s]+", serial_text)
            if x.strip()
        }
        serial_field = field_map["common"]["serial"]
        records = [r for r in records if str(r.get(serial_field) or "") in selected]

    start_date = str(request_data.get("start_date") or "").strip()
    end_date = str(request_data.get("end_date") or "").strip()
    if start_date or end_date:
        date_field = field_map["common"]["datetime"]

        def in_range(record):
            dt = exporter.local_datetime(record.get(date_field))
            if not dt:
                return False
            date_text = dt.date().isoformat()
            return (not start_date or date_text >= start_date) and (not end_date or date_text <= end_date)

        records = [r for r in records if in_range(r)]
    return records


def record_summary(record, field_map):
    common = field_map["common"]
    serial = record.get(common["serial"]) or ""
    date_value = exporter.local_datetime(record.get(common["datetime"]))
    types = []
    models = []
    for letter in exporter.TYPE_LETTERS:
        detail = field_map["detail"].get(letter, {})
        root = detail.get("_root")
        if not root:
            continue
        model_key = str(detail.get("产品型号") or "").rsplit(".", 1)[-1]
        for subrow in record.get(root, []) or []:
            model = subrow.get(model_key)
            if model:
                type_name = exporter.type_label(record, letter)
                if type_name not in types:
                    types.append(type_name)
                if str(model) not in models:
                    models.append(str(model))
    departments = []
    for group in ("1", "2", "3"):
        department = record.get(field_map["responsibility"][group].get("department"))
        if department and str(department) not in departments:
            departments.append(str(department))
    submitter = exporter.display_text(record.get(common.get("submitter"))) or exporter.display_text(record.get("_widget_1714102485475"))
    return {
        "serial": str(serial),
        "date": date_value.date().isoformat() if date_value else "",
        "submitter": str(submitter or ""),
        "line": str(exporter.display_text(record.get(common.get("line"))) or ""),
        "types": "、".join(types),
        "departments": "、".join(departments),
        "models": "、".join(models),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "WorkHoursExport/1.0"

    def authorized(self, parsed=None, body=None):
        token = self.headers.get("X-Export-Token", "")
        if not token and parsed is not None:
            token = parse_qs(parsed.query).get("token", [""])[0]
        if not token and isinstance(body, dict):
            token = str(body.get("token") or "")
        return secrets.compare_digest(token, service_token())

    def send_bytes(self, content, content_type, status=200, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, payload, status=200):
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_bytes(content, "application/json; charset=utf-8", status)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.send_bytes(HTML.encode("utf-8"), "text/html; charset=utf-8")
            return
        if parsed.path == "/api/records":
            if not self.authorized(parsed):
                self.send_json({"error": "Invalid or missing access token"}, 401)
                return
            try:
                query = parse_qs(parsed.query)
                request_data = {key: values[0] for key, values in query.items()}
                config = load_config()
                field_map = exporter.load_field_map(ROOT / "字段代码对照表.xlsx")
                records = select_records(exporter.fetch_records(config), field_map, request_data)
                records = [r for r in records if str(r.get("flowState")) == str(config.get("flow_state", 1))]
                summaries = [record_summary(r, field_map) for r in records]
                department = str(request_data.get("department") or "").strip()
                if department:
                    summaries = [x for x in summaries if department in x["departments"]]
                summaries = [x for x in summaries if x["models"]]
                # Newest form submissions first; use the serial as a stable
                # secondary ordering for records on the same date.
                summaries.sort(key=lambda x: (x["date"], x["serial"]), reverse=True)
                self.send_json({"records": summaries})
            except Exception as exc:
                self.send_json({"error": str(exc)}, 500)
            return
        if parsed.path.startswith("/download/"):
            if not self.authorized(parsed):
                self.send_json({"error": "Invalid or missing access token"}, 401)
                return
            name = Path(unquote(parsed.path.rsplit("/", 1)[-1])).name
            target = (OUTPUT_DIR / name).resolve()
            if target.parent != OUTPUT_DIR.resolve() or target.suffix.lower() != ".xlsx" or not target.exists():
                self.send_json({"error": "File not found"}, 404)
                return
            self.send_bytes(
                target.read_bytes(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                extra_headers={
                    "Content-Disposition": (
                        "attachment; filename=work_hours.xlsx; "
                        f"filename*=UTF-8''{quote(target.name)}"
                    )
                },
            )
            return
        self.send_json({"error": "Not found"}, 404)

    def do_POST(self):
        if urlparse(self.path).path != "/api/export":
            self.send_json({"error": "Not found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request_data = json.loads(self.rfile.read(length) or b"{}")
            if not self.authorized(body=request_data):
                self.send_json({"error": "Invalid or missing access token"}, 401)
                return
            config = load_config()
            field_map = exporter.load_field_map(ROOT / "字段代码对照表.xlsx")
            records = select_records(exporter.fetch_records(config), field_map, request_data)
            rows = exporter.build_rows(records, field_map, flow_state=config.get("flow_state", 1))
            department = str(request_data.get("department") or "").strip()
            if department:
                rows = [row for row in rows if row.get("责任部门") == department]
            if not rows:
                self.send_json({"error": "No completed detail rows matched the filters"}, 400)
                return
            output = OUTPUT_DIR / f"异常工时费用统计_{datetime.now():%Y%m%d_%H%M%S}.xlsx"
            exporter.create_workbook(ROOT / "工时模板.xlsx", rows, output)
            self.send_json({
                "records": len(records),
                "detail_rows": len(rows),
                "download_url": "/download/" + output.name,
            })
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)

    def log_message(self, format, *args):
        print(format % args, flush=True)


def main():
    parser = argparse.ArgumentParser(description="Local work-hours export service")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    args = parser.parse_args()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Export service running at http://127.0.0.1:{args.port}/", flush=True)
    print("For LAN users, use this computer's LAN IP and the same port.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
