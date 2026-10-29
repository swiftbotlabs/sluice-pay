"""Regression tests for the security review findings (C1, H1, H2, M1, M2 and lows)."""
import json
import os
import sys
import time
import unittest
from unittest import mock

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(HERE, "..", "cli"))
sys.path.insert(0, HERE)

from sluice import connect as cn  # noqa: E402
from sluice import server  # noqa: E402
from sluice import solana as sol  # noqa: E402
from sluice.engine import OrderError  # noqa: E402

import fakes  # noqa: E402
from test_core import make_engine  # noqa: E402

# Real payloads returned by Intents Connect on mainnet: the steps-only execution that SETTLED (reference account)
FIX = json.load(open(os.path.join(HERE, "fixture_connect_payload_ref.json")))
FIX_MEMO = json.load(open(os.path.join(HERE, "fixture_connect_payload.json")))  # first design, never executed by the relayer
PAYER = "0x8d9716A9f13FE82BA59E74b3Ce032842EB357818"


def mutate(payload_json: str, old: bytes, new: bytes) -> str:
    p = json.loads(payload_json)
    msg = json.loads(p["intents"][0]["msg"])
    h = msg["request"]["payload_v2"]["Eddsa"]
    assert old.hex() in h
    msg["request"]["payload_v2"]["Eddsa"] = h.replace(old.hex(), new.hex(), 1)
    p["intents"][0]["msg"] = json.dumps(msg)
    return json.dumps(p)


class TestConnectAudit(unittest.TestCase):
    """Positive control = the real payload Intents Connect returned on mainnet; negatives = single-field edits."""

    def audit(self, payload, **kw):
        args = dict(payer=PAYER, intermediary=FIX["intermediary"], merchant=FIX["merchant"], price=FIX["price"], order_id=FIX["order"])
        args.update(kw)
        return cn.audit_payload(payload, **args)

    def test_real_payload_passes(self):
        self.assertTrue(self.audit(FIX["payload"])["ok"])

    def test_redirected_payment_rejected(self):
        evil = sol.b58decode(sol.ata("B5jEjGHi5HyNomGTPerQYVsJ5biMZyGp7G5rWG3ZfwMW"))
        bad = mutate(FIX["payload"], sol.b58decode(sol.ata(FIX["merchant"])), evil)
        with self.assertRaises(cn.PayloadRejected):
            self.audit(bad)

    def test_wrong_amount_memo_signer_price_rejected(self):
        bad_amt = mutate(FIX["payload"], bytes.fromhex("0ce093040000000000"), bytes.fromhex("0c40420f0000000000"))
        bad_ref = mutate(FIX["payload"], sol.b58decode(cn.reference_key(FIX["order"])), sol.b58decode(cn.reference_key("ord_other_order")))
        for payload in (bad_amt, bad_ref):
            with self.assertRaises(cn.PayloadRejected):
                self.audit(payload)
        with self.assertRaises(cn.PayloadRejected):
            self.audit(FIX["payload"], payer="0x0000000000000000000000000000000000000001")
        with self.assertRaises(cn.PayloadRejected):
            self.audit(FIX["payload"], price=299999)
        with self.assertRaises(cn.PayloadRejected):
            self.audit(FIX["payload"], max_fee=1000)  # the real fee (1555) is above this cap
        with self.assertRaises(cn.PayloadRejected):
            self.audit(FIX_MEMO["payload"])  # old memo design: no reference account, Memo program not allowed

    def test_memo_hex_in_metadata_is_not_enough(self):
        p = json.loads(FIX["payload"])
        p["note"] = cn.reference_key("ord_attackerxx")
        with self.assertRaises(cn.PayloadRejected):
            self.audit(json.dumps(p), order_id="ord_attackerxx")


class TestBuyerChecks(unittest.TestCase):
    def setUp(self):
        import sluice_buy
        self.b = sluice_buy
        self.good = {"status": "PENDING_DEPOSIT", "quoteResponse": {
            "quoteRequest": {"destinationAsset": self.b.SOL_USDC, "originAsset": self.b.PINNED["base:USDC"][3],
                             "swapType": "EXACT_OUTPUT", "refundTo": PAYER, "recipient": fakes.MERCHANT, "amount": "400000"},
            "quote": {"depositAddress": "0x" + "1" * 40, "amountIn": "410000"}}}

    def run_check(self, st, **kw):
        args = dict(recipient=fakes.MERCHANT, origin_asset=self.b.PINNED["base:USDC"][3], refund_to=PAYER, price=400000,
                    amount_raw=410000, confidential=False)
        args.update(kw)
        with mock.patch.object(self.b, "jget", return_value=st):
            return self.b.check_deposit_quote("0x" + "1" * 40, **args)

    def test_good_quote_passes(self):
        self.assertEqual(self.run_check(self.good)["status"], "PENDING_DEPOSIT")

    def test_malicious_server_quotes_rejected(self):
        cases = [("recipient", "attacker111111111111111111111111111111111111"), ("amount", "1"), ("refundTo", "0x" + "2" * 40),
                 ("originAsset", "nep141:eth.omft.near"), ("swapType", "EXACT_INPUT"), ("destinationAsset", "nep141:wrap.near")]
        for field, val in cases:
            st = json.loads(json.dumps(self.good))
            st["quoteResponse"]["quoteRequest"][field] = val
            with self.assertRaises(SystemExit, msg=field):
                self.run_check(st)
        with self.assertRaises(SystemExit):
            self.run_check(self.good, amount_raw=10**12)  # server inflates what we should send
        st = json.loads(json.dumps(self.good))
        st["status"] = "SUCCESS"
        with self.assertRaises(SystemExit):
            self.run_check(st)
        with self.assertRaises(SystemExit):
            with mock.patch.object(self.b, "jget", return_value=self.good):
                self.b.check_deposit_quote("not-an-address", recipient=fakes.MERCHANT, origin_asset="x", refund_to=PAYER,
                                           price=1, amount_raw=1, confidential=False)

    def test_terminal_escapes_stripped(self):
        self.assertNotIn("\x1b", self.b.clean("ok\x1b[2J‮"))


