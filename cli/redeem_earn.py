#!/usr/bin/env python3
"""Turn a merchant's Kamino position back into USDC. Dry run by default: it simulates against mainnet and sends nothing.

  python3 cli/redeem_earn.py --key-file merchant.key [--amount 1.25] [--send]
  python3 cli/redeem_earn.py --owner <address>                    # simulate only, no key needed

merchant.key: chmod 600 file with the base58 secret key. It is never printed or sent anywhere. The wallet pays Solana
gas itself. --amount is in cUSDC; the default is the whole balance.
"""
import argparse
import base64
import os
import stat
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sluice import connect as cn  # noqa: E402
from sluice import solana as sol  # noqa: E402
from sluice import soltx  # noqa: E402

RPCS = ("https://api.mainnet-beta.solana.com", "https://public.rpc.solanavibestation.com", "https://solana-mainnet.gateway.tatum.io")
REDEEM = bytes.fromhex("ea75b57db98edc1d")
REFRESH = bytes.fromhex("02da8aeb4fc91966")


def redeem_instructions(owner: str, amount: int, cusdc: str | None = None) -> list:
    usdc, cusdc = sol.ata(owner, sol.USDC_MINT), cusdc or sol.ata(owner, cn.KLEND_CUSDC_MINT)
    t = sol.TOKEN_PROGRAM
    create_usdc = (sol.ATA_PROGRAM, [(owner, True, True), (usdc, False, True), (owner, False, False), (sol.USDC_MINT, False, False),
                                     (cn.SYSTEM_PROGRAM, False, False), (t, False, False)], b"\x01")
    refresh = (cn.KLEND_PROGRAM, [(cn.KLEND_USDC_RESERVE, False, True), (cn.KLEND_MARKET, False, False), (cn.KLEND_PROGRAM, False, False),
                                  (cn.KLEND_PROGRAM, False, False), (cn.KLEND_PROGRAM, False, False), (cn.KLEND_ORACLE, False, False)], REFRESH)
    # account order differs from the deposit: market before reserve (Aurora's Kamino withdraw scenario)
    redeem = (cn.KLEND_PROGRAM, [(owner, True, False), (cn.KLEND_MARKET, False, False), (cn.KLEND_USDC_RESERVE, False, True),
                                 (cn.KLEND_AUTHORITY, False, False), (sol.USDC_MINT, False, False), (cn.KLEND_CUSDC_MINT, False, True),
                                 (cn.KLEND_USDC_SUPPLY, False, True), (cusdc, False, True), (usdc, False, True), (t, False, False), (t, False, False),
                                 (cn.SYSVAR_INSTRUCTIONS, False, False)], REDEEM + amount.to_bytes(8, "little"))
    return [create_usdc, refresh, redeem]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key-file")
    ap.add_argument("--owner")
    ap.add_argument("--amount", help="cUSDC to redeem (default: all)")
    ap.add_argument("--cusdc-account", help="cUSDC token account, if it is not the wallet's associated account")
    ap.add_argument("--send", action="store_true", help="really send it")
    a = ap.parse_args()
    signer = None
    if a.key_file:
        if stat.S_IMODE(os.stat(a.key_file).st_mode) & 0o077:
            sys.exit("refusing: key file must be chmod 600")
        from sluice import receipts
        signer = receipts.Signer(open(a.key_file).read().strip())
    owner = signer.pubkey if signer else a.owner
    if not owner or not sol.is_pubkey(owner):
        sys.exit("give --key-file or --owner")
    rpc = sol.Rpc(RPCS)
    src = a.cusdc_account or sol.ata(owner, cn.KLEND_CUSDC_MINT)
    if not sol.is_pubkey(src):
        sys.exit("bad --cusdc-account")
    if not (rpc.call("getAccountInfo", [src, {"encoding": "base64"}]) or {}).get("value"):
        sys.exit(f"{owner} has no cUSDC account, so there is nothing to redeem")
    held = int(rpc.call("getTokenAccountBalance", [src])["value"]["amount"])
    amount = int(round(float(a.amount) * 1_000_000)) if a.amount else held
    if not 0 < amount <= held:
        sys.exit(f"nothing to redeem: holds {held / 1e6} cUSDC")
    msg, signers = soltx.build_message(owner, redeem_instructions(owner, amount, src))
    r = soltx.simulate(rpc, msg, len(signers))
    v = r["value"]
    print(f"simulated: redeem {amount / 1e6} of {held / 1e6} cUSDC, {v.get('unitsConsumed')} compute units, error: {v.get('err')}")
    for line in v.get("logs") or []:
        if "Instruction:" in line:
            print("  " + line.replace("Program log: ", ""))
    if v.get("err"):
        sys.exit("FAILED in simulation; nothing was sent")
    if not a.send:
        print("dry run: nothing was sent. Add --send with --key-file to do it.")
        return
    if not signer:
        sys.exit("--send needs --key-file")
    bh = rpc.call("getLatestBlockhash", [{"commitment": "confirmed"}])["value"]["blockhash"]
    msg, signers = soltx.build_message(owner, redeem_instructions(owner, amount, src), bh)
    sig = signer._sk.sign(msg).signature
    txid = rpc.call("sendTransaction", [base64.b64encode(soltx.wrap(msg, [sig])).decode(), {"encoding": "base64", "preflightCommitment": "confirmed"}])
    print("sent:", sol.EXPLORER_TX + txid)


if __name__ == "__main__":
    main()
