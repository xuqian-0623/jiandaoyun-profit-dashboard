#!/usr/bin/env python3
"""Serve the dashboard locally or as a protected Render web service."""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))
USERNAME = os.environ.get("DASHBOARD_USERNAME", "")
PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
SERVER_SYNC_ENABLED = os.environ.get("ENABLE_SERVER_SYNC", "").lower() in {
    "1",
    "true",
    "yes",
}
SYNC_INTERVAL_SECONDS = max(60, int(os.environ.get("SYNC_INTERVAL_SECONDS", "300")))


def validate_configuration() -> None:
    if bool(USERNAME) != bool(PASSWORD):
        raise RuntimeError(
            "DASHBOARD_USERNAME 和 DASHBOARD_PASSWORD 必须同时设置。"
        )
    if SERVER_SYNC_ENABLED and (not USERNAME or not PASSWORD):
        raise RuntimeError("服务器同步模式必须设置网页账号和密码。")
    if SERVER_SYNC_ENABLED and not os.environ.get("JIANDAOYUN_API_KEY", "").strip():
        raise RuntimeError("服务器同步模式必须设置 JIANDAOYUN_API_KEY。")


def run_sync_loop() -> None:
    script_path = ROOT / "scripts" / "Sync-JianDaoYun.ps1"
    while True:
        started = time.monotonic()
        print(f"[{datetime.now(timezone.utc).isoformat()}] 开始服务器后台同步。", flush=True)
        try:
            result = subprocess.run(
                [
                    "pwsh",
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    str(script_path),
                ],
                cwd=ROOT,
                check=False,
                timeout=1800,
            )
            print(
                f"[{datetime.now(timezone.utc).isoformat()}] "
                f"后台同步结束，退出码 {result.returncode}。",
                flush=True,
            )
        except (OSError, subprocess.SubprocessError) as error:
            print(
                f"[{datetime.now(timezone.utc).isoformat()}] 后台同步异常：{error}",
                flush=True,
            )

        elapsed = time.monotonic() - started
        time.sleep(max(1, SYNC_INTERVAL_SECONDS - elapsed))


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        request_path = urlsplit(self.path).path
        if request_path == "/api/health":
            self.send_health()
            return
        if not self.is_authorized():
            self.send_authentication_required()
            return
        if request_path == "/":
            self.send_response(302)
            self.send_header("Location", "/web/")
            self.end_headers()
            return
        super().do_GET()

    def do_HEAD(self):
        request_path = urlsplit(self.path).path
        if request_path == "/api/health":
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not self.is_authorized():
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="JianDaoYun Dashboard"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_HEAD()

    def is_authorized(self) -> bool:
        if not USERNAME and not PASSWORD:
            return True
        authorization = self.headers.get("Authorization", "")
        if not authorization.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(authorization[6:], validate=True).decode("utf-8")
            supplied_username, supplied_password = decoded.split(":", 1)
        except (binascii.Error, UnicodeDecodeError, ValueError):
            return False
        return hmac.compare_digest(supplied_username, USERNAME) and hmac.compare_digest(
            supplied_password, PASSWORD
        )

    def send_authentication_required(self) -> None:
        body = "需要登录后才能查看经营看板。".encode("utf-8")
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="JianDaoYun Dashboard"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_health(self) -> None:
        dashboard_exists = (ROOT / "data" / "dashboard.json").exists()
        body = json.dumps(
            {
                "status": "ok",
                "dashboard_ready": dashboard_exists,
                "time_utc": datetime.now(timezone.utc).isoformat(),
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()


if __name__ == "__main__":
    validate_configuration()
    if SERVER_SYNC_ENABLED:
        threading.Thread(target=run_sync_loop, name="dashboard-sync", daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), DashboardHandler)
    print(f"Dashboard: http://{HOST}:{PORT}/", flush=True)
    server.serve_forever()
