"""Aurora Intents Connect (bridge-in) client: pay a Solana merchant AND write the order id on-chain in ONE transaction.

Flow (docs: docs.intents.aurora.dev/intents-connect/developer-guides/solana):
  1. GET  /api/v1/executions/{wallet}/intermediary      -> the payer's Solana intermediary (MPC-controlled by the payer)
  2. POST /api/v1/executions/{wallet}   (x-api-key)      -> bridge-in execution: quote + Solana steps, returns
                                                            deposit address + an ERC-191 payload to sign
  3. POST /api/v1/executions/{wallet}/submit             -> { signature: "secp256k1:<b58>", executionId }
  4. payer transfers the origin asset to quote.depositAddress
  5. GET  /api/v1/executions/{wallet}?id=...             -> poll until SUCCESS / *_FAILED / EXPIRED

The steps run on Solana from the intermediary once the bridged USDC lands:
  a) ATA CreateIdempotent for the merchant (only if the merchant has no USDC account yet)
  b) SPL TransferChecked of exactly the price, intermediary -> merchant, carrying a read-only REFERENCE account
     derived from the order id (the Solana Pay reference pattern)
so the payment and its order are inseparable on Solana: getSignaturesForAddress(reference) finds the payment.
(An SPL Memo step was our first design; Intents Connect's Solana relayer never executed transactions containing
the Memo program in our mainnet tests, while the reference-account form settled in ~25 s.)
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from datetime import datetime

from . import solana as sol

CONNECT_BASE = "https://intents-connect-api.aurora.dev"
SYSTEM_PROGRAM = "11111111111111111111111111111111"
TERMINAL = {"SUCCESS", "DEPOSIT_FAILED", "OPERATION_FAILED", "EXPIRED"}
_ORDER_RE = re.compile(r"^[A-Za-z0-9_-]{6,48}$")


class ConnectError(Exception):
    def __init__(self, msg, status=None, body=None):
        super().__init__(msg)
        self.status, self.body = status, body


def order_tag(order_id: str) -> str:
    if not _ORDER_RE.match(order_id or ""):
        raise ValueError("bad order id")
    return f"sluice:{order_id}"


def reference_key(order_id: str) -> str:
    """Deterministic read-only reference account for an order (sha256, base58). Never a signer, never funded."""
    return sol.b58encode(hashlib.sha256(order_tag(order_id).encode()).digest())


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
             {"pubkey": "{INTERMEDIARY}", "isSigner": True, "isWritable": False},
             {"pubkey": reference_key(order_id), "isSigner": False, "isWritable": False}]},
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


MPC_ROOT = "G9hwngxWNKdmqMCmU1Yt6LPhFpayJeKFxyAV1HqMNLtF"      # v1.signer public_key, domain 1
MPC_PREDECESSOR = "proxy-signer-dev.near"
MPC_VERIFYING = "intents.near"
_L = 2**252 + 27742317777372353535851937790883648493


def _canonical(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def solana_message_from_payload(payload_json: str, now: float | None = None) -> bytes:
    """The signature covers the whole JSON, so every field is checked, not only the Solana message inside it.
    Re-serialising must give the same bytes, which rules out duplicate keys. Mirrors messageFromPayload() in docs/core.js."""
    p = json.loads(payload_json)
    if _canonical(p) != payload_json:
        raise PayloadRejected("payload is not in canonical form")
    if set(p) != {"deadline", "intents", "nonce", "signer_id", "verifying_contract"} or p["verifying_contract"] != MPC_VERIFYING:
        raise PayloadRejected("unexpected payload envelope")
    until = datetime.fromisoformat(p["deadline"].replace("Z", "+00:00")).timestamp()
    if until > (time.time() if now is None else now) + 8 * 86400:
        raise PayloadRejected("payload stays valid for too long")
    intents = p["intents"]
    if not isinstance(intents, list) or len(intents) != 1:
        raise PayloadRejected("expected exactly one auth_call intent")
    it = intents[0]
    if set(it) != {"contract_id", "intent", "min_gas", "msg"} or it["intent"] != "auth_call" or it["contract_id"] != MPC_PREDECESSOR:
        raise PayloadRejected("expected exactly one auth_call intent")
    msg = json.loads(it["msg"])
    if _canonical(msg) != it["msg"] or set(msg) != {"request"}:
        raise PayloadRejected("unexpected fields in signing request")
    req = msg["request"]
    if set(req) != {"domain_id", "path", "payload_v2"} or req["domain_id"] != 1 or set(req["payload_v2"]) != {"Eddsa"}:
        raise PayloadRejected("unexpected signing request")
    if str(req["path"]).lower() != str(p["signer_id"]).lower():
        raise PayloadRejected("payload controls another account")
    hexmsg = req["payload_v2"]["Eddsa"]
    if not isinstance(hexmsg, str) or not re.fullmatch(r"[0-9a-f]{100,2600}", hexmsg):
        raise PayloadRejected("no Solana message in payload")
    return bytes.fromhex(hexmsg)


def derive_intermediary(payer: str) -> str:
    """The Solana account Intents Connect controls for an EVM wallet, computed locally from the MPC root."""
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", payer or ""):
        raise ValueError("bad payer")
    P, D = sol._P, sol._D
    i = pow(2, (P - 1) // 4, P)

    def dec(b: bytes):
        y = int.from_bytes(b, "little") & ((1 << 255) - 1)
        u, v = (y * y - 1) % P, (D * y * y + 1) % P
        x2 = u * pow(v, P - 2, P) % P
        x = pow(x2, (P + 3) // 8, P)
        if (x * x - x2) % P:
            x = x * i % P
        if (x * x - x2) % P:
            raise ValueError("not a curve point")
        if x & 1 != b[31] >> 7:
            x = P - x
        return (x, y, 1, x * y % P)

    def add(p, q):
        a, b = (p[1] - p[0]) * (q[1] - q[0]) % P, (p[1] + p[0]) * (q[1] + q[0]) % P
        c, d = 2 * p[3] * q[3] * D % P, 2 * p[2] * q[2] % P
        e, f, g, h = b - a, d - c, d + c, b + a
        return (e * f % P, g * h % P, f * g % P, e * h % P)

    def mul(k, p):
        r = (0, 1, 1, 0)
        while k:
            if k & 1:
                r = add(r, p)
            p = add(p, p)
            k >>= 1
        return r

    h = hashlib.sha3_256(f"near-mpc-recovery v0.1.0 epsilon derivation:{MPC_PREDECESSOR},{payer.lower()}".encode()).digest()
    t = int.from_bytes(h, "little") % _L
    g = dec((4 * pow(5, P - 2, P) % P).to_bytes(32, "little"))
    pt = add(dec(sol.b58decode(MPC_ROOT)), mul(t, g))
    z = pow(pt[2], P - 2, P)
    x, y = pt[0] * z % P, pt[1] * z % P
    return sol.b58encode((y | ((x & 1) << 255)).to_bytes(32, "little"))


# Intents Connect's fee recipient (relayer 4NDD95L5... and its USDC account), the same in every real payload seen 29 Oct-4 Nov 2026.
# Same pin as CONNECT_FEE in docs/core.js; a payload that pays the fee anywhere else is refused.
CONNECT_FEE_RELAYER = "4NDD95L5DDDLzxX6TewnmYym3Vt6C2gar4SzjeAwnYfr"
CONNECT_FEE_ACCOUNT = "G9jWhbCRcFy9paMRU9rnXAK7y8Q6iGWBwQjkwFN1pA3X"


def audit_payload(payload_json: str, *, payer: str, intermediary: str, merchant: str, price: int, order_id: str,
                  max_fee: int = 20000, mint: str = sol.USDC_MINT) -> dict:
    """Refuse to sign unless the Solana transaction does exactly: (optional ATA create for the merchant),
    TransferChecked `price` USDC intermediary -> merchant carrying this order's reference account, plus the
    service's own compute-budget / nonce instructions and ONE fee transfer of at most `max_fee`."""
    p = json.loads(payload_json)
    if (p.get("signer_id") or "").lower() != payer.lower():
        raise PayloadRejected("payload is for another signer")
    m = decode_solana_message(solana_message_from_payload(payload_json))
    if intermediary not in m["signers"]:
        raise PayloadRejected("intermediary is not a signer")
    src, dst, ref = sol.ata(intermediary, mint), sol.ata(merchant, mint), reference_key(order_id)
    paid = fees = 0
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
        if prog == sol.TOKEN_PROGRAM:
            op = data[:1]
            if op == b"\x0c" and len(data) == 10 and len(acc) >= 4:  # TransferChecked
                amt, dec = int.from_bytes(data[1:9], "little"), data[9]
                if acc[0] != src or acc[1] != mint or acc[3] != intermediary or dec != 6:
                    raise PayloadRejected("unexpected TransferChecked")
                if acc[2] != dst or amt != price:
                    raise PayloadRejected("transfer to an unexpected account")
                if acc[4:] != [ref]:
                    raise PayloadRejected("payment does not carry this order's reference")
                paid += 1
                continue
            if op == b"\x03" and len(data) == 9 and len(acc) >= 3:  # plain Transfer: only the service fee
                amt = int.from_bytes(data[1:9], "little")
                if acc[0] != src or acc[2] != intermediary or amt > max_fee:
                    raise PayloadRejected("unexpected Transfer")
                if acc[1] != CONNECT_FEE_ACCOUNT:
                    raise PayloadRejected("fee goes to an unexpected account")
                fees += 1
                continue
            raise PayloadRejected("unexpected Token instruction")
        raise PayloadRejected(f"unexpected program {prog}")
    if paid != 1 or fees > 1:
        raise PayloadRejected(f"expected one payment and at most one fee (got {paid}/{fees})")
    return {"ok": True, "instructions": len(m["instructions"]), "fee_transfers": fees}


