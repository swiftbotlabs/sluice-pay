"""Order engine: quote -> deposit -> provider status -> independent Solana verification -> exactly-once delivery.

HTTP-agnostic so it can be unit-tested with fakes. All money-relevant decisions live here.
"""
from __future__ import annotations

import json
import re
import secrets
import time
from decimal import Decimal

from . import aurora as au
from . import connect as cn
from . import receipts
from . import solana as sol
from .store import Store, StateError

# Curated origins shown to buyers: (key, Aurora blockchain slug, symbol, label, refund address family)
ORIGINS = [
    ("base:USDC", "base", "USDC", "USDC on Base", "evm"),
    ("base:ETH", "base", "ETH", "ETH on Base", "evm"),
    ("arb:USDC", "arb", "USDC", "USDC on Arbitrum", "evm"),
    ("arb:ETH", "arb", "ETH", "ETH on Arbitrum", "evm"),
    ("eth:USDC", "eth", "USDC", "USDC on Ethereum", "evm"),
    ("eth:ETH", "eth", "ETH", "ETH on Ethereum", "evm"),
    ("op:USDC", "op", "USDC", "USDC on Optimism", "evm"),
    ("pol:USDC", "pol", "USDC", "USDC on Polygon", "evm"),
    ("bsc:USDT", "bsc", "USDT", "USDT on BNB Chain", "evm"),
    ("sol:SOL", "sol", "SOL", "SOL on Solana", "sol"),
    ("btc:BTC", "btc", "BTC", "BTC on Bitcoin", "btc"),
    ("tron:USDT", "tron", "USDT", "USDT on Tron", "tron"),
]

_FAMILY_RE = {
    "evm": re.compile(r"^0x[0-9a-fA-F]{40}$"),
    "btc": re.compile(r"^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$"),
    "tron": re.compile(r"^T[1-9A-HJ-NP-Za-km-z]{33}$"),
}


def valid_refund(family: str, addr: str) -> bool:
    if not isinstance(addr, str) or len(addr) > 100:
        return False
    if family == "sol":
        return sol.is_pubkey(addr)
    rx = _FAMILY_RE.get(family)
    return bool(rx and rx.match(addr))


PROVIDER_TO_STATE = {
    "PENDING_DEPOSIT": "AWAITING_DEPOSIT", "KNOWN_DEPOSIT_TX": "DEPOSIT_SEEN", "INCOMPLETE_DEPOSIT": "DEPOSIT_SEEN",
    "PROCESSING": "PROCESSING", "REFUNDED": "REFUNDED", "FAILED": "FAILED",
    # Intents Connect execution states
    "CREATED": "AWAITING_DEPOSIT", "DEPOSIT_PENDING": "AWAITING_DEPOSIT", "DEPOSIT_PROCESSING": "PROCESSING",
    "OPERATION_PENDING": "PROCESSING", "OPERATION_PROCESSING": "PROCESSING",
    "DEPOSIT_FAILED": "REFUNDED", "OPERATION_FAILED": "FAILED", "EXPIRED": "EXPIRED",
}

BUYER_COPY = {
    "AWAITING_DEPOSIT": "Waiting for your deposit",
    "DEPOSIT_SEEN": "Deposit detected",
    "PROCESSING": "Routing to Solana",
    "SETTLED": "Paid: verified on Solana",
    "DELIVERED": "Paid and delivered",
    "REFUNDED": "Refunded to your address",
    "FAILED": "Payment failed",
    "EXPIRED": "Expired: nothing was charged",
}


class OrderError(Exception):
    def __init__(self, msg: str, http: int = 400):
        super().__init__(msg)
        self.http = http


