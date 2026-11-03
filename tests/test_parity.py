"""The browser and the Python rail must build and audit the same Solana transaction."""
import json
import os
import subprocess
import unittest

from sluice import aurora as au
from sluice import connect as cn
from sluice import receipts
from sluice import solana as sol

HERE = os.path.dirname(os.path.abspath(__file__))
FX = json.load(open(os.path.join(HERE, "fixture_connect_payload_earn.json")))
MV = json.load(open(os.path.join(HERE, "fixture_merchant_view.json")))  # real mainnet reads for the demo merchant, 2026-11-03
NODE_MV = """
const C=require(process.argv[1]);const fx=JSON.parse(require('fs').readFileSync(process.argv[2]));
const paid={};for(const[k,s]of Object.entries(fx.status)){const r=C.recordAmounts(s,k,fx.merchant);paid[k]=r?r.paid:null;}
const credits={};for(const[sig,tx]of Object.entries(fx.txs)){const c=C.merchantCredit(tx,fx.merchant,fx.cusdcAta,sig);credits[sig]=c&&c.kind==='usdc'?c.usdc.toString():null;}
console.log(JSON.stringify({paid,credits}));
"""
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


    def test_name_is_signed_and_validated(self):
        signer = receipts.Signer(sol.b58encode(bytes(range(32))))
        link = receipts.make_pay_link(signer, to=signer.pubkey, amount="2.00", ref="a", name="  Café  Lumière ", base_url="x#")
        fields, ok = receipts.read_pay_link(link.split("#", 1)[1])
        self.assertTrue(ok)
        self.assertEqual(fields["n"], "Café Lumière")
        for bad in ("Sh\u200bop", "x\u202ey", "a" * 41, "...", "Shop <b>"):
            with self.assertRaises(ValueError):
                receipts.make_pay_link(signer, to=signer.pubkey, amount="1", ref="a", name=bad)


NAMES = ["  Café   Lumière  ", "Tienda de Ana & Co.", "दुकान", "Cafe\u0301", "", "   ", "...", "a" * 40, "a" * 41,
         "Shop\u202egnp.exe", "Sh\u200bop", "Shop<script>", 'Shop "x"', "Shop\u00a0Two", "Shop \U0001f642", "Line\u2028Two",
         "Tab\tand\nnewline", "O'Brien (Ltd)!", "under_score-dash", "\ufeffBOM", "東京ラーメン", "مقهى",
         "9cYFzr...DDReR", "9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2", "0x12ab Shop", "Restaurant Lumière", "Lumière2024Shop", "AbCdEfGhIjKl",
         "a\u0301\u0301\u0301", "a\u0301\u0301", "a\u20dd", "\u3164", "Shop\ufe0f", "A\u034fB", "\u115fShop", "Shop\uffa0",
         "Shop\u180b", "Verified - signed by receiving wallet"]
NODE_NAMES = """
const C=require(process.argv[1]);const a=JSON.parse(process.argv[2]);
console.log(JSON.stringify({names:a.names.map(C.cleanName),msg:C.linkMessage(a.link)}));
"""


@unittest.skipUnless(node_available(), "node not installed")
class ParityTests(unittest.TestCase):
    def test_names_and_signed_bytes_match_the_browser(self):
        core = os.path.abspath(os.path.join(HERE, "..", "docs", "core.js"))
        pk = sol.b58encode(bytes(range(32)))
        link = {"to": pk, "amt": "25.00", "ref": "inv-1", "earn": True, "name": "Café Lumière", "signer": pk, "now": 1793700000000}
        out = subprocess.run(["node", "-e", NODE_NAMES, "--", core, json.dumps({"names": NAMES, "link": link})],
                             capture_output=True, text=True, timeout=30, check=True).stdout
        js = json.loads(out)
        self.assertEqual([receipts.clean_name(n) for n in NAMES], js["names"])
        self.assertIn("Café Lumière", js["names"])
        fields = {"v": 1, "to": pk, "amt": "25.00", "ref": "inv-1", "exp": 1793700000 + 7 * 86400, "k": pk, "s": "earn", "n": "Café Lumière"}
        self.assertEqual(receipts.canonical(fields), js["msg"].encode())

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

    def test_merchant_view_amounts_match_the_python_rail(self):
        """The merchant view's numbers must be the ones the server would use: what the customer sent is the record's
        deposited amount (never the swapped amountIn), and every USDC credit is the same token delta the server verifies."""
        core = os.path.abspath(os.path.join(HERE, "..", "docs", "core.js"))
        out = subprocess.run(["node", "-e", NODE_MV, "--", core, os.path.join(HERE, "fixture_merchant_view.json")],
                             capture_output=True, text=True, timeout=30, check=True).stdout
        js = json.loads(out)
        self.assertEqual(sol.ata(MV["merchant"]), MV["usdcAta"])
        self.assertEqual(sol.ata(MV["merchant"], cn.KLEND_CUSDC_MINT), MV["cusdcAta"])
        self.assertEqual(len(MV["status"]), 5)
        for dep, s in MV["status"].items():
            py = au.summarize_status(s)
            self.assertEqual(js["paid"][dep], py["depositedAmount"], dep)
            self.assertNotEqual(js["paid"][dep], py["amountIn"], dep)
        self.assertEqual(js["paid"]["0x3ceB7E53E2127be1Ae70477AB53aE8e2955c34ba"], "0.161563")
        total = 0
        for sig, tx in MV["txs"].items():
            d = sol.token_delta(tx, MV["merchant"])
            want = js["credits"][sig]
            if want is None:
                self.assertLessEqual(d, 0, sig)  # the Kamino deposit: USDC went to the reserve, not to the merchant
            else:
                self.assertEqual(int(want), d, sig)
                total += d
        self.assertEqual(total, 2_300_000)  # 8 credits = the merchant's USDC balance after the newest one


if __name__ == "__main__":
    unittest.main()
