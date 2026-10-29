#!/usr/bin/env python3
"""Create a signed Sluice pay link with your Solana key (the checkout shows "Signed by the receiving wallet").

  make_link.py --key-file merchant.key --amount 25.00 --ref invoice-1042 [--base https://swiftbotlab.github.io/sluice-pay/]

merchant.key: chmod 600 file with the base58 secret key (Phantom/Solflare export format, 64 bytes). Never printed.
"""
import argparse
import os
import re
import stat
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sluice import receipts  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key-file", required=True)
    ap.add_argument("--amount", required=True)
    ap.add_argument("--ref", default="")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--base", default="https://swiftbotlab.github.io/sluice-pay/")
    a = ap.parse_args()
    if stat.S_IMODE(os.stat(a.key_file).st_mode) & 0o077:
        sys.exit("refusing: key file must be chmod 600")
    if not re.fullmatch(r"\d{1,9}(\.\d{1,6})?", a.amount) or float(a.amount) < 0.15:
        sys.exit("amount: at least 0.15 USDC, up to 6 decimals")
    if not re.fullmatch(r"[\w.-]{0,40}", a.ref):
        sys.exit("ref: letters, digits, . _ - only (max 40)")
    if not 1 <= a.days <= 90:
        sys.exit("days: 1..90")
    s = receipts.Signer(open(a.key_file).read().strip())
    print(receipts.make_pay_link(s, to=s.pubkey, amount=a.amount, ref=a.ref, ttl_s=a.days * 86400, base_url=a.base))


if __name__ == "__main__":
    main()
