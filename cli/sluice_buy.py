#!/usr/bin/env python3
"""Headless buyer for Sluice-protected APIs: pay a Solana merchant from an EVM chain, get the resource + a receipt.

  sluice_buy.py URL --pay base:USDC --key-file payer.key [--max-usd 1.00] [--rail swap|connect] [--confidential]

Steps: GET URL -> 402 terms -> POST /api/orders -> check the deposit against --max-usd (spend cap) -> send the deposit
from your EVM key -> poll -> GET URL with X-Sluice-Order -> verify the receipt signature (key from
/.well-known/sluice.json) AND re-verify the Solana settlement tx yourself. On a refund it prints the refund tx.
The key file must be chmod 600 and contain one hex private key; it is never printed or sent anywhere.
"""
from __future__ import annotations

import argparse
import json
import os
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


def http(method, url, body=None, headers=None, timeout=60):
    h = {"user-agent": "sluice-buy/0.1", **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read(2_000_000)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(200_000)


def read_key(path: str) -> str:
    st = os.stat(path)
    if stat.S_IMODE(st.st_mode) & 0o077:
        sys.exit("refusing: key file must be chmod 600")
    k = open(path).read().strip()
    if not (len(k) in (64, 66) and all(c in "0123456789abcdefx" for c in k.lower())):
        sys.exit("key file must hold one hex private key")
    return k


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--pay", default="base:USDC", help="origin chain:asset, see /api/origins")
    ap.add_argument("--key-file", required=True)
    ap.add_argument("--max-usd", type=Decimal, default=Decimal("1.00"), help="hard spend cap for this call")
    ap.add_argument("--rail", choices=["swap", "connect"], default="swap")
    ap.add_argument("--confidential", action="store_true")
    ap.add_argument("--out", help="write the delivered body here")
    a = ap.parse_args()

    u = urllib.parse.urlsplit(a.url)
    if u.scheme not in ("https", "http") or (u.scheme == "http" and u.hostname not in ("127.0.0.1", "localhost")):
        sys.exit("URL must be https (or http on localhost)")
    root = f"{u.scheme}://{u.netloc}"
    key = read_key(a.key_file)
    from eth_account import Account
    payer = Account.from_key(key).address

    code, _, b = http("GET", a.url)
    if code != 402:
        sys.exit(f"expected 402, got {code}: {b[:200]!r}")
    terms = json.loads(b)
    print(f"402: price {terms['price']['amount']} USDC on Solana -> {terms['price']['recipient']}")
    if a.pay not in terms["accepts"]:
        sys.exit(f"{a.pay} not accepted; choose one of {terms['accepts']}")
    _, _, wk = http("GET", root + "/.well-known/sluice.json")
    receipt_key = json.loads(wk)["receipt_key"]
    if receipt_key != terms.get("receipt_key"):
        sys.exit("receipt key mismatch between 402 and .well-known")

    code, _, b = http("POST", root + "/api/orders", {**terms["request"], "pay_with": a.pay, "refund_to": payer,
                                                     "confidential": a.confidential, "rail": a.rail})
    if code != 201:
        sys.exit(f"order failed {code}: {b[:300]!r}")
    order = json.loads(b)
    oid, dep = order["order_id"], order["deposit"]
    _, _, ob = http("GET", root + "/api/origins")
    origin = next(o for o in json.loads(ob)["origins"] if o["key"] == a.pay)
    usd = Decimal(dep["amount"]) * Decimal(str(origin["price_usd"]))
    print(f"order {oid}: send {dep['amount']} {origin['label']} (~${usd:.4f}) to {dep['address']} before {dep['deadline']}")
    print(f"  transfer requirements: {dep['transfer_requirements']}")
    if usd > a.max_usd:
        sys.exit(f"refusing: ${usd:.4f} exceeds --max-usd {a.max_usd}")

    if a.rail == "connect":
        payload = order["sign"]["payload_json"]
        # The payload embeds the Solana message the intermediary will run; refuse unless it carries this order's memo.
        if cn.memo_text(oid).encode().hex() not in payload:
            sys.exit("refusing to sign: payload does not carry this order's memo")
        sig = cn.sign_erc191(key, payload)
        code, _, b = http("POST", f"{root}/api/orders/{oid}/signature", {"signature": sig})
        if code != 200:
            sys.exit(f"signature submit failed {code}: {b[:200]!r}")
        print("signed the Intents Connect execution (pay merchant + on-chain memo)")

    chain, sym = a.pay.split(":")
    if chain not in evm.CHAINS:
        sys.exit("this CLI pays from EVM chains; use the checkout page for other chains")
    token = None
    if sym != "ETH":
        # ERC-20: resolve the contract from the asset id (nep141:<chain>-<0xcontract>.omft.near)
        aid = origin["assetId"]
        token = aid.split("-", 1)[1].split(".", 1)[0]
    tx = evm.send(chain, key, dep["address"], int(dep["amount_raw"]), token=token, max_amount=int(dep["amount_raw"]))
    print(f"deposit {tx['status']}: {tx['explorer']}")
    if tx["status"] != "ok":
        sys.exit("deposit failed")
    http("POST", f"{root}/api/orders/{oid}/deposit", {"tx_hash": tx["tx"]})

    last, t0 = None, time.time()
    while time.time() - t0 < 3600:
        _, _, b = http("GET", f"{root}/api/orders/{oid}")
        v = json.loads(b)
        if v["state"] != last:
            last = v["state"]
            print(f"  {time.strftime('%H:%M:%S')} {last}: {v.get('message')}")
        if last in ("SETTLED", "DELIVERED"):
            break
        if last in ("REFUNDED", "FAILED", "EXPIRED"):
            print(json.dumps(v.get("refund") or v.get("provider"), indent=1))
            sys.exit(f"not delivered: {last}")
        time.sleep(6)

    code, h, body = http("GET", a.url, headers={"X-Sluice-Order": oid})
    if code != 200:
        sys.exit(f"delivery failed {code}: {body[:200]!r}")
    rc = json.loads(h.get("X-Sluice-Receipt") or "{}")
    ok_sig = receipts.verify(rc, receipt_key)
    ok_body = rc.get("payload", {}).get("body_sha256") == receipts.sha256_hex(body)
    p = rc.get("payload", {})
    onchain = sol.verify_payment(sol.Rpc(), p.get("solana_tx", ""), terms["price"]["recipient"], int(p["price"]["amount"]),
                                 memo=cn.memo_text(oid) if a.rail == "connect" else None)
    print(f"receipt signature valid: {ok_sig}; body hash matches: {ok_body}; Solana settlement re-verified: {onchain.get('ok')} "
          f"({onchain.get('explorer')})")
    if a.out:
        open(a.out, "wb").write(body)
    else:
        print(body.decode()[:1500])
    sys.exit(0 if (ok_sig and ok_body and onchain.get("ok")) else 2)


if __name__ == "__main__":
    main()
