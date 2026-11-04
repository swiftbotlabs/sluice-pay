/* Sluice checkout: pay a Solana merchant in USDC from any chain via Aurora Intents (NEAR Intents).
 * Static page, no backend. Talks only to Aurora's APIs (quotes, status, Intents Connect) and public Solana RPCs.
 * The Aurora API key is a public, non-secret integrator id by design (docs.intents.aurora.dev, API Keys & Fees).
 * Money decisions live in core.js, which has its own test suite.
 */
'use strict';
(() => {
  if (window.top !== window.self) { document.documentElement.textContent = 'Open this checkout in its own tab.'; return; }
  const C = window.SluiceCore;
  const { CHAINS, KLEND, USDC_MINT, SOL_USDC, fromUnits, short } = C;
  const AURORA = 'https://intents-api.aurora.dev';
  const CONNECT = 'https://intents-connect-api.aurora.dev';
  const ONECLICK = 'https://1click.chaindefuser.com/v0'; // NEAR Intents' public API: an independent second opinion on Aurora's answers
  const API_KEY = '53042395-08f3-4382-a78e-b2208d0397c1'; // public integrator key for this page only; the server uses its own key
  // Keyless public RPCs with CORS. Each serves a different subset of methods, so calls are routed and fall through.
  // Checked from a browser origin on 2026-11-03: Helium's node returns full signature history; leo and vibe keep only recent
  // history and can answer with a short list and no error (so the merchant view proves completeness, see core.readHistory);
  // tatum refuses getSignaturesForAddress without a key and allows 5 calls a minute; api.mainnet-beta answers browsers 403.
  const RPC = { helium: 'https://solana-rpc.web.helium.io', tatum: 'https://solana-mainnet.gateway.tatum.io', leo: 'https://solana.leorpc.com/?api_key=FREE', vibe: 'https://public.rpc.solanavibestation.com' };
  const RPC_ORDER = { getSignaturesForAddress: [RPC.helium, RPC.leo, RPC.vibe], getTransaction: [RPC.helium, RPC.tatum, RPC.vibe, RPC.leo], default: [RPC.tatum, RPC.helium, RPC.vibe, RPC.leo] };
  const DEMO_LINK = 'p=eyJhbXQiOiIwLjUwIiwiZXhwIjoxODAwMDEzMzY3LCJrIjoiOWNZRnpybUhSY3NZekxoQVdzTmVtekN5NzVaaEVUbjJweDRNUzhvRERSZVIiLCJyZWYiOiJkZW1vLWludm9pY2UtMTA0MiIsInMiOiJlYXJuIiwidG8iOiI5Y1lGenJtSFJjc1l6TGhBV3NOZW16Q3k3NVpoRVRuMnB4NE1TOG9ERFJlUiIsInYiOjF9.XDSG4A7YmbS97B2hAIbGSnT3aJ3sOlasUS3qWgHLkXP8qTCp9P3Iqp71OrojPLT19vcn39eOTFU0IcZZ6b3PCQ';
  const EARN_TX = '558Qh7GUjopxDNUfzDib42h7CwtAhDfCvDBAAwCCAc9zNWHaayHaSq3GUuUtzN6SEWBZwr8CWsBaCvJfqFCThgrv'; // the first live settle-to-earn run
  const MERCHANT_DEMO = '9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR';
  const ROUTED = /^#(p=|to=|s=|c=|m=|a=|start)/;
  // Real mainnet runs: rows, checks and fee arithmetic live in proofs.js (shared with tools/snapshot_proofs.mjs).
  const PR = window.SluiceProofs; const PROOF = PR.PROOF;

  const $ = (id) => document.getElementById(id);
  const show = (el, on = true) => el.classList.toggle('hidden', !on);
  const text = (el, s) => { el.textContent = s; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0));
  const pretty = (raw) => { const v = fromUnits(raw, 6); const [i, f = ''] = v.split('.'); return i + '.' + f.padEnd(2, '0'); };
  const round = (raw, dec) => { const s = fromUnits(raw, dec); const [i, f = ''] = s.split('.'); return f.length > 6 ? `${i}.${f.slice(0, 6)}`.replace(/\.?0+$/, '') || '0' : s; };
  const base = () => location.origin + location.pathname;
  const humanize = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');
  const safeHash = (h) => typeof h === 'string' && /^[A-Za-z0-9_-]{20,130}$/.test(h);
  function link(href, label) { const a = document.createElement('a'); a.href = href; a.textContent = label; a.target = '_blank'; a.rel = 'noopener'; return a; }
  function txLink(chain, hash) { const c = CHAINS[chain]; return c && c.tx && safeHash(hash) ? link(c.tx + hash, short(hash)) : document.createTextNode(short(String(hash))); }
  function copy(btn, value) {
    const done = (ok) => { const old = btn.dataset.label || btn.textContent; btn.dataset.label = old; btn.textContent = ok ? 'Copied' : 'Press and hold to copy'; setTimeout(() => { btn.textContent = old; }, 1500); };
    (navigator.clipboard ? navigator.clipboard.writeText(value) : Promise.reject(new Error('no clipboard'))).then(() => done(true), () => done(false));
  }

  // ---------- network ----------
  async function aurora(path, body) {
    const url = `${AURORA}${path}/${API_KEY}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const signal = AbortSignal.timeout(20000); // Aurora can stall; a page must never wait on it forever
      const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal } : { signal });
      if (r.status === 429) { await sleep(Math.min(Number(r.headers.get('Retry-After')) || 2, 10) * 1000 + Math.random() * 500); continue; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || `HTTP ${r.status}`);
      return j;
    }
    throw new Error('rate limited, try again in a minute');
  }
  const swapStatus = (addr) => fetch(`${AURORA}/api/status/${API_KEY}?depositAddress=${encodeURIComponent(addr)}`, { signal: AbortSignal.timeout(25000) }).then((r) => r.json());
  async function cx(method, path, body, withKey) {
    const headers = { 'content-type': 'application/json' }; if (withKey) headers['x-api-key'] = API_KEY;
    const r = await fetch(CONNECT + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return j.result !== undefined ? j.result : j;
  }
  /** One call to one endpoint. Anything but a JSON-RPC result is an error, never an empty answer. */
  async function rpcAt(u, method, params) {
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(7000) });
    if (r.status === 429) throw new Error('RPC busy');
    const j = await r.json();
    if (j && j.error) throw new Error(String(j.error.message || 'RPC error'));
    if (!r.ok || !j || !('result' in j)) throw new Error(`RPC HTTP ${r.status}`);
    return j.result;
  }
  async function rpc(method, params) {
    let last; let sawNull = false;
    for (const u of RPC_ORDER[method] || RPC_ORDER.default) {
      try {
        const res = await rpcAt(u, method, params);
        if (res === null && method === 'getTransaction') { sawNull = true; continue; } // node may lag: ask the next one
        return res;
      } catch (e) { last = e; }
    }
    if (sawNull) return null;
    throw last;
  }
  const getTx = (sig) => rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  async function accountAmount(addr) {
    const r = await rpc('getAccountInfo', [addr, { encoding: 'base64', commitment: 'confirmed' }]);
    return r && r.value ? C.tokenAccountAmount(r.value.data[0]) : null;
  }

  // ---------- Solana verification (independent of the provider) ----------
  async function verifySig(sig, owner, minRaw, exact, notBefore) {
    const tx = await getTx(sig); const v = C.verifyUsdc(tx, owner, minRaw, exact, notBefore);
    return v ? { sig, delta: v.delta, slot: tx.slot } : null;
  }
  async function findCredit(owner, minRaw, notBefore, exact) {
    const acct = await C.ata(owner);
    const sigs = await rpc('getSignaturesForAddress', [acct, { limit: 15, commitment: 'confirmed' }]);
    for (const s of sigs || []) {
      if (s.err) continue;
      if (s.blockTime && s.blockTime < notBefore - 120) break;
      const v = await verifySig(s.signature, owner, minRaw, exact, notBefore);
      if (v) return v;
    }
    return null;
  }
  /** A reference is unknown until its payment lands, and public afterwards: anyone can then attach it to dust. So the real
   *  payment is the oldest transaction under it, and transactions are checked oldest first. */
  async function findByReference(ref, check) {
    const sigs = await rpc('getSignaturesForAddress', [ref, { limit: 1000, commitment: 'confirmed' }]);
    const clean = (sigs || []).filter((s) => !s.err).reverse().slice(0, 8);
    for (const s of clean) {
      const tx = await getTx(s.signature); const v = tx && C.referenceIn(tx, ref) && check(tx);
      if (v) return { sig: s.signature, tx, ...v };
    }
    return null;
  }
  /** Fresh quotes can take a moment to appear publicly. A quote that never appears, or differs, is refused. */
  async function checkPublic(expected) {
    let problems = ['could not reach NEAR Intents to cross-check this address'];
    for (let i = 0; i < 5; i++) {
      if (i) await sleep(1500);
      try {
        const st = await fetch(`${ONECLICK}/status?depositAddress=${encodeURIComponent(expected.depositAddress)}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
        problems = C.checkPublicQuote(st, expected);
        if (!problems.length) return;
      } catch { /* retried below */ }
    }
    throw new Error(`refusing this address: ${problems.join('; ')}`);
  }

  // ---------- pay links ----------
  async function parseLink() {
    const h = location.hash.slice(1);
    if (h.length > 2000) return null;
    if (h.startsWith('p=')) {
      const [m, s] = h.slice(2).split('.');
      const msgBytes = unb64u(m); const sig = unb64u(s || '');
      const f = JSON.parse(new TextDecoder().decode(msgBytes));
      let sigOk = false; // any decode/length problem = not valid
      let key = null;
      try { key = C.b58decode(f.k); } catch { key = null; }
      if (key && key.length === 32 && sig.length === 64) {
        try {
          const k = await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']);
          sigOk = await crypto.subtle.verify({ name: 'Ed25519' }, k, sig, msgBytes);
        } catch (e) { sigOk = (e && e.name === 'NotSupportedError') ? null : false; } // null = browser lacks Ed25519
      }
      return { to: f.to, amt: f.amt, ref: String(f.ref || '').slice(0, 40), exp: f.exp, signer: f.k, sigOk, signed: true, settle: f.s === 'earn' ? 'earn' : 'usdc', name: C.cleanName(f.n) };
    }
    if (h.startsWith('to=')) {
      const q = new URLSearchParams(h);
      return { to: q.get('to'), amt: q.get('amt'), ref: (q.get('ref') || '').slice(0, 40), signed: false, settle: q.get('s') === 'earn' ? 'earn' : 'usdc', name: C.cleanName(q.get('n') || '') };
    }
    return null;
  }

  // ---------- state ----------
  let tokens = []; let assets = []; let incidents = []; let invoice = null; let choice = null; let order = null;
  let wallet = null; let pollRun = 0; let qrPlain = false; let blocked = false; let sending = false;
  const wallets = new Map();
  const storeKey = () => 'sluice:' + location.hash; // the whole link: two invoices can never share an order
  const save = () => { try { localStorage.setItem(storeKey(), JSON.stringify(order)); } catch { /* private mode */ } };
  const load = () => { try { return JSON.parse(localStorage.getItem(storeKey()) || 'null'); } catch { return null; } };

  async function loadTokens() {
    // The public list decides what can be paid with and is usually first. Aurora's list and incidents get a few seconds:
    // the two lists have matched exactly, and each route is still quoted live, so a slow answer should not hold up the page.
    const within = (p, ms) => Promise.race([p.catch(() => null), sleep(ms).then(() => null)]);
    const [listed, feed, pub] = await Promise.all([
      within(aurora('/api/tokens'), 6000), within(aurora('/api/incidents'), 6000),
      fetch(`${ONECLICK}/tokens`, { signal: AbortSignal.timeout(12000) }).then((r) => r.json()).catch(() => null),
    ]);
    if (!Array.isArray(pub)) throw new Error('cannot cross-check routes with NEAR Intents right now');
    tokens = C.agreedTokens(listed && listed.tokens ? listed.tokens : pub, pub); // contract, decimals and price must agree with the public list
    incidents = (feed && feed.incidents) || []; // advisory: quotes still validate each route
    assets = C.listAssets(tokens, incidents);
  }
  const DIRECT = { blockchain: 'sol', symbol: 'USDC', assetId: SOL_USDC, decimals: 6, contractAddress: USDC_MINT, direct: true };
  const assetKey = (t) => `${t.blockchain}:${t.symbol}:${t.direct ? 'direct' : ''}`;

  function chip(t, pick = selectOrigin) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', 'false'); b.dataset.key = assetKey(t);
    const s = document.createElement('b'); s.textContent = t.symbol;
    const n = document.createElement('span'); n.textContent = t.direct ? 'Solana, direct' : CHAINS[t.blockchain].name;
    b.append(s, n); b.onclick = () => pick(t);
    return b;
  }
  function renderOrigins() {
    const pop = assets.filter(C.isPopular); const nets = new Set(assets.map((t) => t.blockchain)).size;
    text($('origin-count'), `${assets.length + 1} assets on ${nets} networks, live from Aurora. Pick what you hold.`);
    $('origins').replaceChildren(...pop.map((t) => chip(t)), chip(DIRECT));
    const rest = assets.length - pop.length;
    show($('btn-more'), rest > 0); text($('btn-more'), `More assets (${rest})`);
    renderSearch();
  }
  function renderSearch() {
    const q = $('asset-search').value; const hits = assets.filter((t) => !C.isPopular(t) && C.matchAsset(t, q));
    $('asset-results').replaceChildren(...hits.slice(0, 60).map((t) => chip(t)));
    markChoice();
  }
  /** After a pick the asset grid folds into one line, so the next step sits right under it on a phone. */
  function pickedView(on) {
    const name = choice ? (choice.direct ? 'USDC on Solana, direct' : `${choice.sym} on ${choice.net}`) : '';
    text($('picked-name'), name); show($('picked'), on && !!choice);
    for (const id of ['origins', 'origin-count']) show($(id), !on || !choice);
    if (on && choice) { show($('btn-more'), false); show($('more'), false); } else show($('btn-more'), assets.length - assets.filter(C.isPopular).length > 0);
  }
  function markChoice() {
    const k = choice ? assetKey(choice.token) : '';
    for (const el of document.querySelectorAll('.chip')) el.setAttribute('aria-checked', String(el.dataset.key === k));
  }

  let estTimer; let estRun = 0;
  function selectOrigin(t) {
    const ch = CHAINS[t.blockchain];
    choice = { chain: t.blockchain, sym: t.symbol, net: ch.name, fam: ch.fam, chainId: ch.id || null, token: t, memo: !!ch.memo, connect: !!ch.connect, direct: !!t.direct };
    markChoice(); text($('refund-chain'), ch.name); pickedView(true);
    $('refund').placeholder = ch.fam === 'evm' ? `0x… (your wallet on ${ch.name})` : `your ${ch.name} address`;
    show($('quote-error'), false);
    syncForm();
    clearTimeout(estTimer);
    text($('estimate'), 'Getting a live quote…');
    estTimer = setTimeout(estimate, 300);
  }

  /** Which rail this payment takes. Settling into yield needs a wallet signature; everything else can pay by address. */
  function rail() {
    if (!choice) return null;
    if (choice.direct) return 'direct';
    if (invoice.settle === 'earn' && wallet && choice.fam === 'evm' && choice.connect && choice.chainId) return 'connect';
    return 'swap';
  }
  const refundValue = () => (wallet && choice && choice.fam === 'evm' ? wallet.address : $('refund').value.trim());
  function syncForm() {
    const r = rail(); const auto = !!(wallet && choice && choice.fam === 'evm');
    show($('refund-field'), !!choice && !auto && r !== 'direct');
    show($('refund-auto'), !!choice && auto && r !== 'connect');
    if (auto) text($('refund-auto'), `If anything goes wrong, funds come back to your connected wallet ${short(wallet.address)}.`);
    show($('btn-sol-refund'), !!(choice && choice.fam === 'sol' && !choice.direct && window.phantom && window.phantom.solana));
    show($('private-row'), r === 'swap' || r === null);
    if (r !== 'swap') $('confidential').checked = false;
    const btn = $('btn-quote');
    text(btn, r === 'direct' ? 'Show payment QR' : r === 'connect' ? 'Pay with one signature' : auto && choice.chainId ? 'Pay with wallet' : 'Get deposit address');
    btn.disabled = blocked || !choice || (r !== 'direct' && !C.validRefund(choice.fam, refundValue()));
    text($('pay-why'), blocked ? 'Payments are paused while Aurora reports an incident.' : !choice ? 'Pick what you pay with.' : btn.disabled ? `Add your refund address on ${choice.net} to continue.` : '');
  }

  /** Dry quotes move nothing but need a refund target. A same-chain sample keeps the route's real minimum in the quote;
   *  chains with no sample here are priced with an Intents refund so they can still show a price before an address is typed. */
  function previewRefund() {
    const typed = refundValue();
    if (C.validRefund(choice.fam, typed)) return { to: typed, type: 'ORIGIN_CHAIN' };
    const sample = { evm: '0x' + C.toHex(rnd(20)), sol: C.b58encode(rnd(32)), btc: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', tron: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7' }[choice.fam];
    return sample ? { to: sample, type: 'ORIGIN_CHAIN' } : { to: 'sluice-preview.near', type: 'INTENTS' };
  }
  function quoteBody(dry, refund, amountRaw, confidential) {
    return {
      dry, swapType: 'EXACT_OUTPUT', depositType: 'ORIGIN_CHAIN', depositMode: choice.memo ? 'MEMO' : 'SIMPLE', originAsset: choice.token.assetId,
      destinationAsset: SOL_USDC, amount: amountRaw.toString(), slippageTolerance: 100,
      refundTo: refund.to, refundType: refund.type, recipient: invoice.to, recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 15 * 60 * 1000).toISOString(), confidentiality: confidential ? 'advanced' : 'public', quoteWaitingTimeMs: 0,
    };
  }

  async function estimate() {
    const c = choice; const run = ++estRun; const el = $('estimate');
    const live = () => choice === c && run === estRun;
    try {
      if (c.direct) { text(el, `Exactly ${pretty(invoice.raw)} USDC, straight to the merchant. No routing fee.`); return; }
      if (rail() === 'connect') {
        const p = await connectPlan(true);
        if (!live()) return;
        const fee = BigInt(p.x.details.networkFee || 0);
        text(el, `≈ ${round(p.x.quote.amountIn, c.token.decimals)} ${c.sym} on ${c.net}. Includes ${round(fee, 6)} USDC network fee${p.exists ? '' : ', with a one-time account for this merchant'}. ~${p.x.details.estimatedTime || 40}s.`);
      } else {
        const q = await aurora('/api/quote', quoteBody(true, previewRefund(), invoice.raw, false));
        if (!live()) return;
        const earnNote = invoice.settle === 'earn' ? ' Paying without a connected EVM wallet settles as plain USDC.' : '';
        text(el, `≈ ${round(q.quote.amountIn, c.token.decimals)} ${c.sym} on ${c.net} (~$${Number(q.quote.amountInUsd).toFixed(2)}, routing fees included). Typical time ~${q.quote.timeEstimate}s.${earnNote}`);
      }
      const bal = await walletBalance(c);
      if (live() && bal !== null) el.append(` You hold ${round(bal, c.token.decimals)} ${c.sym}.`);
    } catch (e) { if (live()) text(el, routeError(e)); }
  }
  async function walletBalance(c) {
    if (!wallet || wallet.chainId !== c.chainId) return null;
    try {
      const data = '0x70a08231' + wallet.address.slice(2).toLowerCase().padStart(64, '0');
      const hex = c.token.contractAddress
        ? await wallet.provider.request({ method: 'eth_call', params: [{ to: c.token.contractAddress, data }, 'latest'] })
        : await wallet.provider.request({ method: 'eth_getBalance', params: [wallet.address, 'latest'] });
      return BigInt(hex);
    } catch { return null; }
  }
  function routeError(e) {
    const m = /try at least (\d+)/.exec(e.message || '');
    if (m) return `This route needs an invoice of at least ${fromUnits(m[1], 6)} USDC. Pick another asset or ask for a larger invoice.`;
    if (/Failed to get quote|Internal server error/.test(e.message || '')) return 'The route declined this request. Check your refund address, or pick another asset.';
    return 'No route right now: ' + e.message;
  }

  async function submitPay() {
    show($('quote-error'), false);
    const r = rail();
    if (r === 'direct') return startDirect();
    if (r === 'connect') return payConnect();
    return getAddress();
  }

  async function getAddress() {
    const refundTo = refundValue();
    const confidential = $('confidential').checked;
    const btn = $('btn-quote'); const label = btn.textContent;
    btn.disabled = true; text(btn, 'Requesting…');
    try {
      // Private payments hide provider tx hashes, so we tag the amount with a few micro-USDC to find it on Solana.
      const raw = confidential ? invoice.raw + BigInt(1 + (rnd(2)[0] * 256 + rnd(1)[0]) % 998) : invoice.raw;
      const q = await aurora('/api/quote', quoteBody(false, { to: refundTo, type: 'ORIGIN_CHAIN' }, raw, confidential));
      const r = q.quoteRequest || {};
      if (r.recipient !== invoice.to || r.refundTo !== refundTo || r.amount !== raw.toString() || r.destinationAsset !== SOL_USDC || r.originAsset !== choice.token.assetId || r.swapType !== 'EXACT_OUTPUT') throw new Error('quote did not match the invoice; not showing it');
      if (!C.isDepositAddr(q.quote.depositAddress) || (choice.fam === 'evm' && !C.isEvmAddr(q.quote.depositAddress))) throw new Error('unexpected deposit address format');
      if (choice.memo && !q.quote.depositMemo) throw new Error('this route needs a memo and none was returned; not showing it');
      if (!C.amountSane(q.quote.amountIn, choice.token, raw, 300000n)) throw new Error('the amount asked is far above this invoice; not showing it');
      // Everything above compares Aurora with Aurora. NEAR Intents' public record must agree too. Private quotes are not public.
      if (!confidential) await checkPublic({ depositAddress: q.quote.depositAddress, recipient: invoice.to, originAsset: choice.token.assetId, refundTo, amountIn: q.quote.amountIn, amount: raw.toString(), memo: q.quote.depositMemo });
      order = { rail: 'swap', to: invoice.to, createdAt: Math.floor(Date.now() / 1000), chain: choice.chain, sym: choice.sym, net: choice.net, chainId: choice.chainId, fam: choice.fam,
        token: { assetId: choice.token.assetId, decimals: choice.token.decimals, contract: choice.token.contractAddress || null },
        refundTo, confidential, raw: raw.toString(), quote: q.quote, deadline: r.deadline };
      save(); renderDeposit(); pollSwap();
      if (wallet && order.fam === 'evm' && order.chainId) payWithWallet();
    } catch (e) {
      text($('quote-error'), routeError(e)); show($('quote-error'));
    } finally { text(btn, label); syncForm(); }
  }

  function renderQr() {
    const o = order; const q = o.quote;
    const amount = o.topup ? BigInt(o.topup) : BigInt(q.amountIn);
    const uri = o.uri || C.paymentUri({ chain: o.chain, address: q.depositAddress, raw: amount, decimals: o.token.decimals, contract: o.token.contract, memo: q.depositMemo });
    const value = qrPlain ? q.depositAddress : uri; const hasAmount = uri !== q.depositAddress;
    const qr = qrcode(0, 'M'); qr.addData(value); qr.make();
    const img = new Image(); img.src = qr.createDataURL(5, 8); img.alt = 'QR: ' + value;
    $('qr').replaceChildren(img);
    text($('qr-caption'), `${o.sym} on ${o.net} only${hasAmount && !qrPlain ? ', amount filled in' : ''}`);
    show($('btn-qr-mode'), hasAmount && !o.uri); text($('btn-qr-mode'), qrPlain ? 'Show payment QR' : 'Wallet cannot read it? Show address only');
    const app = $('btn-open-app'); const coarse = matchMedia('(pointer: coarse)').matches;
    show(app, hasAmount && coarse); app.href = uri;
  }
  function renderDeposit() {
    const o = order; const q = o.quote;
    show($('step-choose'), false); show($('step-sign'), false); show($('step-deposit')); show($('timeline'));
    text($('d-chain'), o.net); text($('d-asset'), o.sym);
    if (!$('d-left').textContent) show($('d-left-row'), false);
    text($('d-amount'), `${q.amountInFormatted || fromUnits(q.amountIn, o.token.decimals)} ${o.sym}`);
    text($('d-address'), q.depositAddress);
    show($('d-memo-row'), !!q.depositMemo); text($('d-memo'), q.depositMemo || '');
    const amt = q.amountInFormatted || fromUnits(q.amountIn, o.token.decimals);
    const until = o.deadline ? new Date(o.deadline).toLocaleTimeString() : null;
    const over = o.deadline && !o.depositTx && Date.now() > new Date(o.deadline).getTime();
    text($('d-req'), `Send only ${o.sym} from the ${o.net} network to this address, exactly ${amt} ${o.sym}${until ? `, before ${until}` : ''}. ${q.depositMemo ? 'Include the memo, or the deposit cannot be matched. ' : ''}Sending another asset or using another network may result in permanent loss of funds.`);
    const facts = o.rail === 'direct' ? [
      `Merchant receives exactly ${fromUnits(o.raw, 6)} USDC`, 'Use the QR: it carries the reference this page uses to find your payment',
    ] : [
      o.settle === 'earn' ? `Merchant receives ${fromUnits(o.raw, 6)} USDC worth of cUSDC, supplied to Kamino` : `Merchant receives exactly ${fromUnits(o.raw, 6)} USDC on Solana`,
      o.rail === 'connect' ? 'If the route fails, the funds stay recoverable in your own Solana account' : `Less than ${fromUnits(q.minAmountIn, o.token.decimals)} ${o.sym} is refunded to ${short(o.refundTo)} after the deadline`,
      o.rail === 'connect' ? 'Send from the same wallet that signed' : 'Anything above the quoted amount is refunded after settlement',
      q.withdrawFee ? `Routing and network fees are already included (Solana delivery fee ${fromUnits(q.withdrawFee, 6)} USDC)` : 'Routing and network fees are already included',
      o.confidential ? 'Private payment: your source wallet is not published with the Solana payment' : `Typical time ~${q.timeEstimate || 40}s after your deposit confirms`,
    ];
    $('d-facts').replaceChildren(...facts.map((f) => { const li = document.createElement('li'); li.textContent = f; return li; }));
    renderQr();
    if (over) { // never leave an expired address looking payable
      $('qr').replaceChildren(); text($('qr-caption'), ''); show($('btn-qr-mode'), false); text($('d-address'), 'expired');
      text($('d-req'), 'This deposit address has expired. Do not send to it. Reload the link for a new one.');
    }
    const sent = o.depositTx && !o.topup;
    const canWallet = !sent && !over && o.fam === 'evm' && o.chainId && (wallet || wallets.size || window.ethereum) && (!o.deadline || Date.now() < new Date(o.deadline).getTime());
    show($('btn-wallet'), !!canWallet);
    text($('wallet-note'), sent ? `Sent: ${short(o.depositTx)}` : canWallet ? '' : `Send from any wallet or exchange that supports ${o.net}.`);
  }

  // ---------- wallets ----------
  function discoverWallets() {
    window.addEventListener('eip6963:announceProvider', (e) => {
      const d = e.detail || {};
      if (d.info && d.info.uuid && d.provider && typeof d.provider.request === 'function') wallets.set(d.info.uuid, { name: String(d.info.name || 'Wallet').slice(0, 40), provider: d.provider });
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  }
  async function connectWith(entry) {
    try {
      const [address] = await entry.provider.request({ method: 'eth_requestAccounts' });
      if (!C.isEvmAddr(address)) throw new Error('wallet returned no EVM address');
      const chainId = parseInt(await entry.provider.request({ method: 'eth_chainId' }), 16);
      wallet = { ...entry, address, chainId };
      if (entry.provider.on) {
        entry.provider.on('accountsChanged', (a) => { if (a && C.isEvmAddr(a[0])) { wallet.address = a[0]; onWallet(); } else dropWallet(); });
        entry.provider.on('chainChanged', (h) => { if (wallet) { wallet.chainId = parseInt(h, 16); onWallet(); } });
      }
      onWallet();
      if (!choice) preselect();
    } catch (e) { text($('wallet-hint'), 'Wallet: ' + (e.message || e)); }
  }
  function dropWallet() { wallet = null; onWallet(); }
  function onWallet() {
    show($('wallet-off'), !wallet); show($('wallet-on'), !!wallet);
    if (wallet) { text($('wallet-name'), wallet.name); text($('wallet-addr'), short(wallet.address)); }
    syncForm();
    if (choice) estimate();
  }
  function preselect() {
    const net = Object.keys(CHAINS).find((k) => CHAINS[k].id === wallet.chainId);
    const here = assets.find((t) => t.blockchain === net && /^USDC/.test(t.symbol)) || assets.find((t) => t.blockchain === net);
    if (here) selectOrigin(here);
  }
  function startConnect() {
    const list = [...wallets.values()];
    if (!list.length && window.ethereum) list.push({ name: 'Browser wallet', provider: window.ethereum });
    if (list.length === 1) return connectWith(list[0]);
    if (list.length > 1) {
      const box = $('wallet-list');
      box.replaceChildren(...list.map((w) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost wide'; b.textContent = w.name; b.onclick = () => connectWith(w); return b; }));
      show(box); return undefined;
    }
    text($('wallet-hint'), 'No browser wallet found here. Pick an asset below and pay by address or QR from any wallet.');
    show($('open-in'), matchMedia('(pointer: coarse)').matches);
    return undefined;
  }
  function setOpenIn() {
    const here = location.host + location.pathname + location.hash;
    $('open-mm').href = `https://metamask.app.link/dapp/${here}`;
    $('open-ph').href = `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`;
    $('open-cb').href = `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(location.href)}`;
  }
  async function ensureWallet() {
    if (wallet) return wallet;
    startConnect();
    for (let i = 0; i < 300 && !wallet; i++) await sleep(200);
    if (!wallet) throw new Error('connect a wallet first');
    return wallet;
  }
  async function sendFromWallet(o) {
    const q = o.quote; const w = await ensureWallet(); const eth = w.provider;
    if (o.deadline && Date.now() > new Date(o.deadline).getTime()) throw new Error('this deposit address has expired; get a new one');
    if (!C.isEvmAddr(q.depositAddress)) throw new Error('unexpected deposit address');
    const want = '0x' + o.chainId.toString(16);
    try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] }); } catch (e) {
      if (e && e.code === 4902) throw new Error(`add ${o.net} to your wallet, then try again`);
      throw e;
    }
    const got = parseInt(await eth.request({ method: 'eth_chainId' }), 16);
    if (got !== o.chainId) throw new Error(`wallet is on chain ${got}, expected ${o.net}`);
    w.chainId = got;
    const amt = o.topup ? BigInt(o.topup) : BigInt(q.amountIn);
    const c = o.token.contract;
    if (c && !C.isEvmAddr(c)) throw new Error('unexpected token contract');
    const tx = c
      ? { from: w.address, to: c, data: '0xa9059cbb' + q.depositAddress.slice(2).toLowerCase().padStart(64, '0') + amt.toString(16).padStart(64, '0') }
      : { from: w.address, to: q.depositAddress, value: '0x' + amt.toString(16) };
    return eth.request({ method: 'eth_sendTransaction', params: [tx] });
  }
  async function payWithWallet() {
    const note = $('wallet-note');
    if (sending) return;
    if (order.depositTx && !order.topup) { text(note, `Already sent: ${short(order.depositTx)}`); return; }
    sending = true; $('btn-wallet').disabled = true;
    try {
      text(note, 'Confirm in your wallet…');
      const h = await sendFromWallet(order);
      order.depositTx = h; order.topup = null; save(); show($('btn-wallet'), false);
      text(note, 'Sent: ' + short(h));
      if (!order.confidential) aurora('/api/deposit/submit', { txHash: h, depositAddress: order.quote.depositAddress }).catch(() => {});
    } catch (e) { text(note, 'Wallet: ' + (e.message || e)); } finally { sending = false; $('btn-wallet').disabled = false; }
  }

  // ---------- one-signature rail: Intents Connect runs the Solana steps after the bridge lands ----------
  /** Computed locally from the wallet address; an API answer that differs is refused. */
  async function ownIntermediary(address) {
    const inter = C.deriveIntermediary(address);
    if ((await cx('GET', `/api/v1/executions/${address}/intermediary`)).solana !== inter) throw new Error('the Solana account offered is not the one this wallet controls');
    return inter;
  }
  async function connectPlan(dry, orderId) {
    const w = wallet; const c = choice; const price = invoice.raw; const earn = invoice.settle === 'earn';
    const inter = await ownIntermediary(w.address);
    const oid = orderId || 'ord_' + C.b58encode(rnd(12));
    const dst = await C.ata(invoice.to, earn ? KLEND.cusdc : USDC_MINT);
    const exists = (await accountAmount(dst)) !== null;
    const a = { intermediary: inter, merchant: invoice.to, orderId: oid, price: price.toString(), createAta: !exists };
    const steps = earn ? await C.earnSteps(a) : await C.paySteps(a);
    const body = { version: '1.0', type: 'solana', dry,
      quote: { originAsset: c.token.assetId, destinationAsset: SOL_USDC, amount: (price + 2000n).toString(), swapType: 'EXACT_OUTPUT', slippageTolerance: 100, deadline: new Date(Date.now() + 18 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z') },
      steps, metadata: { title: `Sluice ${oid}`, intent: earn ? 'sluice_settle_to_earn' : 'sluice_pay_with_reference' } };
    const x = await cx('POST', `/api/v1/executions/${w.address}`, body, true);
    return { x, inter, oid, dst, exists, earn };
  }
  const execRows = (r) => (Array.isArray(r) ? r : (r && (r.executions || r.items || r.data)) || [r]);
  /** Has anything reached this deposit address, by any record we can read? Unknown counts as yes. */
  async function depositUntouched(e) {
    const dep = (e.quote || {}).depositAddress; const token = tokens.find((t) => t.assetId === (e.quote || {}).originAsset);
    if (!C.isEvmAddr(dep) || !token) return false;
    const mine = load(); if (mine && mine.exec && mine.exec.id === e.id && mine.depositTx) return false;
    const st = await swapStatus(dep).catch(() => null);
    if (!st || st.status !== 'PENDING_DEPOSIT') return false;
    const chainId = (CHAINS[token.blockchain] || {}).id;
    if (!chainId || wallet.chainId !== chainId) return false;
    // A transfer can be on-chain before it is indexed, so ask the chain as well.
    const data = '0x70a08231' + dep.slice(2).toLowerCase().padStart(64, '0');
    const hex = token.contractAddress
      ? await wallet.provider.request({ method: 'eth_call', params: [{ to: token.contractAddress, data }, 'latest'] })
      : await wallet.provider.request({ method: 'eth_getBalance', params: [dep, 'latest'] });
    return BigInt(hex) === 0n;
  }
  /** Only one execution per wallet can be open. An abandoned attempt is cleared with one explicit signature,
   *  and only when nothing was deposited: checked before the wallet prompt and again after it. */
  async function clearOpenExecution() {
    const w = wallet; const list = await cx('GET', `/api/v1/executions/${w.address}`);
    const open = execRows(list).find((e) => e && e.id && (e.status === 'CREATED' || e.status === 'DEPOSIT_PENDING'));
    const busy = new Error('a previous payment from this wallet is still running; wait for it to finish');
    const clear = async (e) => e.status === 'CREATED' || depositUntouched(e).catch(() => false);
    if (!open || !(await clear(open))) throw busy;
    text($('sign-state'), 'Clearing your earlier unfinished attempt: confirm in your wallet');
    const msg = `delete_execution:${open.id}`;
    const sig = await w.provider.request({ method: 'personal_sign', params: ['0x' + C.toHex(C.utf8(msg)), w.address] });
    if (!(await clear(open))) throw busy;
    await cx('DELETE', `/api/v1/executions/${w.address}/${open.id}`, { signature: C.secpWire(sig) });
  }
  /** The one place an Intents Connect signature is requested: nothing reaches the wallet until the audit passes. */
  async function auditAndSign(x, { inter, oid, dst, earn, youSend }) {
    const w = wallet; const d = x.details || {};
    const payload = (d.payload || {}).payload_json;
    if (d.signingStandard && d.signingStandard !== 'erc191') throw new Error('unexpected signing standard');
    const fee = BigInt(d.networkFee || 0);
    const maxFee = (() => { const m = fee + fee / 5n + 2000n; return m > 300000n ? 300000n : m; })();
    const ref = await C.referenceKey(oid); const src = await C.ata(inter);
    const audit = C.auditPayload(payload, { payer: w.address, intermediary: inter, merchant: invoice.to, price: invoice.raw, settle: earn ? 'earn' : 'usdc', src, dst, ref, maxFee });
    const facts = [
      earn ? `${pretty(invoice.raw)} USDC is supplied to Kamino and the cUSDC goes to ${short(invoice.to)}, not to you` : `${pretty(invoice.raw)} USDC goes to ${short(invoice.to)}`,
      `This order's reference ${short(ref)} is attached, so the payment can be found on Solana`,
      `Network fee ${round(audit.fee, 6)} USDC${audit.createsAccount ? ', including a one-time account for this merchant' : ''}`,
      youSend,
    ];
    $('sign-facts').replaceChildren(...facts.map((f) => { const li = document.createElement('li'); li.textContent = f; return li; }));
    text($('sign-state'), 'Sign in your wallet (no gas)');
    const sig = await w.provider.request({ method: 'personal_sign', params: ['0x' + C.toHex(C.utf8(payload)), w.address] });
    await cx('POST', `/api/v1/executions/${w.address}/submit`, { signature: C.secpWire(sig), executionId: x.id });
    return ref;
  }
  /** The bridge landed but the Solana step did not run: the money is in the payer's own Solana account. Run the same
   *  steps again, with the same order reference, so a payment can never be made twice. */
  async function retryConnect() {
    const o = order; const box = $('result'); const state = $('sign-state');
    show(box, false); show($('step-sign')); show($('sign-error'), false); text(state, 'Checking Solana first…');
    try {
      const dstNow = await C.ata(invoice.to, o.settle === 'earn' ? KLEND.cusdc : USDC_MINT);
      const paid = await findByReference(o.exec.ref, (tx) => (o.settle === 'earn' ? C.verifyEarn(tx, invoice.to, o.raw, { dst: dstNow, ref: o.exec.ref, notBefore: o.createdAt }) : C.verifyUsdc(tx, invoice.to, o.raw, false, o.createdAt)));
      if (paid) return finish('ok', null, paid);
      if (!wallet) { const first = [...wallets.values()][0] || (window.ethereum && { name: 'Browser wallet', provider: window.ethereum }); if (first) await connectWith(first); }
      if (!wallet) throw new Error('connect the wallet that signed this payment');
      if (wallet.address.toLowerCase() !== o.exec.wallet.toLowerCase()) throw new Error(`connect the wallet that signed this payment (${short(o.exec.wallet)})`);
      const earn = o.settle === 'earn';
      const inter = await ownIntermediary(wallet.address);
      const dst = dstNow;
      const a = { intermediary: inter, merchant: invoice.to, orderId: o.exec.oid, price: o.raw, createAta: (await accountAmount(dst)) === null };
      const steps = earn ? await C.earnSteps(a) : await C.paySteps(a);
      const x = await cx('POST', `/api/v1/executions/${wallet.address}/steps`, { version: '1.0', type: 'solana', destinationAsset: SOL_USDC, steps, dry: false,
        metadata: { title: `Sluice ${o.exec.oid} retry`, intent: earn ? 'sluice_settle_to_earn' : 'sluice_pay_with_reference' } }, true);
      await auditAndSign(x, { inter, oid: o.exec.oid, dst, earn, youSend: 'Nothing new leaves your wallet: this uses the funds already in your Solana account' });
      o.exec.id = x.id; save();
      text(state, 'Sent. Nothing else to do.'); setStep('ROUTE');
      pollConnect();
    } catch (e) {
      text(state, ''); text($('sign-error'), String(e.message || e)); show($('sign-error')); show(box);
    }
    return undefined;
  }
  async function payConnect() {
    const w = wallet; const c = choice;
    show($('step-choose'), false); show($('step-sign')); show($('timeline')); show($('sign-error'), false);
    text($('tl-await'), 'Waiting for your signature and deposit');
    if (invoice.settle === 'earn') text($('tl-solana'), 'Verified on Solana (merchant\'s Kamino position checked directly)');
    setStep('AWAIT');
    const state = $('sign-state'); text(state, 'Preparing the transaction…');
    try {
      // Lower bound from the dry preview (it overstates the fee): no execution is opened for a wallet that clearly cannot pay.
      const held0 = await walletBalance(c);
      if (held0 !== null) {
        const dry = await connectPlan(true); const need = (BigInt(dry.x.quote.amountIn) * 9n) / 10n;
        if (held0 < need) throw new Error(`this payment needs about ${round(dry.x.quote.amountIn, c.token.decimals)} ${c.sym}, your wallet holds ${round(held0, c.token.decimals)}. Pick another asset or top up first.`);
      }
      let plan;
      try { plan = await connectPlan(false); } catch (e) {
        if (e.status !== 409) throw e;
        await clearOpenExecution(); plan = await connectPlan(false);
      }
      const { x, inter, oid, dst, earn } = plan;
      const q = x.quote;
      const held = await walletBalance(c);
      if (held !== null && held < BigInt(q.amountIn)) throw new Error(`this payment needs ${round(q.amountIn, c.token.decimals)} ${c.sym}, your wallet holds ${round(held, c.token.decimals)}. Pick another asset or top up first.`);
      if (q.recipient !== inter || q.destinationAsset !== SOL_USDC || q.originAsset !== c.token.assetId) throw new Error('quote did not match this payment');
      if (!C.isEvmAddr(q.depositAddress)) throw new Error('unexpected deposit address');
      if (!C.amountSane(q.amountIn, c.token, invoice.raw, 300000n)) throw new Error('the amount asked is far above this invoice');
      await checkPublic({ depositAddress: q.depositAddress, recipient: inter, originAsset: c.token.assetId, refundTo: w.address, amountIn: q.amountIn });
      const ref = await auditAndSign(x, { inter, oid, dst, earn, youSend: `You send ${round(q.amountIn, c.token.decimals)} ${c.sym} on ${c.net}` });
      order = { rail: 'connect', to: invoice.to, settle: earn ? 'earn' : 'usdc', createdAt: Math.floor(Date.now() / 1000), chain: c.chain, sym: c.sym, net: c.net, chainId: c.chainId, fam: c.fam,
        token: { assetId: c.token.assetId, decimals: c.token.decimals, contract: c.token.contractAddress || null },
        raw: invoice.raw.toString(), quote: q, deadline: q.deadline, exec: { id: x.id, wallet: w.address, ref, oid } };
      save();
      text(state, 'Now confirm the transfer in your wallet');
      pollConnect();
      let h;
      try { h = await sendFromWallet(order); } catch (e) {
        renderDeposit(); show($('step-sign')); text(state, '');
        text($('sign-error'), `The signature is in place, but the transfer did not go out (${e.message || e}). Send it below before the deadline, from this wallet.`); show($('sign-error'));
        return;
      }
      order.depositTx = h; save();
      text(state, 'Sent. Nothing else to do.');
      cx('POST', '/api/v1/executions/deposit/submit', { txHash: h, depositAddress: q.depositAddress }).catch(() => {});
    } catch (e) {
      text(state, ''); show($('step-sign'), false); show($('timeline'), false); show($('step-choose'));
      const m = String(e.message || e);
      text($('quote-error'), /try at least/.test(m) ? routeError(e) : m.charAt(0).toUpperCase() + m.slice(1)); show($('quote-error'));
      syncForm();
    }
  }

  function setStep(k, state) {
    const steps = ['AWAIT', 'SEEN', 'ROUTE', 'SOLANA'];
    const idx = steps.indexOf(k);
    for (const li of $('timeline').children) {
      const i = steps.indexOf(li.dataset.k);
      li.className = i < idx ? 'done' : i === idx ? (state || 'active') : '';
    }
  }

  function finish(kind, s, proof) {
    pollRun++; save();
    setLeft('');
    if (kind === 'ok' || kind === 'refund') { show($('step-deposit'), false); show($('step-sign'), false); }
    show($('topup'), false);
    const o = order; const box = $('result'); box.replaceChildren(); box.className = 'result ' + kind; show(box);
    const h = document.createElement('h3'); const p = document.createElement('p'); const ul = document.createElement('ul');
    const d = (s && s.swapDetails) || {};
    const add = (...nodes) => { const li = document.createElement('li'); li.append(...nodes); ul.append(li); };
    let retry = null;
    if (kind === 'ok') {
      setStep('SOLANA', 'done');
      if (proof.shares !== undefined) {
        h.textContent = 'Paid. Now earning in Kamino.';
        p.textContent = `${fromUnits(proof.supplied, 6)} USDC was supplied to Kamino and ${short(invoice.to)} received ${fromUnits(proof.shares, 6)} cUSDC. Read directly from Solana.`;
      } else {
        h.textContent = 'Paid. Verified on Solana.';
        p.textContent = `${short(invoice.to)} received ${fromUnits(proof.delta, 6)} USDC. We read this directly from Solana, not from the payment provider.`;
      }
      add('Solana settlement: ', txLink('sol', proof.sig));
    } else if (kind === 'refund') {
      h.textContent = 'Refunded. Nothing was charged.';
      p.textContent = `${d.refundedAmountFormatted || 'Your deposit'} ${o.sym} went back${o.refundTo ? ' to ' + short(o.refundTo) : ''}${d.refundReason ? ` (${humanize(d.refundReason)})` : ''}.`;
    } else if (kind === 'expired') {
      h.textContent = 'Expired. Nothing was sent.'; p.textContent = 'Reload to get a new deposit address.';
    } else if (o.rail === 'connect') {
      h.textContent = 'The Solana step did not run';
      p.textContent = 'Your funds are in your own Solana account, controlled by the wallet that signed. Nothing reached the merchant. You can run the Solana step again.';
      retry = document.createElement('button'); retry.type = 'button'; retry.className = 'primary'; retry.textContent = 'Try the Solana step again'; retry.onclick = retryConnect;
    } else {
      h.textContent = 'Payment failed'; p.textContent = 'If funds left your wallet, they are returned to your refund address.';
    }
    const roles = C.txRoles(d);
    if (kind === 'ok' && roles.refunded) p.append(` You sent more than needed: ${d.refundedAmountFormatted} ${o.sym} went back${o.refundTo ? ' to ' + short(o.refundTo) : ''}.`);
    if (roles.deposit) add(`${o.net} tx: `, txLink(o.chain, roles.deposit));
    else if (o.depositTx) add(`${o.net} tx: `, txLink(o.chain, o.depositTx));
    for (const h of roles.topups) add(`${o.net} tx: `, txLink(o.chain, h));
    for (const h of roles.refunds) add('Refund tx: ', txLink(o.chain, h));
    const receipt = o.rail === 'connect' ? `#c=${o.exec.ref}.${invoice.to}` : o.rail === 'swap' && !o.confidential ? `#s=${o.quote.depositAddress}` : null;
    if (receipt) add(Object.assign(document.createElement('a'), { href: base() + receipt, textContent: 'Open the shareable payment record' }));
    box.append(h, p, ul);
    if (retry) box.append(retry);
  }

  /** The countdown sits next to the amount too, so a payer on a phone sees it without scrolling to the timeline. */
  function setLeft(msg) { text($('countdown'), msg); const el = $('d-left'); if (el) { text(el, msg || '—'); show($('d-left-row'), !!msg); } }
  async function pollSwap() {
    const run = ++pollRun; let solTries = 0; const o = order;
    while (run === pollRun) {
      const left = Math.max(0, Math.floor((new Date(o.deadline) - Date.now()) / 1000));
      setLeft(left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : 'deadline passed');
      try {
        const s = await swapStatus(o.quote.depositAddress);
        const st = s.status; const g = C.stage(st);
        if (g.end) return finish(g.end, s);
        setStep(g.step, g.tone);
        if (st === 'PENDING_DEPOSIT' && !left && Date.now() - new Date(o.deadline) > 10 * 60 * 1000) return finish('expired', s);
        if (st === 'INCOMPLETE_DEPOSIT') showTopup(s);
        if (st === 'SUCCESS') {
          show($('topup'), false);
          const raw = BigInt(o.raw); let proof = null;
          for (const sig of C.txRoles(s.swapDetails).solana) { proof = await verifySig(sig, invoice.to, raw, false, o.createdAt).catch(() => null); if (proof) break; }
          if (!proof) proof = await findCredit(invoice.to, raw, o.createdAt, o.confidential);
          if (proof) return finish('ok', s, proof);
          if (++solTries > 20) text($('countdown'), 'provider reports success; Solana credit not visible yet');
        }
      } catch (e) { text($('countdown'), 'reconnecting…'); }
      await sleep(6000);
    }
    return undefined;
  }
  /** A short deposit can still be completed: show exactly what is missing, instead of waiting for the refund. */
  function showTopup(s) {
    const o = order; const d = s.swapDetails || {}; const q = o.quote;
    const need = C.shortfall(q.amountIn, d.depositedAmount);
    if (need <= 0n) return;
    const left = fromUnits(need, o.token.decimals);
    const el = $('topup'); show(el);
    text(el, `Only ${d.depositedAmountFormatted || fromUnits(d.depositedAmount, o.token.decimals)} ${o.sym} arrived. Send ${left} ${o.sym} more to the same address before the deadline to complete this payment. If you do nothing, it comes back to ${short(o.refundTo)} automatically.`);
    if (o.topup !== need.toString()) { o.topup = need.toString(); text($('d-amount'), `${left} ${o.sym} more`); renderQr(); save(); }
  }

  async function pollConnect() {
    const run = ++pollRun; const o = order; const { id, wallet: addr, ref } = o.exec;
    let solTries = 0;
    while (run === pollRun) {
      const left = Math.max(0, Math.floor((new Date(o.deadline) - Date.now()) / 1000));
      setLeft(left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : '');
      try {
        const r = await cx('GET', `/api/v1/executions/${addr}?id=${encodeURIComponent(id)}`);
        const x = execRows(r).find((e) => e && e.id === id);
        const g = C.stage(x && x.status);
        if (g.end) return finish(g.end);
        setStep(g.step, g.tone);
        if (x && x.status === 'SUCCESS') {
          const dst = await C.ata(invoice.to, o.settle === 'earn' ? KLEND.cusdc : USDC_MINT);
          const hit = await findByReference(ref, (tx) => (o.settle === 'earn' ? C.verifyEarn(tx, invoice.to, o.raw, { dst, ref, notBefore: o.createdAt }) : C.verifyUsdc(tx, invoice.to, o.raw, false, o.createdAt)));
          if (hit) return finish('ok', null, hit);
          if (++solTries > 20) text($('countdown'), 'provider reports success; Solana proof not visible yet');
        }
      } catch (e) { text($('countdown'), 'reconnecting…'); }
      await sleep(6000);
    }
    return undefined;
  }

  // ---------- paying with USDC already on Solana: no bridge, a plain Solana Pay transfer ----------
  async function startDirect() {
    const reference = C.b58encode(rnd(32));
    order = { rail: 'direct', to: invoice.to, createdAt: Math.floor(Date.now() / 1000), chain: 'sol', sym: 'USDC', net: 'Solana', chainId: null, fam: 'sol',
      token: { assetId: SOL_USDC, decimals: 6, contract: USDC_MINT }, raw: invoice.raw.toString(), reference,
      quote: { depositAddress: invoice.to, amountIn: invoice.raw.toString(), amountInFormatted: fromUnits(invoice.raw, 6) },
      uri: C.solanaPayUri({ recipient: invoice.to, raw: invoice.raw, reference, label: 'Sluice', message: invoice.ref || 'Payment' }) };
    save(); renderDeposit(); show($('btn-wallet'), false); text($('wallet-note'), 'Scan with Phantom, Solflare or any Solana Pay wallet.');
    return pollDirect();
  }
  async function pollDirect() {
    const run = ++pollRun; const o = order; setStep('AWAIT');
    while (run === pollRun) {
      try {
        const hit = await findByReference(o.reference, (tx) => C.verifyUsdc(tx, invoice.to, o.raw, false, o.createdAt));
        if (hit) return finish('ok', null, hit);
      } catch (e) { text($('countdown'), 'reconnecting…'); }
      await sleep(6000);
    }
    return undefined;
  }

  // ---------- first run: three steps to a working checkout ----------
  // Only what the merchant typed, once validated, is kept, and only in this browser (localStorage). Nothing goes to a server.
  const PROFILE = 'sluice:merchant'; const LINKS = 'sluice:links'; const FLAGS = 'sluice:checklist:';
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: the flow still works */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  function profile() {
    const p = store.get(PROFILE, null);
    return p && C.isSolAddr(p.to) ? { to: p.to, name: C.cleanName(p.name || '') || '', settle: p.settle === 'earn' ? 'earn' : 'usdc' } : null;
  }
  /** Who a link pays, read from the link itself, so a stored entry cannot claim one address and carry another. */
  function linkTarget(url) {
    if (typeof url !== 'string' || !url.startsWith(base() + '#') || url.length > 2400) return null;
    const h = url.slice(base().length + 1);
    try {
      if (h.startsWith('p=')) return JSON.parse(new TextDecoder().decode(unb64u(h.slice(2).split('.')[0]))).to;
      const q = new URLSearchParams(h); return q.get('to') || q.get('a');
    } catch { return null; }
  }
  const myLinks = () => { const l = store.get(LINKS, []); return (Array.isArray(l) ? l : []).filter((x) => x && typeof x === 'object' && C.isSolAddr(x.to) && linkTarget(x.url) === x.to); };
  const flags = (addr) => { const f = store.get(FLAGS + addr, {}); return f && typeof f === 'object' && !Array.isArray(f) ? f : {}; };
  const flag = (addr, k) => { const f = flags(addr); if (!f[k]) { f[k] = Date.now(); store.set(FLAGS + addr, f); } };
  const phantom = () => (window.phantom && window.phantom.solana) || (window.solana && window.solana.isPhantom ? window.solana : null);
  /** The getting-started list, ticked from real events: a link made here, opened, shared, and a credit read from Solana. */
  function checklistItems(addr, paid) {
    const f = flags(addr); const made = myLinks().some((l) => l.to === addr);
    return [
      ['Create your first link', made],
      ['Open it once and check the amount, name and address', !!f.opened],
      ['Send it to a customer, or print the QR', !!f.shared],
      ['See the first payment verified on Solana', !!(f.paid || paid)],
    ];
  }
  function paintChecklist(el, items) {
    el.replaceChildren(...items.map(([label, done]) => {
      const li = document.createElement('li'); li.className = done ? 'done' : '';
      li.textContent = label; if (done) li.setAttribute('aria-label', label + ' (done)');
      return li;
    }));
  }

  const ob = { step: 1, name: '', to: '', check: C.payoutCheck('', undefined), settle: 'usdc', kind: 'fixed', stored: false };
  const STEPS = ['You', 'How you get paid', 'Your link'];
  let chkRun = 0; let chkTimer;
  function paintCheck(r) {
    const el = $('o-to-check'); el.className = 'check ' + r.level; text(el, r.msg || '');
  }
  async function checkPayout() {
    const input = $('o-to'); const v = input.value.trim(); const run = ++chkRun;
    let r = C.payoutCheck(v, undefined);
    if (r.level === 'secret') input.value = ''; // never keep a secret on the page, not even in the field
    ob.to = ''; ob.check = r; paintCheck(r); syncOnb();
    if (r.level !== 'pending') return;
    let acct;
    try {
      const res = await rpc('getAccountInfo', [v, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      acct = res && res.value ? { owner: res.value.owner, executable: !!res.value.executable, type: res.value.data && res.value.data.parsed ? res.value.data.parsed.type : null } : null;
    } catch { acct = 'error'; }
    if (run !== chkRun) return;
    r = C.payoutCheck(v, acct); ob.check = r; ob.to = r.ok ? v : ''; paintCheck(r); syncOnb();
  }
  function onbValid() {
    if (ob.step === 1) {
      const n = $('o-name').value; const clean = C.cleanName(n);
      if (!n.trim()) return 'Add your name to continue.';
      if (!clean) return 'Your name: up to 40 letters, digits, spaces and . , \' & ( ) ! _ - only.';
      if (ob.check.level === 'pending') return 'Checking your address on Solana…';
      if (!ob.check.ok) return ob.check.level === 'empty' ? 'Add your Solana wallet address to continue.' : 'Fix the wallet address to continue.';
      if (ob.stored && !$('o-confirm').checked) return 'Confirm the saved address is your own wallet to continue.';
      return '';
    }
    if (ob.step === 3 && ob.kind === 'fixed') {
      try { C.linkInput({ to: ob.to, amt: $('o-amt').value, ref: $('o-ref').value, name: ob.name }); } catch (e) { return $('o-amt').value.trim() ? e.message + '.' : 'Enter the amount to continue (at least 0.15 USDC).'; }
    }
    return '';
  }
  function syncOnb() {
    ob.name = C.cleanName($('o-name').value) || '';
    ob.settle = document.querySelector('input[name=o-settle]:checked').value;
    ob.kind = document.querySelector('input[name=o-kind]:checked').value;
    const done = ob.step === 4;
    for (const [i, id] of ['o-s1', 'o-s2', 'o-s3', 'o-done'].entries()) show($(id), ob.step === i + 1);
    [...document.querySelectorAll('.onb-progress span')].forEach((el, i) => { el.className = i + 1 < ob.step || done ? 'on' : i + 1 === ob.step ? 'cur' : ''; });
    text($('o-step'), done ? 'Done · your checkout is ready' : `Step ${ob.step} of 3 · ${STEPS[ob.step - 1]}`);
    show($('o-earn-facts'), ob.settle === 'earn');
    show($('o-fixed'), ob.kind === 'fixed'); show($('o-perm'), ob.kind === 'perm');
    text($('o-s2-to'), ob.to ? short(ob.to) : 'your wallet');
    const ph = phantom(); const why = onbValid();
    const next = $('o-next'); next.disabled = !!why; text($('o-why'), why);
    text(next, ob.step === 1 ? 'Next: how you get paid' : ob.step === 2 ? 'Next: your link' : ob.kind === 'perm' ? 'Create my pay page' : ph ? 'Sign with Phantom' : 'Create my link');
    show($('o-confirm-row'), ob.stored && ob.step === 1);
    show($('o-back'), ob.step > 1 && !done); show(document.querySelector('.onb-bar'), !done);
    const note = $('o-sign-note'); note.replaceChildren();
    if (ob.step === 3 && ob.kind === 'fixed') {
      if (ph) {
        note.append('Phantom signs the link, so nobody can change the amount, your name, the address or how it settles. Valid 7 days. ');
        const b = document.createElement('button'); b.type = 'button'; b.className = 'link'; b.textContent = 'Create it without signing'; b.onclick = () => createLink(false); note.append(b);
      } else {
        note.append('No Solana wallet in this browser, so the link will be unsigned. It works, and your customer sees a warning that anyone could edit it. ');
        if (matchMedia('(pointer: coarse)').matches) note.append(link(`https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`, 'Open this page in Phantom to sign it'));
      }
    }
    paintPreview(!!ph);
  }
  const POPULAR_PREVIEW = [['base', 'USDC'], ['arb', 'USDC'], ['base', 'ETH'], ['tron', 'USDT'], ['btc', 'BTC'], ['sol', 'USDC']];
  function paintPreview(canSign) {
    const perm = ob.kind === 'perm' && ob.step >= 3; const signs = !perm && canSign;
    let amt = null; try { amt = C.toUnits(C.linkInput({ to: MERCHANT_DEMO, amt: $('o-amt').value }).amt, 6); } catch { amt = null; }
    text($('pv-url'), `${location.host}${location.pathname}${perm ? '#a=…' : signs ? '#p=…' : '#to=…'}`);
    text($('pv-lead'), perm ? 'Pay any amount to' : 'You are paying');
    show($('pv-amount-row'), !perm); text($('pv-amt'), amt ? pretty(amt) : '0.00'); $('pv-amt').classList.toggle('ph', !amt);
    $('pv-amt').title = amt ? '' : 'You set the amount in step 3';
    show($('pv-to-word'), !perm);
    text($('pv-name'), ob.name || 'Your name'); $('pv-name').classList.toggle('ph', !ob.name);
    const to = ob.to || $('o-to').value.trim(); const okTo = C.isSolAddr(to) && ob.check.ok;
    text($('pv-to'), okTo ? to : 'your Solana address'); $('pv-to').classList.toggle('ph', !okTo);
    const bd = $('pv-badge');
    if (perm) { text(bd, 'This link is not signed: confirm the name and address with the merchant'); bd.className = 'badge warn'; }
    else if (signs) { text(bd, '✓ Signed by the receiving wallet. Confirm the address with the merchant.'); bd.className = 'badge good'; }
    else { text(bd, 'Unsigned link: anyone could change the name, amount or address. Check the address with the merchant.'); bd.className = 'badge warn'; }
    show($('pv-earn'), ob.settle === 'earn' && !perm);
    $('pv-chips').replaceChildren(...POPULAR_PREVIEW.map(([c, sym]) => {
      const d = document.createElement('div'); d.className = 'chip'; const b = document.createElement('b'); b.textContent = sym;
      const n = document.createElement('span'); n.textContent = c === 'sol' ? 'Solana, direct' : CHAINS[c].name; d.append(b, n); return d;
    }));
    const nets = new Set(assets.map((t) => t.blockchain)).size;
    text($('pv-count'), assets.length ? `${perm ? assets.length : assets.length + 1} assets on ${nets} networks, live from Aurora.` : '');
  }
  function saveProfile() {
    if (ob.to && ob.check.ok && ob.name) store.set(PROFILE, { to: ob.to, name: ob.name, settle: ob.settle });
  }
  function go(step) {
    ob.step = step; show($('o-error'), false); syncOnb();
    window.scrollTo(0, 0); // the progress bar and the new step's heading come first
    const first = { 1: 'o-name', 2: null, 3: ob.kind === 'fixed' ? 'o-amt' : null }[step];
    if (first && !matchMedia('(pointer: coarse)').matches) $(first).focus();
  }
  async function verifyOwn(msg, sig, key) {
    try {
      const k = await crypto.subtle.importKey('raw', C.b58decode(key), { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'Ed25519' }, k, sig, msg);
    } catch { return null; } // this browser cannot check Ed25519; the checkout says so too
  }
  async function createLink(sign) {
    const err = $('o-error'); show(err, false);
    const next = $('o-next'); next.disabled = true;
    try {
      let url; let note; let signed = false; let exp = null; let amt = null; let ref = '';
      if (ob.kind === 'perm') {
        const q = new URLSearchParams({ a: ob.to }); if (ob.name) q.set('n', ob.name);
        url = `${base()}#${q}`;
        note = 'Never expires. Customers choose the amount, and it arrives as USDC in your wallet. Unsigned, so customers are told to confirm your address with you.';
      } else {
        const f = C.linkInput({ to: ob.to, amt: $('o-amt').value, ref: $('o-ref').value, name: ob.name }); amt = f.amt; ref = f.ref;
        if (sign) {
          const ph = phantom();
          if (!ph || !ph.signMessage) throw new Error('No Phantom wallet here. Create the link without signing, or open this page in Phantom.');
          text(next, 'Confirm in Phantom…');
          const { publicKey } = await ph.connect(); const k = publicKey.toString();
          if (k !== f.to) throw new Error(`Phantom is on ${short(k)}, but payments go to ${short(f.to)}. Switch Phantom to that wallet, or go back and use ${short(k)}.`);
          const msg = C.utf8(C.linkMessage({ to: f.to, amt: f.amt, ref: f.ref, earn: ob.settle === 'earn', name: f.name, signer: k }));
          const { signature } = await ph.signMessage(msg, 'utf8');
          const sig = signature instanceof Uint8Array ? signature : new Uint8Array(0);
          if (sig.length !== 64 || (await verifyOwn(msg, sig, k)) === false) throw new Error('The wallet returned a signature that does not verify. Nothing was created; try again.');
          url = `${base()}#p=${b64u(msg)}.${b64u(sig)}`; signed = true; exp = JSON.parse(new TextDecoder().decode(msg)).exp;
          note = `Signed by your wallet: nobody can change the amount, your name, the address or how it settles. Valid until ${new Date(exp * 1000).toLocaleDateString()}.`;
        } else {
          const q = { to: f.to, amt: f.amt }; if (f.ref) q.ref = f.ref; if (f.name) q.n = f.name; if (ob.settle === 'earn') q.s = 'earn';
          url = `${base()}#${new URLSearchParams(q)}`;
          note = 'Unsigned: it works, but anyone could edit it, so your customer sees a warning. Sign it with Phantom to make it tamper-proof.';
        }
      }
      saveProfile();
      store.set(LINKS, C.rememberLink(myLinks(), { url, to: ob.to, kind: ob.kind, amt, ref, signed, exp, settle: ob.kind === 'perm' ? 'usdc' : ob.settle, at: Date.now() }));
      showDone(url, note);
    } catch (e) {
      text(err, (e && e.message) || 'Could not create the link.'); show(err); syncOnb();
    }
  }
  function drawQr(url, caption) {
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    const n = qr.getModuleCount(); const cell = Math.max(2, Math.floor(232 / (n + 8)));
    const img = new Image(); img.src = qr.createDataURL(cell, cell * 4); img.alt = 'QR code of your link';
    $('o-qr').replaceChildren(img);
    // A printable PNG for the counter: big modules, quiet zone, and who it pays underneath.
    const px = 10; const pad = 4 * px; const cv = document.createElement('canvas'); const w = n * px + 2 * pad;
    cv.width = w; cv.height = w + 70; const g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#000000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect(pad + c * px, pad + r * px, px, px);
    g.textAlign = 'center'; g.font = '600 26px system-ui, sans-serif'; g.fillText(caption.slice(0, 48), w / 2, w + 22);
    g.font = '18px system-ui, sans-serif'; g.fillStyle = '#444444'; g.fillText('Pay from any chain · USDC on Solana', w / 2, w + 52);
    try { $('o-qr-dl').href = cv.toDataURL('image/png'); } catch { show($('o-qr-dl'), false); }
  }
  function showDone(url, note) {
    ob.step = 4; syncOnb();
    text($('pv-foot'), 'This is what your customer sees when they open the link.');
    text($('o-link'), url); text($('o-link-note'), note);
    $('o-open').href = url; $('o-merchant').href = `${base()}#m=${ob.to}`;
    const who = ob.name || short(ob.to);
    const last = myLinks()[0] || {};
    text($('o-qr-cap'), last.kind === 'perm' ? `Pay ${who}: any amount` : `Pay ${who}: ${last.amt} USDC`);
    drawQr(url, last.kind === 'perm' ? `Pay ${who}` : `Pay ${who} · ${last.amt} USDC`);
    $('o-qr-dl').download = `sluice-${(last.ref || (last.kind === 'perm' ? 'pay-page' : 'link')).replace(/[^\w.-]/g, '')}.png`;
    const ticks = () => paintChecklist($('o-checklist'), checklistItems(ob.to, false));
    const shared = () => { flag(ob.to, 'shared'); ticks(); };
    $('o-copy').onclick = () => { copy($('o-copy'), url); shared(); };
    $('o-qr-dl').onclick = shared;
    $('o-open').onclick = () => { flag(ob.to, 'opened'); setTimeout(ticks, 0); };
    show($('o-share'), !!navigator.share);
    $('o-share').onclick = () => navigator.share({ title: `Pay ${who}`, url }).then(shared, () => {});
    ticks();
    window.scrollTo(0, 0); // the progress bar and the new step's heading come first
  }
  async function startOnboarding() {
    view('setup'); // the section is not called 'start', so the #start link does not scroll the header away
    const me = profile();
    if (me) {
      $('o-name').value = me.name; $('o-to').value = me.to; ob.stored = true; $('o-confirm').checked = false;
      document.querySelector(`input[name=o-settle][value=${me.settle}]`).checked = true;
    }
    $('o-name').oninput = () => { syncOnb(); };
    $('o-confirm').onchange = syncOnb;
    $('o-to').oninput = () => { ob.stored = false; clearTimeout(chkTimer); ob.to = ''; ob.check = C.payoutCheck($('o-to').value, undefined); if (ob.check.level === 'secret') return checkPayout(); paintCheck(ob.check.level === 'pending' ? { level: 'pending', msg: '' } : ob.check); syncOnb(); chkTimer = setTimeout(checkPayout, 350); return undefined; };
    $('o-paste').onclick = async () => {
      try { const t = (await navigator.clipboard.readText()).trim(); if (C.looksSecret(t)) { $('o-to').value = ''; paintCheck(C.payoutCheck(t, undefined)); return; } ob.stored = false; $('o-to').value = t.slice(0, 200); checkPayout(); } catch { $('o-to').focus(); text($('o-to-check'), 'Press and hold in the field, then Paste.'); }
    };
    const ph = phantom();
    show($('o-phantom'), !!ph);
    $('o-phantom').onclick = async () => { try { const { publicKey } = await ph.connect(); ob.stored = false; $('o-to').value = publicKey.toString(); checkPayout(); } catch { /* declined */ } };
    for (const b of document.querySelectorAll('#o-help [role=tab]')) {
      b.onclick = () => {
        for (const x of document.querySelectorAll('#o-help [role=tab]')) x.setAttribute('aria-selected', String(x === b));
        for (const p of document.querySelectorAll('#o-help .howto')) show(p, p.dataset.w === b.dataset.w);
      };
    }
    for (const r of document.querySelectorAll('input[name=o-settle], input[name=o-kind]')) r.onchange = () => { syncOnb(); saveProfile(); };
    $('o-amt').oninput = syncOnb; $('o-ref').oninput = syncOnb;
    $('o-back').onclick = () => go(Math.max(1, ob.step - 1));
    $('o-next').onclick = () => {
      if (onbValid()) return;
      if (ob.step === 1) { saveProfile(); return go(2); }
      if (ob.step === 2) { saveProfile(); return go(3); }
      return createLink(ob.kind === 'fixed' && !!phantom());
    };
    $('o-again').onclick = () => { $('o-amt').value = ''; $('o-ref').value = ''; go(3); };
    $('o-forget').onclick = () => { const p = profile(); store.del(PROFILE); store.del(LINKS); if (p) store.del(FLAGS + p.to); location.hash = '#start'; location.reload(); };
    $('o-ref').onkeydown = $('o-amt').onkeydown = (e) => { if (e.key === 'Enter') $('o-next').click(); };
    const proof = $('o-earn-proof'); proof.append(txLink('sol', EARN_TX), ': 0.15 USDC paid on Base, supplied to Kamino, cUSDC in the merchant\'s own account.');
    syncOnb();
    if (me) checkPayout();
    loadTokens().then(() => syncOnb(), () => {});
  }

  // ---------- proof ----------
  // Each row shows the stored verification (docs/proofs-snapshot.json, made by tools/snapshot_proofs.mjs with the same checks)
  // at once; "Check live" re-reads Aurora and Solana from this browser. A slow or failed live check never paints a row red:
  // the row keeps saying what was verified and when, and that the live check is pending.
  let proofQueue = Promise.resolve(); const checks = []; let SNAP = null;
  // Aurora's list endpoint can stall for a while: give it 25 s and one retry, like the status call.
  const permOnce = (address, type) => fetch(`${AURORA}/api/persistent-deposit-status/${API_KEY}?address=${encodeURIComponent(address)}&type=${type}&limit=20`, { signal: AbortSignal.timeout(25000) })
    .then((x) => x.json()).then((j) => (Array.isArray(j.deposits) ? j.deposits : []));
  const permList = (address, type) => permOnce(address, type).catch(() => sleep(1500).then(() => permOnce(address, type)));
  const proofIo = { swapStatus, getTx, permList };
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  function summaryNodes(items) {
    return (items || []).map((x) => (typeof x === 'string' ? document.createTextNode(x) : x && x.tx && safeHash(x.tx) && CHAINS[x.chain] ? txLink(x.chain, x.tx) : document.createTextNode('')));
  }
  function feeBox(fees) {
    const wrap = document.createElement('div'); wrap.className = 'fees';
    if (!fees) return wrap;
    const p = document.createElement('p'); p.className = 'feeline'; p.textContent = fees.sentence; wrap.append(p);
    const d = document.createElement('details'); const sm = document.createElement('summary'); sm.textContent = 'Where every unit went';
    d.append(sm);
    for (const g of fees.groups || []) {
      const t = document.createElement('table'); t.className = 'feetab';
      const row = (label, amount, unit, cls) => { const tr = document.createElement('tr'); if (cls) tr.className = cls; const a = document.createElement('td'); a.textContent = label; const b = document.createElement('td'); const u = document.createElement('span'); u.className = 'u'; u.textContent = unit ? ' ' + unit : ''; b.append(amount, u); tr.append(a, b); return tr; };
      t.append(row(g.total.label, g.total.amount, g.total.unit, 'tot'));
      for (const x of g.parts) t.append(row(x.label, x.amount, x.unit, x.kind ? 'k-' + x.kind : ''));
      d.append(t);
    }
    if (fees.network) { const n = document.createElement('p'); n.className = 'muted'; n.textContent = fees.network; d.append(n); }
    wrap.append(d);
    return wrap;
  }
  function showResult(out, res, live) {
    const head = document.createElement('span'); head.className = live ? 'when live' : 'when';
    head.textContent = live ? 'Checked live just now: ' : `${PR.snapshotLabel(res)}: `;
    out.replaceChildren(head, ...summaryNodes(res.summary), feeBox(res.fees));
    out.className = 'out' + (res.ok ? ' ok' : '');
  }
  function renderProof() {
    const box = (p) => {
      const el = document.createElement('div'); el.className = 'proof' + (p.fresh ? ' fresh' : '');
      const t = document.createElement('b'); t.textContent = p.name;
      const n = document.createElement('div'); n.className = 'note'; n.textContent = p.note;
      const l = document.createElement('div'); l.className = 'links';
      if (p.dep) { const dep = document.createElement('span'); dep.append(`${CHAINS[p.chain].name}: `, txLink(p.chain, p.dep)); l.append(dep); }
      const sol = document.createElement('span');
      if (p.sol) sol.append('Solana: ', txLink('sol', p.sol)); else sol.textContent = p.kind ? '' : p.refund ? 'Solana: none (refunded)' : 'Solana: none';
      l.append(sol);
      if (p.refund) { const r = document.createElement('span'); r.append('Refund: ', txLink(p.chain, p.refund)); l.append(r); }
      const rec = document.createElement('a');
      rec.href = p.kind === 'perm' ? `#a=${MERCHANT_DEMO}` : p.kind === 'redeem' ? `#m=${MERCHANT_DEMO}` : p.ref ? `#c=${p.ref}.${MERCHANT_DEMO}` : `#s=${p.addr}`;
      rec.textContent = p.kind === 'perm' ? 'Permanent page' : p.kind === 'redeem' ? 'Merchant view' : 'Record';
      l.append(rec);
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ghost chk'; btn.textContent = 'Check live';
      const out = document.createElement('div'); out.className = 'out';
      const pend = document.createElement('div'); pend.className = 'pending muted';
      const stored = () => (SNAP && SNAP.get(PR.id(p))) || null;
      const paintStored = () => { const s = stored(); if (s) showResult(out, s, false); else text(out, 'Not checked yet on this page: press Check live.'); };
      paintStored();
      const check = async () => {
        try {
          const res = await withTimeout(PR.checkRow(p, proofIo), 45000);
          if (res.ok || !stored()) { showResult(out, res, true); text(pend, ''); }
          else text(pend, `Live check did not confirm it this time (${humanize((res.aurora || {}).status) || 'no answer'}); showing the stored verification. Try again in a minute.`);
        } catch (e) {
          text(pend, stored() ? `Showing the ${PR.snapshotLabel(stored()).replace(/^Verified /, '').replace(/,.*$/, '')} verification, live check pending: Aurora or Solana is slow right now (${String(e.message || e).slice(0, 60)}). Try again in a minute.` : `Live check pending: Aurora or Solana is slow right now. Try again in a minute.`);
        }
        btn.disabled = false;
      };
      const run = () => {
        btn.disabled = true;
        text(pend, stored() ? `Showing the ${PR.snapshotLabel(stored()).replace(/^Verified /, '').replace(/,.*$/, '')} verification, live check pending…` : 'Asking Aurora and Solana…');
        proofQueue = proofQueue.then(check);
      };
      btn.onclick = run; checks.push(run);
      el.append(t, n, l, out, pend, btn);
      el._paint = paintStored;
      return el;
    };
    const head = (s) => Object.assign(document.createElement('h3'), { className: 'proof-head', textContent: s });
    const fresh = PROOF.filter((p) => p.fresh).map(box); const older = PROOF.filter((p) => !p.fresh).map(box);
    $('proof-table').replaceChildren(head('Run on 4 Nov: a permanent address, two refunds, a second chain, a redemption'), ...fresh,
      head('Earlier runs, 29 Oct to 3 Nov'), ...older);
    $('btn-check-all').onclick = () => checks.forEach((f) => f());
    fetch('proofs-snapshot.json', { signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (!j || !Array.isArray(j.rows)) return;
      SNAP = new Map(j.rows.filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
      for (const el of [...fresh, ...older]) el._paint();
    }).catch(() => {});
  }

  // ---------- hosted 402 API ----------
  const API402 = 'https://sluice-api.swiftbotlab.workers.dev';
  async function askApi() {
    const out = $('api-answer'); const btn = $('btn-ask-api'); btn.disabled = true; text(out, 'Asking…');
    try {
      const r = await fetch(`${API402}/api/report/${MERCHANT_DEMO}`, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (r.status !== 402 || !j || !j.price) throw new Error(`HTTP ${r.status}`);
      const ok = (v, rx) => (typeof v === 'string' && rx.test(v) ? v : '?');
      const lines = [`${r.status} Payment Required: ${ok(j.price.amount, /^\d+(\.\d+)?$/)} USDC on Solana to ${short(ok(j.price.recipient, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/))}`,
        `Accepts ${Array.isArray(j.accepts) ? j.accepts.length : 0} assets, for example ${(Array.isArray(j.accepts) ? j.accepts.slice(0, 4) : []).map((x) => ok(x, /^[a-z]{2,5}:[A-Z]{2,5}$/)).join(', ')}`,
        j.indicative ? `Right now that is about ${ok(j.indicative.send_about, /^\d+(\.\d+)?$/)} ${ok(j.indicative.asset, /^[A-Za-z ]{3,40}$/)} (an indicative quote; each order gets its own)` : 'Indicative quote unavailable right now',
        `Receipts are signed by ${short(ok(j.receipt_key, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/))}`];
      out.replaceChildren(...lines.map((l) => Object.assign(document.createElement('div'), { textContent: l })));
    } catch (e) { text(out, `No answer right now (${String(e.message || e).slice(0, 60)}). The curl line above asks the same thing.`); }
    btn.disabled = false;
  }

  // ---------- views ----------
  function view(name) {
    for (const v of ['pay', 'perm', 'receipt', 'merchant', 'home', 'setup']) show($(v), v === name);
    show($('nav'), name === 'home');
    for (const el of [$('main'), document.querySelector('.top .wrap'), document.querySelector('footer')]) el.classList.toggle('wide', name === 'setup');
    const me = profile(); const mine = $('nav-mine');
    show(mine, !!me && (name === 'home' || name === 'setup')); if (me) mine.href = `#m=${me.to}`;
  }
  const row = (label, value) => {
    const d = document.createElement('div'); const t = document.createElement('dt'); const v = document.createElement('dd');
    t.textContent = label; if (value instanceof Node) v.append(value); else v.textContent = value;
    d.append(t, v); return d;
  };
  const tokenName = (id) => { const t = tokens.find((x) => x.assetId === id); return t ? { sym: t.symbol, chain: t.blockchain, net: (CHAINS[t.blockchain] || {}).name || t.blockchain, decimals: t.decimals } : null; };

  async function showReceipt(dep) {
    view('receipt'); const rows = $('r-rows');
    $('r-share').onclick = () => copy($('r-share'), location.href);
    if (!C.isDepositAddr(dep)) { text($('r-title'), 'This is not a valid payment record link'); return; }
    let support = { depositAddress: dep };
    $('r-copy').onclick = () => copy($('r-copy'), JSON.stringify(support, null, 2));
    try {
      await loadTokens().catch(() => {});
      const s = await swapStatus(dep);
      if (!s || !s.status) throw new Error((s && s.message) || 'not found');
      const q = s.quoteResponse || {}; const qr = q.quoteRequest || {}; const qq = q.quote || {}; const d = s.swapDetails || {};
      const org = tokenName(qr.originAsset); const stg = C.stage(s.status);
      const raw = qr.swapType === 'EXACT_OUTPUT' && qr.destinationAsset === SOL_USDC ? BigInt(qr.amount) : null;
      const roles = C.txRoles(d); const sols = roles.solana;
      support = { depositAddress: dep, status: s.status, sourceTxHash: roles.deposit, network: org ? org.net : null, asset: org ? org.sym : qr.originAsset || null,
        amount: d.depositedAmountFormatted || qq.amountInFormatted || null, correlationId: s.correlationId || null, refundReason: d.refundReason || null };
      rows.replaceChildren();
      if (raw !== null) rows.append(row('Invoice', `${pretty(raw)} USDC on Solana`));
      if (C.isSolAddr(qr.recipient)) rows.append(row('Merchant', Object.assign(document.createElement('a'), { href: `#m=${qr.recipient}`, textContent: short(qr.recipient) })));
      // "Paid with" is what reached the deposit address; before a deposit there is only the quoted amount to send.
      const ra = C.recordAmounts(s, dep, qr.recipient);
      if (org) {
        if (ra && ra.paid) rows.append(row('Paid with', `${ra.paid} ${org.sym} on ${org.net}`));
        else if (s.status === 'PENDING_DEPOSIT' && qq.amountInFormatted) rows.append(row('Amount to send', `${qq.amountInFormatted} ${org.sym} on ${org.net}`));
        else rows.append(row('Paid with', `${org.sym} on ${org.net}`)); // a confidential record shows no amounts: none is guessed
      }
      if (roles.deposit) rows.append(row('Deposit', txLink(org ? org.chain : '', roles.deposit)));
      for (const h of roles.topups) rows.append(row('Further deposit', txLink(org ? org.chain : '', h)));
      if (s.status === 'INCOMPLETE_DEPOSIT' && /^\d{1,30}$/.test(String(qq.amountIn)) && /^\d{1,30}$/.test(String(d.depositedAmount || '0'))) rows.append(row('Short by', `${fromUnits(C.shortfall(qq.amountIn, d.depositedAmount), org ? org.decimals : 6)} ${org ? org.sym : ''}: it goes back to the payer after the deadline unless the rest arrives`));
      if (roles.refunded) rows.append(row('Refunded', `${d.refundedAmountFormatted} ${org ? org.sym : ''}${d.refundReason ? ` (${humanize(d.refundReason)})` : s.status === 'SUCCESS' ? ' (sent above what the payment needed)' : ''}`));
      for (const h of roles.refunds) rows.append(row('Refund tx', txLink(org ? org.chain : '', h)));
      if (sols[0]) rows.append(row('Solana settlement', txLink('sol', sols[0])));
      let verified = null;
      if (sols[0] && raw !== null && C.isSolAddr(qr.recipient)) {
        const madeAt = Math.floor(Date.parse(q.timestamp || '') / 1000) || 0;
        verified = await verifySig(sols[0], qr.recipient, raw, false, madeAt).catch(() => null);
        rows.append(row('Checked on Solana', verified ? `merchant +${fromUnits(verified.delta, 6)} USDC ✓` : 'not verified'));
      }
      const titles = { refund: 'Refunded to the payer', fail: 'Payment failed', expired: 'Expired' };
      text($('r-title'), verified ? (roles.refunded ? 'Paid, verified on Solana. The extra went back' : 'Paid, verified on Solana')
        : titles[stg.end] || (s.status === 'SUCCESS' ? 'Provider says paid; checking Solana' : s.status === 'INCOMPLETE_DEPOSIT' ? 'Short payment: waiting for the rest or the refund' : 'In progress'));
      text($('r-sub'), `Provider status: ${humanize(s.status)}`);
    } catch (e) { text($('r-title'), 'No record found'); text($('r-sub'), e.message || ''); }
  }
  async function showConnectReceipt(arg) {
    view('receipt'); const [ref, merchant] = arg.split('.');
    $('r-share').onclick = () => copy($('r-share'), location.href);
    show($('r-copy'), false);
    if (!C.isSolAddr(ref) || !C.isSolAddr(merchant)) { text($('r-title'), 'This is not a valid payment record link'); return; }
    try {
      // A record only says "paid" for a real credit to this merchant, and always says how much.
      const credit = (tx) => {
        const usdc = C.tokenDelta(tx, merchant, USDC_MINT); const shares = C.tokenDelta(tx, merchant, KLEND.cusdc);
        return !tx.meta.err && (usdc > 0n || shares > 0n) ? { usdc, shares } : null;
      };
      const hit = await findByReference(ref, credit);
      if (!hit) { text($('r-title'), 'No payment to this merchant with this reference'); return; }
      const rows = $('r-rows'); rows.replaceChildren(row('Merchant', Object.assign(document.createElement('a'), { href: `#m=${merchant}`, textContent: short(merchant) })), row('Order reference', short(ref)), row('Solana settlement', txLink('sol', hit.sig)));
      if (hit.usdc > 0n) rows.append(row('USDC received', fromUnits(hit.usdc, 6)));
      if (hit.shares > 0n) rows.append(row('cUSDC received', fromUnits(hit.shares, 6)));
      text($('r-title'), hit.usdc > 0n ? `${pretty(hit.usdc)} USDC received, verified on Solana` : `${fromUnits(hit.shares, 6)} cUSDC received, verified on Solana`);
      text($('r-sub'), 'Found from the order reference alone: no database, no provider.');
    } catch (e) { text($('r-title'), 'Could not read Solana right now'); text($('r-sub'), e.message || ''); }
  }
  // ---------- merchant view: Solana is the ledger; Aurora only adds where a credit came from ----------
  const when = (at) => (at ? new Date(at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const dayName = (key, today) => (key === today ? 'Today' : new Date(key + 'T12:00:00Z').toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' }));
  function ledgerRow(r) {
    const el = document.createElement('div'); el.className = 'lrow';
    const top = document.createElement('div'); top.className = 'ltop';
    const amt = document.createElement('b');
    amt.textContent = r.kind === 'earn' ? `${pretty(r.usdc)} USDC into Kamino` : r.kind === 'withdraw' ? `${fromUnits(r.shares, 6)} cUSDC → ${fromUnits(r.usdc, 6)} USDC` : r.kind === 'usdc' ? `+${pretty(r.usdc)} USDC` : r.out ? `${r.out} USDC` : 'Payment';
    const tag = document.createElement('span');
    const st = r.verified ? ['good', '✓ On Solana'] : r.status === 'REFUNDED' ? ['warn', 'Refunded to payer'] : r.status === 'FAILED' ? ['bad', 'Failed'] : r.status === 'SUCCESS' ? ['wait', 'Reported paid'] : ['wait', 'On its way'];
    tag.className = 'tag ' + st[0]; tag.textContent = st[1];
    top.append(amt, tag);
    const org = r.origin ? tokenName(r.origin) : null;
    // The amount the customer sent comes from this payment's record (what reached the deposit address), never from a list total.
    const back = r.refunded && org ? `, ${r.refunded} ${org.sym} refunded` : '';
    const from = org ? `paid with ${r.paidIn ? r.paidIn + ' ' : ''}${org.sym} on ${org.net}${back}` : r.kind === 'earn' ? `${fromUnits(r.shares, 6)} cUSDC to your account`
      : r.kind === 'withdraw' ? 'taken out of Kamino into your own USDC account' : r.kind === 'usdc' ? 'USDC received' : '';
    const sub = document.createElement('div'); sub.className = 'muted lsub'; sub.textContent = [from, when(r.at)].filter(Boolean).join(' · ');
    const links = document.createElement('div'); links.className = 'links';
    if (r.sig) { const s = document.createElement('span'); s.append('Solana: ', txLink('sol', r.sig)); links.append(s); }
    if (r.record) links.append(Object.assign(document.createElement('a'), { href: base() + r.record, textContent: r.verified ? 'Shareable record' : 'Open record' }));
    el.append(top, sub, links);
    return el;
  }
  function paintList(box, rows, empty) {
    if (!rows.length) { box.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: empty })); return; }
    box.replaceChildren(...rows.map(ledgerRow));
  }
  /** Single-series column chart: one baseline, one hue, a hover or tap readout per day, the busiest day labelled. */
  function paintChart(days, partial) {
    const box = $('m-chart'); const max = days.reduce((m, d) => (d.usdc > m ? d.usdc : m), 0n);
    const today = days[days.length - 1].day;
    const plot = document.createElement('div'); plot.className = 'plot';
    const tip = document.createElement('div'); tip.className = 'tip hidden'; tip.setAttribute('aria-hidden', 'true');
    let labelled = false;
    for (const d of days) {
      const col = document.createElement('button'); col.type = 'button'; col.className = 'col';
      const label = `${dayName(d.day, today)}: ${pretty(d.usdc)} USDC, ${d.count} payment${d.count === 1 ? '' : 's'}`;
      col.setAttribute('aria-label', label);
      const bar = document.createElement('span'); bar.className = 'bar';
      bar.style.height = d.usdc > 0n ? `max(3px, ${Number((d.usdc * 1000n) / max) / 10}%)` : '0px';
      if (!labelled && max > 0n && d.usdc === max) { const cap = document.createElement('span'); cap.className = 'cap'; cap.textContent = pretty(d.usdc); bar.append(cap); labelled = true; }
      col.append(bar);
      const on = () => { tip.textContent = label; show(tip); tip.style.left = `${col.offsetLeft + col.offsetWidth / 2}px`; col.classList.add('hot'); };
      const off = () => { show(tip, false); col.classList.remove('hot'); };
      col.onpointerenter = on; col.onfocus = on; col.onclick = on; col.onpointerleave = off; col.onblur = off;
      plot.append(col);
    }
    const axis = document.createElement('div'); axis.className = 'axis';
    for (const k of [days[0].day, days[Math.floor(days.length / 2)].day, today]) axis.append(Object.assign(document.createElement('span'), { textContent: dayName(k, today) }));
    const nodes = [plot, axis, tip];
    if (max === 0n) nodes.push(Object.assign(document.createElement('p'), { className: 'empty muted', textContent: partial ? 'No verified payments in the history Solana returned.' : 'No verified payments in the last 14 days yet.' }));
    box.replaceChildren(...nodes);
  }
  function paintMerchant(addr, st, mine) {
    const rows = C.ledgerRows(st.credits, st.aurora, addr, st.records);
    const days = C.dailyTotals(rows, { days: 14, tzOffsetMin: new Date().getTimezoneOffset() });
    const sum = days.reduce((s, d) => s + d.usdc, 0n); const cnt = days.reduce((s, d) => s + d.count, 0);
    // A total is only called complete when the history behind it is proven complete (core.readHistory); otherwise it says so.
    const partial = st.done && (st.partial || st.solError || st.unread > 0);
    text($('m-14'), st.done || cnt ? `${partial ? 'at least ' : ''}${pretty(sum)} USDC` : '…');
    text($('m-14-sub'), `${cnt} payment${cnt === 1 ? '' : 's'}, verified on Solana${partial ? ' · history incomplete' : ''}`);
    const since = st.from ? new Date(st.from * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null;
    const hist = st.capped ? 'More than 200 transactions in 14 days: only the newest are read, so older payments may be missing from the total.'
      : st.partial ? `Solana's public nodes returned history only ${since ? `back to ${since}` : 'for recent days'} just now, so older payments may be missing from the total. Reload to try again.`
        : 'The history is complete for the last 14 days: it reaches back past them, or to the transaction that opened each account.';
    text($('m-partial'), !partial ? '' : st.solError ? 'Solana could not be read just now, so no total is shown as complete. Reload to try again.'
      : st.partial ? hist : `${st.unread} transaction${st.unread === 1 ? '' : 's'} could not be read just now, so the total may be higher. Reload to try again.`);
    if (st.shares === 'error') { text($('m-earn'), 'unavailable'); text($('m-shares'), 'unavailable'); } else if (st.shares !== null) {
      const v = C.earnValue(st.shares, rows); const has = st.shares > 0n;
      text($('m-earn'), `${has ? fromUnits(st.shares, 6) : '0'} cUSDC`); text($('m-shares'), `${has ? fromUnits(st.shares, 6) : '0'} cUSDC`);
      text($('m-earn-sub'), v ? `worth at least ${pretty(v.usdc)} USDC` : has && !st.done ? 'reading the rate…' : 'cUSDC position');
      text($('m-worth'), v ? `${pretty(v.usdc)} USDC` : has ? (st.done ? 'not in view' : '…') : '0.00 USDC');
      text($('m-worth-sub'), v ? `at the rate of your deposit on ${when(v.at)}` : has && st.done ? 'no deposit found in the latest transactions' : 'USDC');
    }
    paintChart(days, partial);
    const dust = rows.filter((r) => r.dust).length;
    const pays = rows.filter((r) => !r.dust && (r.kind !== 'earn' || r.verified));
    const wait = st.done ? 'No payments found yet.' : 'Reading Solana…';
    paintList($('m-latest'), pays.slice(0, 3), wait);
    paintList($('m-rows'), pays, wait);
    paintList($('m-earn-rows'), rows.filter((r) => r.kind === 'earn' && !r.dust), st.done ? 'No deposits into Kamino yet. Choose "Put it to work" when you make a link.' : 'Reading Solana…');
    // Withdrawals are the merchant's own money moving, so they are listed here and never counted as payments.
    const outs = st.credits.filter((c) => c && c.kind === 'withdraw').sort((a, b) => (b.at || 0) - (a.at || 0))
      .map((c) => ({ kind: 'withdraw', verified: true, sig: c.sig, at: c.at, usdc: c.usdc, shares: c.shares }));
    paintList($('m-out-rows'), outs, st.done ? 'Nothing taken out of Kamino yet.' : 'Reading Solana…');
    if (st.done) {
      const how = st.solError ? 'Solana could not be read just now, so only what Aurora reports is listed, marked as not checked. Reload to try again.'
        : `Every amount is read from Solana: ${st.scanned} transaction${st.scanned === 1 ? '' : 's'} to your USDC and cUSDC accounts, each checked on its own, so any USDC sent to this wallet shows, not only payments through Sluice. ${hist}${st.unread ? ` ${st.unread} of them could not be read just now and are not shown; reload to try again.` : ''}${dust ? ` ${dust} transfer${dust === 1 ? '' : 's'} under 0.01 USDC ${dust === 1 ? 'is' : 'are'} left out of the list and the totals.` : ''}`;
      text($('m-scan-note'), `${how} Where this checkout routed a payment, its record adds what the customer sent (the amount that reached the deposit address) and a link you can share.${st.auroraError ? ' Aurora\'s history could not be read just now.' : ''}`);
    }
    if (mine) {
      const paid = rows.some((r) => r.verified && !r.dust); if (paid) flag(addr, 'paid');
      const items = checklistItems(addr, paid); const n = items.filter((i) => i[1]).length;
      const hidden = !!flags(addr).hideWelcome;
      show($('m-welcome'), !hidden && n < items.length);
      text($('m-welcome-title'), `Getting started · ${n} of ${items.length}`); paintChecklist($('m-checklist'), items);
    }
  }
  function merchantTabs() {
    const ids = ['overview', 'payments', 'earn'];
    const sel = (k, focus) => {
      for (const id of ids) { const t = $('mt-' + id); const on = id === k; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; show($('mp-' + id), on); if (on && focus) t.focus(); }
    };
    ids.forEach((id, i) => {
      const t = $('mt-' + id); t.onclick = () => sel(id);
      t.onkeydown = (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); sel(ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length], true); } };
    });
    $('m-all').onclick = () => sel('payments', true);
  }
  async function showMerchant(addr) {
    view('merchant');
    if (!C.isSolAddr(addr)) {
      text($('m-title'), 'Not a Solana address'); show(document.querySelector('#merchant .tabs'), false);
      for (const id of ['mp-overview', 'mp-payments', 'mp-earn', 'm-addr', 'm-copy']) show($(id), false);
      show(document.querySelector('#merchant .mlinks'), false); return;
    }
    const me = profile(); const mine = !!(me && me.to === addr);
    text($('m-title'), mine && me.name ? me.name : short(addr));
    if (mine && me.name) document.title = `${me.name} · Sluice`;
    text($('m-addr'), addr); $('m-copy').onclick = () => copy($('m-copy'), addr);
    const pq = new URLSearchParams({ a: addr }); if (mine && me.name) pq.set('n', me.name);
    $('m-perm').href = `#${pq}`; $('m-sol').href = `https://solscan.io/account/${addr}`;
    $('m-welcome-x').onclick = () => { flag(addr, 'hideWelcome'); show($('m-welcome'), false); };
    merchantTabs();
    const st = { credits: [], aurora: [], records: new Map(), shares: null, done: false, scanned: 0 };
    const paint = () => paintMerchant(addr, st, mine);
    paint();
    const [usdcAcct, cusdcAcct] = await Promise.all([C.ata(addr), C.ata(addr, KLEND.cusdc)]);
    const usdcBal = accountAmount(usdcAcct); const cusdcBal = accountAmount(cusdcAcct);
    usdcBal.then((v) => text($('m-usdc'), `${pretty(v === null ? 0n : v)} USDC`), () => text($('m-usdc'), 'unavailable'));
    cusdcBal.then((v) => { st.shares = v === null ? 0n : v; paint(); }, () => { st.shares = 'error'; paint(); });
    loadTokens().then(paint, () => {});
    // Aurora's list says which Solana transactions it routed. What the customer sent is read from each payment's own record
    // (the #s= page's source), one at a time, newest first.
    const records = async () => {
      const want = st.aurora.filter((x) => x && x.recipient === addr && C.isDepositAddr(x.depositAddress) && x.status && x.status !== 'PENDING_DEPOSIT').slice(0, 12);
      for (const x of want) {
        const s = await swapStatus(x.depositAddress).catch(() => null);
        const v = C.recordAmounts(s, x.depositAddress, addr);
        if (v) { st.records.set(x.depositAddress, v); paint(); }
      }
    };
    fetch(`${AURORA}/api/transactions/${API_KEY}?walletAddress=${encodeURIComponent(addr)}&numberOfTransactions=25`, { signal: AbortSignal.timeout(12000) })
      .then((x) => x.json()).then((r) => { st.aurora = (Array.isArray(r) ? r : r.data || r.transactions || []).slice(0, 25); paint(); return records(); }, () => { st.auroraError = true; paint(); })
      .catch(() => {}); // a record that cannot be read only leaves its amount out
    // Both token accounts, newest first, read until 14 days are covered so a burst of dust cannot push real payments out of view.
    // A public node that keeps only recent history answers with a short list and no error, so the list must prove it is
    // complete (core.readHistory), and the next endpoint is asked when it cannot. Each transaction is read once and shown as soon as it is checked.
    const cutoff = Math.floor(Date.now() / 1000) - 14 * 86400;
    const txs = new Map();
    const getTxOnce = (sig) => {
      if (!txs.has(sig)) txs.set(sig, getTx(sig).then((tx) => { if (!tx) txs.delete(sig); return tx; }, (e) => { txs.delete(sig); throw e; }));
      return txs.get(sig);
    };
    const callRetry = async (u, method, params) => { try { return await rpcAt(u, method, params); } catch { await sleep(1500); return rpcAt(u, method, params); } };
    const exists = (p) => p.then((v) => v !== null, () => undefined);
    const history = async (acct, cap, bal) => C.readHistory({ urls: RPC_ORDER.getSignaturesForAddress, account: acct, cutoff, cap, page: 100, call: callRetry, getTx: getTxOnce, accountExists: () => exists(bal) });
    try {
      const [a, b] = await Promise.all([history(usdcAcct, 200, usdcBal), history(cusdcAcct, 100, cusdcBal)]);
      st.partial = !a.complete || !b.complete; st.capped = a.reason === 'cap' || b.reason === 'cap';
      st.from = [a, b].filter((h) => !h.complete && h.from).reduce((m, h) => (m === null || h.from < m ? h.from : m), null);
      if (!a.sigs.length && !b.sigs.length && [...a.tried, ...b.tried].every((t) => t.error)) throw new Error('no Solana endpoint answered');
      const seen = new Set();
      const all = [...a.sigs, ...b.sigs].filter((s) => !s.err && safeHash(s.signature) && !seen.has(s.signature) && seen.add(s.signature))
        .sort((x, y) => (y.blockTime || 0) - (x.blockTime || 0));
      const list = all.filter((s, i) => i < 30 || (s.blockTime || 0) >= cutoff).slice(0, 200);
      st.scanned = list.length;
      // Public RPCs rate-limit bursts: a read that fails is retried after a pause, and what still fails is counted, never guessed.
      let todo = list.map((s) => s.signature);
      for (let pass = 0; pass < 3 && todo.length; pass++) {
        if (pass) await sleep(2500 * pass);
        const failed = [];
        for (const sig of todo) {
          const tx = await getTxOnce(sig).catch(() => undefined);
          if (tx === undefined || tx === null) { failed.push(sig); continue; }
          const c = C.merchantCredit(tx, addr, cusdcAcct, sig);
          if (c) { st.credits.push(c); paint(); }
        }
        todo = failed;
      }
      st.unread = todo.length;
    } catch { st.solError = true; }
    st.done = true; paint();
  }

  // ---------- permanent pay page: any amount, any time, no expiry ----------
  let permRun = 0; let permPicked = '';
  function markPerm() { for (const el of document.querySelectorAll('#perm .chip')) el.setAttribute('aria-checked', String(el.dataset.key === permPicked)); }
  async function pickPermanent(merchant, t) {
    const ch = CHAINS[t.blockchain]; const run = ++permRun; permPicked = assetKey(t); markPerm();
    text($('p-picked-name'), `${t.symbol} on ${ch.name}`); show($('p-picked')); show($('p-origins'), false); show($('p-count'), false); show($('p-more'), false); show($('p-more-box'), false);
    const err = $('p-error'); show(err, false); show($('p-panel'), false);
    try {
      const r = await aurora('/api/persistent-deposit-address', C.permanentRequest(merchant, t.blockchain));
      if (!C.isDepositAddr(r.depositAddress)) throw new Error('unexpected deposit address');
      if (ch.fam === 'evm' && !C.isEvmAddr(r.depositAddress)) throw new Error('unexpected deposit address');
      // Both answers come from Aurora: this guards against mix-ups, not a compromised API. SECURITY.md says so.
      const rec = await fetch(`${AURORA}/api/persistent-deposit-address-data/${API_KEY}?address=${encodeURIComponent(r.depositAddress)}`, { signal: AbortSignal.timeout(12000) }).then((x) => x.json());
      if (!C.permanentMatches(rec, r.depositAddress, merchant)) throw new Error('this address does not match the merchant, so it is not shown');
      if (ch.memo && !r.memo) throw new Error('this network needs a memo and none was returned, so the address is not shown');
      if (run !== permRun) return;
      const here = assets.filter((x) => x.blockchain === t.blockchain); const min = C.permanentMinUsd(t.blockchain); const inAsset = C.minInAsset(t, min);
      text($('p-chain'), ch.name); text($('p-asset'), t.symbol); text($('p-pill'), `${here.length} ${here.length === 1 ? 'asset' : 'assets'} supported`);
      text($('p-address'), r.depositAddress); show($('p-memo-row'), !!r.memo); text($('p-memo'), r.memo || '');
      const qr = qrcode(0, 'M'); qr.addData(r.depositAddress); qr.make();
      const img = new Image(); img.src = qr.createDataURL(5, 8); img.alt = 'QR: ' + r.depositAddress; $('p-qr').replaceChildren(img);
      text($('p-qr-caption'), `${t.symbol} on ${ch.name} only`);
      text($('p-req'), `Send only ${t.symbol} from the ${ch.name} network to this address.${r.memo ? ' Include the memo, or the deposit is not credited.' : ''} Minimum $${min}${inAsset ? ` (about ${inAsset} ${t.symbol})` : ''}: smaller deposits may never arrive. Sending another asset or using another network may result in permanent loss of funds.`);
      const names = here.slice(0, 8).map((x) => x.symbol).join(', ') + (here.length > 8 ? ` and ${here.length - 8} more` : '');
      const facts = [`${here.length === 1 ? 'Supported here' : 'Also accepted here'}: ${names}`, `Arrives as USDC in ${short(merchant)} on Solana, minus routing fees. The rate is set when the deposit is processed`,
        'This address is permanent: save it, print it, reuse it', 'No automatic refund: a deposit that cannot be processed is retried. For a fixed price with refunds, ask for a pay link'];
      if (ch.fam === 'evm') facts.splice(1, 0, 'The same address works on the other supported EVM networks');
      $('p-facts').replaceChildren(...facts.map((f) => { const li = document.createElement('li'); li.textContent = f; return li; }));
      show($('p-panel')); show($('p-activity'));
      $('p-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      pollPermanent(r.depositAddress, merchant, run);
    } catch (e) {
      if (run !== permRun) return;
      const closed = /403|forbidden|not allowed|not approved/i.test(e.message || '');
      text(err, closed ? 'Permanent addresses are not available right now. Ask the merchant for a pay link instead.' : `This address is not available right now: ${e.message}`); show(err);
    }
  }
  async function pollPermanent(address, merchant, run) {
    const list = (type) => permList(address, type);
    const checked = new Map(); const box = $('p-rows');
    while (run === permRun) {
      try {
        const [received, success, failed] = await Promise.all([list('received'), list('success'), list('failed')]);
        const rows = C.depositRows({ received, success, failed });
        if (!rows.length) text(box, 'Nothing yet. This page updates by itself.');
        else {
          const nodes = [];
          for (const r of rows.slice(0, 20)) {
            const t = tokenName(r.assetId); const el = document.createElement('div'); el.className = 'proof';
            const b = document.createElement('b'); el.append(b);
            const tName = `${r.amount} ${t ? t.sym : ''}${r.chain && CHAINS[r.chain] ? ` on ${CHAINS[r.chain].name}` : ''}`;
            b.textContent = r.kind === 'received' ? `Received: ${tName}` : r.kind === 'failed' ? 'Delivery failed, being retried' : 'Delivered: checking on Solana';
            const links = document.createElement('div'); links.className = 'links';
            if (r.tx) links.append(txLink(r.kind === 'received' ? r.chain || '' : 'sol', r.tx));
            if (r.kind === 'delivered') {
              // The amount shown comes only from Solana, never from the API's list.
              const at = Math.floor(Date.parse(r.at || '') / 1000) || 0;
              if (r.tx && safeHash(r.tx) && !checked.get(r.tx)) checked.set(r.tx, await verifySig(r.tx, merchant, 1n, false, at).catch(() => null));
              const v = checked.get(r.tx);
              b.textContent = v ? `Delivered: merchant +${fromUnits(v.delta, 6)} USDC ✓` : 'Delivery reported, not yet verified on Solana';
            }
            el.append(links);
            nodes.push(el);
          }
          box.replaceChildren(...nodes);
        }
      } catch { /* keep the last view; the next poll retries */ }
      await sleep(10000);
    }
  }
  async function startPermanent() {
    view('perm');
    const { merchant, name } = C.permanentLink(location.hash);
    if (!C.isSolAddr(merchant)) { text($('p-to'), '—'); text($('p-badge'), 'This link has an invalid Solana address.'); $('p-badge').className = 'badge bad'; show($('p-pick'), false); return; }
    text($('p-to'), merchant);
    if (name) { text($('p-name'), name); show($('p-name')); show($('p-name-tag')); document.title = `Pay ${name} · Sluice`; text($('p-badge'), 'This link is not signed: confirm the name and address with the merchant'); }
    $('p-change').onclick = () => { show($('p-picked'), false); show($('p-origins')); show($('p-count')); show($('p-more'), assets.length - assets.filter(C.isPopular).length > 0); };
    $('p-copy').onclick = () => copy($('p-copy'), $('p-address').textContent);
    $('p-copy-memo').onclick = () => copy($('p-copy-memo'), $('p-memo').textContent);
    const pick = (t) => pickPermanent(merchant, t);
    const search = () => {
      const hits = assets.filter((t) => !C.isPopular(t) && C.matchAsset(t, $('p-search').value));
      $('p-results').replaceChildren(...hits.slice(0, 60).map((t) => chip(t, pick))); markPerm();
    };
    $('p-more').onclick = () => { const on = $('p-more-box').classList.contains('hidden'); show($('p-more-box'), on); $('p-more').setAttribute('aria-expanded', String(on)); if (on) $('p-search').focus(); };
    $('p-search').oninput = search;
    try {
      await loadTokens();
      if (C.settlementIncident(incidents)) { text($('banner'), 'Aurora reports an incident on Solana delivery. Please wait until it clears before sending anything.'); show($('banner')); show($('p-pick'), false); return; }
      const pop = assets.filter(C.isPopular); const nets = new Set(assets.map((t) => t.blockchain)).size;
      text($('p-count'), `${assets.length} assets on ${nets} networks, live from Aurora.`);
      $('p-origins').replaceChildren(...pop.map((t) => chip(t, pick)));
      const rest = assets.length - pop.length; show($('p-more'), rest > 0); text($('p-more'), `More assets (${rest})`);
      search();
    } catch (e) { text($('p-count'), 'Could not load assets: ' + e.message); }
  }

  async function startPay() {
    view('pay');
    invoice = await parseLink().catch(() => null);
    const bd = $('inv-badge'); const stop = (msg) => { text(bd, msg); bd.className = 'badge bad'; show($('step-choose'), false); };
    if (!invoice) { show($('pay')); text($('inv-to'), '—'); show($('inv-ref-row'), false); return stop('This pay link cannot be read.'); }
    if (invoice.signed && invoice.sigOk === false) { // nothing from a forged link is worth showing as an invoice
      show($('inv-ref-row'), false); show(document.querySelector('#pay .payee'), false); show(document.querySelector('.invoice .amount'), false);
      text(document.querySelector('.invoice .muted'), 'This link was changed after it was signed');
      return stop('Tampered link: the signature does not match. Do not pay.');
    }
    try {
      if (!C.isSolAddr(invoice.to)) throw new Error('This link has an invalid Solana address.');
      if (typeof invoice.amt !== 'string') throw new Error('This link has an invalid amount.');
      invoice.raw = C.toUnits(invoice.amt, 6);
      if (invoice.raw < 100000n) throw new Error('Amount below the 0.10 USDC minimum.');
      if (invoice.exp && invoice.exp < Date.now() / 1000) throw new Error('This pay link has expired. Ask the merchant for a new one.');
    } catch (e) { return stop(e.message); }
    text($('inv-amount'), pretty(invoice.raw)); text($('inv-to'), invoice.to); text($('inv-ref'), invoice.ref || '—');
    if (invoice.name) { text($('inv-name'), invoice.name); show($('inv-name')); show($('inv-name-tag')); document.title = `Pay ${invoice.name} · Sluice`; }
    show($('inv-ref-row'), !!invoice.ref);
    show($('inv-earn'), invoice.settle === 'earn');
    if (invoice.signed && invoice.sigOk && invoice.signer === invoice.to) { text(bd, '✓ Signed by the receiving wallet. Confirm the address with the merchant.'); bd.className = 'badge good'; }
    else if (invoice.signed && invoice.sigOk) { text(bd, 'Signed by ' + short(invoice.signer) + ' (not the receiving wallet)'); bd.className = 'badge warn'; }
    else if (invoice.signed) { text(bd, 'This browser cannot check the signature: treat this link as unsigned and check the address with the merchant'); bd.className = 'badge warn'; }
    else { text(bd, invoice.name ? 'Unsigned link: anyone could change the name, amount or address. Check the address with the merchant.' : 'Unsigned link: check the address with the merchant'); bd.className = 'badge warn'; }

    setOpenIn(); discoverWallets();
    $('refund').oninput = syncForm; $('btn-quote').onclick = submitPay;
    $('btn-wallet-connect').onclick = startConnect; $('btn-wallet-off').onclick = dropWallet;
    $('btn-copy').onclick = () => copy($('btn-copy'), $('d-address').textContent);
    $('btn-copy-memo').onclick = () => copy($('btn-copy-memo'), $('d-memo').textContent);
    $('btn-qr-mode').onclick = () => { qrPlain = !qrPlain; renderQr(); };
    $('btn-wallet').onclick = payWithWallet;
    $('btn-change').onclick = () => { pickedView(false); $('origins').querySelector('[aria-checked="true"]')?.focus(); };
    $('btn-more').onclick = () => { const on = $('more').classList.contains('hidden'); show($('more'), on); $('btn-more').setAttribute('aria-expanded', String(on)); if (on) $('asset-search').focus(); };
    $('asset-search').oninput = renderSearch;
    $('btn-sol-refund').onclick = async () => { try { const { publicKey } = await window.phantom.solana.connect(); $('refund').value = publicKey.toString(); syncForm(); } catch { /* user declined */ } };
    $('btn-tx').onclick = () => {
      const h = $('txhash').value.trim();
      if (!order || !/^(0x)?[0-9a-fA-F]{64}$/.test(h)) return;
      if (order.rail === 'swap' && !order.confidential) aurora('/api/deposit/submit', { txHash: h, depositAddress: order.quote.depositAddress }).catch(() => {});
      else if (order.rail === 'connect') cx('POST', '/api/v1/executions/deposit/submit', { txHash: h, depositAddress: order.quote.depositAddress }).catch(() => {});
    };
    try { await loadTokens(); renderOrigins(); if (wallet && !choice) preselect(); } catch (e) { text($('origin-count'), 'Could not load assets: ' + e.message); }
    if (C.settlementIncident(incidents)) {
      blocked = true; text($('banner'), 'Aurora reports an incident on Solana delivery. Payments are paused here until it clears, so no funds get stuck.'); show($('banner'));
    }
    syncForm();
    const prev = load();
    if (prev) {
      // An order for this link was started earlier. If it cannot be re-checked, say so: silently starting over invites paying twice.
      const warnEarlier = () => { text($('banner'), 'An earlier payment for this link could not be re-checked. If you already sent it, check your wallet before paying again.'); show($('banner')); };
      try {
        if (!C.restorable(prev, invoice)) { if (prev.depositTx) warnEarlier(); return undefined; }
        if (prev.confidential) throw new Error('private quotes cannot be re-checked');
        if (prev.rail === 'swap') await checkPublic({ depositAddress: prev.quote.depositAddress, recipient: invoice.to, originAsset: prev.token.assetId, refundTo: prev.refundTo, amountIn: prev.quote.amountIn, amount: prev.raw, memo: prev.quote.depositMemo, fresh: false });
        else if (prev.rail === 'connect') await checkPublic({ depositAddress: prev.quote.depositAddress, recipient: C.deriveIntermediary(prev.exec.wallet), originAsset: prev.token.assetId, refundTo: prev.exec.wallet, amountIn: prev.quote.amountIn, fresh: false });
        else if (prev.quote.depositAddress !== invoice.to) throw new Error('not this merchant');
        else prev.uri = C.solanaPayUri({ recipient: invoice.to, raw: invoice.raw, reference: prev.reference, label: 'Sluice', message: invoice.ref || 'Payment' });
        order = prev; renderDeposit();
        if (prev.rail === 'connect') { if (prev.settle === 'earn') text($('tl-solana'), 'Verified on Solana (merchant\'s Kamino position checked directly)'); pollConnect(); }
        else if (prev.rail === 'direct') pollDirect();
        else pollSwap();
      } catch { warnEarlier(); }
    }
    return undefined;
  }

  async function startHome() {
    view('home');
    $('btn-demo').href = '#' + DEMO_LINK; $('btn-demo-perm').href = `#a=${MERCHANT_DEMO}`;
    const me = profile();
    if (me) {
      show($('c-back')); text($('c-back-name'), me.name || short(me.to)); $('c-back-m').href = `#m=${me.to}`;
      $('c-back-links').replaceChildren(...myLinks().filter((l) => l.to === me.to).slice(0, 3).map((l) => {
        const li = document.createElement('li');
        const amt = typeof l.amt === 'string' && /^\d{1,9}(\.\d{1,6})?$/.test(l.amt) ? l.amt : '?'; const ref = typeof l.ref === 'string' && /^[\w.-]{0,40}$/.test(l.ref) ? l.ref : '';
      const label = `${l.kind === 'perm' ? 'Pay page, any amount' : `${amt} USDC${ref ? ' · ' + ref : ''}${l.signed ? ' · signed' : ''}${typeof l.exp === 'number' && l.exp * 1000 < Date.now() ? ' · expired' : ''}`} · to ${short(l.to)}`;
        li.append(Object.assign(document.createElement('a'), { href: l.url, textContent: label }));
        return li;
      }));
    }
    renderProof();
    $('btn-ask-api').onclick = askApi;
    const ep = $('earn-proof');
    if (EARN_TX) ep.append('Live on mainnet: ', txLink('sol', EARN_TX));
    else text(ep, 'Run it yourself with no wallet: cli/simulate_earn.py sends this exact transaction through Solana\'s simulator against live mainnet state.');
    try {
      await loadTokens();
      text($('stat-assets'), String(assets.length + 1)); text($('stat-nets'), String(new Set(assets.map((t) => t.blockchain)).size));
    } catch { /* the static numbers stay */ }
  }

  function route() {
    const h = location.hash;
    if (h.startsWith('#s=')) return showReceipt(decodeURIComponent(h.slice(3)));
    if (h.startsWith('#c=')) return showConnectReceipt(h.slice(3));
    if (h.startsWith('#m=')) return showMerchant(h.slice(3));
    if (h.startsWith('#a=')) return startPermanent();
    if (h.startsWith('#p=') || h.startsWith('#to=')) return startPay();
    if (h === '#start') return startOnboarding();
    return startHome();
  }
  // Pay, record and merchant views are whole pages; plain anchors (#create) just scroll.
  window.addEventListener('hashchange', (e) => {
    const was = new URL(e.oldURL).hash;
    if (!ROUTED.test(location.hash) && !ROUTED.test(was)) return;
    // A page that opened this tab must not swap the invoice under the payer.
    if (window.opener) { text($('banner'), 'Another page tried to change this link. Close this tab and open your link again.'); show($('banner')); show($('main'), false); return; }
    location.reload();
  });
  if (window.opener) { text($('banner'), 'Another page opened this tab. Check the amount and address carefully, or open your link in a new tab.'); show($('banner')); }
  route();
})();
