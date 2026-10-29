"""Independent Solana-side settlement verification (stdlib only).

We never trust a provider's SUCCESS on its own: before an order is marked SETTLED we fetch the destination transaction
from a Solana RPC and check that the merchant's USDC token account actually grew by at least the invoiced amount, that
the transaction succeeded and is confirmed, and (for Intents Connect orders) that it carries the order memo.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.request

RPCS = ("https://solana-mainnet.gateway.tatum.io", "https://solana.leorpc.com/?api_key=FREE", "https://api.mainnet-beta.solana.com")
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"  # SPL Memo v2 (verified executable on mainnet 2026-10-29)
EXPLORER_TX = "https://solscan.io/tx/"

_ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_IDX = {c: i for i, c in enumerate(_ALPH)}
_SIG_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{64,90}$")


class SolanaError(Exception):
    pass


# --- base58 -----------------------------------------------------------------------------------
def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = _ALPH[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s


def b58decode(s: str) -> bytes:
    if not isinstance(s, str) or not s or len(s) > 100:
        raise ValueError("bad base58")
    n = 0
    for c in s:
        if c not in _IDX:
            raise ValueError("bad base58 char")
        n = n * 58 + _IDX[c]
    full = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(s) - len(s.lstrip("1"))) + full


def is_pubkey(s: str) -> bool:
    try:
        return len(b58decode(s)) == 32
    except ValueError:
        return False


def is_signature(s: str) -> bool:
    if not isinstance(s, str) or not _SIG_RE.match(s):
        return False
    try:
        return len(b58decode(s)) == 64
    except ValueError:
        return False


# --- ed25519 curve check (for program-derived addresses) -------------------------------------
_P = 2**255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P


def _on_curve(b: bytes) -> bool:
    """True if the 32 bytes decode to a point on ed25519 (PDAs must NOT be on the curve)."""
    y = int.from_bytes(b, "little") & ((1 << 255) - 1)
    if y >= _P:
        return False
    sign = b[31] >> 7
    y2 = y * y % _P
    u = (y2 - 1) % _P
    v = (_D * y2 + 1) % _P
    x2 = u * pow(v, _P - 2, _P) % _P
    if x2 == 0:
        return sign == 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * pow(2, (_P - 1) // 4, _P) % _P
    if (x * x - x2) % _P != 0:
        return False
    return True


def find_program_address(seeds: list[bytes], program_id: str) -> tuple[str, int]:
    prog = b58decode(program_id)
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b"".join(seeds) + bytes([bump]) + prog + b"ProgramDerivedAddress").digest()
        if not _on_curve(h):
            return b58encode(h), bump
    raise SolanaError("no viable bump")


def ata(owner: str, mint: str = USDC_MINT) -> str:
    """Associated token account address (classic SPL Token program)."""
    addr, _ = find_program_address([b58decode(owner), b58decode(TOKEN_PROGRAM), b58decode(mint)], ATA_PROGRAM)
    return addr


# --- RPC ---------------------------------------------------------------------------------------
class Rpc:
    def __init__(self, urls=RPCS, opener=None, timeout: float = 25.0):
        self.urls = tuple(urls)
        self._open = opener or urllib.request.urlopen
        self.timeout = timeout

    def call(self, method: str, params: list):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        last = None
        for url in self.urls:
            for attempt in range(2):
                req = urllib.request.Request(url, data=body, headers={"content-type": "application/json",
                                                                      "user-agent": "Mozilla/5.0 sluice/0.1"})
                try:
                    with self._open(req, timeout=self.timeout) as r:
                        d = json.loads(r.read(5_000_000))
                    if "error" in d:
                        last = SolanaError(f"{method}: {d['error']}")
                        break
                    return d.get("result")
                except Exception as e:  # try next attempt / endpoint
                    last = e
                    time.sleep(0.8 * (attempt + 1))
        raise SolanaError(f"rpc failed: {last}")

    def tx(self, sig: str):
        if not is_signature(sig):
            raise ValueError("bad signature")
        return self.call("getTransaction", [sig, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0,
                                                  "commitment": "confirmed"}])

    def signatures(self, address: str, limit: int = 20):
        if not is_pubkey(address):
            raise ValueError("bad address")
        return self.call("getSignaturesForAddress", [address, {"limit": max(1, min(limit, 100)), "commitment": "confirmed"}])


# --- verification ------------------------------------------------------------------------------
def token_delta(tx: dict, owner: str, mint: str = USDC_MINT) -> int:
    """Net change (smallest units) of `owner`'s balance of `mint` inside one parsed transaction."""
    meta = tx.get("meta") or {}

    def total(rows):
        s = 0
        for r in rows or []:
            if r.get("owner") == owner and r.get("mint") == mint:
                s += int((r.get("uiTokenAmount") or {}).get("amount") or 0)
        return s

    return total(meta.get("postTokenBalances")) - total(meta.get("preTokenBalances"))


