"""Signed delivery receipts and signed pay links (ed25519, Solana-style base58 keys).

A receipt binds: order id, the exact request (hash), the delivered bytes (hash), the price, the merchant's Solana
address, the Aurora deposit address, the origin-chain deposit tx and the Solana settlement signature. Anyone can
verify it offline with the receipt key published at /.well-known/sluice.json, then re-check the Solana tx on-chain.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import time
import unicodedata

from . import solana as sol

try:
    import nacl.exceptions
    import nacl.signing
except ImportError:  # pragma: no cover
    nacl = None


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def request_hash(resource: str, params: dict) -> str:
    return sha256_hex(canonical({"resource": resource, "params": params}))


class Signer:
    def __init__(self, secret_b58: str):
        if nacl is None:
            raise RuntimeError("PyNaCl is required for receipts")
        raw = sol.b58decode(secret_b58)
        if len(raw) not in (32, 64):
            raise ValueError("bad secret key length")
        self._sk = nacl.signing.SigningKey(raw[:32])
        self.pubkey = sol.b58encode(bytes(self._sk.verify_key))
        if len(raw) == 64 and sol.b58encode(raw[32:]) != self.pubkey:
            raise ValueError("secret/public mismatch")

    def sign(self, payload: dict) -> dict:
        body = dict(payload, signer=self.pubkey)
        sig = self._sk.sign(canonical(body)).signature
        return {"payload": body, "signature": sol.b58encode(sig)}


def verify(signed: dict, expected_signer: str | None = None) -> bool:
    if nacl is None:
        raise RuntimeError("PyNaCl is required")
    try:
        payload, sig = signed["payload"], sol.b58decode(signed["signature"])
        signer = payload["signer"]
        if expected_signer and signer != expected_signer:
            return False
        nacl.signing.VerifyKey(sol.b58decode(signer)).verify(canonical(payload), sig)
        return True
    except (KeyError, ValueError, TypeError, nacl.exceptions.BadSignatureError):
        return False


def make_receipt(signer: Signer, order: dict, body: bytes) -> str:
    proof = json.loads(order["settle_proof"] or "{}")
    payload = {
        "v": 1, "kind": "sluice.receipt", "order": order["id"], "rail": order["rail"],
        "resource": order["resource"], "request_hash": order["request_hash"], "body_sha256": sha256_hex(body),
        "price": {"amount": order["price_raw"], "asset": "USDC", "chain": "solana", "mint": sol.USDC_MINT},
        "merchant": order["merchant"], "deposit_address": None if order.get("confidential") else order["deposit_address"],
        "origin_asset": order["origin_asset"],
        "deposit_tx": None if order.get("confidential") else order["deposit_tx"], "solana_tx": order["settle_sig"], "solana_slot": proof.get("slot"),
        "merchant_delta": proof.get("delta"), "reference": proof.get("reference"), "issued_at": int(time.time()),
    }
    return json.dumps(signer.sign(payload), sort_keys=True)


# --- signed pay links (used by the static checkout) ---------------------------------------------
def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


NAME_PUNCT = " .,'&()!_-"


# Code points that render as nothing (Unicode Default_Ignorable_Code_Point): the same list as docs/core.js.
IGNORABLE = ((0xAD, 0xAD), (0x34F, 0x34F), (0x61C, 0x61C), (0x115F, 0x1160), (0x17B4, 0x17B5), (0x180B, 0x180F), (0x200B, 0x200F),
             (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8),
             (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF))


def clean_name(s) -> str | None:
    """Same rule as cleanName() in docs/core.js: letters, marks and digits from any script, single spaces and a little
    punctuation, at most 40 characters. Invisible, enclosing and stacked marks are refused, and so is anything that could pass
    for an address on the checkout."""
    if not isinstance(s, str):
        return None
    t = re.sub(r"[ \t\n\r]+", " ", unicodedata.normalize("NFC", s)).strip(" ")
    if not t or len(t) > 40:
        return None
    cat = unicodedata.category
    if not all(cat(c)[0] in "LMN" or c in NAME_PUNCT for c in t) or not any(cat(c)[0] in "LN" for c in t):
        return None
    if any(a <= ord(c) <= b for c in t for a, b in IGNORABLE) or any(cat(c) == "Me" for c in t):
        return None
    run = 0
    for c in t:
        run = run + 1 if cat(c)[0] == "M" else 0
        if run >= 3:
            return None
    if ".." in t or re.search(r"(^| )0[xX]", t):
        return None
    for w in t.split(" "):
        if len(w) >= 12 and (any(cat(c)[0] == "N" for c in w) or sum(cat(c) == "Lu" for c in w) >= 3):
            return None
    return t


def make_pay_link(signer: Signer, *, to: str, amount: str, ref: str, ttl_s: int = 7 * 86400,
                  base_url: str = "https://apps.swiftbotlab.workers.dev/sluice-pay/", settle: str = "usdc",
                  name: str | None = None) -> str:
    """The link is signed by `signer`; the checkout shows a 'signed by the receiving wallet' badge when signer == to.
    `name` is the merchant's display name, inside the signed bytes like everything else."""
    if not sol.is_pubkey(to):
        raise ValueError("bad Solana address")
    if settle not in ("usdc", "earn"):
        raise ValueError("settle must be usdc or earn")
    fields = {"v": 1, "to": to, "amt": amount, "ref": ref, "exp": int(time.time()) + ttl_s, "k": signer.pubkey}
    if name:
        n = clean_name(name)
        if not n:
            raise ValueError("name: up to 40 letters, digits, spaces and . , ' & ( ) ! _ -")
        fields["n"] = n
    if settle == "earn":
        fields["s"] = "earn"  # inside the signed bytes: a relay cannot change it. A payer with no wallet still pays plain USDC.
    msg = canonical(fields)
    sig = signer._sk.sign(msg).signature
    return f"{base_url}#p={_b64u(msg)}.{_b64u(sig)}"


def read_pay_link(fragment: str) -> tuple[dict, bool]:
    """Parse `p=<msg>.<sig>`; returns (fields, signature_valid)."""
    if fragment.startswith("#"):
        fragment = fragment[1:]
    if not fragment.startswith("p=") or len(fragment) > 2000:
        raise ValueError("not a pay link")
    m, _, s = fragment[2:].partition(".")
    msg, sig = _unb64u(m), _unb64u(s)
    fields = json.loads(msg)
    try:
        nacl.signing.VerifyKey(sol.b58decode(fields["k"])).verify(msg, sig)
        ok = True
    except Exception:
        ok = False
    return fields, ok