class Engine:
    def __init__(self, store: Store, aurora: au.Aurora, rpc: sol.Rpc, signer: receipts.Signer, merchant: str,
                 catalog: dict, connect: cn.Connect | None = None, max_open: int = 50, deadline_s: int = 900,
                 status_min_interval: float = 6.0, max_open_per_client: int = 5, expire_grace_s: int = 1800):
        if not sol.is_pubkey(merchant):
            raise ValueError("merchant must be a Solana address")
        self.store, self.au, self.rpc, self.signer, self.merchant = store, aurora, rpc, signer, merchant
        self.catalog = catalog  # resource -> {"price_raw": int, "validate": fn(params)->params, "produce": fn(params)->bytes}
        self.connect = connect
        self.max_open, self.deadline_s, self.status_min_interval = max_open, deadline_s, status_min_interval
        self.max_open_per_client, self.expire_grace_s = max_open_per_client, expire_grace_s

    # -- catalogue / discovery ----------------------------------------------------------------
    def origins(self) -> list[dict]:
        out = []
        for key, chain, sym, label, fam in ORIGINS:
            try:
                t = self.au.find(chain, sym)
            except ValueError:
                continue
            out.append({"key": key, "label": label, "assetId": t["assetId"], "decimals": t["decimals"],
                        "price_usd": t.get("price"), "refund_family": fam})
        return out

    def _origin(self, key: str) -> dict:
        for o in self.origins():
            if o["key"] == key:
                return o
        raise OrderError("unsupported pay_with; see /api/origins")

    def payment_required(self, resource: str) -> dict:
        item = self.catalog.get(resource)
        if not item:
            raise OrderError("unknown resource", 404)
        return {
            "error": "payment_required",
            "price": {"amount": str(Decimal(item["price_raw"]) / 10**6), "asset": "USDC", "chain": "solana",
                      "mint": sol.USDC_MINT, "recipient": self.merchant},
            "how_to_pay": {"create_order": "POST /api/orders", "status": "GET /api/orders/{id}",
                           "then": f"GET this URL again with header X-Sluice-Order: <id>"},
            "accepts": [o["key"] for o in self.origins()],
            "rails": ["swap", "connect"] if self.connect else ["swap"],
            "receipt_key": self.signer.pubkey,
        }

    # -- order creation -----------------------------------------------------------------------
    def create_order(self, *, resource: str, params: dict, pay_with: str, refund_to: str, confidential: bool = False,
                     rail: str = "swap", client: str | None = None) -> dict:
        item = self.catalog.get(resource)
        if not item:
            raise OrderError("unknown resource", 404)
        params = item["validate"](params)
        if rail not in ("swap", "connect") or (rail == "connect" and not self.connect):
            raise OrderError("unsupported rail")
        if self.store.count_open() >= self.max_open:
            raise OrderError("too many open orders, try again later", 503)
        if client and self.store.count_open(client) >= self.max_open_per_client:
            raise OrderError("you have too many unpaid orders; pay or wait for them to expire", 429)
        o = self._origin(pay_with)
        if not valid_refund(o["refund_family"], refund_to):
            raise OrderError(f"refund_to must be your own address on the paying chain ({o['refund_family']})")
        price = int(item["price_raw"])
        if confidential:
            # Confidential mode hides provider tx hashes, so we tag the amount (+1..999 micro-USDC) to make the
            # Solana credit uniquely attributable to this order when we scan the merchant account. The tag is
            # unique among open private orders for the same base price.
            used = self.store.open_tags(price)
            free = [t for t in range(1, 1000) if price + t not in used]
            if not free:
                raise OrderError("too many private payments in flight, try again shortly", 503)
            price += free[secrets.randbelow(len(free))]
        rh = receipts.request_hash(resource, params)
        oid = self.store.new_id()
        if rail == "swap":
            try:
                q = self.au.quote(origin_asset=o["assetId"], destination_asset=au.SOL_USDC, amount=price,
                                  recipient=self.merchant, refund_to=refund_to, swap_type="EXACT_OUTPUT",
                                  deadline_s=self.deadline_s, confidentiality="advanced" if confidential else "public",
                                  session_id=oid)
            except au.AuroraError as e:
                raise OrderError(f"quote failed: {e}", 502)
            qq = q["quote"]
            order = self.store.create(
                id=oid, rail="swap", resource=resource, params=json.dumps(params, sort_keys=True), request_hash=rh,
                price_raw=price, merchant=self.merchant, origin_asset=o["assetId"], refund_to=refund_to,
                confidential=int(confidential), deposit_address=qq["depositAddress"], deposit_memo=qq.get("depositMemo"),
                amount_in=qq["amountIn"], min_amount_in=qq.get("minAmountIn"),
                deadline=q["quoteRequest"]["deadline"], quote=json.dumps({k: v for k, v in q.items() if k != "signature"}),
                client=client)
            return self.view(order)
        # rail == connect: the payer's EVM wallet (refund_to) owns a Solana intermediary that runs our steps
        if o["refund_family"] != "evm":
            raise OrderError("connect rail needs an EVM payer wallet (refund_to)")
        inter = self.connect.intermediary(refund_to).get("solana")
        if not inter:
            raise OrderError("no Solana intermediary for this wallet", 502)
        steps = cn.receipt_steps(inter, self.merchant, oid)
        dst_exists = (self.rpc.call("getAccountInfo", [sol.ata(self.merchant), {"encoding": "base64"}]) or {}).get("value")
        if dst_exists:
            steps = steps[1:]
        for s in steps:
            if s["programId"] == sol.TOKEN_PROGRAM:
                s["args"][0]["value"] = str(price)
        try:
            x = self.connect.create_bridge_in(refund_to, origin_asset=o["assetId"], amount=price + 2000, steps=steps,
                                              deadline=au.iso_in(min(self.deadline_s, 1200)), destination_asset=au.SOL_USDC,
                                              swap_type="EXACT_OUTPUT", dry=False, title=f"Sluice {oid}")
        except cn.ConnectError as e:
            raise OrderError(f"execution failed: {e}", 502)
        qq, det = x["quote"], x["details"]
        payload = (det.get("payload") or {}).get("payload_json") or ""
        if cn.memo_text(oid).encode().hex() not in payload:
            raise OrderError("execution payload does not carry the order memo", 502)
        order = self.store.create(
            id=oid, rail="connect", resource=resource, params=json.dumps(params, sort_keys=True), request_hash=rh,
            price_raw=price, merchant=self.merchant, origin_asset=o["assetId"], refund_to=refund_to,
            confidential=0, deposit_address=qq["depositAddress"], amount_in=qq["amountIn"], min_amount_in=qq.get("minAmountIn"),
            deadline=qq.get("deadline"), quote=json.dumps({"execution": {k: x.get(k) for k in ("id", "status", "quote", "details")}}),
            execution_id=x["id"], client=client)
        v = self.view(order)
        v["sign"] = {"standard": det.get("signingStandard"), "payload_json": payload,
                     "submit": f"POST /api/orders/{oid}/signature"}
        return v

    # -- buyer actions ------------------------------------------------------------------------
    def submit_signature(self, oid: str, signature: str) -> dict:
        o = self._get(oid)
        if o["rail"] != "connect":
            raise OrderError("not a connect order")
        if not re.match(r"^secp256k1:[1-9A-HJ-NP-Za-km-z]{80,100}$", signature or ""):
            raise OrderError("signature must be secp256k1:<base58>")
        try:
            r = self.connect.submit(o["refund_to"], o["execution_id"], signature)
        except cn.ConnectError as e:
            raise OrderError(f"submit failed: {e}", 502)
        return {"ok": True, "provider": r}

    def note_deposit(self, oid: str, tx_hash: str) -> dict:
        o = self._get(oid)
        if not re.match(r"^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{43,90}|[0-9a-fA-F]{64})$", tx_hash or ""):
            raise OrderError("bad tx hash")
        if not o["deposit_tx"]:
            self.store.update(oid, deposit_tx=tx_hash)  # first value wins; receipts prefer provider-reported hashes
        try:
            if o["rail"] == "connect":
                self.connect.record_deposit(o["deposit_address"], tx_hash)
            elif not o["confidential"]:
                self.au.submit_deposit(o["deposit_address"], tx_hash, o["deposit_memo"])
        except (au.AuroraError, cn.ConnectError):
            pass  # optional speed-up only; detection works without it
        return self.refresh(oid, force=time.time() - o["last_polled"] > self.status_min_interval)

    # -- status machine -----------------------------------------------------------------------
    def refresh(self, oid: str, force: bool = False) -> dict:
        o = self._get(oid)
        if o["state"] in ("SETTLED", "DELIVERED", "REFUNDED", "FAILED"):
            return self.view(o)
        interval = 300 if o["state"] == "EXPIRED" else self.status_min_interval  # expired: slow re-check for late deposits
        if (not force or o["state"] == "EXPIRED") and time.time() - o["last_polled"] < interval:
            return self.view(o)
        self.store.update(oid, last_polled=time.time())
        try:
            if o["rail"] == "connect":
                x = self.connect.get(o["refund_to"], o["execution_id"])
                pstat, pview, dest = x.get("status"), {"status": x.get("status"), "transaction": x.get("transaction")}, \
                    [(x.get("transaction") or {}).get("solanaTxHash")]
            else:
                s = self.au.status(o["deposit_address"], o["deposit_memo"])
                pview = au.summarize_status(s)
                pstat, dest = pview["status"], pview["destinationTx"]
        except (au.AuroraError, cn.ConnectError) as e:
            return {**self.view(o), "warning": f"provider unreachable: {str(e)[:120]}"}
        self.store.update(oid, provider_status=pstat, provider_view=json.dumps(pview))
        if pstat == "SUCCESS":
            self._settle(o, [d for d in dest if d])
        elif pstat in ("PENDING_DEPOSIT", "CREATED", "DEPOSIT_PENDING") and self._past_deadline(o):
            if o["state"] == "AWAITING_DEPOSIT":
                self.store.transition(oid, "EXPIRED")
        else:
            new = PROVIDER_TO_STATE.get(pstat)
            if new and new != o["state"]:
                try:
                    self.store.transition(oid, new)
                except StateError:
                    pass
        return self.view(self._get(oid))

    def _past_deadline(self, o: dict) -> bool:
        try:
            import datetime as _dt
            dl = _dt.datetime.fromisoformat((o["deadline"] or "").replace("Z", "+00:00")).timestamp()
        except ValueError:
            return False
        return time.time() > dl + self.expire_grace_s

    def _settle(self, o: dict, dest_sigs: list[str]):
        memo = cn.memo_text(o["id"]) if o["rail"] == "connect" else None
        not_before = o["created"]
        proof = None
        for sig in dest_sigs:
            if sol.is_signature(sig):
                v = sol.verify_payment(self.rpc, sig, o["merchant"], o["price_raw"], not_before=not_before, memo=memo)
                if v.get("ok"):
                    proof = v
                    break
        if proof is None and o["confidential"]:
            proof = sol.find_payment(self.rpc, o["merchant"], o["price_raw"], not_before, memo=memo, exact=True,
                                     exclude=self.store.claimed_sigs())
        if proof is None:
            self.store.update(o["id"], provider_view=json.dumps({**json.loads(self._get(o["id"])["provider_view"] or "{}"),
                                                                "note": "provider SUCCESS, Solana credit not verified yet"}))
            if o["state"] != "PROCESSING":
                try:
                    self.store.transition(o["id"], "PROCESSING")
                except StateError:
                    pass
            return
        self.store.claim_settlement(o["id"], proof["sig"], proof)

    # -- delivery -----------------------------------------------------------------------------
    def deliver(self, oid: str, resource: str, params: dict) -> tuple[bytes, dict]:
        o = self._get(oid)
        item = self.catalog.get(resource)
        if not item:
            raise OrderError("unknown resource", 404)
        if o["resource"] != resource or o["request_hash"] != receipts.request_hash(resource, item["validate"](params)):
            raise OrderError("this order paid for a different request", 409)
        if o["state"] not in ("SETTLED", "DELIVERED"):
            o = self._get(oid)
            self.refresh(oid)
            o = self._get(oid)
            if o["state"] not in ("SETTLED", "DELIVERED"):
                raise OrderError(f"not paid yet ({o['state']})", 402)
        body, receipt = self.store.deliver_once(
            oid, lambda cur: item["produce"](json.loads(cur["params"])),
            lambda cur, b: receipts.make_receipt(self.signer, cur, b))
        return body, json.loads(receipt)

    # -- views --------------------------------------------------------------------------------
    def _get(self, oid: str) -> dict:
        if not re.match(r"^ord_[A-Za-z0-9]{10,24}$", oid or ""):
            raise OrderError("bad order id", 404)
        o = self.store.get(oid)
        if not o:
            raise OrderError("no such order", 404)
        return o

    def view(self, o: dict) -> dict:
        origin = next((x for x in self.origins() if x["assetId"] == o["origin_asset"]), None)
        dec = origin["decimals"] if origin else 0
        pv = json.loads(o["provider_view"] or "{}")
        proof = json.loads(o["settle_proof"] or "null")
        amt = Decimal(o["amount_in"] or 0) / (Decimal(10) ** dec) if dec else None
        label = origin["label"] if origin else o["origin_asset"]
        v = {
            "order_id": o["id"], "rail": o["rail"], "state": o["state"], "message": BUYER_COPY.get(o["state"]),
            "resource": o["resource"], "confidential": bool(o["confidential"]),
            "price": {"amount": str(Decimal(o["price_raw"]) / 10**6), "asset": "USDC", "chain": "solana", "recipient": o["merchant"]},
            "deposit": {
                "address": o["deposit_address"], "memo": o["deposit_memo"], "pay_with": label,
                "amount": str(amt.normalize()) if amt is not None else o["amount_in"], "amount_raw": o["amount_in"],
                "deadline": o["deadline"],
                "transfer_requirements": f"Send only {label.replace(' on ', ' from the ')} network to this address. "
                                         f"Send exactly {amt.normalize() if amt is not None else o['amount_in']} before "
                                         f"{o['deadline']}. Less is refunded to "
                                         f"{'your refund address' if o['confidential'] else o['refund_to']} after the deadline; "
                                         f"any excess is refunded after settlement. Other assets or networks may be lost.",
            },
            "refund_to": None if o["confidential"] else o["refund_to"], "provider_status": o["provider_status"], "provider": pv,
            "deposit_tx": None if o["confidential"] else o["deposit_tx"],
            "settlement": proof and {"solana_tx": proof["sig"], "explorer": proof["explorer"], "merchant_delta": proof["delta"],
                                     "slot": proof["slot"], "memos": proof.get("memos")},
        }
        if o["state"] == "REFUNDED":
            v["refund"] = {"amount": pv.get("refundedAmount"), "reason": pv.get("refundReason"),
                           "origin_txs": pv.get("originTx")}
        return v
