"""The browser and the Python rail must build and audit the same Solana transaction."""
import json
import os
import subprocess
import unittest

from sluice import connect as cn
from sluice import receipts
from sluice import solana as sol

HERE = os.path.dirname(os.path.abspath(__file__))
FX = json.load(open(os.path.join(HERE, "fixture_connect_payload_earn.json")))
NODE = """
const C=require(process.argv[1]);(async()=>{const a=JSON.parse(process.argv[2]);
const s=await C.earnSteps({intermediary:a.i,merchant:a.m,orderId:a.o,price:a.p,createAta:a.c});
console.log(JSON.stringify({steps:s,ref:await C.referenceKey(a.o),usdc:await C.ata(a.m),cusdc:await C.ata(a.m,C.KLEND.cusdc),inter:C.deriveIntermediary('0x'+'ab'.repeat(20))}))})();
"""


def node_available():
    try:
        return subprocess.run(["node", "-v"], capture_output=True, timeout=10).returncode == 0
    except OSError:
        return False


class AuditTests(unittest.TestCase):
    def kw(self, **over):
        k = dict(payer=FX["payer"], intermediary=FX["intermediary"], merchant=FX["merchant"], price=FX["price"],
                 order_id=FX["order_id"], max_fee=200000)
        k.update(over)
        return k

    def test_real_payload_passes(self):
        self.assertTrue(cn.audit_earn_payload(FX["payload_json"], **self.kw())["ok"])

    def test_wrong_merchant_price_order_fee_signer_refused(self):
        for over in ({"merchant": FX["intermediary"]}, {"price": FX["price"] + 1}, {"order_id": "ord_someOtherOrder"},
                     {"max_fee": 1000}, {"payer": "0x" + "1" * 40}):
            with self.assertRaises(cn.PayloadRejected, msg=str(over)):
                cn.audit_earn_payload(FX["payload_json"], **self.kw(**over))

    def test_whole_envelope_is_checked(self):
        now = 1793534400  # 2026-11-01T12:00Z, the fixture's validity window
        p = json.loads(FX["payload_json"])

        def edited(f):
            q = json.loads(FX["payload_json"])
            m = json.loads(q["intents"][0]["msg"])
            f(q, m)
            q["intents"][0]["msg"] = json.dumps(m, separators=(",", ":"))
            return json.dumps(q, separators=(",", ":"))

        self.assertTrue(cn.solana_message_from_payload(FX["payload_json"], now))
        cases = [edited(lambda q, m: q["intents"][0].update(contract_id="evil.near")),
                 edited(lambda q, m: q["intents"][0].update(attached_deposit="1")),
                 edited(lambda q, m: q.update(verifying_contract="evil.near")),
                 edited(lambda q, m: q.update(deadline="2099-01-01T00:00:00Z")),
                 edited(lambda q, m: m["request"].update(domain_id=0)),
                 edited(lambda q, m: m["request"].update(path="0x" + "1" * 40)),
                 edited(lambda q, m: q.update(extra=1)),
                 FX["payload_json"].replace('"intents":', '"intents":[],"intents":')]
        for bad in cases:
            with self.assertRaises(cn.PayloadRejected):
                cn.solana_message_from_payload(bad, now)
        self.assertEqual(p["signer_id"], FX["payer"].lower())

    def test_intermediary_derives_locally(self):
        self.assertEqual(cn.derive_intermediary(FX["payer"]), FX["intermediary"])
        with self.assertRaises(ValueError):
            cn.derive_intermediary("nope")

    def test_earn_steps_reject_bad_input(self):
        with self.assertRaises(ValueError):
            cn.earn_steps("bad", FX["merchant"], "ord_x123456", 1)
        with self.assertRaises(ValueError):
            cn.earn_steps(FX["intermediary"], FX["merchant"], "ord_x123456", 0)


class LinkTests(unittest.TestCase):
    def test_settle_is_inside_the_signature(self):
        signer = receipts.Signer(sol.b58encode(bytes(range(32))))
        link = receipts.make_pay_link(signer, to=signer.pubkey, amount="1.00", ref="a", settle="earn", base_url="x#")
        fields, ok = receipts.read_pay_link(link.split("#", 1)[1])
        self.assertTrue(ok)
        self.assertEqual(fields["s"], "earn")
        plain = receipts.make_pay_link(signer, to=signer.pubkey, amount="1.00", ref="a", base_url="x#")
        self.assertNotIn("s", receipts.read_pay_link(plain.split("#", 1)[1])[0])
        with self.assertRaises(ValueError):
            receipts.make_pay_link(signer, to=signer.pubkey, amount="1", ref="a", settle="other")


@unittest.skipUnless(node_available(), "node not installed")
class ParityTests(unittest.TestCase):
    def test_python_and_browser_build_identical_steps(self):
        core = os.path.abspath(os.path.join(HERE, "..", "docs", "core.js"))
        for create in (True, False):
            arg = json.dumps({"i": FX["intermediary"], "m": FX["merchant"], "o": FX["order_id"], "p": FX["price"], "c": create})
            out = subprocess.run(["node", "-e", NODE, "--", core, arg], capture_output=True, text=True, timeout=30, check=True).stdout
            js = json.loads(out)
            py = cn.earn_steps(FX["intermediary"], FX["merchant"], FX["order_id"], FX["price"], create_ata=create)
            self.assertEqual(py, js["steps"])
            self.assertEqual(cn.reference_key(FX["order_id"]), js["ref"])
            self.assertEqual(sol.ata(FX["merchant"]), js["usdc"])
            self.assertEqual(sol.ata(FX["merchant"], cn.KLEND_CUSDC_MINT), js["cusdc"])
            self.assertEqual(cn.derive_intermediary("0x" + "ab" * 20), js["inter"])


if __name__ == "__main__":
    unittest.main()
