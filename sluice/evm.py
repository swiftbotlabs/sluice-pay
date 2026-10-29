"""Tiny EVM payer used by the headless buyer CLI: send native coin or an ERC-20 to an Aurora deposit address.

Requires `eth-account` (pinned in requirements.txt). The private key is read from an environment variable or a
0600 file by the caller and never logged. Every send asserts chain id, recipient and amount before signing.
"""
from __future__ import annotations

import json
import time
import urllib.request
from decimal import Decimal

# Fixed public RPCs (no user-supplied URLs).
CHAINS = {
    "base": {"id": 8453, "rpc": "https://mainnet.base.org", "explorer": "https://basescan.org/tx/"},
    "arb": {"id": 42161, "rpc": "https://arb1.arbitrum.io/rpc", "explorer": "https://arbiscan.io/tx/"},
    "eth": {"id": 1, "rpc": "https://ethereum-rpc.publicnode.com", "explorer": "https://etherscan.io/tx/"},
    "op": {"id": 10, "rpc": "https://mainnet.optimism.io", "explorer": "https://optimistic.etherscan.io/tx/"},
    "pol": {"id": 137, "rpc": "https://polygon-bor-rpc.publicnode.com", "explorer": "https://polygonscan.com/tx/"},
}


class EvmError(Exception):
    pass


def _rpc(url: str, method: str, params: list, timeout: float = 30):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"content-type": "application/json", "user-agent": "Mozilla/5.0 sluice/0.1"})
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                d = json.loads(r.read(1_000_000))
            if "error" in d:
                raise EvmError(f"{method}: {d['error']}")
            return d["result"]
        except EvmError:
            raise
        except Exception as e:  # transient RPC trouble (403/429/timeouts): retry, never resend blindly
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise EvmError(f"{method}: {last}")


def is_address(a: str) -> bool:
    return isinstance(a, str) and len(a) == 42 and a.startswith("0x") and all(c in "0123456789abcdefABCDEF" for c in a[2:])


def erc20_balance(chain: str, token: str, owner: str) -> int:
    c = CHAINS[chain]
    data = "0x70a08231" + owner[2:].lower().rjust(64, "0")
    return int(_rpc(c["rpc"], "eth_call", [{"to": token, "data": data}, "latest"]), 16)


def native_balance(chain: str, owner: str) -> int:
    return int(_rpc(CHAINS[chain]["rpc"], "eth_getBalance", [owner, "latest"]), 16)


def send(chain: str, private_key: str, to: str, amount: int, token: str | None = None, max_amount: int | None = None,
         wait: bool = True) -> dict:
    """Send `amount` (smallest units) of `token` (ERC-20 contract) or the native coin to `to`.

    `max_amount` is a hard cap the caller sets from the quote; we refuse anything above it.
    """
    from eth_account import Account  # optional dependency, only for the buyer side
    from eth_utils import to_checksum_address

    if chain not in CHAINS:
        raise EvmError("unsupported chain")
    if not is_address(to) or (token and not is_address(token)):
        raise EvmError("bad address")
    if not (isinstance(amount, int) and amount > 0):
        raise EvmError("bad amount")
    if max_amount is not None and amount > max_amount:
        raise EvmError("amount above cap")
    c = CHAINS[chain]
    to = to_checksum_address(to)
    token = to_checksum_address(token) if token else None
    acct = Account.from_key(private_key)
    if int(_rpc(c["rpc"], "eth_chainId", []), 16) != c["id"]:
        raise EvmError("chain id mismatch")
    if token:
        tx_to, value = token, 0
        data = "0xa9059cbb" + to[2:].lower().rjust(64, "0") + hex(amount)[2:].rjust(64, "0")
        if erc20_balance(chain, token, acct.address) < amount:
            raise EvmError("insufficient token balance")
    else:
        tx_to, value, data = to, amount, "0x"
    gas = int(int(_rpc(c["rpc"], "eth_estimateGas", [{"from": acct.address, "to": tx_to, "value": hex(value), "data": data}]), 16) * 1.25)
    blk = _rpc(c["rpc"], "eth_getBlockByNumber", ["latest", False])
    base = int(blk.get("baseFeePerGas", "0x0"), 16)
    tip = max(int(_rpc(c["rpc"], "eth_maxPriorityFeePerGas", []), 16), 10**6)
    max_fee = 2 * base + tip
    if native_balance(chain, acct.address) < value + gas * max_fee:
        raise EvmError("insufficient native balance for value + gas")
    nonce = int(_rpc(c["rpc"], "eth_getTransactionCount", [acct.address, "pending"]), 16)
    tx = {"chainId": c["id"], "nonce": nonce, "to": tx_to, "value": value, "data": data, "gas": gas,
          "maxFeePerGas": max_fee, "maxPriorityFeePerGas": tip, "type": 2}
    signed = acct.sign_transaction(tx)
    h = _rpc(c["rpc"], "eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex()])
    out = {"chain": chain, "tx": h, "from": acct.address, "to": to, "amount": str(amount), "token": token,
           "explorer": c["explorer"] + h, "status": "sent"}
    if wait:
        for _ in range(90):
            try:
                rc = _rpc(c["rpc"], "eth_getTransactionReceipt", [h])
            except EvmError:
                rc = None
            if rc:
                out["status"] = "ok" if int(rc["status"], 16) == 1 else "reverted"
                out["block"] = int(rc["blockNumber"], 16)
                break
            time.sleep(2)
    return out


def human(amount: int, decimals: int) -> str:
    return str((Decimal(amount) / (Decimal(10) ** decimals)).normalize())
