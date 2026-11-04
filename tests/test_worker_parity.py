"""The hosted 402 API (worker/, JavaScript) and the Python reference must agree byte for byte on what a receipt signs:
a receipt made by the Worker's signer verifies with sluice.receipts.verify and cli/verify_receipt.py's logic, and a tampered
one does not. Request hashes match too, so the Python CLI and the Worker bind the same request."""
import json
import os
import subprocess
import unittest

from sluice import receipts
from sluice import solana as sol

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r"""
import { makeSigner, requestHash } from '%s';
import core from '%s';
const seed = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const pkcs8 = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20, ...seed]);
const k = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
const x = (await crypto.subtle.exportKey('jwk', k)).x;
const pub = Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const s = await makeSigner(core.b58encode(new Uint8Array([...seed, ...pub])));
const payload = { v: 1, kind: 'sluice.receipt', order: 'ord_AbCdEfGhIjKlMnOp', rail: 'swap', resource: 'report', request_hash: 'ab'.repeat(32),
  body_sha256: 'cd'.repeat(32), price: { amount: 200000, asset: 'USDC', chain: 'solana', mint: core.USDC_MINT }, merchant: '9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR',
  deposit_address: '0x' + '12'.repeat(20), origin_asset: 'nep141:base.omft.near', deposit_tx: null, solana_tx: 'x', solana_slot: 1, merchant_delta: 200000, reference: null, issued_at: 1 };
console.log(JSON.stringify({ receipt: await s.sign(payload), key: s.pubkey, rh: await requestHash('report', { address: '9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR' }) }));
"""


def node_available():
    try:
        return subprocess.run(["node", "-v"], capture_output=True, timeout=10).returncode == 0
    except OSError:
        return False


@unittest.skipUnless(node_available(), "node not installed")
class WorkerReceiptParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = NODE % (os.path.join(ROOT, "worker", "src", "engine.js"), os.path.join(ROOT, "docs", "core.js"))
        out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60, cwd=ROOT)
        if out.returncode != 0:
            raise AssertionError(out.stderr[-400:])
        cls.d = json.loads(out.stdout)

    def test_worker_receipt_verifies_in_python(self):
        self.assertTrue(receipts.verify(self.d["receipt"], self.d["key"]))

    def test_tampered_or_foreign_receipt_fails(self):
        rc = json.loads(json.dumps(self.d["receipt"]))
        rc["payload"]["merchant_delta"] = 1
        self.assertFalse(receipts.verify(rc, self.d["key"]))
        self.assertFalse(receipts.verify(self.d["receipt"], sol.b58encode(b"\x07" * 32)))

    def test_request_hash_matches(self):
        self.assertEqual(self.d["rh"], receipts.request_hash("report", {"address": "9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR"}))


if __name__ == "__main__":
    unittest.main()
