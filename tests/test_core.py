import io
import json
import os
import sys
import threading
import unittest
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from sluice import aurora as au  # noqa: E402
from sluice import connect as cn  # noqa: E402
from sluice import receipts  # noqa: E402
from sluice import solana as sol  # noqa: E402
from sluice.engine import Engine, OrderError, valid_refund  # noqa: E402
from sluice.store import StateError, Store  # noqa: E402

import fakes  # noqa: E402

RECEIPT_SK = sol.b58encode(bytes(range(32)))


class TestSolana(unittest.TestCase):
    def test_base58_roundtrip(self):
        for b in (b"\0\0abc", b"\0", os.urandom(32), os.urandom(64)):
            self.assertEqual(sol.b58decode(sol.b58encode(b)), b)

    def test_ata_matches_mainnet(self):
        # verified on mainnet: seller USDC ATA (T2 settlement) and the intermediary ATA Intents Connect used
        self.assertEqual(sol.ata(fakes.MERCHANT), "AuUeb7gBsUca1aDXJV1D8XsEDjWYRC4ctx8qdHMm6yH9")
        self.assertEqual(sol.ata("Eg6brpDagWxXdYNDmsFpDUb3wjyrCZeHhBfu6jxndvcr"), "FELa4TUdvJBuBDCgNfnUXjBF2TqVXK7LomS2cLcre4Sb")

    def test_validators(self):
        self.assertTrue(sol.is_pubkey(fakes.MERCHANT))
        self.assertFalse(sol.is_pubkey("0xabc"))
        self.assertFalse(sol.is_pubkey("I" * 44))  # 'I' not in alphabet
        self.assertTrue(sol.is_signature(fakes.SIG_A))
        self.assertFalse(sol.is_signature(fakes.MERCHANT))
        with self.assertRaises(ValueError):
            sol.b58decode("x" * 200)

    def test_verify_payment_cases(self):
        rpc = fakes.FakeRpc(txs={
            fakes.SIG_A: fakes.parsed_tx(fakes.MERCHANT, 500000),
            fakes.SIG_B: fakes.parsed_tx(fakes.MERCHANT, 499999),
        })
        self.assertTrue(sol.verify_payment(rpc, fakes.SIG_A, fakes.MERCHANT, 500000)["ok"])
        short = sol.verify_payment(rpc, fakes.SIG_B, fakes.MERCHANT, 500000)
        self.assertFalse(short["ok"])
        self.assertIn("received", short["reason"])
        # wrong owner, failed tx, memo required, exact tag
        self.assertFalse(sol.verify_payment(rpc, fakes.SIG_A, "11111111111111111111111111111111", 1)["ok"])
        rpc.txs[fakes.SIG_A]["meta"]["err"] = {"InstructionError": [0, "x"]}
        self.assertFalse(sol.verify_payment(rpc, fakes.SIG_A, fakes.MERCHANT, 1)["ok"])
        rpc.txs[fakes.SIG_A] = fakes.parsed_tx(fakes.MERCHANT, 300000, memo="sluice:ord_abcdefghijkl")
        self.assertTrue(sol.verify_payment(rpc, fakes.SIG_A, fakes.MERCHANT, 300000, memo="sluice:ord_abcdefghijkl")["ok"])
        self.assertFalse(sol.verify_payment(rpc, fakes.SIG_A, fakes.MERCHANT, 300000, memo="sluice:ord_other0000000")["ok"])
        self.assertFalse(sol.verify_payment(rpc, fakes.SIG_A, fakes.MERCHANT, 299999, exact=True)["ok"])
        rpc.txs[fakes.SIG_A]["transaction"]["message"]["accountKeys"] = [{"pubkey": "RefKey1111111111111111111111111111111111111"}]
        self.assertTrue(sol.verify_payment(rpc, fakes.SIG_A, fakes.MERCHANT, 300000, reference="RefKey1111111111111111111111111111111111111")["ok"])
        self.assertFalse(sol.verify_payment(rpc, fakes.SIG_A, fakes.MERCHANT, 300000, reference=fakes.MERCHANT)["ok"])
        self.assertFalse(sol.verify_payment(rpc, fakes.SIG_A, fakes.MERCHANT, 1, not_before=2_000_000_000 + 10_000)["ok"])

    def test_wrong_mint_not_counted(self):
        rpc = fakes.FakeRpc(txs={fakes.SIG_A: fakes.parsed_tx(fakes.MERCHANT, 900000, mint="So11111111111111111111111111111111111111112")})
        self.assertFalse(sol.verify_payment(rpc, fakes.SIG_A, fakes.MERCHANT, 1)["ok"])


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestAurora(unittest.TestCase):
    def test_retry_after_429_then_ok(self):
        calls = []

        def opener(req, timeout=0):
            calls.append(req.full_url)
            if len(calls) == 1:
                raise urllib.error.HTTPError(req.full_url, 429, "x", {"Retry-After": "0"}, io.BytesIO(b"{}"))
            return FakeResp(json.dumps({"tokens": fakes.TOKENS}).encode())

        a = au.Aurora("ea5aaaaa-1111-2222-3333-444444444444", opener=opener)
        self.assertEqual(len(a.tokens()), 4)
        self.assertEqual(len(calls), 2)

    def test_quote_echo_mismatch_rejected(self):
        def opener(req, timeout=0):
            if "/tokens/" in req.full_url:
                return FakeResp(json.dumps({"tokens": fakes.TOKENS}).encode())
            body = json.loads(req.data)
            body["recipient"] = "attackerAddress1111111111111111111111111111"
            return FakeResp(json.dumps({"quoteRequest": body, "quote": {"depositAddress": "0x1"}}).encode())

        a = au.Aurora("ea5aaaaa-1111-2222-3333-444444444444", opener=opener)
        with self.assertRaises(au.AuroraError):
            a.quote(origin_asset=fakes.BASE_USDC, destination_asset=au.SOL_USDC, amount=500000,
                    recipient=fakes.MERCHANT, refund_to=fakes.PAYER_EVM)

    def test_input_bounds(self):
        a = au.Aurora("ea5aaaaa-1111-2222-3333-444444444444", opener=lambda *x, **k: FakeResp(json.dumps({"tokens": fakes.TOKENS}).encode()))
        for kw in ({"amount": 0}, {"amount": -5}, {"deadline_s": 10}, {"slippage_bps": 9999}, {"swap_type": "ANY_INPUT"},
                   {"confidentiality": "max"}):
            args = dict(origin_asset=fakes.BASE_USDC, destination_asset=au.SOL_USDC, amount=1, recipient=fakes.MERCHANT,
                        refund_to=fakes.PAYER_EVM)
            args.update(kw)
            with self.assertRaises(ValueError):
                a.quote(**args)
        with self.assertRaises(ValueError):
            a.asset("nep141:../../etc/passwd")
        with self.assertRaises(ValueError):
            au.Aurora("ok-key-123456", base="https://evil.example")

    def test_unknown_status_rejected(self):
        a = au.Aurora("ea5aaaaa-1111-2222-3333-444444444444", opener=lambda *x, **k: FakeResp(b'{"status":"WEIRD"}'))
        with self.assertRaises(au.AuroraError):
            a.status("0xabc")


