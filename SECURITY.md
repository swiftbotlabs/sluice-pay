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
- **A tampered API answer is refused on invoices.** Before any QR, signature or send, a public-rail invoice compares the deposit
  address with NEAR Intents' public record (`checkPublicQuote`): recipient, refund address, origin asset, amounts, memo and fees must
  all match. Token contracts and decimals must agree with the public token list, and the amount asked must be within 5% plus $0.10 of
  the invoice and fees at public prices. If the public record cannot be read, the payment does not proceed. This does not cover
  private quotes or permanent addresses: see Known limits.
- **The payer's Solana account is computed, not fetched.** `deriveIntermediary` derives it locally from the NEAR MPC root key and
  the wallet address. An API answer that differs is refused.
- **The browser audits everything it asks you to sign.** An Intents Connect signature request is opaque text in a wallet, and the
  signature covers the whole JSON. Before the wallet opens, `auditPayload` in `docs/core.js` requires the exact expected fields,
  contracts and domain, a short validity window, and canonical JSON (so duplicate keys cannot hide anything). It then decodes the
  Solana transaction inside and refuses anything but the invoice: exact amount, this merchant's token account, this order's
  reference, Kamino's expected reserve accounts, and one fee within 120% of the previewed fee (never above 0.30 USDC). Lookup tables
  and unknown programs are refused. Tests run it on real mainnet payloads and on tampered copies. The Python rail has the same audit.
- **"Paid" means a credit that is bound to this order.** A Connect payment counts only if a transaction carrying this order's
  reference, as a read-only non-signing key, credits the merchant. For settle-to-earn the Kamino deposit instruction itself must name
  the merchant's cUSDC account, this reference and the invoice amount, so a crumb sent to the merchant alongside someone else's
  deposit does not count. A reference is unknown until its payment lands, so the real payment is the oldest transaction under it:
  transactions are checked oldest first, and dust added later cannot hide it. Transactions older than the order are ignored.
  Records state only the amount read from Solana. A record link proves a credit, not who paid it or for what.
- **How an invoice settles is signed.** The `settle` flag sits inside the merchant-signed bytes, so a relay cannot change it. A
  payer with no wallet to sign with pays by address, which settles as plain USDC; the page says so, and the merchant is paid either way.
- **An open payment is not cleared while money is visibly moving.** An abandoned Intents Connect attempt is deleted only with an
  explicit wallet signature, and only if our own record shows no deposit, Aurora's status is still `PENDING_DEPOSIT` and the deposit
  address holds nothing on-chain, checked before and after the wallet prompt. A transfer still in a mempool is not visible to these
  checks; if one lands afterwards, the funds reach the payer's own Solana account, not the merchant.
- **A stored order only resumes for its own invoice.** Orders are kept per full link, must match its merchant, amount and settlement,
  and are re-checked with the public record before they are shown. An order that cannot be re-checked is not resumed, and the page warns
  the payer not to pay twice. Expired addresses are not shown as payable. The page guards against a double click on its own send
  button; it cannot stop a payer sending again from another wallet.
- **Private payments stay private in our records.** For confidential orders the order view and the receipt omit the
  payer's refund address, source-chain tx and deposit address.

## Inputs and limits
- Request bodies: JSON only, max 8 KB, unknown fields rejected; order ids, Solana addresses, tx hashes, refund
  addresses and asset ids are validated with strict patterns (base58 length checks, per-family regexes).
- Rate limits per client (IPv4 address or IPv6 /64): 6 order creations/min (burst 3), 60 status reads/min,
  120 GET/min; LRU-bounded so flooding new keys cannot reset other clients. Behind a proxy only the right-most
  `X-Forwarded-For` entry is used. Socket timeout 10 s, at most 32 requests in flight.
- The checkout's Content-Security-Policy allows scripts and styles from its own origin only, and connections only to Aurora's
  two APIs, NEAR Intents' public API and four named Solana RPCs. All API and wallet text is rendered with `textContent`, explorer links are built from
  fixed prefixes and validated hashes, and record links are validated before use.
- Upstream calls go only to fixed hosts (Aurora API, Intents Connect API, public Solana RPCs, fixed EVM RPCs in the CLI):
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
- **Permanent addresses trust Aurora's API.** The page reads Aurora's stored record back to catch mistakes, but both answers come from
  Aurora and no public record of these addresses exists, so a compromised Aurora API could show a wrong address. The page's status list
  comes from Aurora too; the delivered amount shown comes only from Solana. Failed deposits are retried, not refunded, and the page says so.
- Private quotes are not public, so they cannot be cross-checked or re-checked after a reload. The page says so.
- The Intents Connect fee recipient is not pinned, so that a relayer change does not stop payments. The fee is capped at 120% of the
  preview and 0.30 USDC, and is shown before signing.
- The intermediary check pins the NEAR MPC root key and the proxy contract. If Aurora rotates them, the Connect rail stops and refuses
  rather than continuing, until the pin is updated.
- A signed pay link proves who signed it, not that this is the merchant you meant to pay: compare the address with the merchant.
- Unsigned links can be edited by anyone, and the page says so.
- Kamino is a third-party protocol. Settling into it carries smart-contract and liquidity risk until the merchant redeems.
- The checkout page trusts the browser's WebCrypto Ed25519 to verify signed links; older browsers show the link as
  "cannot verify" instead of "signed".

## Reporting
Open a GitHub issue without exploit details, or email swiftbotlabs@gmail.com.
