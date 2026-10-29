"""Aurora Intents Connect (bridge-in) client: pay a Solana merchant AND write the order id on-chain in ONE transaction.

Flow (docs: docs.intents.aurora.dev/intents-connect/developer-guides/solana):
  1. GET  /api/v1/executions/{wallet}/intermediary      -> the payer's Solana intermediary (MPC-controlled by the payer)
  2. POST /api/v1/executions/{wallet}   (x-api-key)      -> bridge-in execution: quote + Solana steps, returns
                                                            deposit address + an ERC-191 payload to sign
  3. POST /api/v1/executions/{wallet}/submit             -> { signature: "secp256k1:<b58>", executionId }
  4. payer transfers the origin asset to quote.depositAddress
  5. GET  /api/v1/executions/{wallet}?id=...             -> poll until SUCCESS / *_FAILED / EXPIRED

The steps run on Solana from the intermediary once the bridged USDC lands:
  a) ATA CreateIdempotent for the merchant (no-op if it exists)
  b) SPL TransferChecked {MIN_AMOUNT_OUT} USDC  intermediary -> merchant
  c) SPL Memo "sluice:<order_id>" signed by the intermediary
so the payment and its order reference are inseparable on Solana.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request

from . import solana as sol

CONNECT_BASE = "https://intents-connect-api.aurora.dev"
SYSTEM_PROGRAM = "11111111111111111111111111111111"
TERMINAL = {"SUCCESS", "DEPOSIT_FAILED", "OPERATION_FAILED", "EXPIRED"}
_ORDER_RE = re.compile(r"^[A-Za-z0-9_-]{6,48}$")


class ConnectError(Exception):
    def __init__(self, msg, status=None, body=None):
        super().__init__(msg)
        self.status, self.body = status, body


def memo_text(order_id: str) -> str:
    if not _ORDER_RE.match(order_id or ""):
        raise ValueError("bad order id")
    return f"sluice:{order_id}"


def receipt_steps(intermediary: str, merchant: str, order_id: str, mint: str = sol.USDC_MINT, decimals: int = 6) -> list[dict]:
    """The Solana instructions the payer's intermediary executes after the bridge settles."""
    if not (sol.is_pubkey(intermediary) and sol.is_pubkey(merchant)):
        raise ValueError("bad pubkey")
    src = sol.ata(intermediary, mint)
    dst = sol.ata(merchant, mint)
    return [
        {"metadata": {"name": "Create merchant USDC account (idempotent)"},
         "programId": sol.ATA_PROGRAM, "discriminator": "01", "args": [],
         "accounts": [
             {"pubkey": "{INTERMEDIARY}", "isSigner": True, "isWritable": True},  # funder (service reassigns to fee payer)
             {"pubkey": dst, "isSigner": False, "isWritable": True},
             {"pubkey": merchant, "isSigner": False, "isWritable": False},
             {"pubkey": mint, "isSigner": False, "isWritable": False},
             {"pubkey": SYSTEM_PROGRAM, "isSigner": False, "isWritable": False},
             {"pubkey": sol.TOKEN_PROGRAM, "isSigner": False, "isWritable": False}]},
        {"metadata": {"name": "Pay merchant", "description": f"USDC to {merchant}"},
         "programId": sol.TOKEN_PROGRAM, "discriminator": "0c",
         "args": [{"name": "amount", "type": "u64", "value": "{MIN_AMOUNT_OUT}"},
                  {"name": "decimals", "type": "u8", "value": decimals}],
         "accounts": [
             {"pubkey": src, "isSigner": False, "isWritable": True},
             {"pubkey": mint, "isSigner": False, "isWritable": False},
             {"pubkey": dst, "isSigner": False, "isWritable": True},
             {"pubkey": "{INTERMEDIARY}", "isSigner": True, "isWritable": False}]},
        {"metadata": {"name": "On-chain order receipt", "description": memo_text(order_id)},
         "programId": sol.MEMO_PROGRAM, "discriminator": memo_text(order_id).encode().hex(), "args": [],
         "accounts": [{"pubkey": "{INTERMEDIARY}", "isSigner": True, "isWritable": False}]},
    ]


class Connect:
    def __init__(self, api_key: str, base: str = CONNECT_BASE, opener=None, timeout: float = 45.0):
        if base != CONNECT_BASE and not base.startswith("http://127.0.0.1"):
            raise ValueError("unexpected API base")
        self.key, self.base, self.timeout = api_key, base, timeout
        self._open = opener or urllib.request.urlopen

    def _req(self, method, path, body=None, query=None, with_key=False):
        url = f"{self.base}/{path}"
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        headers = {"content-type": "application/json", "user-agent": "sluice/0.1"}
        if with_key:
            headers["x-api-key"] = self.key
        req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
        try:
            with self._open(req, timeout=self.timeout) as r:
                d = json.loads(r.read(2_000_000))
        except urllib.error.HTTPError as e:
            text = e.read(4000).decode("utf-8", "replace")
            raise ConnectError(f"HTTP {e.code}: {text[:300]}", e.code, text) from None
        return d.get("result", d) if isinstance(d, dict) else d

    def intermediary(self, wallet: str) -> dict:
        return self._req("GET", f"api/v1/executions/{urllib.parse.quote(wallet)}/intermediary")

    def create_bridge_in(self, wallet: str, *, origin_asset: str, amount: int, steps: list, deadline: str,
                         destination_asset: str, slippage_bps: int = 100, swap_type: str = "EXACT_INPUT",
                         dry: bool = True, title: str = "Sluice order") -> dict:
        body = {"version": "1.0", "type": "solana", "dry": bool(dry),
                "quote": {"originAsset": origin_asset, "destinationAsset": destination_asset, "amount": str(amount),
                          "swapType": swap_type, "slippageTolerance": slippage_bps, "deadline": deadline},
                "steps": steps, "metadata": {"title": title, "intent": "sluice_pay_with_receipt"}}
        return self._req("POST", f"api/v1/executions/{urllib.parse.quote(wallet)}", body, with_key=True)

    def submit(self, wallet: str, execution_id: str, signature: str, public_key: str | None = None) -> dict:
        body = {"signature": signature, "executionId": execution_id}
        if public_key:
            body["publicKey"] = public_key
        return self._req("POST", f"api/v1/executions/{urllib.parse.quote(wallet)}/submit", body)

    def record_deposit(self, deposit_address: str, tx_hash: str) -> dict:
        return self._req("POST", "api/v1/executions/deposit/submit", {"txHash": tx_hash, "depositAddress": deposit_address})

    def get(self, wallet: str, execution_id: str) -> dict:
        r = self._req("GET", f"api/v1/executions/{urllib.parse.quote(wallet)}", query={"id": execution_id})
        if isinstance(r, list):
            r = next((x for x in r if x.get("id") == execution_id), None)
        if not r:
            raise ConnectError("execution not found")
        return r


def sign_erc191(private_key: str, payload_json: str) -> str:
    """personal_sign the payload verbatim; return the wire form `secp256k1:<base58(r||s||v)>`, v in {0,1}."""
    from eth_account import Account
    from eth_account.messages import encode_defunct

    sig = Account.sign_message(encode_defunct(text=payload_json), private_key=private_key).signature
    b = bytearray(bytes(sig))
    if len(b) != 65:
        raise ValueError("bad signature length")
    if b[64] >= 27:
        b[64] -= 27
    return "secp256k1:" + sol.b58encode(bytes(b))
