"""Minimal legacy Solana transaction builder + mainnet simulation (stdlib only). Used by the earn tools."""
from __future__ import annotations

import base64

from . import solana as sol


def _compact(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def build_message(fee_payer: str, instructions: list[tuple[str, list[tuple[str, bool, bool]], bytes]], blockhash: str | None = None) -> tuple[bytes, list[str]]:
    """instructions = [(program, [(pubkey, is_signer, is_writable), ...], data)]. Returns (message bytes, signer keys in order)."""
    meta: dict[str, list[bool]] = {fee_payer: [True, True]}
    for prog, accs, _ in instructions:
        for k, signer, writable in accs:
            m = meta.setdefault(k, [False, False])
            m[0] |= signer
            m[1] |= writable
        meta.setdefault(prog, [False, False])
    keys = sorted(meta, key=lambda k: (k != fee_payer, not meta[k][0], not meta[k][1]))
    n_sig = sum(meta[k][0] for k in keys)
    n_ro_signed = sum(meta[k][0] and not meta[k][1] for k in keys)
    n_ro_unsigned = sum(not meta[k][0] and not meta[k][1] for k in keys)
    idx = {k: i for i, k in enumerate(keys)}
    recent = sol.b58decode(blockhash) if blockhash else b"\1" * 32
    msg = bytes([n_sig, n_ro_signed, n_ro_unsigned]) + _compact(len(keys)) + b"".join(sol.b58decode(k) for k in keys) + recent + _compact(len(instructions))
    for prog, accs, data in instructions:
        msg += bytes([idx[prog]]) + _compact(len(accs)) + bytes(idx[a[0]] for a in accs) + _compact(len(data)) + data
    return msg, keys[:n_sig]


def wrap(message: bytes, signatures: list[bytes]) -> bytes:
    return _compact(len(signatures)) + b"".join(signatures) + message


def simulate(rpc: sol.Rpc, message: bytes, n_signers: int, watch: list[str] | None = None) -> dict:
    """Run an unsigned transaction through mainnet's simulator. Moves nothing."""
    tx = wrap(message, [b"\0" * 64] * n_signers)
    cfg = {"encoding": "base64", "sigVerify": False, "replaceRecentBlockhash": True, "commitment": "confirmed"}
    if watch:
        cfg["accounts"] = {"encoding": "jsonParsed", "addresses": watch}
    return rpc.call("simulateTransaction", [base64.b64encode(tx).decode(), cfg])


def steps_to_instructions(steps: list[dict], intermediary: str, funder: str | None = None) -> list[tuple[str, list[tuple[str, bool, bool]], bytes]]:
    """Turn Intents Connect steps into instructions, playing the service's role: {INTERMEDIARY} is the signer and the
    account-create funder is reassigned to the fee payer."""
    out = []
    for s in steps:
        data = bytes.fromhex(s["discriminator"])
        for a in s["args"]:
            size = 8 if a["type"] == "u64" else 1
            data += int(a["value"]).to_bytes(size, "little")
        accs = []
        for a in s["accounts"]:
            k = a["pubkey"]
            if k == "{INTERMEDIARY}":
                k = funder if (funder and s["programId"] == sol.ATA_PROGRAM) else intermediary
            accs.append((k, a["isSigner"], a["isWritable"]))
        out.append((s["programId"], accs, data))
    return out
