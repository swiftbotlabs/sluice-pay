/* Sluice checkout: pay a Solana merchant in USDC from any chain via Aurora Intents (NEAR Intents).
 * Static page, no backend. Talks only to: Aurora Swap API (quotes, status) and a public Solana RPC (verification).
 * The Aurora API key is a public, non-secret integrator id by design (see docs.intents.aurora.dev, API Keys & Fees).
 */
'use strict';
(() => {
  const AURORA = 'https://intents-api.aurora.dev';
  const API_KEY = '53042395-08f3-4382-a78e-b2208d0397c1'; // public integrator key for this page only (Aurora: keys are non-secret); the server uses its own key
  const RPCS = ['https://solana-mainnet.gateway.tatum.io', 'https://api.mainnet-beta.solana.com'];
  const SOL_USDC = 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const ORIGINS = [
    ['base', 'USDC', 'Base', 'evm', 8453], ['base', 'ETH', 'Base', 'evm', 8453],
    ['arb', 'USDC', 'Arbitrum', 'evm', 42161], ['arb', 'ETH', 'Arbitrum', 'evm', 42161],
    ['eth', 'USDC', 'Ethereum', 'evm', 1], ['eth', 'ETH', 'Ethereum', 'evm', 1],
    ['op', 'USDC', 'Optimism', 'evm', 10], ['pol', 'USDC', 'Polygon', 'evm', 137],
    ['bsc', 'USDT', 'BNB Chain', 'evm', 56], ['sol', 'SOL', 'Solana', 'sol', null],
    ['btc', 'BTC', 'Bitcoin', 'btc', null], ['tron', 'USDT', 'Tron', 'tron', null],
  ];
  const EXPLORER = {
    base: 'https://basescan.org/tx/', arb: 'https://arbiscan.io/tx/', eth: 'https://etherscan.io/tx/',
    op: 'https://optimistic.etherscan.io/tx/', pol: 'https://polygonscan.com/tx/', bsc: 'https://bscscan.com/tx/',
    sol: 'https://solscan.io/tx/', btc: 'https://mempool.space/tx/', tron: 'https://tronscan.org/#/transaction/',
  };
  const MERCHANT_DEMO = '9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR';
  // Real mainnet runs. "Check live" re-reads each one from Aurora and from Solana in your browser.
  const PROOF = [
    { name: 'Success (Base USDC)', chain: 'base', dep: '0x041579bb7dfcdc42b09b50b5809f746981a6b4cc8e46de22acca7e571bdd6f52', addr: '0xd1EFDa88E49e98c3a9881C8CfcB0c9dfED19D8A5', sol: '3uyHowgryQxRWjsC9DrxMSxFd1nvpEtq3xsrR6iGJfodAdsRC6TyVN8Zk1GgUWunsLH1j6dnz9Tz2tsMhu3xiSG2', raw: 500000n, note: '0.50 USDC received; 0.002659 USDC excess refunded' },
    { name: 'Refund (sent too little)', chain: 'base', dep: '0x926b1cce75dac5750c8cbe0364519987aa3d56d93f7bfaae6bad08fe9084b6ed', addr: '0x399E9E3B0013C1D51148F19402d9A5ecC7e0AD56', sol: null, raw: 0n, note: 'refund tx 0x7654c9ed…071b: 0.3976 USDC back to the payer' },
    { name: 'Private payment (Arbitrum ETH)', chain: 'arb', dep: '0x51fdff2ad7247d23f443f9611bd333d8b7398766b57d1e6cde8983d5ac94564a', addr: '0xFAae838d6717EBE699118255Ae94e0a970064CC1', sol: '44GN5eYQhed3UHLkwCXxi2nJU53xeHot1Ff5x4YQNNZn9PG4vy8XVMhrvof6V4fJ9C2SEKCJ9ev8dAXUDZtuB6Cj', raw: 500000n, note: 'Confidential Intents: provider shows no hashes; found on Solana' },
    { name: 'Checkout page (this page)', chain: 'base', dep: '0x1f0c7e5f28450751799f7594f0ba5272b4b883c9efdd95b6c2f812017b240852', addr: '0x6919bC22A44a4E3941318dBa908e7a282C2B22BE', sol: '49Uz6rAsJMQEx2qcX9JdCJqSzCdbpWSKBttYaJNrjaPKjAfZ5qH6SdLr3mwAw34rucxM6hy2i91FcAJe1nVVAxZV', raw: 150000n, note: 'signed pay link -> deposit address + QR -> paid from another wallet -> verified on Solana by the page' },
    { name: 'API call paid by the CLI', chain: 'base', dep: '0x7fb6497012291c7da94c4998f151c4c6740cd9d0df4b2f59bc3619b8105a0708', addr: '0x0497bb48C0335f1D22f147B2983ffDC6dA054042', sol: '45WMgPZthD5cn8RNdrEBKVDD95a8pzZ7sDrU7rZMyAabJBwDSCbZ8oHhhtgioGB4G8jQcitgypadhpTWTtURcMaX', raw: 400000n, note: '402 -> order -> deposit -> verified -> report + signed receipt' },
  ];

  const $ = (id) => document.getElementById(id);
  const show = (el, on = true) => el.classList.toggle('hidden', !on);
  const text = (el, s) => { el.textContent = s; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- base58 / base64url ----------
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58decode(s) {
    if (typeof s !== 'string' || !s || s.length > 100) throw new Error('bad base58');
    let n = 0n;
    for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
    const out = [];
    while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
    for (const c of s) { if (c === '1') out.unshift(0); else break; }
    return new Uint8Array(out);
  }
  function b58encode(bytes) {
    let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
    let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
    return s;
  }
  const isSolAddr = (a) => { try { return b58decode(a).length === 32; } catch { return false; } };
  const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0));

  // ---------- amounts ----------
  function toUnits(dec, decimals) {
    if (!/^\d{1,12}(\.\d{1,18})?$/.test(dec)) throw new Error('bad amount');
    const [i, f = ''] = dec.split('.');
    if (f.length > decimals) throw new Error('too many decimals');
    return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
  }
  function fromUnits(raw, decimals) {
    const v = BigInt(raw); const d = 10n ** BigInt(decimals);
    const f = (v % d).toString().padStart(decimals, '0').replace(/0+$/, '');
    return (v / d).toString() + (f ? '.' + f : '');
  }
  const short = (a) => a && a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-6) : a;

  // ---------- refund address validation ----------
  const FAMILY = {
    evm: /^0x[0-9a-fA-F]{40}$/, btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
    tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  };
  const validRefund = (fam, a) => fam === 'sol' ? isSolAddr(a) : !!(FAMILY[fam] && FAMILY[fam].test(a || ''));

  // ---------- network ----------
  async function aurora(path, body) {
    const url = `${AURORA}${path}/${API_KEY}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
      if (r.status === 429) { await sleep(Math.min(Number(r.headers.get('Retry-After')) || 2, 10) * 1000 + Math.random() * 500); continue; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || `HTTP ${r.status}`);
      return j;
    }
    throw new Error('rate limited, try again in a minute');
  }
  async function rpc(method, params) {
    let last;
    for (const u of RPCS) {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message);
        return j.result;
      } catch (e) { last = e; }
    }
    throw last;
  }

  // ---------- Solana verification (independent of the provider) ----------
  function usdcDelta(tx, owner) {
    const sum = (rows) => (rows || []).filter((r) => r.owner === owner && r.mint === USDC_MINT)
      .reduce((s, r) => s + BigInt(r.uiTokenAmount.amount), 0n);
    return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
  }
  async function verifySig(sig, owner, minRaw, exact) {
    const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    if (!tx || tx.meta.err) return null;
    const d = usdcDelta(tx, owner);
    if (d < minRaw || (exact && d !== minRaw)) return null;
    return { sig, delta: d, slot: tx.slot, blockTime: tx.blockTime };
  }
  async function findCredit(owner, minRaw, notBefore, exact) {
    const accs = await rpc('getTokenAccountsByOwner', [owner, { mint: USDC_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    for (const a of (accs && accs.value) || []) {
      const sigs = await rpc('getSignaturesForAddress', [a.pubkey, { limit: 15, commitment: 'confirmed' }]);
      for (const s of sigs || []) {
        if (s.err) continue;
        if (s.blockTime && s.blockTime < notBefore - 120) break;
        const v = await verifySig(s.signature, owner, minRaw, exact);
        if (v) return v;
      }
    }
    return null;
  }

  // ---------- pay links ----------
  async function parseLink() {
    const h = location.hash.slice(1);
    if (h.startsWith('p=')) {
      const [m, s] = h.slice(2).split('.');
      const msgBytes = unb64u(m); const sig = unb64u(s || '');
      const f = JSON.parse(new TextDecoder().decode(msgBytes));
      let sigOk = null;
      try {
        const key = await crypto.subtle.importKey('raw', b58decode(f.k), { name: 'Ed25519' }, false, ['verify']);
        sigOk = await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, msgBytes);
      } catch { sigOk = null; } // browser without WebCrypto Ed25519
      return { to: f.to, amt: f.amt, ref: f.ref || '', exp: f.exp, signer: f.k, sigOk, signed: true };
    }
    if (h.startsWith('to=')) {
      const q = new URLSearchParams(h);
      return { to: q.get('to'), amt: q.get('amt'), ref: q.get('ref') || '', signed: false };
    }
    return null;
  }

  // ---------- state ----------
  let tokens = []; let invoice = null; let choice = null; let order = null; let stopPoll = false;
  const storeKey = () => 'sluice:' + location.hash.slice(0, 200);
  const save = () => { try { localStorage.setItem(storeKey(), JSON.stringify(order)); } catch { /* private mode */ } };
  const load = () => { try { return JSON.parse(localStorage.getItem(storeKey()) || 'null'); } catch { return null; } };

  async function loadTokens() {
    const d = await aurora('/api/tokens');
    tokens = d.tokens || [];
  }
  const tok = (chain, sym) => tokens.find((t) => t.blockchain === chain && t.symbol === sym);

  function renderOrigins() {
    const box = $('origins'); box.replaceChildren();
    const avail = ORIGINS.filter(([c, s]) => tok(c, s));
    text($('origin-count'), `${avail.length} assets on ${new Set(avail.map((o) => o[0])).size} networks. Pick what you hold.`);
    for (const o of avail) {
      const [c, s, net] = o;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', 'false');
      b.textContent = `${s} · ${net}`;
      b.onclick = () => selectOrigin(o, b);
      box.appendChild(b);
    }
  }

  let estTimer;
  function selectOrigin(o, btn) {
    for (const el of document.querySelectorAll('.chip')) el.setAttribute('aria-checked', 'false');
    btn.setAttribute('aria-checked', 'true');
    choice = { chain: o[0], sym: o[1], net: o[2], fam: o[3], chainId: o[4], token: tok(o[0], o[1]) };
    text($('refund-chain'), o[2]);
    $('refund').placeholder = o[3] === 'evm' ? '0x… (your wallet on ' + o[2] + ')' : 'your ' + o[2] + ' address';
    validate();
    clearTimeout(estTimer);
    text($('estimate'), 'Getting a live quote…');
    estTimer = setTimeout(estimate, 300);
  }

  function quoteBody(dry, refundTo, amountRaw, confidential) {
    return {
      dry, swapType: 'EXACT_OUTPUT', depositType: 'ORIGIN_CHAIN', depositMode: 'SIMPLE', originAsset: choice.token.assetId,
      destinationAsset: SOL_USDC, amount: amountRaw.toString(), slippageTolerance: 100,
      refundTo, refundType: 'ORIGIN_CHAIN', recipient: invoice.to, recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 15 * 60 * 1000).toISOString(), confidentiality: confidential ? 'advanced' : 'public', quoteWaitingTimeMs: 0,
    };
  }
  // For a price preview we need *some* valid refund address; use the buyer's if typed, else a random one (dry quotes move no funds).
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const dummyRefund = (fam) => {
    const typed = $('refund').value.trim();
    if (validRefund(fam, typed)) return typed;
    return { evm: '0x' + [...rnd(20)].map((b) => b.toString(16).padStart(2, '0')).join(''), sol: b58encode(rnd(32)),
      btc: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', tron: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7' }[fam];
  };

  async function estimate() {
    const c = choice;
    try {
      const q = await aurora('/api/quote', quoteBody(true, dummyRefund(c.fam), invoice.raw, false));
      if (choice !== c) return;
      const usd = Number(q.quote.amountInUsd).toFixed(2);
      text($('estimate'), `≈ ${q.quote.amountInFormatted} ${c.sym} on ${c.net} (~$${usd}, all routing fees included). Typical time ~${q.quote.timeEstimate}s.`);
    } catch (e) { if (choice === c) text($('estimate'), routeError(e)); }
  }

  function routeError(e) {
    const m = /try at least (\d+)/.exec(e.message || '');
    if (m) return `This route needs an invoice of at least ${fromUnits(m[1], 6)} USDC. Pick another asset or ask for a larger invoice.`;
    return 'No route right now: ' + e.message;
  }

  function validate() {
    const ok = choice && validRefund(choice.fam, $('refund').value.trim());
    $('btn-quote').disabled = !ok;
  }

  async function getAddress() {
    show($('quote-error'), false);
    const refundTo = $('refund').value.trim();
    const confidential = $('confidential').checked;
    $('btn-quote').disabled = true; text($('btn-quote'), 'Requesting…');
    try {
      // Private payments hide provider tx hashes, so we tag the amount with a few micro-USDC to find it on Solana.
      const raw = confidential ? invoice.raw + BigInt(1 + Math.floor(Math.random() * 998)) : invoice.raw;
      const q = await aurora('/api/quote', quoteBody(false, refundTo, raw, confidential));
      const r = q.quoteRequest || {};
      if (r.recipient !== invoice.to || r.refundTo !== refundTo || r.amount !== raw.toString() || r.destinationAsset !== SOL_USDC) throw new Error('quote did not match the invoice; not showing it');
      order = { createdAt: Math.floor(Date.now() / 1000), chain: choice.chain, sym: choice.sym, net: choice.net, chainId: choice.chainId,
        token: { assetId: choice.token.assetId, decimals: choice.token.decimals, contract: choice.token.contractAddress || null },
        refundTo, confidential, raw: raw.toString(), quote: q.quote, deadline: r.deadline };
      save();
      renderDeposit();
      poll();
    } catch (e) {
      text($('quote-error'), routeError(e)); show($('quote-error'));
    } finally { text($('btn-quote'), 'Get deposit address'); validate(); }
  }

  function renderDeposit() {
    const q = order.quote;
    show($('step-choose'), false); show($('step-deposit')); show($('timeline'));
    text($('d-chain'), order.net); text($('d-asset'), order.sym);
    text($('d-amount'), `${q.amountInFormatted} ${order.sym}`);
    text($('d-address'), q.depositAddress);
    text($('d-req'), `Send only ${order.sym} from the ${order.net} network to this address, exactly ${q.amountInFormatted} ${order.sym}, before ${new Date(order.deadline).toLocaleTimeString()}. ` +
      'Sending another asset or using another network may result in permanent loss of funds.');
    const facts = [
      `Merchant receives exactly ${fromUnits(order.raw, 6)} USDC on Solana`,
      `Less than ${fromUnits(q.minAmountIn, order.token.decimals)} ${order.sym} is refunded to ${short(order.refundTo)} after the deadline`,
      'Anything above the quoted amount is refunded after settlement',
      `Routing and network fees are already included (Solana delivery fee ${fromUnits(q.withdrawFee || '0', 6)} USDC)`,
      order.confidential ? 'Private payment: your source wallet is not published with the Solana payment' : `Typical time ~${q.timeEstimate}s after your deposit confirms`,
    ];
    $('d-facts').replaceChildren(...facts.map((f) => { const li = document.createElement('li'); li.textContent = f; return li; }));
    const qr = qrcode(0, 'M'); qr.addData(q.depositAddress); qr.make();
    const img = new Image(); img.src = qr.createDataURL(5, 8); img.alt = 'QR: ' + q.depositAddress;
    $('qr').replaceChildren(img);
    text($('qr-caption'), `${order.sym} on ${order.net} only`);
    const evm = order.chainId && window.ethereum;
    show($('btn-wallet'), !!evm);
    text($('wallet-note'), evm ? '' : (order.chainId ? 'No browser wallet found: send from any wallet or exchange that supports ' + order.net + '.' : 'Send from your ' + order.net + ' wallet.'));
  }

  async function payWithWallet() {
    const eth = window.ethereum; const q = order.quote;
    try {
      const [from] = await eth.request({ method: 'eth_requestAccounts' });
      if (from.toLowerCase() !== order.refundTo.toLowerCase()) {
        text($('wallet-note'), 'Heads up: the connected wallet differs from your refund address. Refunds still go to ' + short(order.refundTo) + '.');
      }
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + order.chainId.toString(16) }] });
      const amt = BigInt(q.amountIn);
      const tx = order.token.contract
        ? { from, to: order.token.contract, data: '0xa9059cbb' + q.depositAddress.slice(2).toLowerCase().padStart(64, '0') + amt.toString(16).padStart(64, '0') }
        : { from, to: q.depositAddress, value: '0x' + amt.toString(16) };
      const h = await eth.request({ method: 'eth_sendTransaction', params: [tx] });
      order.depositTx = h; save();
      text($('wallet-note'), 'Sent: ' + short(h));
      if (!order.confidential) aurora('/api/deposit/submit', { txHash: h, depositAddress: q.depositAddress }).catch(() => {});
    } catch (e) { text($('wallet-note'), 'Wallet: ' + (e.message || e)); }
  }

  function setStep(k, state) {
    const order_ = ['AWAIT', 'SEEN', 'ROUTE', 'SOLANA'];
    const idx = order_.indexOf(k);
    for (const li of $('timeline').children) {
      const i = order_.indexOf(li.dataset.k);
      li.className = i < idx ? 'done' : i === idx ? (state || 'active') : '';
    }
  }

  function link(href, label) { const a = document.createElement('a'); a.href = href; a.textContent = label; a.target = '_blank'; a.rel = 'noopener'; return a; }

  function finish(kind, s, proof) {
    stopPoll = true; save();
    text($('countdown'), ''); if (kind === 'ok' || kind === 'refund') show($('step-deposit'), false);
    const box = $('result'); box.replaceChildren(); box.className = 'result ' + kind; show(box);
    const h = document.createElement('h3'); const p = document.createElement('p'); const ul = document.createElement('ul');
    const d = (s && s.swapDetails) || {};
    if (kind === 'ok') {
      setStep('SOLANA', 'done');
      h.textContent = 'Paid. Verified on Solana.';
      p.textContent = `${invoice.to.slice(0, 6)}… received ${fromUnits(proof.delta, 6)} USDC. We read this directly from Solana, not from the payment provider.`;
      const li = document.createElement('li'); li.append('Solana settlement: ', link(EXPLORER.sol + proof.sig, short(proof.sig))); ul.append(li);
    } else if (kind === 'refund') {
      h.textContent = 'Refunded. Nothing was charged.';
      p.textContent = `${d.refundedAmountFormatted || ''} ${order.sym} went back to ${short(order.refundTo)}${d.refundReason ? ' (' + d.refundReason.toLowerCase().replace(/_/g, ' ') + ')' : ''}.`;
    } else {
      h.textContent = kind === 'expired' ? 'Expired. Nothing was sent.' : 'Payment failed';
      p.textContent = kind === 'expired' ? 'Get a new deposit address to try again.' : 'If funds left your wallet, they are returned to your refund address.';
    }
    for (const t of d.originChainTxHashes || []) {
      const li = document.createElement('li'); li.append(`${order.net} tx: `, link(EXPLORER[order.chain] + t.hash, short(t.hash))); ul.append(li);
    }
    box.append(h, p, ul);
  }

  async function poll() {
    stopPoll = false; let solTries = 0;
    while (!stopPoll) {
      const left = Math.max(0, Math.floor((new Date(order.deadline) - Date.now()) / 1000));
      text($('countdown'), left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : 'deadline passed');
      try {
        const s = await fetch(`${AURORA}/api/status/${API_KEY}?depositAddress=${encodeURIComponent(order.quote.depositAddress)}`).then((r) => r.json());
        const st = s.status;
        if (st === 'PENDING_DEPOSIT') { setStep('AWAIT'); if (!left && Date.now() - new Date(order.deadline) > 10 * 60 * 1000) return finish('expired', s); }
        else if (st === 'KNOWN_DEPOSIT_TX') setStep('SEEN');
        else if (st === 'INCOMPLETE_DEPOSIT') { setStep('SEEN', 'warn'); text($('countdown'), 'deposit below the required amount: top up before the deadline or it is refunded'); }
        else if (st === 'PROCESSING') setStep('ROUTE');
        else if (st === 'REFUNDED') return finish('refund', s);
        else if (st === 'FAILED') return finish('fail', s);
        else if (st === 'SUCCESS') {
          setStep('SOLANA');
          const raw = BigInt(order.raw);
          let proof = null;
          for (const t of (s.swapDetails && s.swapDetails.destinationChainTxHashes) || []) { proof = await verifySig(t.hash, invoice.to, raw, false); if (proof) break; }
          if (!proof) proof = await findCredit(invoice.to, raw, order.createdAt, order.confidential);
          if (proof) return finish('ok', s, proof);
          if (++solTries > 20) { text($('countdown'), 'provider reports success; Solana credit not visible yet'); }
        }
      } catch (e) { text($('countdown'), 'reconnecting…'); }
      await sleep(6000);
    }
  }

  // ---------- create links ----------
  function linkFields() {
    const to = $('c-to').value.trim(); const amt = $('c-amt').value.trim(); const ref = $('c-ref').value.trim();
    if (!isSolAddr(to)) throw new Error('Enter a valid Solana address');
    if (!/^\d{1,9}(\.\d{1,6})?$/.test(amt) || Number(amt) < 0.15) throw new Error('Amount must be at least 0.15 USDC (cross-chain minimum), up to 6 decimals');
    if (!/^[\w.-]{0,40}$/.test(ref)) throw new Error('Reference: letters, digits, . _ - only');
    return { to, amt, ref };
  }
  const base = () => location.origin + location.pathname;
  function outLink(url, note) { text($('c-link'), url); text($('c-note'), note); show($('c-out')); show($('c-error'), false); }
  function makeLink() {
    try { const f = linkFields(); outLink(`${base()}#${new URLSearchParams({ to: f.to, amt: f.amt, ref: f.ref })}`, 'Unsigned link. Anyone could edit it, so the payer will see an "unsigned" notice. Sign it with Phantom to make it tamper-proof.'); }
    catch (e) { text($('c-error'), e.message); show($('c-error')); }
  }
  async function makeSigned() {
    try {
      const f = linkFields();
      const ph = (window.phantom && window.phantom.solana) || window.solana;
      if (!ph || !ph.signMessage) throw new Error('Phantom (or a wallet with signMessage) is needed to sign');
      const { publicKey } = await ph.connect();
      const k = publicKey.toString();
      if (k !== f.to) throw new Error('Connect the wallet that receives the USDC (' + short(f.to) + ')');
      const msg = new TextEncoder().encode(JSON.stringify({ amt: f.amt, exp: Math.floor(Date.now() / 1000) + 7 * 86400, k, ref: f.ref, to: f.to, v: 1 }));
      const { signature } = await ph.signMessage(msg, 'utf8');
      outLink(`${base()}#p=${b64u(msg)}.${b64u(signature)}`, 'Signed by the receiving wallet. If anyone changes the amount or address, the checkout refuses the link. Valid 7 days.');
    } catch (e) { text($('c-error'), e.message); show($('c-error')); }
  }

  function renderProof() {
    const t = document.createElement('table');
    const hd = t.createTHead().insertRow();
    for (const c of ['Run', 'Deposit', 'Solana settlement', 'Live check']) { const th = document.createElement('th'); th.textContent = c; hd.appendChild(th); }
    const tb = t.createTBody();
    for (const p of PROOF) {
      const r = tb.insertRow();
      const c0 = r.insertCell(); c0.textContent = p.name; const sm = document.createElement('div'); sm.className = 'small muted'; sm.textContent = p.note; c0.append(sm);
      r.insertCell().append(link(EXPLORER[p.chain] + p.dep, short(p.dep)));
      const c = r.insertCell(); if (p.sol) c.append(link(EXPLORER.sol + p.sol, short(p.sol))); else c.textContent = 'none (refunded)';
      const cl = r.insertCell(); const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ghost small'; btn.textContent = 'Check live';
      const out = document.createElement('div'); out.className = 'small';
      btn.onclick = async () => {
        btn.disabled = true; text(out, 'Asking Aurora and Solana…');
        try {
          const st = await fetch(`${AURORA}/api/status/${API_KEY}?depositAddress=${encodeURIComponent(p.addr)}`).then((x) => x.json());
          let msg = `Aurora: ${st.status}`;
          const d = st.swapDetails || {};
          if (st.status === 'REFUNDED') msg += ` (${d.refundedAmountFormatted || '?'} refunded, ${String(d.refundReason || '').toLowerCase().replace(/_/g, ' ')})`;
          if (p.sol) {
            const v = await verifySig(p.sol, MERCHANT_DEMO, p.raw, false);
            msg += v ? ` · Solana: merchant +${fromUnits(v.delta, 6)} USDC ✓` : ' · Solana: not verified';
          }
          text(out, msg);
        } catch (e) { text(out, 'Check failed: ' + e.message); }
        btn.disabled = false;
      };
      cl.append(btn, out);
    }
    $('proof-table').replaceChildren(t);
  }

  async function init() {
    renderProof();
    $('btn-link').onclick = makeLink; $('btn-sign').onclick = makeSigned;
    $('btn-copy-link').onclick = () => navigator.clipboard.writeText($('c-link').textContent);
    invoice = await parseLink().catch(() => null);
    if (!invoice) return;
    show($('pay')); $('pay').scrollIntoView();
    try {
      if (!isSolAddr(invoice.to)) throw new Error('This link has an invalid Solana address.');
      invoice.raw = toUnits(String(invoice.amt), 6);
      if (invoice.raw < 100000n) throw new Error('Amount below the 0.10 USDC minimum.');
      if (invoice.exp && invoice.exp < Date.now() / 1000) throw new Error('This pay link has expired. Ask the merchant for a new one.');
    } catch (e) { text($('inv-badge'), e.message); $('inv-badge').className = 'badge bad'; show($('step-choose'), false); return; }
    text($('inv-amount'), (() => { const v = fromUnits(invoice.raw, 6); const [i, f = ''] = v.split('.'); return i + '.' + f.padEnd(2, '0'); })()); text($('inv-to'), invoice.to); text($('inv-ref'), invoice.ref || '—');
    const bd = $('inv-badge');
    if (invoice.signed && invoice.sigOk === false) { text(bd, 'Tampered link: the signature does not match. Do not pay.'); bd.className = 'badge bad'; show($('step-choose'), false); return; }
    if (invoice.signed && invoice.sigOk && invoice.signer === invoice.to) { text(bd, '✓ Signed by the receiving wallet'); bd.className = 'badge good'; }
    else if (invoice.signed && invoice.sigOk) { text(bd, 'Signed by ' + short(invoice.signer) + ' (not the receiving wallet)'); bd.className = 'badge warn'; }
    else if (invoice.signed) { text(bd, 'Signed link (this browser cannot check Ed25519 signatures)'); bd.className = 'badge warn'; }
    else { text(bd, 'Unsigned link: check the address with the merchant'); bd.className = 'badge warn'; }
    $('refund').oninput = validate; $('btn-quote').onclick = getAddress;
    $('btn-copy').onclick = () => navigator.clipboard.writeText($('d-address').textContent);
    $('btn-wallet').onclick = payWithWallet;
    $('btn-tx').onclick = () => { const h = $('txhash').value.trim(); if (/^0x[0-9a-fA-F]{64}$/.test(h) && order && !order.confidential) aurora('/api/deposit/submit', { txHash: h, depositAddress: order.quote.depositAddress }).catch(() => {}); };
    await loadTokens().catch((e) => text($('origin-count'), 'Could not load assets: ' + e.message));
    renderOrigins();
    const prev = load();
    if (prev && prev.quote && prev.quote.depositAddress) { order = prev; renderDeposit(); poll(); }
  }
  window.addEventListener('hashchange', () => location.reload());
  init();
})();