# --- settle-to-earn: the invoice lands in the merchant's Kamino position, not idle in a wallet -------
KLEND_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
KLEND_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"       # Kamino Main Market
KLEND_AUTHORITY = "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo"
KLEND_USDC_RESERVE = "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"
KLEND_USDC_SUPPLY = "Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6"
KLEND_CUSDC_MINT = "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D"
KLEND_ORACLE = "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"
SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111"


def earn_steps(intermediary: str, merchant: str, order_id: str, price: int, create_ata: bool = True) -> list[dict]:
    """Settle an invoice INTO Kamino for the merchant: the payer's intermediary supplies exactly `price` USDC to the
    Kamino Main Market USDC reserve and the minted cUSDC goes straight to the MERCHANT's own token account.

    klend only requires the destination to be a cUSDC token account, so the intermediary never holds the position;
    the order's reference account rides on the deposit instruction, so the payment is still findable from Solana alone."""
    if not (sol.is_pubkey(intermediary) and sol.is_pubkey(merchant)):
        raise ValueError("bad pubkey")
    if not isinstance(price, int) or price <= 0:
        raise ValueError("bad price")
    src = sol.ata(intermediary, sol.USDC_MINT)
    dst = sol.ata(merchant, KLEND_CUSDC_MINT)
    ro = lambda k: {"pubkey": k, "isSigner": False, "isWritable": False}  # noqa: E731
    rw = lambda k: {"pubkey": k, "isSigner": False, "isWritable": True}  # noqa: E731
    create = [{"metadata": {"name": "Create merchant cUSDC account (idempotent)"},
               "programId": sol.ATA_PROGRAM, "discriminator": "01", "args": [],
               "accounts": [{"pubkey": "{INTERMEDIARY}", "isSigner": True, "isWritable": True}, rw(dst), ro(merchant),
                            ro(KLEND_CUSDC_MINT), ro(SYSTEM_PROGRAM), ro(sol.TOKEN_PROGRAM)]}] if create_ata else []
    return create + [
        {"metadata": {"name": "Refresh reserve", "description": "Refresh the Kamino USDC reserve"},
         "programId": KLEND_PROGRAM, "discriminator": "02da8aeb4fc91966", "args": [],
         "accounts": [rw(KLEND_USDC_RESERVE), ro(KLEND_MARKET), ro(KLEND_PROGRAM), ro(KLEND_PROGRAM), ro(KLEND_PROGRAM),
                      ro(KLEND_ORACLE)]},
        {"metadata": {"name": "Settle into Kamino for the merchant", "description": f"cUSDC to {merchant}"},
         "programId": KLEND_PROGRAM, "discriminator": "a9c91e7e06cd6644",
         "args": [{"name": "liquidity_amount", "type": "u64", "value": str(price)}],
         "accounts": [{"pubkey": "{INTERMEDIARY}", "isSigner": True, "isWritable": False}, rw(KLEND_USDC_RESERVE),
                      ro(KLEND_MARKET), ro(KLEND_AUTHORITY), ro(sol.USDC_MINT), rw(KLEND_USDC_SUPPLY),
                      rw(KLEND_CUSDC_MINT), rw(src), rw(dst), ro(sol.TOKEN_PROGRAM), ro(sol.TOKEN_PROGRAM),
                      ro(SYSVAR_INSTRUCTIONS), ro(reference_key(order_id))]},
    ]


