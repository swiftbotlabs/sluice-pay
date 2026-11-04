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
- **A merchant's name is bounded display text, and always labelled as unverified.** Names are NFC-normalised, at most 40
  characters, letters, marks and digits of any script plus single spaces and `. , ' & ( ) ! _ -`. Control, zero-width, bidi and other
  default-ignorable characters, enclosing marks and runs of three or more marks are refused, and so is anything that could pass for an
  address: `..`, a word starting `0x`, or a word of 12 or more characters with a digit or three capitals. The Python CLI applies the
  same rule and a parity test runs both. On a signed link the name sits inside the signed bytes, so changing it breaks the signature,
  but a signature only proves which wallet made the link: anyone can sign their own link with any name. So every page that shows a name
  marks it "name not verified", clips it to one line, and shows the full address under it. A name never replaces the address check.
- **The payout address is checked before a link exists.** The first-run form refuses 0x addresses, token mints, token accounts,
  programs and known Kamino accounts, reading the account from Solana. Anything that looks like a recovery phrase (any case, numbered
  or not, 8 words or more) or a private key is cleared from the field at once and never stored. Addresses with no private key (for
  example multisig vaults) are allowed with a warning. An address filled in from this device's storage must be confirmed with a tick
  before it is used again.
- **The merchant view counts only what Solana shows.** Every amount in it comes from a transaction read from Solana: a USDC credit
  to the merchant, or a Kamino deposit that names the merchant's own cUSDC account. The merchant moving its own USDC into Kamino, and
  withdrawals from it, are not counted. Aurora's history only adds what the customer paid with and a record link, and payments it
  lists that Solana does not show yet are marked as not checked, and its amount fields are shown only if they are plain numbers. Any
  USDC sent to the merchant appears, not only Sluice payments, and the page says so. Credits under 0.01 USDC are left out of the list
  and the totals, and the view pages back through the last 14 days (up to 200 transactions), so a burst of dust cannot push real
  payments out of view. A Kamino deposit row counts only the deposit instructions that name the merchant's cUSDC account, never
  anything else the same transaction put into Kamino. The Kamino value shown is a floor: balance x supplied / (shares + 1) for the
  newest non-dust deposit seen on Solana.
- **What stays on the device.** The first-run form keeps the merchant's name, address, settlement choice, the links made and checklist
  ticks in this browser's localStorage, and nothing else. Stored values are re-validated when read: a stored link is shown only if the
  link itself pays the stored address. "Forget my details on this device" removes them.
- **Refund hashes are never read as settlements.** Aurora has listed a refund both after the deposit in `originChainTxHashes`
  and inside `destinationChainTxHashes` (seen on 4 Nov, next to the Solana signature). The checkout, the record page and the server
  sort every hash by what it is (`txRoles` in `docs/core.js`, `tx_roles` in `sluice/aurora.py`): only a string that decodes to a
  64-byte Solana signature is looked up on Solana, anything else on the destination list is shown as a refund on the paying chain, and
  a later paying-chain hash counts as a refund only when the record reports a refunded amount. Tested with the real 4 Nov record,
  the October records, the refund listed first, and junk values.
- **Redemption signs only for the merchant.** `cli/redeem_earn.py` builds one transaction: create the merchant's own USDC account if
  missing, refresh Kamino's USDC reserve, and redeem cUSDC from the merchant's cUSDC account into the merchant's USDC account, with the
  merchant as the only signer. It simulates first and sends only with `--send`; the key file must be chmod 600 and is never printed.
  Before it simulates or signs, it refuses any program, signer or writable account other than the merchant, its two token accounts and
  Kamino's reserve, cUSDC mint and vault (tested with tampered copies). The live redemption on 4 Nov was this transaction. The checkout's proof check (`verifyRedeem`) counts a redemption only if Kamino's redeem
  instruction is signed by the merchant and names its accounts, and the merchant's cUSDC fell while its USDC grew.
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
  open private orders for the same price, and already-claimed settlement signatures are skipped when scanning. The payer pays the
  tag and the merchant receives it on top of the invoice, so a private payment is the one case where the merchant does not receive
  exactly the invoiced USDC; the checkout says so next to the private-payment toggle.
- An order id works like a bearer token for its delivered response; do not publish order ids of private calls.
- Unpaid orders expire 30 minutes after the quote deadline and stop counting toward the open-order limits (50 total,
  5 per client); an expired order is still re-checked every 5 minutes, so a late deposit can settle or be refunded.
- **Permanent addresses trust Aurora's API.** The page reads Aurora's stored record back to catch mistakes, but both answers come from
  Aurora and no public record of these addresses exists, so a compromised Aurora API could show a wrong address. The page's status list
  comes from Aurora too; the delivered amount shown comes only from Solana. Failed deposits are retried, not refunded, and the page says so.
- Private quotes are not public, so they cannot be cross-checked or re-checked after a reload. The page says so.
- The Intents Connect fee recipient is pinned (`CONNECT_FEE` in `docs/core.js`, `CONNECT_FEE_ACCOUNT` in `sluice/connect.py`): the one
  fee transfer allowed must go to the relayer's USDC account `G9jWhbCR...pA3X` (owner `4NDD95L5...nYfr`), the account in every real
  payload and both live Connect runs. If Aurora moves its fee elsewhere, the checkout, the CLI and Retry refuse to sign until the pin
  is updated; tests run the real payloads (positive control) and copies with the fee redirected. The fee stays capped at 120% of the
  preview and 0.30 USDC, and is shown before signing.