def memos(tx: dict) -> list[str]:
    out = []
    msg = (tx.get("transaction") or {}).get("message") or {}
    groups = [msg.get("instructions") or []]
    for inner in (tx.get("meta") or {}).get("innerInstructions") or []:
        groups.append(inner.get("instructions") or [])
    for ixs in groups:
        for ix in ixs:
            if ix.get("program") == "spl-memo" or ix.get("programId") == MEMO_PROGRAM:
                p = ix.get("parsed")
                if isinstance(p, str):
                    out.append(p)
    return out


def account_keys(tx: dict) -> list[str]:
    keys = []
    for k in ((tx.get("transaction") or {}).get("message") or {}).get("accountKeys") or []:
        keys.append(k.get("pubkey") if isinstance(k, dict) else k)
    return keys


def verify_payment(rpc: Rpc, sig: str, owner: str, min_amount: int, mint: str = USDC_MINT,
                   not_before: int | None = None, memo: str | None = None, exact: bool = False,
                   reference: str | None = None) -> dict:
    """Check one destination tx. Returns a dict with ok + evidence; never raises for a merely-wrong tx."""
    tx = rpc.tx(sig)
    if not tx:
        return {"ok": False, "reason": "tx not found (yet)", "sig": sig}
    meta = tx.get("meta") or {}
    if meta.get("err") is not None:
        return {"ok": False, "reason": f"tx failed: {meta.get('err')}", "sig": sig}
    delta = token_delta(tx, owner, mint)
    bt = tx.get("blockTime")
    res = {"sig": sig, "slot": tx.get("slot"), "blockTime": bt, "delta": delta, "owner": owner, "mint": mint,
           "explorer": EXPLORER_TX + sig, "memos": memos(tx)}
    if delta < min_amount:
        return {**res, "ok": False, "reason": f"merchant received {delta} < {min_amount}"}
    if exact and delta != min_amount:
        return {**res, "ok": False, "reason": f"amount tag mismatch ({delta} != {min_amount})"}
    if not_before and bt and bt < not_before - 120:
        return {**res, "ok": False, "reason": "tx predates the order"}
    if memo is not None and not any(memo in m for m in res["memos"]):
        return {**res, "ok": False, "reason": "order memo missing"}
    if reference is not None:
        if reference not in account_keys(tx):
            return {**res, "ok": False, "reason": "order reference missing"}
        res["reference"] = reference
    return {**res, "ok": True}


def find_payment(rpc: Rpc, owner: str, min_amount: int, not_before: int, mint: str = USDC_MINT,
                 exclude: set | None = None, memo: str | None = None, limit: int = 15, exact: bool = False,
                 reference: str | None = None) -> dict | None:
    """Find a matching credit without a known destination hash: by the order's reference account if there is one
    (Solana Pay pattern, exact), else by scanning the merchant ATA's recent transactions."""
    exclude = exclude or set()
    for s in rpc.signatures(reference or ata(owner, mint), limit) or []:
        if s.get("err") is not None or s.get("signature") in exclude:
            continue
        if s.get("blockTime") and s["blockTime"] < not_before - 120:
            break
        v = verify_payment(rpc, s["signature"], owner, min_amount, mint, not_before, memo, exact, reference)
        if v.get("ok"):
            return v
    return None
