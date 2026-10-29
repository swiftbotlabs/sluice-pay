"""Offline fakes for Aurora, Intents Connect and Solana RPC."""
import copy
import json

from sluice import aurora as au
from sluice import solana as sol

MERCHANT = "9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR"
PAYER_EVM = "0x8d9716A9f13FE82BA59E74b3Ce032842EB357818"
BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
TOKENS = [
    {"assetId": BASE_USDC, "decimals": 6, "blockchain": "base", "symbol": "USDC", "price": 1.0, "priceUpdatedAt": "x",
     "contractAddress": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"},
    {"assetId": "nep141:base.omft.near", "decimals": 18, "blockchain": "base", "symbol": "ETH", "price": 2300.0, "priceUpdatedAt": "x"},
    {"assetId": "nep141:btc.omft.near", "decimals": 8, "blockchain": "btc", "symbol": "BTC", "price": 70000.0, "priceUpdatedAt": "x"},
    {"assetId": au.SOL_USDC, "decimals": 6, "blockchain": "sol", "symbol": "USDC", "price": 1.0, "priceUpdatedAt": "x",
     "contractAddress": sol.USDC_MINT},
]
SIG_A = "3uyHowgryQxRWjsC9DrxMSxFd1nvpEtq3xsrR6iGJfodAdsRC6TyVN8Zk1GgUWunsLH1j6dnz9Tz2tsMhu3xiSG2"
SIG_B = "44GN5eYQhed3UHLkwCXxi2nJU53xeHot1Ff5x4YQNNZn9PG4vy8XVMhrvof6V4fJ9C2SEKCJ9ev8dAXUDZtuB6Cj"


class FakeAurora:
    def __init__(self):
        self.statuses = {}  # deposit address -> list of statuses (consumed in order, last sticks)
        self.quotes = []
        self.n = 0

    def tokens(self, max_age=600):
        return TOKENS

    def find(self, chain, sym):
        for t in TOKENS:
            if t["blockchain"] == chain and t["symbol"] == sym:
                return t
        raise ValueError("nope")

    def asset(self, a):
        for t in TOKENS:
            if t["assetId"] == a:
                return t
        raise ValueError("nope")

    def quote(self, **kw):
        self.n += 1
        addr = "0x" + f"{self.n:040x}"
        self.quotes.append(kw)
        return {"quoteRequest": {"deadline": "2030-01-01T00:00:00.000Z", "recipient": kw["recipient"], "refundTo": kw["refund_to"],
                                 "amount": str(kw["amount"])},
                "quote": {"depositAddress": addr, "amountIn": str(kw["amount"] + 10000), "minAmountIn": str(kw["amount"] + 5000),
                          "amountInFormatted": "x", "withdrawFee": "10005", "refundFee": "2400"}}

    def status(self, addr, memo=None):
        seq = self.statuses.get(addr) or [{"status": "PENDING_DEPOSIT"}]
        s = seq.pop(0) if len(seq) > 1 else seq[0]
        return copy.deepcopy(s)

    def submit_deposit(self, *a, **k):
        return {"status": "PENDING_DEPOSIT"}


def success(dest_sig=None, refund=None):
    d = {"originChainTxHashes": [{"hash": "0x" + "a" * 64, "explorerUrl": ""}], "destinationChainTxHashes": [],
         "nearTxHashes": [], "intentHashes": []}
    if dest_sig:
        d["destinationChainTxHashes"] = [{"hash": dest_sig, "explorerUrl": ""}]
    return {"status": "SUCCESS", "swapDetails": d}


def parsed_tx(owner, delta, mint=sol.USDC_MINT, err=None, memo=None, block_time=2_000_000_000):
    ixs = []
    if memo:
        ixs.append({"program": "spl-memo", "programId": sol.MEMO_PROGRAM, "parsed": memo})
    return {"slot": 1, "blockTime": block_time,
            "meta": {"err": err, "preTokenBalances": [{"owner": owner, "mint": mint, "uiTokenAmount": {"amount": "1000"}}],
                     "postTokenBalances": [{"owner": owner, "mint": mint, "uiTokenAmount": {"amount": str(1000 + delta)}}],
                     "innerInstructions": []},
            "transaction": {"message": {"instructions": ixs}}}


class FakeRpc:
    def __init__(self, txs=None, sigs=None, accounts=None):
        self.txs = txs or {}
        self.sigs = sigs or []
        self.accounts = accounts or {}
        self.calls = []

    def call(self, method, params):
        self.calls.append(method)
        if method == "getAccountInfo":
            return {"value": self.accounts.get(params[0])}
        if method == "getTokenAccountsByOwner":
            return {"value": []}
        return None

    def tx(self, sig):
        self.calls.append("getTransaction")
        return copy.deepcopy(self.txs.get(sig))

    def signatures(self, address, limit=20):
        self.calls.append("getSignaturesForAddress")
        return list(self.sigs)


def dumps(x):
    return json.dumps(x)
