"""Minimal, dependency-free client for the Aurora Intents Swap API (powered by NEAR Intents / 1Click).

Docs: https://docs.intents.aurora.dev/intents-swap/what-is-swap-api
Base URL: https://intents-api.aurora.dev  (API key is a path segment; Aurora documents it as non-secret)

Only fixed hosts are ever contacted (no user-controlled URLs -> no SSRF).
"""
from __future__ import annotations

import datetime as _dt
import json
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "https://intents-api.aurora.dev"
USER_AGENT = "sluice/0.1 (+https://github.com/swiftbotlabs/sluice-pay)"

# Canonical asset ids (from GET /api/tokens). Never build ids by hand at runtime: they are checked
# against the live token list before use.
SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"
SOL_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

TERMINAL = {"SUCCESS", "REFUNDED", "FAILED"}
STATUSES = {"KNOWN_DEPOSIT_TX", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"}

_ASSET_RE = re.compile(r"^nep(141|245):[A-Za-z0-9._:-]{2,120}$")
_KEY_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")


class AuroraError(Exception):
    def __init__(self, msg: str, status: int | None = None, body: str | None = None):
        super().__init__(msg)
        self.status = status
        self.body = body


def iso_in(seconds: int) -> str:
    t = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=seconds)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


class Aurora:
    """Thin client. `opener` is injectable for offline tests."""

    def __init__(self, api_key: str, base: str = API_BASE, opener=None, timeout: float = 40.0, max_attempts: int = 3):
        if not _KEY_RE.match(api_key or ""):
            raise ValueError("invalid Aurora API key format")
        if base != API_BASE and not base.startswith("http://127.0.0.1"):
            raise ValueError("unexpected API base")  # fixed host only
        self.key = api_key
        self.base = base
        self.timeout = timeout
        self.max_attempts = max_attempts
        self._open = opener or urllib.request.urlopen
        self._tokens: list[dict] | None = None
        self._tokens_at = 0.0

    # -- transport -----------------------------------------------------------------------------
    def _req(self, method: str, path: str, body: dict | None = None, query: dict | None = None):
        url = f"{self.base}{path}/{urllib.parse.quote(self.key)}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(1, self.max_attempts + 1):
            req = urllib.request.Request(url, data=data, method=method,
                                         headers={"content-type": "application/json", "user-agent": USER_AGENT})
            try:
                with self._open(req, timeout=self.timeout) as r:
                    raw = r.read(2_000_001)
                    if len(raw) > 2_000_000:
                        raise AuroraError("response too large")
                    return json.loads(raw)
            except urllib.error.HTTPError as e:
                text = e.read(4000).decode("utf-8", "replace")
                if e.code == 429 and attempt < self.max_attempts:
                    # Honour Retry-After (docs: rejected requests still count toward the hourly quota)
                    wait = min(float(e.headers.get("Retry-After") or 1), 15.0) + random.random() * 0.5
                    time.sleep(wait)
                    continue
                try:
                    msg = json.loads(text).get("message", text)
                except Exception:
                    msg = text
                raise AuroraError(f"HTTP {e.code}: {msg}"[:400], e.code, text) from None
            except urllib.error.URLError as e:
                if attempt < self.max_attempts:
                    time.sleep(1.5 * attempt)
                    continue
                raise AuroraError(f"network error: {e.reason}") from None
        raise AuroraError("retries exhausted")

    # -- endpoints -----------------------------------------------------------------------------
    def tokens(self, max_age: float = 600) -> list[dict]:
        """GET /api/tokens/{key}; cached (docs: fetch once, refresh every few minutes)."""
        if self._tokens is None or time.time() - self._tokens_at > max_age:
            d = self._req("GET", "/api/tokens")
            toks = d.get("tokens") if isinstance(d, dict) else d
            if not isinstance(toks, list):
                raise AuroraError("unexpected tokens payload")
            self._tokens, self._tokens_at = toks, time.time()
        return self._tokens

    def asset(self, asset_id: str) -> dict:
        if not _ASSET_RE.match(asset_id or ""):
            raise ValueError("malformed asset id")
        for t in self.tokens():
            if t.get("assetId") == asset_id:
                return t
        raise ValueError(f"asset not supported: {asset_id}")

    def find(self, blockchain: str, symbol: str) -> dict:
        for t in self.tokens():
            if t.get("blockchain") == blockchain and t.get("symbol") == symbol:
                return t
        raise ValueError(f"no {symbol} on {blockchain}")

    def quote(self, *, origin_asset: str, destination_asset: str, amount: int, recipient: str, refund_to: str,
              swap_type: str = "EXACT_OUTPUT", deadline_s: int = 900, slippage_bps: int = 100, dry: bool = False,
              confidentiality: str = "public", referral: str | None = None, session_id: str | None = None) -> dict:
        """POST /api/quote/{key}. EXACT_OUTPUT = the merchant receives exactly `amount` (smallest units)."""
        if swap_type not in ("EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT"):
            raise ValueError("swap_type")
        if confidentiality not in ("public", "basic", "advanced"):
            raise ValueError("confidentiality")
        if not (isinstance(amount, int) and 0 < amount < 10**30):
            raise ValueError("amount")
        if not (60 <= deadline_s <= 24 * 3600):
            raise ValueError("deadline")
        if not (1 <= slippage_bps <= 500):
            raise ValueError("slippage")
        self.asset(origin_asset)
        self.asset(destination_asset)
        body = {
            "dry": bool(dry), "swapType": swap_type, "depositType": "ORIGIN_CHAIN", "depositMode": "SIMPLE",
            "originAsset": origin_asset, "destinationAsset": destination_asset, "amount": str(amount),
            "slippageTolerance": slippage_bps, "refundTo": refund_to, "refundType": "ORIGIN_CHAIN",
            "recipient": recipient, "recipientType": "DESTINATION_CHAIN", "deadline": iso_in(deadline_s),
            "confidentiality": confidentiality, "quoteWaitingTimeMs": 0,
        }
        if referral:
            body["referral"] = referral
        if session_id:
            body["sessionId"] = session_id
        q = self._req("POST", "/api/quote", body)
        if not isinstance(q, dict) or "quote" not in q:
            raise AuroraError("unexpected quote payload")
        # Defensive: the quote must echo what we asked for (recipient, refund, assets, amount).
        qr = q.get("quoteRequest", {})
        for k, v in (("recipient", recipient), ("refundTo", refund_to), ("originAsset", origin_asset),
                     ("destinationAsset", destination_asset), ("amount", str(amount)), ("swapType", swap_type)):
            if qr.get(k) != v:
                raise AuroraError(f"quote echo mismatch on {k}")
        if not dry and not q["quote"].get("depositAddress"):
            raise AuroraError("quote has no deposit address")
        return q

    def submit_deposit(self, deposit_address: str, tx_hash: str, memo: str | None = None) -> dict:
        body = {"txHash": tx_hash, "depositAddress": deposit_address}
        if memo:
            body["memo"] = memo
        return self._req("POST", "/api/deposit/submit", body)

    def status(self, deposit_address: str, memo: str | None = None) -> dict:
        q = {"depositAddress": deposit_address}
        if memo:
            q["depositMemo"] = memo
        s = self._req("GET", "/api/status", query=q)
        if s.get("status") not in STATUSES:
            raise AuroraError(f"unknown status {s.get('status')!r}")
        return s

    def incidents(self) -> dict:
        return self._req("GET", "/api/incidents")


def summarize_status(s: dict) -> dict:
    """Small, stable view of a status payload (what we store and show)."""
    d = s.get("swapDetails") or {}
    return {
        "status": s.get("status"),
        "updatedAt": s.get("updatedAt"),
        "amountIn": d.get("amountInFormatted"),
        "amountOut": d.get("amountOutFormatted"),
        "depositedAmount": d.get("depositedAmountFormatted"),
        "refundedAmount": d.get("refundedAmountFormatted"),
        "refundReason": d.get("refundReason"),
        "originTx": [x.get("hash") for x in d.get("originChainTxHashes") or []],
        "destinationTx": [x.get("hash") for x in d.get("destinationChainTxHashes") or []],
        "originExplorer": [x.get("explorerUrl") for x in d.get("originChainTxHashes") or []],
        "destinationExplorer": [x.get("explorerUrl") for x in d.get("destinationChainTxHashes") or []],
        "nearTx": list(d.get("nearTxHashes") or []),
        "intentHashes": list(d.get("intentHashes") or []),
    }
