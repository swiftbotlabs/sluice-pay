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


# --- payload audit: decode the exact Solana message the buyer is asked to authorise -----------------
COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111"


class PayloadRejected(Exception):
    pass


def _cu16(b: bytes, i: int) -> tuple[int, int]:
    v = s = 0
    while True:
        x = b[i]
        i += 1
        v |= (x & 0x7F) << s
        if not x & 0x80:
            return v, i
        s += 7
        if s > 14:
            raise PayloadRejected("bad compact-u16")


def decode_solana_message(raw: bytes) -> dict:
    """Legacy or v0 Solana message -> static keys + instructions (lookup-table accounts are refused)."""
    i = 0
    version = None
    if raw[0] & 0x80:
        version = raw[0] & 0x7F
        i = 1
    n_sig, n_ro_signed, n_ro_unsigned = raw[i], raw[i + 1], raw[i + 2]
    i += 3
    n_keys, i = _cu16(raw, i)
    keys = [sol.b58encode(raw[i + 32 * k:i + 32 * (k + 1)]) for k in range(n_keys)]
    i += 32 * n_keys
    i += 32  # recent blockhash / durable nonce value
    n_ix, i = _cu16(raw, i)
    ixs = []
    for _ in range(n_ix):
        prog = raw[i]
        i += 1
        n_acc, i = _cu16(raw, i)
        accs = list(raw[i:i + n_acc])
        i += n_acc
        n_data, i = _cu16(raw, i)
        data = raw[i:i + n_data]
        i += n_data
        if prog >= n_keys or any(a >= n_keys for a in accs):
            raise PayloadRejected("instruction uses lookup-table accounts")
        ixs.append({"program": keys[prog], "accounts": [keys[a] for a in accs], "data": data})
    if version is not None and i < len(raw):
        n_lut, i = _cu16(raw, i)
        if n_lut:
            raise PayloadRejected("address lookup tables not expected")
    return {"version": version, "signers": keys[:n_sig], "keys": keys, "instructions": ixs,
            "header": (n_sig, n_ro_signed, n_ro_unsigned)}


def solana_message_from_payload(payload_json: str) -> bytes:
    p = json.loads(payload_json)
    intents = p.get("intents") or []
    if len(intents) != 1 or intents[0].get("intent") != "auth_call":
        raise PayloadRejected("expected exactly one auth_call intent")
    msg = json.loads(intents[0]["msg"])
    hexmsg = ((msg.get("request") or {}).get("payload_v2") or {}).get("Eddsa")
    if not isinstance(hexmsg, str) or not re.fullmatch(r"[0-9a-f]{100,2600}", hexmsg):
        raise PayloadRejected("no Solana message in payload")
    return bytes.fromhex(hexmsg)


def audit_payload(payload_json: str, *, payer: str, intermediary: str, merchant: str, price: int, order_id: str,
                  max_fee: int = 20000, mint: str = sol.USDC_MINT) -> dict:
    """Refuse to sign unless the Solana transaction does exactly: (optional ATA create for the merchant),
    TransferChecked `price` USDC intermediary -> merchant, Memo `sluice:<order>`, plus the service's own
    compute-budget / nonce instructions and ONE fee transfer of at most `max_fee`."""
    p = json.loads(payload_json)
    if (p.get("signer_id") or "").lower() != payer.lower():
        raise PayloadRejected("payload is for another signer")
    m = decode_solana_message(solana_message_from_payload(payload_json))
    if intermediary not in m["signers"]:
        raise PayloadRejected("intermediary is not a signer")
    src, dst, memo = sol.ata(intermediary, mint), sol.ata(merchant, mint), memo_text(order_id)
    paid = fees = memos = 0
    for ix in m["instructions"]:
        prog, acc, data = ix["program"], ix["accounts"], ix["data"]
        if prog == COMPUTE_BUDGET:
            continue
        if prog == SYSTEM_PROGRAM:
            if data[:4] != b"\x04\x00\x00\x00":  # only AdvanceNonceAccount
                raise PayloadRejected("unexpected System instruction")
            continue
        if prog == sol.ATA_PROGRAM:
            if data not in (b"\x01",) or len(acc) < 4 or acc[1] != dst or acc[2] != merchant or acc[3] != mint:
                raise PayloadRejected("unexpected token-account creation")
            continue
        if prog == sol.MEMO_PROGRAM:
            if data.decode("utf-8", "replace") != memo:
                raise PayloadRejected("memo does not match this order")
            memos += 1
            continue
        if prog == sol.TOKEN_PROGRAM:
            op = data[:1]
            if op == b"\x0c" and len(data) == 10 and len(acc) >= 4:  # TransferChecked
                amt, dec = int.from_bytes(data[1:9], "little"), data[9]
                if acc[0] != src or acc[1] != mint or acc[3] != intermediary or dec != 6:
                    raise PayloadRejected("unexpected TransferChecked")
                if acc[2] == dst and amt == price:
                    paid += 1
                elif amt <= max_fee:
                    fees += 1
                else:
                    raise PayloadRejected("transfer to an unexpected account")
                continue
            if op == b"\x03" and len(data) == 9 and len(acc) >= 3:  # plain Transfer: only the service fee
                amt = int.from_bytes(data[1:9], "little")
                if acc[0] != src or acc[2] != intermediary or amt > max_fee:
                    raise PayloadRejected("unexpected Transfer")
                fees += 1
                continue
            raise PayloadRejected("unexpected Token instruction")
        raise PayloadRejected(f"unexpected program {prog}")
    if paid != 1 or memos != 1 or fees > 1:
        raise PayloadRejected(f"expected one payment, one memo, at most one fee (got {paid}/{memos}/{fees})")
    return {"ok": True, "instructions": len(m["instructions"]), "fee_transfers": fees}
