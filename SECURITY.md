# Security

Sluice moves real money, so the design assumes every input is hostile and every external answer can be wrong.

## Trust model
- **The payment provider is not trusted for delivery.** A `SUCCESS` from Aurora is only a hint. Nothing is delivered
  until Sluice reads the settlement transaction from Solana and sees the merchant's USDC token account grow by at least
  the invoiced amount, in a successful transaction that is not older than the order.
- **Quotes are checked before use.** The quote must echo our recipient, refund address, assets, amount and swap type,
  otherwise it is discarded (protects against a tampered or mismatched response).
- **One settlement, one order.** The ledger enforces `UNIQUE(deposit_address)` and `UNIQUE(settle_sig)`; a Solana
  transaction can never pay for two orders. Delivery runs once per order; retries return the stored bytes.
- **Refunds go to the payer.** `refundTo` is the buyer's own address on the paying chain, validated per chain family.
- **The buyer does not trust the seller.** The CLI pins token contracts/decimals, takes prices from the public NEAR
  Intents token list, and checks the deposit address with the public NEAR Intents status API before paying
  (recipient, amount, origin asset, refund address, amountIn must all match). On the Intents Connect rail it decodes
  the Solana transaction it is asked to authorise and refuses anything but: pay the merchant the price with this order's
  reference account, the service's compute-budget/nonce instructions and one fee transfer of at most 0.02 USDC.
- **Private payments stay private in our records.** For confidential orders the order view and the receipt omit the
  payer's refund address, source-chain tx and deposit address.

## Inputs and limits
- Request bodies: JSON only, max 8 KB, unknown fields rejected; order ids, Solana addresses, tx hashes, refund
  addresses and asset ids are validated with strict patterns (base58 length checks, per-family regexes).
- Rate limits per client (IPv4 address or IPv6 /64): 6 order creations/min (burst 3), 60 status reads/min,
  120 GET/min; LRU-bounded so flooding new keys cannot reset other clients. Behind a proxy only the right-most
  `X-Forwarded-For` entry is used. Socket timeout 10 s, at most 32 requests in flight.
- Upstream calls go only to fixed hosts (Aurora API, Intents Connect API, two Solana RPCs, fixed EVM RPCs in the CLI):
  no user-controlled URLs, so no SSRF. Responses are size-capped.
- Static files are served from a fixed allow-list (no path joins), with CSP, `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`.
- Errors never echo stack traces; logs contain method, path and status only.

## Keys
- Server secrets live in an env file you create with `chmod 600` (Aurora key, merchant address, receipt secret).
  Use a dedicated receipt key, never the treasury key.
- The buyer CLI reads a `chmod 600` key file and refuses looser permissions. Keys are never printed or sent anywhere.
- The Aurora key embedded in `docs/app.js` is a separate, public integrator key (Aurora documents API keys as
  non-secret and safe in client code); it has no fee configuration that a third party could change.

## Known limits
- Single-process SQLite reference server; run behind a TLS proxy and set `SLUICE_TRUST_PROXY=1` only if the proxy
  sets `X-Forwarded-For`.
- Confidential payments are matched by an exact tagged amount (base price + 1..999 micro-USDC). The tag is unique among
  open private orders for the same price, and already-claimed settlement signatures are skipped when scanning.
- An order id works like a bearer token for its delivered response; do not publish order ids of private calls.
- Unpaid orders expire 30 minutes after the quote deadline and stop counting toward the open-order limits (50 total,
  5 per client); an expired order is still re-checked every 5 minutes, so a late deposit can settle or be refunded.
- The checkout page trusts the browser's WebCrypto Ed25519 to verify signed links; older browsers show the link as
  "cannot verify" instead of "signed".

## Reporting
Open a GitHub issue without exploit details, or email swiftbotlabs@gmail.com.