class TestEngineHardening(unittest.TestCase):
    P = {"address": fakes.MERCHANT}

    def test_unpaid_orders_expire_and_free_capacity(self):
        e, _ = make_engine()
        e.max_open = 2
        a = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=PAYER)
        e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=PAYER)
        with self.assertRaises(OrderError):
            e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=PAYER)
        e.store.update(a["order_id"], deadline="2020-01-01T00:00:00.000Z")
        self.assertEqual(e.refresh(a["order_id"])["state"], "EXPIRED")
        e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=PAYER)  # capacity freed

    def test_late_payment_on_expired_order_still_settles(self):
        fa = fakes.FakeAurora()
        rpc = fakes.FakeRpc(txs={fakes.SIG_A: fakes.parsed_tx(fakes.MERCHANT, 400000)})
        e, _ = make_engine(fa, rpc)
        v = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=PAYER)
        e.store.update(v["order_id"], deadline="2020-01-01T00:00:00.000Z")
        self.assertEqual(e.refresh(v["order_id"])["state"], "EXPIRED")
        fa.statuses[v["deposit"]["address"]] = [fakes.success(fakes.SIG_A)]
        e.store.update(v["order_id"], last_polled=0)
        self.assertEqual(e.refresh(v["order_id"])["state"], "SETTLED")

    def test_per_client_cap(self):
        e, _ = make_engine()
        for _ in range(5):
            e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=PAYER, client="1.2.3.4")
        with self.assertRaises(OrderError) as cm:
            e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=PAYER, client="1.2.3.4")
        self.assertEqual(cm.exception.http, 429)
        e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=PAYER, client="5.6.7.8")

    def test_confidential_tags_unique_and_claimed_sigs_skipped(self):
        fa = fakes.FakeAurora()
        e, _ = make_engine(fa)
        with mock.patch("sluice.engine.secrets.randbelow", return_value=0):  # always pick the first free tag
            a = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=PAYER, confidential=True)
            b = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=PAYER, confidential=True)
        pa, pb = fa.quotes[0]["amount"], fa.quotes[1]["amount"]
        self.assertNotEqual(pa, pb)
        # a credit already claimed by another order is skipped during the scan
        e.rpc.txs = {fakes.SIG_A: fakes.parsed_tx(fakes.MERCHANT, pa, block_time=4_000_000_000)}
        e.rpc.sigs = [{"signature": fakes.SIG_A, "blockTime": 4_000_000_000, "err": None}]
        other = e.store.get(b["order_id"])
        e.store.claim_settlement(other["id"], fakes.SIG_A, {"sig": fakes.SIG_A})
        fa.statuses[a["deposit"]["address"]] = [{"status": "SUCCESS"}]
        self.assertNotEqual(e.refresh(a["order_id"])["state"], "SETTLED")

    def test_confidential_view_hides_payer(self):
        e, _ = make_engine()
        v = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=PAYER, confidential=True)
        self.assertIsNone(v["refund_to"])
        self.assertNotIn(PAYER, json.dumps(v))

    def test_deposit_tx_first_value_wins(self):
        e, _ = make_engine()
        v = e.create_order(resource="report", params=self.P, pay_with="base:USDC", refund_to=PAYER)
        e.note_deposit(v["order_id"], "0x" + "a" * 64)
        e.note_deposit(v["order_id"], "0x" + "b" * 64)
        self.assertEqual(e.store.get(v["order_id"])["deposit_tx"], "0x" + "a" * 64)


class TestLimiter(unittest.TestCase):
    def test_flood_does_not_reset_other_clients(self):
        rl = server.RateLimiter(max_keys=100)
        for _ in range(3):
            rl.allow("9.9.9.9", "create", 0.0001, 3)
        self.assertFalse(rl.allow("9.9.9.9", "create", 0.0001, 3))
        for i in range(50):
            rl.allow(f"10.0.0.{i}", "create", 0.0001, 3)
        self.assertFalse(rl.allow("9.9.9.9", "create", 0.0001, 3))  # still limited

    def test_ipv6_grouped_by_64(self):
        self.assertEqual(server.client_key("2001:db8::1"), server.client_key("2001:db8::ffff"))
        self.assertNotEqual(server.client_key("2001:db8::1"), server.client_key("2001:db8:0:1::1"))
        self.assertEqual(server.client_key("not an ip"), "invalid")


if __name__ == "__main__":
    unittest.main()