def audit_earn_payload(payload_json: str, *, payer: str, intermediary: str, merchant: str, price: int, order_id: str,
                       max_fee: int) -> dict:
    """Refuse to sign unless the Solana transaction does exactly: (optional cUSDC account for the merchant), refresh the
    Kamino USDC reserve, supply `price` USDC with the cUSDC going to the MERCHANT and this order's reference attached,
    plus the service's compute-budget / nonce instructions and ONE fee transfer of at most `max_fee`.
    Mirrors auditPayload() in docs/core.js."""
    p = json.loads(payload_json)
    if (p.get("signer_id") or "").lower() != payer.lower():
        raise PayloadRejected("payload is for another signer")
    m = decode_solana_message(solana_message_from_payload(payload_json))
    if intermediary not in m["signers"]:
        raise PayloadRejected("intermediary is not a signer")
    src, dst, ref = sol.ata(intermediary, sol.USDC_MINT), sol.ata(merchant, KLEND_CUSDC_MINT), reference_key(order_id)
    want = [intermediary, KLEND_USDC_RESERVE, KLEND_MARKET, KLEND_AUTHORITY, sol.USDC_MINT, KLEND_USDC_SUPPLY, KLEND_CUSDC_MINT,
            src, dst, sol.TOKEN_PROGRAM, sol.TOKEN_PROGRAM, SYSVAR_INSTRUCTIONS, ref]
    paid = fees = refreshed = 0
    for ix in m["instructions"]:
        prog, acc, data = ix["program"], ix["accounts"], ix["data"]
        if prog == COMPUTE_BUDGET:
            continue
        if prog == SYSTEM_PROGRAM:
            if data[:4] != b"\x04\x00\x00\x00":
                raise PayloadRejected("unexpected System instruction")
            continue
        if prog == sol.ATA_PROGRAM:
            if data != b"\x01" or len(acc) < 4 or acc[1] != dst or acc[2] != merchant or acc[3] != KLEND_CUSDC_MINT:
                raise PayloadRejected("unexpected token-account creation")
            continue
        if prog == KLEND_PROGRAM:
            if data == bytes.fromhex("02da8aeb4fc91966"):
                if acc[:2] != [KLEND_USDC_RESERVE, KLEND_MARKET]:
                    raise PayloadRejected("unexpected reserve refresh")
                refreshed += 1
                continue
            if data[:8] == bytes.fromhex("a9c91e7e06cd6644") and len(data) == 16:
                if acc != want:
                    raise PayloadRejected("deposit does not go to the merchant with this order reference")
                if int.from_bytes(data[8:], "little") != price:
                    raise PayloadRejected("deposit amount differs from the invoice")
                paid += 1
                continue
            raise PayloadRejected("unexpected lending instruction")
        if prog == sol.TOKEN_PROGRAM and data[:1] == b"\x03" and len(data) == 9 and len(acc) >= 3:
            if acc[0] != src or acc[2] != intermediary or int.from_bytes(data[1:], "little") > max_fee:
                raise PayloadRejected("unexpected Transfer")
            if acc[1] != CONNECT_FEE_ACCOUNT:
                raise PayloadRejected("fee goes to an unexpected account")
            fees += 1
            continue
        raise PayloadRejected(f"unexpected program {prog}")
    if paid != 1 or fees > 1 or refreshed != 1:
        raise PayloadRejected(f"expected one deposit, one refresh, at most one fee (got {paid}/{refreshed}/{fees})")
    return {"ok": True, "instructions": len(m["instructions"]), "fee_transfers": fees}
