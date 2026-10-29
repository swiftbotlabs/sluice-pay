"""Sluice HTTP server: a pay-per-call Solana API that buyers can pay from any chain.

    GET  /api/report/<solana-address>          402 + how to pay   (or 200 + data + receipt with X-Sluice-Order)
    POST /api/orders                           create an order (Aurora quote -> deposit address)
    GET  /api/orders/<id>                      status (provider status + our own Solana verification)
    POST /api/orders/<id>/deposit              optional: {"tx_hash": ...} speeds up detection
    POST /api/orders/<id>/signature            Intents Connect rail: {"signature": "secp256k1:..."}
    GET  /api/origins                          what buyers can pay with
    GET  /.well-known/sluice.json              merchant address, receipt key, prices
    GET  /                                     checkout + docs page (web/)

Stdlib only (+ PyNaCl for receipts). Binds 127.0.0.1 by default; put a TLS proxy in front to expose it.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import aurora as au
from . import connect as cn
from . import receipts
from . import report
from . import solana as sol
from .engine import Engine, OrderError
from .store import Store

MAX_BODY = 8 * 1024
WEB_DIR = Path(__file__).resolve().parent.parent / "docs"  # also served by GitHub Pages
STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/style.css": ("style.css", "text/css; charset=utf-8"), "/qrcode.min.js": ("qrcode.min.js", "text/javascript; charset=utf-8")}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "connect-src 'self' https://intents-api.aurora.dev https://solana-mainnet.gateway.tatum.io https://api.mainnet-beta.solana.com; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")


class RateLimiter:
    """Token buckets per (ip, bucket). Memory-bounded."""

    def __init__(self):
        self.b: dict[tuple, list] = {}
        self.lock = threading.Lock()

    def allow(self, ip: str, bucket: str, rate_per_min: float, burst: int) -> bool:
        now = time.monotonic()
        with self.lock:
            if len(self.b) > 20000:
                self.b.clear()
            tokens, last = self.b.get((ip, bucket), [burst, now])
            tokens = min(burst, tokens + (now - last) * rate_per_min / 60.0)
            if tokens < 1:
                self.b[(ip, bucket)] = [tokens, now]
                return False
            self.b[(ip, bucket)] = [tokens - 1, now]
            return True


def load_env(path: str) -> dict:
    env = {}
    for line in open(path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v
    return env


def build_engine(cfg: dict, store_path: str) -> Engine:
    aurora = au.Aurora(cfg["AURORA_API_KEY"])
    rpc = sol.Rpc()
    signer = receipts.Signer(cfg["RECEIPT_SECRET_B58"])
    price = int(cfg.get("SLUICE_PRICE_RAW", "400000"))

    def validate(params):
        if not isinstance(params, dict) or set(params) - {"address"}:
            raise OrderError("params must be {address}")
        a = params.get("address")
        if not sol.is_pubkey(a or ""):
            raise OrderError("address must be a Solana public key")
        return {"address": a}

    catalog = {"report": {"price_raw": price, "validate": validate,
                          "produce": lambda p: report.render(report.wallet_report(rpc, p["address"]))}}
    return Engine(Store(store_path), aurora, rpc, signer, cfg["MERCHANT"], catalog,
                  connect=cn.Connect(cfg["AURORA_API_KEY"]))


class Handler(BaseHTTPRequestHandler):
    server_version = "sluice/0.1"
    sys_version = ""
    engine: Engine = None  # set by serve()
    limiter = RateLimiter()
    trust_proxy = False

    # -- helpers --------------------------------------------------------------------------------
    def _ip(self) -> str:
        if self.trust_proxy:
            xf = self.headers.get("X-Forwarded-For", "")
            if xf:
                return xf.split(",")[0].strip()[:64]
        return self.client_address[0]

    def _send(self, code: int, body, ctype="application/json", extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body, indent=1).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        if ctype.startswith("text/html"):
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Frame-Options", "DENY")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json_body(self) -> dict:
        n = self.headers.get("Content-Length")
        if not n or not n.isdigit() or int(n) > MAX_BODY:
            raise OrderError("body missing or too large", 413)
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            raise OrderError("Content-Type must be application/json", 415)
        try:
            d = json.loads(self.rfile.read(int(n)))
        except (ValueError, UnicodeDecodeError):
            raise OrderError("invalid JSON")
        if not isinstance(d, dict):
            raise OrderError("JSON object expected")
        return d

    def _limit(self, bucket: str, rate: float, burst: int) -> bool:
        if self.limiter.allow(self._ip(), bucket, rate, burst):
            return True
        self._send(429, {"error": "rate_limited"}, extra={"Retry-After": "10"})
        return False

    def log_message(self, fmt, *args):  # no request bodies / headers in logs
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    # -- routing --------------------------------------------------------------------------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._limit("get", 120, 40):
            return
        path = self.path.split("?", 1)[0]
        try:
            if path in STATIC:
                fn, ctype = STATIC[path]
                f = WEB_DIR / fn
                return self._send(200, f.read_bytes(), ctype) if f.is_file() else self._send(404, {"error": "not found"})
            if path == "/healthz":
                return self._send(200, {"ok": True})
            if path == "/.well-known/sluice.json":
                e = self.engine
                return self._send(200, {"merchant": e.merchant, "receipt_key": e.signer.pubkey, "settles_in": "USDC on Solana",
                                        "resources": {k: {"price_usdc": v["price_raw"] / 1e6} for k, v in e.catalog.items()}})
            if path == "/api/origins":
                return self._send(200, {"origins": self.engine.origins()})
            m = re.fullmatch(r"/api/orders/(ord_[A-Za-z0-9]{10,24})", path)
            if m:
                if not self._limit("status", 60, 20):
                    return
                return self._send(200, self.engine.refresh(m.group(1)))
            m = re.fullmatch(r"/api/report/([1-9A-HJ-NP-Za-km-z]{32,44})", path)
            if m:
                params = {"address": m.group(1)}
                oid = (self.headers.get("X-Sluice-Order") or "").strip()
                if not oid:
                    pr = self.engine.payment_required("report")
                    pr["request"] = {"resource": "report", "params": params}
                    return self._send(402, pr, extra={"WWW-Authenticate": 'Sluice realm="report"'})
                body, receipt = self.engine.deliver(oid, "report", params)
                return self._send(200, body, extra={"X-Sluice-Receipt": json.dumps(receipt, separators=(",", ":"))})
            return self._send(404, {"error": "not found"})
        except OrderError as e:
            return self._send(e.http, {"error": str(e)})
        except Exception as e:  # never leak internals
            sys.stderr.write(f"GET error: {type(e).__name__}\n")
            return self._send(500, {"error": "internal error"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/orders":
                if not self._limit("create", 6, 3):
                    return
                d = self._json_body()
                allowed = {"resource", "params", "pay_with", "refund_to", "confidential", "rail"}
                if set(d) - allowed:
                    raise OrderError("unknown fields")
                v = self.engine.create_order(resource=str(d.get("resource", "")), params=d.get("params") or {},
                                             pay_with=str(d.get("pay_with", "")), refund_to=str(d.get("refund_to", "")),
                                             confidential=bool(d.get("confidential", False)), rail=str(d.get("rail", "swap")))
                return self._send(201, v)
            m = re.fullmatch(r"/api/orders/(ord_[A-Za-z0-9]{10,24})/(deposit|signature)", path)
            if m:
                if not self._limit("post", 20, 6):
                    return
                d = self._json_body()
                if m.group(2) == "deposit":
                    return self._send(200, self.engine.note_deposit(m.group(1), str(d.get("tx_hash", ""))))
                return self._send(200, self.engine.submit_signature(m.group(1), str(d.get("signature", ""))))
            return self._send(404, {"error": "not found"})
        except OrderError as e:
            return self._send(e.http, {"error": str(e)})
        except Exception as e:
            sys.stderr.write(f"POST error: {type(e).__name__}\n")
            return self._send(500, {"error": "internal error"})


def poller(engine: Engine, stop: threading.Event, every: float = 3.0):
    """Background status refresh: one provider call per `every` seconds in total (stays far below Aurora's quota)."""
    while not stop.wait(every):
        try:
            for o in engine.store.open_orders(limit=1):
                engine.refresh(o["id"])
        except Exception as e:
            sys.stderr.write(f"poller: {type(e).__name__}\n")


def serve(cfg_path: str, host: str = "127.0.0.1", port: int = 8402, db: str = "data/sluice.db"):
    cfg = load_env(cfg_path)
    Handler.engine = build_engine(cfg, db)
    Handler.trust_proxy = cfg.get("SLUICE_TRUST_PROXY") == "1"
    stop = threading.Event()
    threading.Thread(target=poller, args=(Handler.engine, stop), daemon=True).start()
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    print(f"sluice listening on http://{host}:{port}  merchant={Handler.engine.merchant}  receipt_key={Handler.engine.signer.pubkey}")
    try:
        httpd.serve_forever()
    finally:
        stop.set()


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Sluice pay-per-call server")
    ap.add_argument("--config", default=os.environ.get("SLUICE_CONFIG", "sluice.env"),
                    help="env file with AURORA_API_KEY, MERCHANT, RECEIPT_SECRET_B58 (chmod 600)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8402)
    ap.add_argument("--db", default="data/sluice.db")
    a = ap.parse_args()
    serve(a.config, a.host, a.port, a.db)
