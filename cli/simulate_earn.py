#!/usr/bin/env python3
"""Prove settle-to-earn with no wallet, no keys and no money: run the exact Solana steps through mainnet's simulator.

  python3 cli/simulate_earn.py [--price 0.15]

A wallet that really holds USDC plays the Intents Connect intermediary, a fresh address plays the merchant. Nothing is
signed or sent: simulateTransaction replays the transaction against live mainnet state and returns what would happen.
Pass condition: Kamino accepts the deposit and the MERCHANT's token account ends up holding the cUSDC.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sluice import connect as cn  # noqa: E402
from sluice import solana as sol  # noqa: E402
from sluice import soltx  # noqa: E402

RPCS = ("https://api.mainnet-beta.solana.com", "https://public.rpc.solanavibestation.com", "https://solana-mainnet.gateway.tatum.io")
HOLDER = "9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR"     # Sluice's demo merchant wallet, holds real USDC
MERCHANT = "B5jEjGHi5HyNomGTPerQYVsJ5biMZyGp7G5rWG3ZfwMW"   # no cUSDC account yet, so the create step runs too
FEE_PAYER = "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg"   # any funded account: simulation only, nothing is signed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--price", default="0.15", help="invoice in USDC")
    a = ap.parse_args()
    price = int(round(float(a.price) * 1_000_000))
    steps = cn.earn_steps(HOLDER, MERCHANT, "ord_simulated01", price)
    msg, signers = soltx.build_message(FEE_PAYER, soltx.steps_to_instructions(steps, HOLDER, FEE_PAYER))
    dst = sol.ata(MERCHANT, cn.KLEND_CUSDC_MINT)
    r = soltx.simulate(sol.Rpc(RPCS), msg, len(signers), [dst])
    v, slot = r["value"], (r.get("context") or {}).get("slot")
    print(f"mainnet slot {slot}: simulated {len(msg)} byte message, {v.get('unitsConsumed')} compute units, error: {v.get('err')}")
    for line in v.get("logs") or []:
        if "Instruction:" in line or "Depositing" in line or "Price" in line:
            print("  " + line.replace("Program log: ", ""))
    acc = (v.get("accounts") or [None])[0]
    if v.get("err") or not acc:
        sys.exit("FAILED: see the error above")
    info = acc["data"]["parsed"]["info"]
    print(json.dumps({"merchant_cusdc_account": dst, "owner": info["owner"], "mint": info["mint"], "cusdc": info["tokenAmount"]["uiAmountString"]}, indent=1))
    if info["owner"] != MERCHANT or info["mint"] != cn.KLEND_CUSDC_MINT:
        sys.exit("FAILED: the position is not the merchant's")
    print(f"PASS: {a.price} USDC supplied to Kamino, cUSDC owned by the merchant, order reference attached.")


if __name__ == "__main__":
    main()