class TestStore(unittest.TestCase):
    def mk(self, s, **kw):
        base = dict(rail="swap", resource="report", params="{}", request_hash="h", price_raw=1, merchant=fakes.MERCHANT,
                    origin_asset=fakes.BASE_USDC, refund_to=fakes.PAYER_EVM)
        base.update(kw)
        return s.create(**base)

    def test_transitions(self):
        s = Store(":memory:")
        o = self.mk(s, deposit_address="0x1")
        s.transition(o["id"], "PROCESSING")
        with self.assertRaises(StateError):
            s.transition(o["id"], "AWAITING_DEPOSIT")
        s.transition(o["id"], "REFUNDED")
        with self.assertRaises(StateError):
            s.transition(o["id"], "SETTLED")

    def test_settlement_sig_claimed_once(self):
        s = Store(":memory:")
        a = self.mk(s, deposit_address="0x1")
        b = self.mk(s, deposit_address="0x2")
        self.assertTrue(s.claim_settlement(a["id"], fakes.SIG_A, {"sig": fakes.SIG_A}))
        self.assertFalse(s.claim_settlement(b["id"], fakes.SIG_A, {"sig": fakes.SIG_A}))
        self.assertEqual(s.get(b["id"])["state"], "AWAITING_DEPOSIT")

    def test_deposit_address_unique(self):
        s = Store(":memory:")
        self.mk(s, deposit_address="0x1")
        with self.assertRaises(Exception):
            self.mk(s, deposit_address="0x1")

    def test_deliver_once_under_concurrency(self):
        s = Store(":memory:")
        o = self.mk(s, deposit_address="0x1")
        s.claim_settlement(o["id"], fakes.SIG_A, {"sig": fakes.SIG_A})
        runs = []

        def body(cur):
            runs.append(1)
            return b"paid work"

        out = []
        ts = [threading.Thread(target=lambda: out.append(s.deliver_once(o["id"], body, lambda c, b: "r"))) for _ in range(8)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(len(runs), 1)
        self.assertTrue(all(x == (b"paid work", "r") for x in out))


def make_engine(aurora=None, rpc=None, price=400000):
    produced = []

    def validate(p):
        if not isinstance(p, dict) or set(p) - {"address"} or not sol.is_pubkey(p.get("address", "")):
            raise OrderError("bad params")
        return {"address": p["address"]}

    def produce(p):
        produced.append(p)
        return json.dumps({"report": p["address"]}).encode()

    e = Engine(Store(":memory:"), aurora or fakes.FakeAurora(), rpc or fakes.FakeRpc(), receipts.Signer(RECEIPT_SK),
               fakes.MERCHANT, {"report": {"price_raw": price, "validate": validate, "produce": produce}}, status_min_interval=0)
    return e, produced


class TestEngine(unittest.TestCase):
    P = {"address": fakes.MERCHANT}

    def test_refund_address_family_enforced(self):
        e, _ = make_engine()
        with self.assertRaises(OrderError):
            e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh")
        with self.assertRaises(OrderError):
            e.create_order(resource="report", params=self.P, pay_with="btc:BTC", refund_to=fakes.PAYER_EVM)
        self.assertTrue(valid_refund("btc", "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"))
        with self.assertRaises(OrderError):
            e.create_order(resource="report", params={"address": "x"}, pay_with="base:USDC", refund_to=fakes.PAYER_EVM)
        with self.assertRaises(OrderError):
            e.create_order(resource="nope", params=self.P, pay_with="base:USDC", refund_to=fakes.PAYER_EVM)

    def test_happy_path_settles_only_after_solana_check_and_delivers_once(self):
        fa = fakes.FakeAurora()
        rpc = fakes.FakeRpc(txs={fakes.SIG_A: fakes.parsed_tx(fakes.MERCHANT, 400000)})
        e, produced = make_engine(fa, rpc)
        v = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=fakes.PAYER_EVM)
        self.assertEqual(fa.quotes[0]["recipient"], fakes.MERCHANT)
        self.assertEqual(fa.quotes[0]["refund_to"], fakes.PAYER_EVM)
        self.assertEqual(fa.quotes[0]["swap_type"], "EXACT_OUTPUT")
        addr = v["deposit"]["address"]
        oid = v["order_id"]
        with self.assertRaises(OrderError) as cm:
            e.deliver(oid, "report", self.P)
        self.assertEqual(cm.exception.http, 402)
        fa.statuses[addr] = [{"status": "PROCESSING"}, fakes.success(fakes.SIG_A)]
        self.assertEqual(e.refresh(oid)["state"], "PROCESSING")
        self.assertEqual(e.refresh(oid)["state"], "SETTLED")
        b1, r1 = e.deliver(oid, "report", self.P)
        b2, r2 = e.deliver(oid, "report", self.P)
        self.assertEqual(b1, b2)
        self.assertEqual(r1, r2)
        self.assertEqual(len(produced), 1)
        self.assertTrue(receipts.verify(r1, e.signer.pubkey))
        self.assertEqual(r1["payload"]["solana_tx"], fakes.SIG_A)
        self.assertEqual(r1["payload"]["body_sha256"], receipts.sha256_hex(b1))

    def test_provider_success_but_short_on_solana_is_not_delivered(self):
        fa = fakes.FakeAurora()
        rpc = fakes.FakeRpc(txs={fakes.SIG_A: fakes.parsed_tx(fakes.MERCHANT, 399999)})
        e, produced = make_engine(fa, rpc)
        v = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=fakes.PAYER_EVM)
        fa.statuses[v["deposit"]["address"]] = [fakes.success(fakes.SIG_A)]
        self.assertEqual(e.refresh(v["order_id"])["state"], "PROCESSING")
        with self.assertRaises(OrderError):
            e.deliver(v["order_id"], "report", self.P)
        self.assertEqual(produced, [])

    def test_same_solana_tx_cannot_pay_two_orders(self):
        fa = fakes.FakeAurora()
        rpc = fakes.FakeRpc(txs={fakes.SIG_A: fakes.parsed_tx(fakes.MERCHANT, 400000)})
        e, _ = make_engine(fa, rpc)
        a = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=fakes.PAYER_EVM)
        b = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=fakes.PAYER_EVM)
        fa.statuses[a["deposit"]["address"]] = [fakes.success(fakes.SIG_A)]
        fa.statuses[b["deposit"]["address"]] = [fakes.success(fakes.SIG_A)]  # lying / replayed provider data
        self.assertEqual(e.refresh(a["order_id"])["state"], "SETTLED")
        self.assertNotEqual(e.refresh(b["order_id"])["state"], "SETTLED")

    def test_refund_path_surfaces_refund(self):
        fa = fakes.FakeAurora()
        e, _ = make_engine(fa)
        v = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=fakes.PAYER_EVM)
        fa.statuses[v["deposit"]["address"]] = [
            {"status": "INCOMPLETE_DEPOSIT", "swapDetails": {"depositedAmountFormatted": "0.4"}},
            {"status": "REFUNDED", "swapDetails": {"refundedAmountFormatted": "0.3976", "refundReason": "AMOUNT_MORE_THAN_BALANCE",
                                                   "originChainTxHashes": [{"hash": "0x" + "b" * 64, "explorerUrl": ""}]}}]
        self.assertEqual(e.refresh(v["order_id"])["state"], "DEPOSIT_SEEN")
        r = e.refresh(v["order_id"])
        self.assertEqual(r["state"], "REFUNDED")
        self.assertEqual(r["refund"]["amount"], "0.3976")
        self.assertIn("0x" + "b" * 64, r["refund"]["origin_txs"])

    def test_wrong_request_for_order(self):
        fa = fakes.FakeAurora()
        rpc = fakes.FakeRpc(txs={fakes.SIG_A: fakes.parsed_tx(fakes.MERCHANT, 400000)})
        e, _ = make_engine(fa, rpc)
        v = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=fakes.PAYER_EVM)
        fa.statuses[v["deposit"]["address"]] = [fakes.success(fakes.SIG_A)]
        e.refresh(v["order_id"])
        with self.assertRaises(OrderError) as cm:
            e.deliver(v["order_id"], "report", {"address": "B5jEjGHi5HyNomGTPerQYVsJ5biMZyGp7G5rWG3ZfwMW"})
        self.assertEqual(cm.exception.http, 409)

    def test_confidential_amount_tag_and_exact_scan(self):
        fa = fakes.FakeAurora()
        e, _ = make_engine(fa)
        v = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=fakes.PAYER_EVM, confidential=True)
        tagged = fa.quotes[0]["amount"]
        self.assertTrue(400000 < tagged < 401000)
        self.assertEqual(fa.quotes[0]["confidentiality"], "advanced")
        # Solana has a plain 0.40 credit (someone else's) and our tagged credit
        e.rpc.txs = {fakes.SIG_B: fakes.parsed_tx(fakes.MERCHANT, 400000, block_time=4_000_000_000),
                     fakes.SIG_A: fakes.parsed_tx(fakes.MERCHANT, tagged, block_time=4_000_000_000)}
        e.rpc.sigs = [{"signature": fakes.SIG_B, "blockTime": 4_000_000_000, "err": None},
                      {"signature": fakes.SIG_A, "blockTime": 4_000_000_000, "err": None}]
        fa.statuses[v["deposit"]["address"]] = [{"status": "SUCCESS"}]  # confidential: no hashes
        r = e.refresh(v["order_id"])
        self.assertEqual(r["state"], "SETTLED")
        self.assertEqual(r["settlement"]["solana_tx"], fakes.SIG_A)

    def test_bad_order_ids(self):
        e, _ = make_engine()
        for bad in ("", "../etc", "ord_" + "x" * 80, "ord_short"):
            with self.assertRaises(OrderError):
                e.refresh(bad)


