"""Order ledger (SQLite). One order = one Aurora deposit address = at most one delivery.

Exactly-once guarantees come from the schema, not from application luck:
  * deposit_address UNIQUE      -> a deposit can only ever belong to one order
  * settle_sig      UNIQUE      -> a Solana settlement tx can only be credited once
  * delivered_body is written once, inside a transaction that also flips the state to DELIVERED;
    later reads return the stored bytes (retries never re-run the paid work)
"""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
import threading
import time

STATES = ("AWAITING_DEPOSIT", "DEPOSIT_SEEN", "PROCESSING", "SETTLED", "DELIVERED", "REFUNDED", "FAILED", "EXPIRED")
TERMINAL = {"DELIVERED", "REFUNDED", "FAILED", "EXPIRED"}
ALLOWED = {
    "AWAITING_DEPOSIT": {"DEPOSIT_SEEN", "PROCESSING", "SETTLED", "REFUNDED", "FAILED", "EXPIRED"},
    "DEPOSIT_SEEN": {"PROCESSING", "SETTLED", "REFUNDED", "FAILED"},
    "PROCESSING": {"SETTLED", "REFUNDED", "FAILED"},
    "SETTLED": {"DELIVERED"},
    "DELIVERED": set(), "REFUNDED": set(), "FAILED": set(),
    "EXPIRED": {"SETTLED", "REFUNDED", "FAILED"},  # a late deposit can still settle or be refunded
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  rail TEXT NOT NULL,                 -- 'swap' (Swap API) | 'connect' (Intents Connect bridge-in + memo)
  resource TEXT NOT NULL,
  params TEXT NOT NULL,               -- canonical JSON
  request_hash TEXT NOT NULL,
  price_raw INTEGER NOT NULL,         -- USDC base units the merchant must receive
  merchant TEXT NOT NULL,
  origin_asset TEXT NOT NULL,
  refund_to TEXT NOT NULL,
  confidential INTEGER NOT NULL DEFAULT 0,
  deposit_address TEXT UNIQUE,
  deposit_memo TEXT,
  amount_in TEXT,
  min_amount_in TEXT,
  deadline TEXT,
  quote TEXT,                          -- JSON (signature stripped)
  execution_id TEXT,
  state TEXT NOT NULL,
  provider_status TEXT,
  provider_view TEXT,                  -- JSON summary of the last provider status
  deposit_tx TEXT,
  settle_sig TEXT UNIQUE,
  settle_proof TEXT,                   -- JSON from solana.verify_payment
  delivered_body BLOB,
  receipt TEXT,
  last_polled REAL NOT NULL DEFAULT 0,
  client TEXT
);
CREATE INDEX IF NOT EXISTS orders_state ON orders(state);
"""


class StateError(Exception):
    pass


class Store:
    def __init__(self, path: str):
        self.path = path
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._lock = threading.RLock()
        self._order_locks: dict[str, threading.Lock] = {}
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        if path != ":memory:":
            self.db.execute("PRAGMA journal_mode=WAL")
            os.chmod(path, 0o600)
        self.db.executescript(SCHEMA)
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(orders)")}
        if "client" not in cols:  # migrate older ledgers
            self.db.execute("ALTER TABLE orders ADD COLUMN client TEXT")

    @staticmethod
    def new_id() -> str:
        return "ord_" + secrets.token_urlsafe(12).replace("-", "x").replace("_", "y")

    def create(self, **f) -> dict:
        now = int(time.time())
        f.setdefault("id", self.new_id())
        f.update(created=now, updated=now, state="AWAITING_DEPOSIT")
        cols = ",".join(f)
        with self._lock:
            self.db.execute(f"INSERT INTO orders ({cols}) VALUES ({','.join('?' * len(f))})", list(f.values()))
        return self.get(f["id"])

    def get(self, oid: str) -> dict | None:
        with self._lock:
            r = self.db.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
        return dict(r) if r else None

    def by_deposit(self, addr: str) -> dict | None:
        with self._lock:
            r = self.db.execute("SELECT * FROM orders WHERE deposit_address=?", (addr,)).fetchone()
        return dict(r) if r else None

    def open_orders(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = self.db.execute(
                "SELECT * FROM orders WHERE state NOT IN ('DELIVERED','REFUNDED','FAILED','EXPIRED','SETTLED') "
                "ORDER BY last_polled ASC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    def count_open(self, client: str | None = None) -> int:
        q = "SELECT COUNT(*) FROM orders WHERE state IN ('AWAITING_DEPOSIT','DEPOSIT_SEEN','PROCESSING')"
        with self._lock:
            if client is None:
                return self.db.execute(q).fetchone()[0]
            return self.db.execute(q + " AND client=?", (client,)).fetchone()[0]

    def open_tags(self, base_price: int) -> set:
        """price_raw values in use by open confidential orders for the same base price (tag collision check)."""
        with self._lock:
            rows = self.db.execute("SELECT price_raw FROM orders WHERE confidential=1 AND state IN "
                                   "('AWAITING_DEPOSIT','DEPOSIT_SEEN','PROCESSING','EXPIRED') AND price_raw BETWEEN ? AND ?",
                                   (base_price, base_price + 999)).fetchall()
        return {r[0] for r in rows}

    def claimed_sigs(self, limit: int = 500) -> set:
        with self._lock:
            return {r[0] for r in self.db.execute("SELECT settle_sig FROM orders WHERE settle_sig IS NOT NULL "
                                                  "ORDER BY updated DESC LIMIT ?", (limit,)).fetchall()}

    def update(self, oid: str, **f):
        f["updated"] = int(time.time())
        sets = ",".join(f"{k}=?" for k in f)
        with self._lock:
            self.db.execute(f"UPDATE orders SET {sets} WHERE id=?", [*f.values(), oid])

    def transition(self, oid: str, new: str, **f) -> bool:
        """Move an order to `new` if the state machine allows it. Returns False if it already is there."""
        if new not in STATES:
            raise StateError(new)
        with self._lock:
            cur = self.get(oid)
            if not cur:
                raise StateError("no such order")
            if cur["state"] == new:
                if f:
                    self.update(oid, **f)
                return False
            if new not in ALLOWED[cur["state"]]:
                raise StateError(f"{cur['state']} -> {new} not allowed")
            self.update(oid, state=new, **f)
            return True

    def claim_settlement(self, oid: str, sig: str, proof: dict) -> bool:
        """Credit a Solana tx to an order exactly once (UNIQUE settle_sig)."""
        with self._lock:
            cur = self.get(oid)
            if cur["state"] in ("SETTLED", "DELIVERED"):
                return cur["settle_sig"] == sig
            try:
                self.db.execute("BEGIN IMMEDIATE")
                self.db.execute("UPDATE orders SET settle_sig=?, settle_proof=?, state='SETTLED', updated=? WHERE id=? "
                                "AND state IN ('AWAITING_DEPOSIT','DEPOSIT_SEEN','PROCESSING','EXPIRED')",
                                (sig, json.dumps(proof), int(time.time()), oid))
                self.db.execute("COMMIT")
            except sqlite3.IntegrityError:
                self.db.execute("ROLLBACK")
                return False
            except Exception:
                self.db.execute("ROLLBACK")
                raise
            return self.get(oid)["state"] == "SETTLED"

    def _order_lock(self, oid: str) -> threading.Lock:
        with self._lock:
            if len(self._order_locks) > 5000:
                self._order_locks.clear()
            return self._order_locks.setdefault(oid, threading.Lock())

    def deliver_once(self, oid: str, make_body, make_receipt) -> tuple[bytes, str]:
        """Run the paid work at most once; later calls return the stored body + receipt.
        A per-order lock serialises deliveries of one order; the global DB lock is never held during the work."""
        with self._order_lock(oid):
            cur = self.get(oid)
            if cur["state"] == "DELIVERED":
                return cur["delivered_body"], cur["receipt"]
            if cur["state"] != "SETTLED":
                raise StateError(f"order not settled ({cur['state']})")
            body = make_body(cur)
            receipt = make_receipt(cur, body)
            with self._lock:
                try:
                    self.db.execute("BEGIN IMMEDIATE")
                    self.db.execute("UPDATE orders SET delivered_body=?, receipt=?, state='DELIVERED', updated=? "
                                    "WHERE id=? AND state='SETTLED'", (body, receipt, int(time.time()), oid))
                    self.db.execute("COMMIT")
                except Exception:
                    self.db.execute("ROLLBACK")
                    raise
            cur = self.get(oid)
            return cur["delivered_body"], cur["receipt"]
