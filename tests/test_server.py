import http.client
import json
import os
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from sluice import server  # noqa: E402

import fakes  # noqa: E402
from test_core import make_engine  # noqa: E402


class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fa = fakes.FakeAurora()
        cls.rpc = fakes.FakeRpc(txs={fakes.SIG_A: fakes.parsed_tx(fakes.MERCHANT, 400000)})
        cls.engine, cls.produced = make_engine(cls.fa, cls.rpc)
        server.Handler.engine = cls.engine
        server.Handler.limiter = server.RateLimiter()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def req(self, method, path, body=None, headers=None, raw=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = dict(headers or {})
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        out = r.status, dict(r.getheaders()), r.read()
        c.close()
        return out

    def test_full_402_flow(self):
        code, h, b = self.req("GET", f"/api/report/{fakes.MERCHANT}")
        self.assertEqual(code, 402)
        terms = json.loads(b)
        self.assertEqual(terms["price"]["amount"], "0.4")
        self.assertIn("base:USDC", terms["accepts"])
        code, _, b = self.req("POST", "/api/orders", {**terms["request"], "pay_with": "base:USDC", "refund_to": fakes.PAYER_EVM})
        self.assertEqual(code, 201, b)
        order = json.loads(b)
        self.assertIn("Send only USDC from the Base network", order["deposit"]["transfer_requirements"])
        oid = order["order_id"]
        code, _, b = self.req("GET", f"/api/report/{fakes.MERCHANT}", headers={"X-Sluice-Order": oid})
        self.assertEqual(code, 402)
        self.fa.statuses[order["deposit"]["address"]] = [fakes.success(fakes.SIG_A)]
        code, _, b = self.req("GET", f"/api/orders/{oid}")
        self.assertEqual(json.loads(b)["state"], "SETTLED")
        code, h, b1 = self.req("GET", f"/api/report/{fakes.MERCHANT}", headers={"X-Sluice-Order": oid})
        self.assertEqual(code, 200)
        rc = json.loads(h["X-Sluice-Receipt"])
        self.assertEqual(rc["payload"]["order"], oid)
        code, h2, b2 = self.req("GET", f"/api/report/{fakes.MERCHANT}", headers={"X-Sluice-Order": oid})
        self.assertEqual(b1, b2)
        self.assertEqual(len(self.produced), 1)

    def test_input_hardening(self):
        server.Handler.limiter = type("NoLimit", (), {"allow": lambda *a: True})()
        self.addCleanup(lambda: setattr(server.Handler, "limiter", server.RateLimiter()))
        self.assertEqual(self.req("POST", "/api/orders", raw=b"x" * 9000, headers={"Content-Type": "application/json"})[0], 413)
        self.assertEqual(self.req("POST", "/api/orders", raw=b"{}", headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.req("POST", "/api/orders", raw=b"{nope", headers={"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.req("POST", "/api/orders", {"resource": "report", "evil": 1})[0], 400)
        self.assertEqual(self.req("POST", "/api/orders", raw=b"[1,2]", headers={"Content-Type": "application/json"})[0], 400)
        for p in ("/../../etc/passwd", "/web/../sluice/server.py", "/api/report/notanaddress", "/api/orders/ord_../x", "/%2e%2e/secrets"):
            self.assertEqual(self.req("GET", p)[0], 404, p)
        code, h, _ = self.req("GET", "/")
        self.assertEqual(code, 200)
        self.assertIn("default-src 'self'", h["Content-Security-Policy"])
        self.assertEqual(h["X-Content-Type-Options"], "nosniff")

    def test_rate_limit(self):
        server.Handler.limiter = server.RateLimiter()
        codes = [self.req("POST", "/api/orders", {"resource": "nope"})[0] for _ in range(6)]
        self.assertIn(429, codes)
        server.Handler.limiter = server.RateLimiter()

    def test_well_known(self):
        code, _, b = self.req("GET", "/.well-known/sluice.json")
        d = json.loads(b)
        self.assertEqual(d["merchant"], fakes.MERCHANT)
        self.assertEqual(d["receipt_key"], self.engine.signer.pubkey)


if __name__ == "__main__":
    unittest.main()
