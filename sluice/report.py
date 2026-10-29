"""The paid resource of the demo API: a Solana wallet snapshot (balances, token holdings, recent activity).

Read-only calls to a fixed public Solana RPC; the only user input is a base58 address validated to 32 bytes.
"""
from __future__ import annotations

import json
import time

from . import solana as sol

KNOWN_MINTS = {
    sol.USDC_MINT: "USDC",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
    "So11111111111111111111111111111111111111112": "wSOL",
    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": "JUP",
}


def wallet_report(rpc: sol.Rpc, address: str) -> dict:
    if not sol.is_pubkey(address):
        raise ValueError("not a Solana address")
    info = rpc.call("getAccountInfo", [address, {"encoding": "base64", "commitment": "confirmed"}]) or {}
    val = info.get("value")
    lamports = (val or {}).get("lamports", 0)
    toks = rpc.call("getTokenAccountsByOwner", [address, {"programId": sol.TOKEN_PROGRAM},
                                                {"encoding": "jsonParsed", "commitment": "confirmed"}]) or {}
    holdings = []
    for acc in (toks.get("value") or [])[:200]:
        try:
            p = acc["account"]["data"]["parsed"]["info"]
            amt = p["tokenAmount"]
            if int(amt.get("amount", "0")) == 0:
                continue
            holdings.append({"mint": p["mint"], "symbol": KNOWN_MINTS.get(p["mint"]), "amount": amt.get("uiAmountString"),
                             "token_account": acc.get("pubkey")})
        except (KeyError, TypeError):
            continue
    holdings.sort(key=lambda h: (h["symbol"] is None, -(float(h["amount"] or 0))))
    sigs = rpc.signatures(address, 100) or []
    times = [s["blockTime"] for s in sigs if s.get("blockTime")]
    return {
        "address": address,
        "generated_at": int(time.time()),
        "exists": val is not None,
        "executable": bool((val or {}).get("executable")),
        "owner_program": (val or {}).get("owner"),
        "sol": lamports / 1e9,
        "token_accounts_nonzero": len(holdings),
        "top_holdings": holdings[:15],
        "recent_activity": {
            "tx_count_last_100": len(sigs),
            "failed_in_last_100": sum(1 for s in sigs if s.get("err") is not None),
            "newest_tx_time": max(times) if times else None,
            "oldest_in_window": min(times) if times else None,
        },
        "source": "Solana mainnet RPC (read-only)",
    }


def render(report: dict) -> bytes:
    return json.dumps(report, indent=2, sort_keys=True).encode()
