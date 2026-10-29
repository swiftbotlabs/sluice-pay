#!/usr/bin/env python3
"""Verify a Sluice receipt offline (ed25519 signature) and re-check its Solana settlement on mainnet.

  verify_receipt.py RECEIPT.json [--key RECEIPT_PUBKEY] [--body DELIVERED_BODY_FILE]

RECEIPT.json may be the raw X-Sluice-Receipt JSON or an evidence file that contains a "receipt" field.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sluice import receipts  # noqa: E402
from sluice import solana as sol  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("receipt")
    ap.add_argument("--key", help="expected receipt public key (from /.well-known/sluice.json)")
    ap.add_argument("--body", help="file with the delivered bytes, to check body_sha256")
    a = ap.parse_args()
    d = json.load(open(a.receipt))
    rc = d.get("receipt", d)
    p = rc["payload"]
    if not a.key:
        print("warning: no --key given; this only proves the receipt is self-consistent, not who issued it")
    sig_ok = receipts.verify(rc, a.key)
    print(f"signature by {p['signer']}: {'valid' if sig_ok else 'INVALID'}")
    if a.body:
        ok = receipts.sha256_hex(open(a.body, "rb").read()) == p["body_sha256"]
        print(f"delivered body hash: {'matches' if ok else 'MISMATCH'}")
    memo = None
    if p.get("rail") == "connect":
        memo = f"sluice:{p['order']}"
    v = sol.verify_payment(sol.Rpc(), p["solana_tx"], p["merchant"], int(p["price"]["amount"]), memo=memo)
    print(f"Solana settlement {p['solana_tx'][:16]}...: {'verified' if v.get('ok') else 'NOT verified: ' + v.get('reason', '')}"
          f" (merchant +{v.get('delta', 0) / 1e6} USDC, slot {v.get('slot')})")
    sys.exit(0 if sig_ok and v.get("ok") else 1)


if __name__ == "__main__":
    main()