class TestReceiptsAndLinks(unittest.TestCase):
    def test_sign_verify_tamper(self):
        s = receipts.Signer(RECEIPT_SK)
        r = s.sign({"a": 1})
        self.assertTrue(receipts.verify(r, s.pubkey))
        r["payload"]["a"] = 2
        self.assertFalse(receipts.verify(r))
        self.assertFalse(receipts.verify({"payload": {}, "signature": "x"}))

    def test_pay_link_roundtrip_and_tamper(self):
        s = receipts.Signer(RECEIPT_SK)
        url = receipts.make_pay_link(s, to=fakes.MERCHANT, amount="1.50", ref="inv-1")
        frag = url.split("#", 1)[1]
        f, ok = receipts.read_pay_link(frag)
        self.assertTrue(ok)
        self.assertEqual(f["amt"], "1.50")
        m, sig = frag[2:].split(".")
        evil = json.loads(receipts._unb64u(m))
        evil["amt"] = "0.01"
        forged = "p=" + receipts._b64u(receipts.canonical(evil)) + "." + sig
        self.assertFalse(receipts.read_pay_link(forged)[1])


class TestConnectSteps(unittest.TestCase):
    def test_receipt_steps_shape(self):
        inter = "Eg6brpDagWxXdYNDmsFpDUb3wjyrCZeHhBfu6jxndvcr"
        steps = cn.receipt_steps(inter, fakes.MERCHANT, "ord_abcdefghijkl")
        self.assertEqual([s["programId"] for s in steps], [sol.ATA_PROGRAM, sol.TOKEN_PROGRAM])
        pay = steps[1]
        self.assertEqual(pay["discriminator"], "0c")
        self.assertEqual(pay["accounts"][2]["pubkey"], sol.ata(fakes.MERCHANT))
        self.assertEqual(pay["accounts"][0]["pubkey"], sol.ata(inter))
        self.assertEqual(pay["accounts"][4], {"pubkey": cn.reference_key("ord_abcdefghijkl"), "isSigner": False, "isWritable": False})
        self.assertNotEqual(cn.reference_key("ord_abcdefghijkl"), cn.reference_key("ord_abcdefghijkm"))
        for s in steps:  # only the intermediary may sign (service rule)
            for acc in s["accounts"]:
                if acc["isSigner"]:
                    self.assertEqual(acc["pubkey"], "{INTERMEDIARY}")
        with self.assertRaises(ValueError):
            cn.reference_key("bad id with spaces")

    def test_erc191_wire_format(self):
        try:
            from eth_account import Account
            from eth_account.messages import encode_defunct
        except ImportError:
            self.skipTest("eth-account not installed")
        acct = Account.create()
        sig = cn.sign_erc191(acct.key.hex(), '{"x":1}')
        self.assertTrue(sig.startswith("secp256k1:"))
        raw = bytearray(sol.b58decode(sig.split(":", 1)[1]))
        self.assertEqual(len(raw), 65)
        self.assertIn(raw[64], (0, 1))
        raw[64] += 27
        self.assertEqual(Account.recover_message(encode_defunct(text='{"x":1}'), signature=bytes(raw)), acct.address)


if __name__ == "__main__":
    unittest.main()