- **Sluice's own fee is pinned too** (`SLUICE_FEE` in `docs/core.js`: 50 bps of a settle-to-earn invoice to the USDC account of
  `8b9QYitF...RFEY8`). The audit allows exactly one `TransferChecked` of exactly that amount to exactly that account, with nothing
  attached, plus the idempotent creation of that one account; any other amount, account or a fee on a plain-USDC invoice is refused.
  Tests run the real 4 Nov payload (positive control) and copies with the fee raised, redirected or not agreed; mutants of the
  amount and owner checks fail them. The fee account's key is not in the repo or the page.
- A Solana wallet can authorise Intents Connect too (ed25519). Its NEAR-side id, the payload's signer and the MPC path, is the
  wallet's public key in hex; `walletPath()` derives it and the audit requires it, exactly like the lowercased address of an EVM wallet.
- The intermediary check pins the NEAR MPC root key and the proxy contract. If Aurora rotates them, the Connect rail stops and refuses
  rather than continuing, until the pin is updated.
- A signed pay link proves who signed it, not that this is the merchant you meant to pay: compare the address with the merchant.
- Unsigned links can be edited by anyone, and the page says so.
- The live checkout shares its web origin with other static apps from the same maker, so they share one localStorage. A script bug in
  any of them could rewrite the merchant's saved address; that is why a saved address needs a fresh confirmation. A separate origin for
  the checkout would remove this.
- Kamino is a third-party protocol. Settling into it carries smart-contract and liquidity risk until the merchant redeems.
- The checkout page trusts the browser's WebCrypto Ed25519 to verify signed links; older browsers show the link as
  "cannot verify" instead of "signed".

## Hosted 402 API (worker/)
`https://sluice-api.swiftbotlab.workers.dev` is the public pay-per-call endpoint: a Cloudflare Worker in front of one Durable Object
that keeps the order ledger in its own SQLite database. No port is open on any machine of ours.
- **No key that can move money.** The Worker's secrets are the Aurora integrator id (it can create quotes, not move funds) and the
  ed25519 key that signs receipts; that key's Solana address is never funded. The merchant is a public address in the config. If
  either secret is missing or the receipt key does not match its public half (checked by signing and verifying at start), every
  route answers 503 instead of running half-configured.
- **Delivery only after Solana.** Aurora's `SUCCESS` is a hint. The order settles only when a Solana signature from Aurora's
  destination list (sorted by `txRoles`, so an EVM refund hash is never looked up as a settlement) is a successful transaction, at
  `confirmed`, not older than the order (2 minutes of clock slack), that grows the merchant's USDC balance by at least the price
  (`verifyUsdc` from `docs/core.js`, the checkout's own rule).
- **One settlement, one order, one delivery.** `UNIQUE(deposit_address)` and `UNIQUE(settle_sig)` in the ledger; settling and
  delivering are conditional updates on the row's current state. One producer per order runs the paid work, and the stored body
  and receipt are written only over a settled row with no body yet, so concurrent or repeated collects get the same bytes and the
  same receipt. A failed report build answers 503 and keeps the order paid; the next call delivers.
- **The request is bound.** An order pays for one resource and one address (`request_hash`, byte-identical to the Python server's,
  tested across both languages); collecting another address with it answers 409.
- **Quotes are checked.** Aurora's quote must echo our recipient, refund address, assets, amount and EXACT_OUTPUT, carry at most
  30 bps of app fees and deliver exactly the price; the deposit address must have the expected format. Otherwise no order is stored.
- **Inputs.** JSON bodies only, at most 8 KB (checked by header and by bytes read), unknown fields refused, strict patterns for the
  address, order id, `pay_with` and tx hashes, refund addresses validated per chain family (`validRefund`). URL and query length are
  capped. Only the Swap rail with public quotes is accepted; `confidential: true` and the Connect rail are refused with a pointer to
  the self-hosted server.
- **Limits.** Per client (the `CF-Connecting-IP` address set by Cloudflare, or its IPv6 /64): 120 reads a minute (burst 40), 60
  status or collect calls (burst 20), 6 orders (burst 3), 10 quotes for a named asset (burst 4); 60 orders a minute in total; 5 unpaid orders per
  client and 50 in total. Buckets are LRU-bounded. Indicative quotes are cached for a minute per asset, the token list for ten.
  Limits live in the Durable Object's memory and reset if it restarts.
- **Upstream calls** go only to Aurora's API host and four named Solana RPCs over https, with `redirect: manual` (a redirect is an
  error), a timeout on every call and a 2 MB cap on every response body, counted while reading.
- **Logs** hold method, a path with addresses and order ids replaced by placeholders, status and duration, plus one line per poller
  pass. No bodies, headers, IP addresses or secrets. Responses carry `nosniff`, `no-store`, `no-referrer`; CORS is open
  because nothing is authenticated by cookies (an order id is the only bearer value, as on the reference server).
- **Health is checked, not assumed.** `/healthz` probes Aurora and a Solana RPC (cached a minute) and reports the background
  poller's failure streak; it answers 503 after five failed passes in a row, and the poller then backs off to once a minute.
- **Known limits.** Fifty unpaid orders from many addresses can fill the open-order cap until they expire (30 minutes after the
  quote deadline). The paid resource is a read of public Solana data, so a buyer gets nothing secret for the 0.20 USDC.
- Tests: `tests/js/worker.test.mjs` (real SQLite, real Ed25519, a real mainnet transaction) with positive controls; removing the
  Solana check, the UNIQUE settlement, the single producer, the quote echo check or the request binding each makes a test fail.

## Reporting
Open a GitHub issue without exploit details, or email swiftbotlabs@gmail.com.
