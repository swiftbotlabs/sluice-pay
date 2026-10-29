#!/usr/bin/env python3
"""Headless buyer for Sluice-protected APIs: pay a Solana merchant from an EVM chain, get the resource + a receipt.

  sluice_buy.py URL --pay base:USDC --key-file payer.key [--max-usd 1.00] [--rail swap|connect] [--confidential]

The seller is NOT trusted with your money:
  * the token contract, decimals and asset id come from a pinned table in this file, never from the server;
  * the USD price comes from the public NEAR Intents token list, never from the server;
  * before sending anything, the deposit address is looked up in the public NEAR Intents status API and its quote
    must say: recipient = the merchant from the 402, destination = USDC on Solana, amount = the price (+ at most
    999 micro-USDC privacy tag), EXACT_OUTPUT, origin = your pinned asset, refundTo = your own address, and
    amountIn = exactly what you are asked to send;
  * on the Intents Connect rail the Solana transaction you authorise is decoded and must only pay the merchant the
    price, write this order's memo, and pay at most a 0.02 USDC service fee.
After delivery the receipt signature, body hash and Solana settlement are re-verified locally.
The key file must be chmod 600 and contain one hex private key; it is never printed or sent anywhere.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sluice import connect as cn  # noqa: E402
from sluice import evm, receipts  # noqa: E402
from sluice import solana as sol  # noqa: E402

ONECLICK = "https://1click.chaindefuser.com/v0"
SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"
# key -> (evm chain, ERC-20 contract or None for the native coin, decimals, NEAR Intents asset id)
PINNED = {
    "base:USDC": ("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6, "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"),
    "base:ETH": ("base", None, 18, "nep141:base.omft.near"),
    "arb:USDC": ("arb", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6, "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"),
    "arb:ETH": ("arb", None, 18, "nep141:arb.omft.near"),
    "eth:USDC": ("eth", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near"),
    "eth:ETH": ("eth", None, 18, "nep141:eth.omft.near"),
}
_CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]")


def clean(s) -> str:
    """Server-provided text is printed without terminal control or bidi characters."""
    return _CTRL.sub("?", str(s))[:400]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def http(method, url, body=None, headers=None, timeout=60):
    h = {"user-agent": "sluice-buy/0.2", **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with _opener.open(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read(2_000_000)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(200_000)


def jget(url):
    code, _, b = http("GET", url)
    if code != 200:
        raise SystemExit(f"GET {url} -> {code}")
    return json.loads(b)


def read_key(path: str) -> str:
    st = os.stat(path)
    if stat.S_IMODE(st.st_mode) & 0o077:
        sys.exit("refusing: key file must be chmod 600")
    k = open(path).read().strip()
    if not re.fullmatch(r"(0x)?[0-9a-fA-F]{64}", k):
        sys.exit("key file must hold one hex private key")
    return k


def check_deposit_quote(dep_addr: str, *, recipient: str, origin_asset: str, refund_to: str, price: int, amount_raw: int,
                        confidential: bool, connect_intermediary: str | None = None) -> dict:
    """Independent check of the deposit address against NEAR Intents' public status API."""
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", dep_addr):
        raise SystemExit("refusing: deposit address is not an EVM address")
    st = jget(f"{ONECLICK}/status?depositAddress={urllib.parse.quote(dep_addr)}")
    qr = (st.get("quoteResponse") or {}).get("quoteRequest") or {}
    q = (st.get("quoteResponse") or {}).get("quote") or {}
    problems = []
    if (q.get("depositAddress") or "").lower() != dep_addr.lower():
        problems.append("deposit address unknown to NEAR Intents")
    if qr.get("destinationAsset") != SOL_USDC:
        problems.append("destination is not USDC on Solana")
    if qr.get("originAsset") != origin_asset:
        problems.append("origin asset differs from what you chose")
    if qr.get("swapType") != "EXACT_OUTPUT":
        problems.append("not an exact-output quote")
    if (qr.get("refundTo") or "").lower() != refund_to.lower():
        problems.append("refunds would not go to you")
    if str(q.get("amountIn")) != str(amount_raw):
        problems.append("amount to send differs from the signed quote")
    if connect_intermediary is None:
        if qr.get("recipient") != recipient:
            problems.append("recipient is not the merchant from the 402")
        amt = int(qr.get("amount") or 0)
        if not (price <= amt <= price + (999 if confidential else 0)):
            problems.append("quoted amount is not the price")
    else:
        if qr.get("recipient") != connect_intermediary:
            problems.append("bridge recipient is not your own Solana intermediary")
    if st.get("status") != "PENDING_DEPOSIT":
        problems.append(f"deposit address is not waiting for a deposit ({st.get('status')})")
    if problems:
        raise SystemExit("refusing to pay: " + "; ".join(problems))
    return st


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--pay", default="base:USDC", choices=sorted(PINNED))
    ap.add_argument("--key-file", required=True)
    ap.add_argument("--max-usd", type=Decimal, default=Decimal("1.00"), help="hard spend cap for this call")
    ap.add_argument("--rail", choices=["swap", "connect"], default="swap")
    ap.add_argument("--confidential", action="store_true",
                    help="private payment; needs --accept-unverifiable-quote (private quotes are hidden from public APIs)")
    ap.add_argument("--accept-unverifiable-quote", action="store_true",
                    help="for --confidential: pay without the NEAR Intents cross-check; --max-usd still caps the loss")
    ap.add_argument("--out", help="write the delivered body here")
    a = ap.parse_args()

    u = urllib.parse.urlsplit(a.url)
    if u.scheme not in ("https", "http") or (u.scheme == "http" and u.hostname not in ("127.0.0.1", "localhost")):
        sys.exit("URL must be https (or http on localhost)")
    root = f"{u.scheme}://{u.netloc}"
    key = read_key(a.key_file)
    from eth_account import Account
    payer = Account.from_key(key).address
    chain, contract, decimals, asset_id = PINNED[a.pay]

    code, _, b = http("GET", a.url)
    if code != 402:
        sys.exit(f"expected 402, got {code}")
    terms = json.loads(b)
    merchant = terms["price"]["recipient"]
    price = int(Decimal(terms["price"]["amount"]) * 10**6)
    wk = jget(root + "/.well-known/sluice.json")
    if wk.get("receipt_key") != terms.get("receipt_key") or wk.get("merchant") != merchant or not sol.is_pubkey(merchant):
        sys.exit("refusing: 402 terms disagree with /.well-known/sluice.json")
    receipt_key = wk["receipt_key"]
    print(f"402: price {price / 1e6} USDC on Solana -> {clean(merchant)}")

    code, _, b = http("POST", root + "/api/orders", {**terms["request"], "pay_with": a.pay, "refund_to": payer,
                                                     "confidential": a.confidential, "rail": a.rail})
    if code != 201:
        sys.exit(f"order failed {code}: {clean(b[:300])}")
    order = json.loads(b)
    oid, dep = order["order_id"], order["deposit"]
    if not re.fullmatch(r"ord_[A-Za-z0-9]{10,24}", oid or ""):
        sys.exit("refusing: bad order id")
    amount_raw = int(dep["amount_raw"])

    inter = None
    if a.rail == "connect":
        c = cn.Connect("unused-for-reads")
        inter = c.intermediary(payer).get("solana")
        try:
            cn.audit_payload(order["sign"]["payload_json"], payer=payer, intermediary=inter, merchant=merchant,
                             price=price, order_id=oid)
        except cn.PayloadRejected as e:
            sys.exit(f"refusing to sign: {e}")
    if a.confidential:
        if not a.accept_unverifiable_quote:
            sys.exit("refusing: private quotes cannot be cross-checked publicly; re-run with --accept-unverifiable-quote "
                     "(your loss is still capped by --max-usd)")
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", dep["address"]):
            sys.exit("refusing: deposit address is not an EVM address")
        print("  private payment: quote not publicly verifiable; relying on --max-usd and pinned asset")
    else:
        check_deposit_quote(dep["address"], recipient=merchant, origin_asset=asset_id, refund_to=payer, price=price,
                            amount_raw=amount_raw, confidential=False, connect_intermediary=inter)
    tok = next((t for t in jget(f"{ONECLICK}/tokens") if t.get("assetId") == asset_id), None)
    if not tok:
        sys.exit("asset not listed by NEAR Intents")
    usd = Decimal(amount_raw) / (Decimal(10) ** decimals) * Decimal(str(tok["price"]))
    print(f"order {oid}: send {Decimal(amount_raw) / (Decimal(10) ** decimals)} via {a.pay} (~${usd:.4f}) to {dep['address']}")
    if not a.confidential:
        print("  quote independently checked with NEAR Intents: recipient, amount, asset, refund address")
    if usd > a.max_usd:
        sys.exit(f"refusing: ${usd:.4f} exceeds --max-usd {a.max_usd}")

    if a.rail == "connect":
        sig = cn.sign_erc191(key, order["sign"]["payload_json"])
        code, _, b = http("POST", f"{root}/api/orders/{oid}/signature", {"signature": sig})
        if code != 200:
            sys.exit(f"signature submit failed {code}: {clean(b[:200])}")
        print("signed the audited Solana transaction (pay merchant + on-chain memo)")

    tx = evm.send(chain, key, dep["address"], amount_raw, token=contract, max_amount=amount_raw)
    print(f"deposit {tx['status']}: {tx['explorer']}")
    if tx["status"] != "ok":
        sys.exit("deposit failed")
    http("POST", f"{root}/api/orders/{oid}/deposit", {"tx_hash": tx["tx"]})

    last, t0 = None, time.time()
    while time.time() - t0 < 3600:
        _, _, b = http("GET", f"{root}/api/orders/{oid}")
        v = json.loads(b)
        if v.get("state") != last:
            last = v.get("state")
            print(f"  {time.strftime('%H:%M:%SZ', time.gmtime())} {clean(last)}: {clean(v.get('message'))}")
        if last in ("SETTLED", "DELIVERED"):
            break
        if last in ("REFUNDED", "FAILED", "EXPIRED"):
            print(clean(json.dumps(v.get("refund") or v.get("provider"))))
            sys.exit(f"not delivered: {last}")
        time.sleep(6)

    code, h, body = http("GET", a.url, headers={"X-Sluice-Order": oid})
    if code != 200:
        sys.exit(f"delivery failed {code}")
    rc = json.loads(h.get("X-Sluice-Receipt") or "{}")
    p = rc.get("payload", {})
    ok_sig = receipts.verify(rc, receipt_key)
    ok_body = p.get("body_sha256") == receipts.sha256_hex(body)
    ok_terms = p.get("merchant") == merchant and p.get("order") == oid and int((p.get("price") or {}).get("amount", 0)) >= price
    onchain = sol.verify_payment(sol.Rpc(), p.get("solana_tx", ""), merchant, price,
                                 memo=cn.memo_text(oid) if a.rail == "connect" else None)
    print(f"receipt signature valid: {ok_sig}; body hash matches: {ok_body}; receipt terms match: {ok_terms}; "
          f"Solana settlement re-verified: {onchain.get('ok')} ({onchain.get('explorer')})")
    if a.out:
        open(a.out, "wb").write(body)
    else:
        print("\n".join(clean(line) for line in body.decode("utf-8", "replace")[:1500].splitlines()))
    sys.exit(0 if (ok_sig and ok_body and ok_terms and onchain.get("ok")) else 2)


if __name__ == "__main__":
    main()
