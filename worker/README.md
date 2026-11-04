# Sluice hosted 402 API (Cloudflare Worker)

Live at https://sluice-api.swiftbotlab.workers.dev. The pay-per-call flow of `sluice/server.py`, rebuilt for Workers: the front
Worker shapes each request, and one Durable Object (`Ledger`) keeps every order in its own SQLite database. Money rules come from
`../docs/core.js` (the checkout's own `verifyUsdc`, `txRoles`, `validRefund`), so the API and the page cannot drift apart.

| File | What it does |
|---|---|
| `src/engine.js` | orders, Aurora quote echo checks, status machine, Solana settlement check, exactly-once delivery, signed receipts |
| `src/router.js` | routes, strict JSON input (8 KB), rate limits per client and in total, response headers |
| `src/upstream.js` | Aurora and Solana RPC calls: fixed https hosts, no redirects, timeouts, 2 MB response cap; the paid wallet report |
| `src/index.js` | Worker entry and the Durable Object (ledger, background poller, live `/healthz`) |

Routes: `GET /api/report/<solana address>` (402, or 200 + `X-Sluice-Receipt` with `X-Sluice-Order`), `POST /api/orders`,
`GET /api/orders/<id>`, `POST /api/orders/<id>/deposit`, `GET /api/origins`, `GET /.well-known/sluice.json`, `GET /healthz`, `GET /`.

Tests (offline): `node --test tests/js/worker.test.mjs` from the repo root, and `python3 -m unittest tests.test_worker_parity`
(receipts made here verify with the Python reference).

Deploy (wrangler 4.x, a Cloudflare account with Workers):

```bash
cd worker
wrangler deploy                                  # creates the Worker and the SQLite-backed Durable Object (migration v1)
wrangler secret put AURORA_API_KEY               # an Aurora integrator key from studio.aurora.dev
wrangler secret put RECEIPT_SECRET_B58           # base58 of a 64-byte ed25519 secret (seed + public key), for receipts only
```

Until both secrets are set, and if the receipt key does not match its public half, every route answers 503. Set `MERCHANT`,
`PRICE_RAW` (USDC base units, 0.10 to 5.00) and `PUBLIC_URL` in `wrangler.toml`. Never put a key that can move funds here.
