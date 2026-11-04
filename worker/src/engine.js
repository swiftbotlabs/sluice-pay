// Sluice hosted pay-per-call API: the 402 flow of sluice/server.py + sluice/engine.py, rebuilt for Cloudflare Workers.
//   402 terms -> order (Aurora EXACT_OUTPUT quote to the merchant) -> buyer pays from their own wallet
//   -> Aurora status is only a hint -> the Solana credit is read and checked here -> deliver exactly once + signed receipt.
// Pure logic: storage (db), upstream calls (up), the receipt signer and the clock are passed in, so it runs under node:test.
// Money rules are the checkout's own: docs/core.js (verifyUsdc, txRoles, validRefund) is imported, not copied.
import core from '../../docs/core.js';

export const SOL_USDC = core.SOL_USDC;
export const USDC_MINT = core.USDC_MINT;
// Curated origins (same list as sluice/engine.py ORIGINS): key, Aurora chain slug, symbol, label, refund address family
export const ORIGINS = [
  ['base:USDC', 'base', 'USDC', 'USDC on Base', 'evm'], ['base:ETH', 'base', 'ETH', 'ETH on Base', 'evm'],
  ['arb:USDC', 'arb', 'USDC', 'USDC on Arbitrum', 'evm'], ['arb:ETH', 'arb', 'ETH', 'ETH on Arbitrum', 'evm'],
  ['eth:USDC', 'eth', 'USDC', 'USDC on Ethereum', 'evm'], ['eth:ETH', 'eth', 'ETH', 'ETH on Ethereum', 'evm'],
  ['op:USDC', 'op', 'USDC', 'USDC on Optimism', 'evm'], ['pol:USDC', 'pol', 'USDC', 'USDC on Polygon', 'evm'],
  ['bsc:USDT', 'bsc', 'USDT', 'USDT on BNB Chain', 'evm'], ['sol:SOL', 'sol', 'SOL', 'SOL on Solana', 'sol'],
  ['btc:BTC', 'btc', 'BTC', 'BTC on Bitcoin', 'btc'], ['tron:USDT', 'tron', 'USDT', 'USDT on Tron', 'tron'],
];
export const STATUSES = new Set(['KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED']);
const PROVIDER_TO_STATE = { PENDING_DEPOSIT: 'AWAITING_DEPOSIT', KNOWN_DEPOSIT_TX: 'DEPOSIT_SEEN', INCOMPLETE_DEPOSIT: 'DEPOSIT_SEEN', PROCESSING: 'PROCESSING', REFUNDED: 'REFUNDED', FAILED: 'FAILED' };
const ALLOWED = {
  AWAITING_DEPOSIT: ['DEPOSIT_SEEN', 'PROCESSING', 'SETTLED', 'REFUNDED', 'FAILED', 'EXPIRED'],
  DEPOSIT_SEEN: ['PROCESSING', 'SETTLED', 'REFUNDED', 'FAILED'], PROCESSING: ['SETTLED', 'REFUNDED', 'FAILED'],
  SETTLED: ['DELIVERED'], DELIVERED: [], REFUNDED: [], FAILED: [], EXPIRED: ['SETTLED', 'REFUNDED', 'FAILED'],
};
const OPEN = "('AWAITING_DEPOSIT','DEPOSIT_SEEN','PROCESSING')";
const BUYER_COPY = {
  AWAITING_DEPOSIT: 'Waiting for your deposit', DEPOSIT_SEEN: 'Deposit detected', PROCESSING: 'Routing to Solana',
  SETTLED: 'Paid: verified on Solana', DELIVERED: 'Paid and delivered', REFUNDED: 'Refunded to your address',
  FAILED: 'Payment failed', EXPIRED: 'Expired: nothing was charged',
};
// Dry quotes move nothing but need a refund target; like the checkout (docs/app.js dryRefund) a random same-chain address is used.
const sampleEvm = () => '0x' + core.toHex(crypto.getRandomValues(new Uint8Array(20)));

export const SCHEMA = `CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, created INTEGER NOT NULL, updated INTEGER NOT NULL, resource TEXT NOT NULL, params TEXT NOT NULL,
  request_hash TEXT NOT NULL, price_raw INTEGER NOT NULL, merchant TEXT NOT NULL, origin_key TEXT NOT NULL, origin_asset TEXT NOT NULL,
  decimals INTEGER NOT NULL, label TEXT NOT NULL, refund_to TEXT NOT NULL, deposit_address TEXT UNIQUE, deposit_memo TEXT,
  amount_in TEXT, min_amount_in TEXT, deadline TEXT, quote TEXT, state TEXT NOT NULL, provider_status TEXT, provider_view TEXT,
  deposit_tx TEXT, settle_sig TEXT UNIQUE, settle_proof TEXT, delivered_body TEXT, receipt TEXT, last_polled REAL NOT NULL DEFAULT 0,
  client TEXT);
CREATE INDEX IF NOT EXISTS orders_state ON orders(state);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`;

export class OrderError extends Error {
  constructor(msg, http = 400, extra) { super(msg); this.http = http; this.extra = extra; }
}

// ---- canonical JSON + hashes (byte-identical to sluice/receipts.py canonical()) ----
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('canonical: non-integer number');
  return JSON.stringify(v === undefined ? null : v);
}
const enc = new TextEncoder();
export async function sha256hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? enc.encode(bytes) : bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const requestHash = (resource, params) => sha256hex(canonical({ resource, params }));
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
const decimal = (raw, dec) => core.fromUnits(BigInt(raw), dec);
export const ORDER_RE = /^ord_[A-Za-z0-9]{16}$/;
export function newOrderId() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const out = []; const buf = new Uint8Array(64);
  while (out.length < 16) { crypto.getRandomValues(buf); for (const b of buf) if (b < 248 && out.length < 16) out.push(A[b % 62]); }
  return 'ord_' + out.join('');
}

/** Ed25519 receipt signer from a 64-byte Solana-style secret (seed || public key), base58. The key signs receipts only. */
export async function makeSigner(secretB58) {
  const raw = core.b58decode(String(secretB58 || '').trim());
  if (raw.length !== 64) throw new Error('receipt secret must be 64 bytes (seed + public key)');
  const b64u = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let key; let ok = false;
  try {
    key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', d: b64u(raw.slice(0, 32)), x: b64u(raw.slice(32)) }, { name: 'Ed25519' }, false, ['sign']);
    const pub = await crypto.subtle.importKey('raw', raw.slice(32), { name: 'Ed25519' }, false, ['verify']);
    const probe = enc.encode('sluice receipt key self-check');
    ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, probe)), probe);
  } catch { ok = false; }
  if (!ok) throw new Error('receipt secret and public key do not match');
  const pubkey = core.b58encode(raw.slice(32));
  return { pubkey, async sign(payload) {
    const body = { ...payload, signer: pubkey };
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, enc.encode(canonical(body))));
    return { payload: body, signature: core.b58encode(sig) };
  } };
}

/**
 * db: { all(sql, ...args) -> rows }  (any statement; a UNIQUE violation throws; UPDATE ... RETURNING id tells whether a row changed)
 * up: { tokens(), quote(body), status(addr, memo), submitDeposit(addr, tx, memo), solTx(sig), report(address) }
 * cfg: { merchant, priceRaw, deadlineS, graceS, maxOpen, maxOpenPerClient, statusMinS }
 */
export function makeEngine({ db, up, signer, cfg, now = () => Date.now() }) {
  const C = { deadlineS: 900, graceS: 1800, maxOpen: 50, maxOpenPerClient: 5, statusMinS: 6, ...cfg };
  if (!core.isSolAddr(C.merchant)) throw new Error('merchant must be a Solana address');
  const price = BigInt(C.priceRaw);
  if (price < 100000n || price > 5000000n) throw new Error('price out of range');
  if (!(C.deadlineS >= 300 && C.deadlineS <= 3600)) throw new Error('deadline out of range');
  const sec = () => Math.floor(now() / 1000);
  const inflight = new Map();
  let tokenCache = null; let tokenAt = 0; const dryCache = new Map();

  async function origins() {
    if (!tokenCache || now() - tokenAt > 600000) {
      const t = await up.tokens();
      if (!Array.isArray(t)) throw new OrderError('payment provider unavailable', 503);
      tokenCache = t; tokenAt = now();
    }
    const out = [];
    for (const [key, chain, sym, label, fam] of ORIGINS) {
      const t = tokenCache.find((x) => x && x.blockchain === chain && x.symbol === sym);
      if (t && typeof t.assetId === 'string' && Number.isInteger(t.decimals)) out.push({ key, label, assetId: t.assetId, decimals: t.decimals, price_usd: typeof t.price === 'number' ? t.price : null, refund_family: fam });
    }
    return out;
  }
  async function origin(key) {
    const o = (await origins()).find((x) => x.key === key);
    if (!o) throw new OrderError('unsupported pay_with; see /api/origins');
    return o;
  }
  function quoteBody(o, refundTo, dry, sessionId) {
    const dl = new Date(now() + C.deadlineS * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
    const b = { dry, swapType: 'EXACT_OUTPUT', depositType: 'ORIGIN_CHAIN', depositMode: 'SIMPLE', originAsset: o.assetId, destinationAsset: SOL_USDC,
      amount: price.toString(), slippageTolerance: 100, refundTo, refundType: 'ORIGIN_CHAIN', recipient: C.merchant, recipientType: 'DESTINATION_CHAIN',
      deadline: dl, confidentiality: 'public', quoteWaitingTimeMs: 0 };
    if (sessionId) b.sessionId = sessionId;
    return b;
  }
  /** The quote must echo exactly what we asked for, or it is discarded (sluice/aurora.py quote()). */
  function checkQuote(q, body) {
    if (!q || typeof q !== 'object' || !q.quote || typeof q.quote !== 'object') throw new OrderError('quote failed: unexpected payload', 502);
    const qr = q.quoteRequest || {};
    for (const k of ['recipient', 'refundTo', 'originAsset', 'destinationAsset', 'amount', 'swapType']) {
      if (qr[k] !== body[k]) throw new OrderError(`quote failed: echo mismatch on ${k}`, 502);
    }
    if ((qr.appFees || []).reduce((n, f) => n + Number((f && f.fee) || 0), 0) > 30) throw new OrderError('quote failed: fee above 30 bps', 502);
    const qq = q.quote;
    if (!/^\d{1,40}$/.test(String(qq.amountIn || '')) || BigInt(qq.amountOut || 0) !== price) throw new OrderError('quote failed: amounts', 502);
    return qq;
  }

  async function paymentRequired(resource, payWith) {
    if (resource !== 'report') throw new OrderError('unknown resource', 404);
    const os = await origins();
    const terms = {
      error: 'payment_required',
      price: { amount: decimal(price, 6), asset: 'USDC', chain: 'solana', mint: USDC_MINT, recipient: C.merchant },
      how_to_pay: { create_order: 'POST /api/orders', status: 'GET /api/orders/{id}', then: 'GET this URL again with header X-Sluice-Order: <id>',
        rule: 'Delivered only after the USDC credit to the merchant is read from Solana; the response carries a receipt signed with receipt_key.' },
      accepts: os.map((o) => o.key), rails: ['swap'], receipt_key: signer.pubkey,
    };
    const o = os.find((x) => x.key === (payWith || 'base:USDC'));
    if (o && o.refund_family === 'evm') {
      const hit = dryCache.get(o.key);
      if (hit && now() - hit.t < 60000) terms.indicative = hit.v;
      else {
        try {
          const body = quoteBody(o, sampleEvm(), true);
          const qq = checkQuote(await up.quote(body), body);
          const v = { pay_with: o.key, send_about: decimal(qq.amountIn, o.decimals), asset: o.label, usd: qq.amountInUsd || null,
            at: new Date(now()).toISOString(), note: 'Indicative dry quote; your order gets its own quote and deposit address.' };
          dryCache.set(o.key, { t: now(), v }); terms.indicative = v;
        } catch { terms.indicative = null; }
      }
    }
    return terms;
  }

  const get = (oid) => {
    if (!ORDER_RE.test(oid || '')) throw new OrderError('bad order id', 404);
    const r = db.all('SELECT * FROM orders WHERE id=?', oid)[0];
    if (!r) throw new OrderError('no such order', 404);
    return r;
  };
  const countOpen = (client) => Number(db.all(`SELECT COUNT(*) AS n FROM orders WHERE state IN ${OPEN}` + (client ? ' AND client=?' : ''), ...(client ? [client] : []))[0].n);
  function transition(o, next, fields = {}) {
    if (o.state === next || !ALLOWED[o.state].includes(next)) return false;
    const sets = Object.keys(fields).map((k) => `${k}=?`);
    return db.all(`UPDATE orders SET state=?, updated=?${sets.length ? ',' + sets.join(',') : ''} WHERE id=? AND state=? RETURNING id`, next, sec(), ...Object.values(fields), o.id, o.state).length === 1;
  }

  function validateParams(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some((k) => k !== 'address')) throw new OrderError('params must be {address}');
    if (typeof params.address !== 'string' || !core.isSolAddr(params.address)) throw new OrderError('address must be a Solana public key');
    return { address: params.address };
  }

  async function createOrder(d, client) {
    const allowed = new Set(['resource', 'params', 'pay_with', 'refund_to', 'confidential', 'rail']);
    if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some((k) => !allowed.has(k))) throw new OrderError('unknown fields');
    if (d.resource !== 'report') throw new OrderError('unknown resource', 404);
    const params = validateParams(d.params);
    if (d.confidential === true || (d.rail !== undefined && d.rail !== 'swap')) {
      throw new OrderError('this hosted endpoint takes the Swap API rail with public quotes; private payments and the Intents Connect rail run on the self-hosted server (python3 -m sluice.server)');
    }
    if (typeof d.pay_with !== 'string' || typeof d.refund_to !== 'string' || d.refund_to.length > 100) throw new OrderError('pay_with and refund_to are required');
    if (countOpen() >= C.maxOpen) throw new OrderError('too many open orders, try again later', 503);
    if (client && countOpen(client) >= C.maxOpenPerClient) throw new OrderError('you have too many unpaid orders; pay or wait for them to expire', 429);
    const o = await origin(d.pay_with);
    if (!core.validRefund(o.refund_family, d.refund_to)) throw new OrderError(`refund_to must be your own address on the paying chain (${o.refund_family})`);
    const oid = newOrderId();
    const body = quoteBody(o, d.refund_to, false, oid);
    let q;
    try { q = await up.quote(body); } catch (e) { throw new OrderError(`quote failed: ${String((e && e.message) || e).slice(0, 160)}`, 502); }
    const qq = checkQuote(q, body);
    if (!core.isDepositAddr(qq.depositAddress || '') || (o.refund_family === 'evm' && !core.isEvmAddr(qq.depositAddress))) throw new OrderError('quote failed: deposit address', 502);
    const memo = typeof qq.depositMemo === 'string' && /^[A-Za-z0-9]{1,64}$/.test(qq.depositMemo) ? qq.depositMemo : null;
    const t = sec();
    db.all(`INSERT INTO orders (id,created,updated,resource,params,request_hash,price_raw,merchant,origin_key,origin_asset,decimals,label,refund_to,
      deposit_address,deposit_memo,amount_in,min_amount_in,deadline,quote,state,client) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    oid, t, t, 'report', canonical(params), await requestHash('report', params), Number(price), C.merchant, o.key, o.assetId, o.decimals, o.label, d.refund_to,
    qq.depositAddress, memo, String(qq.amountIn), String(qq.minAmountIn || ''), String((q.quoteRequest || {}).deadline || body.deadline),
    JSON.stringify({ quote: qq, quoteRequest: q.quoteRequest || {} }), 'AWAITING_DEPOSIT', client || null);
    return view(get(oid));
  }

  function summarize(s) {
    const d = s.swapDetails || {}; const roles = core.txRoles(d);
    const num = (x) => (typeof x === 'string' && /^\d+(\.\d+)?$/.test(x) ? x : null);
    return { status: s.status, updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt.slice(0, 40) : null, amountIn: num(d.amountInFormatted),
      amountOut: num(d.amountOutFormatted), depositedAmount: num(d.depositedAmountFormatted), refundedAmount: num(d.refundedAmountFormatted),
      refundReason: typeof d.refundReason === 'string' ? d.refundReason.slice(0, 80) : null, originTx: roles.deposit ? [roles.deposit] : [],
      solanaTx: roles.solana.slice(0, 4), refundTx: roles.refunds.slice(0, 4), topupTx: roles.topups.slice(0, 4) };
  }

  async function settle(o, sigs) {
    for (const sig of sigs) {
      let tx;
      try { tx = await up.solTx(sig); } catch { continue; }
      const v = tx && core.verifyUsdc(tx, o.merchant, BigInt(o.price_raw), false, o.created);
      if (!v) continue;
      const proof = { sig, slot: tx.slot, blockTime: tx.blockTime || null, delta: Number(v.delta), owner: o.merchant, mint: USDC_MINT, explorer: 'https://solscan.io/tx/' + sig, commitment: 'confirmed' };
      try {
        const r = db.all(`UPDATE orders SET state='SETTLED', settle_sig=?, settle_proof=?, updated=? WHERE id=? AND state IN ('AWAITING_DEPOSIT','DEPOSIT_SEEN','PROCESSING','EXPIRED') RETURNING id`,
          sig, JSON.stringify(proof), sec(), o.id);
        if (r.length === 1) return true;
      } catch { /* UNIQUE(settle_sig): this Solana transaction already paid another order */ }
    }
    const cur = get(o.id);
    if (cur.state !== 'PROCESSING' && cur.state !== 'SETTLED' && cur.state !== 'DELIVERED') transition(cur, 'PROCESSING');
    return false;
  }

  async function refresh(oid, force = false) {
    let o = get(oid);
    if (['SETTLED', 'DELIVERED', 'REFUNDED', 'FAILED'].includes(o.state)) return view(o);
    const interval = o.state === 'EXPIRED' ? 300 : C.statusMinS;
    if ((!force || o.state === 'EXPIRED') && now() / 1000 - o.last_polled < interval) return view(o);
    db.all('UPDATE orders SET last_polled=? WHERE id=?', now() / 1000, oid);
    let s;
    try {
      s = await up.status(o.deposit_address, o.deposit_memo);
      if (!s || !STATUSES.has(s.status)) throw new Error('unknown status');
    } catch (e) {
      return { ...view(get(oid)), warning: `payment provider unreachable: ${String((e && e.message) || e).slice(0, 100)}` };
    }
    const pv = summarize(s);
    db.all('UPDATE orders SET provider_status=?, provider_view=? WHERE id=?', pv.status, JSON.stringify(pv), oid);
    o = get(oid);
    if (pv.status === 'SUCCESS') await settle(o, pv.solanaTx);
    else if (pv.status === 'PENDING_DEPOSIT' && o.state === 'AWAITING_DEPOSIT' && pastDeadline(o)) transition(o, 'EXPIRED');
    else if (PROVIDER_TO_STATE[pv.status]) transition(o, PROVIDER_TO_STATE[pv.status]);
    return view(get(oid));
  }
  const pastDeadline = (o) => { const t = Date.parse(o.deadline || ''); return Number.isFinite(t) && now() > t + C.graceS * 1000; };

  async function noteDeposit(oid, txHash) {
    const o = get(oid);
    if (!/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{43,90}|[0-9a-fA-F]{64})$/.test(txHash || '')) throw new OrderError('bad tx hash');
    if (!o.deposit_tx) db.all('UPDATE orders SET deposit_tx=? WHERE id=? AND deposit_tx IS NULL', txHash, oid);
    try { await up.submitDeposit(o.deposit_address, txHash, o.deposit_memo); } catch { /* optional speed-up only */ }
    return refresh(oid, now() / 1000 - o.last_polled > C.statusMinS);
  }

  async function makeReceipt(o, bodyText) {
    const proof = JSON.parse(o.settle_proof || '{}');
    return signer.sign({ v: 1, kind: 'sluice.receipt', order: o.id, rail: 'swap', resource: o.resource, request_hash: o.request_hash,
      body_sha256: await sha256hex(bodyText), price: { amount: Number(o.price_raw), asset: 'USDC', chain: 'solana', mint: USDC_MINT },
      merchant: o.merchant, deposit_address: o.deposit_address, origin_asset: o.origin_asset, deposit_tx: o.deposit_tx || (JSON.parse(o.provider_view || '{}').originTx || [])[0] || null,
      solana_tx: o.settle_sig, solana_slot: proof.slot ?? null, merchant_delta: proof.delta ?? null, reference: null, issued_at: sec() });
  }

  /** Exactly once: one producer per order in this instance, and the stored body + receipt are written only over a SETTLED row. */
  async function deliver(oid, resource, params) {
    let o = get(oid);
    if (resource !== 'report') throw new OrderError('unknown resource', 404);
    const p = validateParams(params);
    if (o.resource !== resource || o.request_hash !== (await requestHash(resource, p))) throw new OrderError('this order paid for a different request', 409);
    if (o.state !== 'SETTLED' && o.state !== 'DELIVERED') {
      await refresh(oid, true); o = get(oid);
      if (o.state !== 'SETTLED' && o.state !== 'DELIVERED') throw new OrderError(`not paid yet (${o.state})`, 402);
    }
    if (o.state === 'SETTLED') {
      if (!inflight.has(oid)) {
        inflight.set(oid, (async () => {
          const rep = await up.report(JSON.parse(o.params).address);
          const bodyText = JSON.stringify(sortDeep(rep), null, 2);
          const cur = get(oid);
          if (cur.state !== 'SETTLED') return;
          const receipt = JSON.stringify(await makeReceipt(cur, bodyText));
          db.all(`UPDATE orders SET delivered_body=?, receipt=?, state='DELIVERED', updated=? WHERE id=? AND state='SETTLED' AND delivered_body IS NULL`, bodyText, receipt, sec(), oid);
        })().finally(() => inflight.delete(oid)));
      }
      try { await inflight.get(oid); } catch { throw new OrderError('paid; the report could not be built right now, retry in a moment (you will not pay again)', 503); }
      o = get(oid);
    }
    if (o.state !== 'DELIVERED' || o.delivered_body == null) throw new OrderError('delivery pending, retry', 503);
    return { body: o.delivered_body, receipt: JSON.parse(o.receipt) };
  }

  function view(o) {
    const pv = JSON.parse(o.provider_view || '{}'); const proof = o.settle_proof ? JSON.parse(o.settle_proof) : null;
    const amt = decimal(o.amount_in || '0', o.decimals);
    const v = {
      order_id: o.id, rail: 'swap', state: o.state, message: BUYER_COPY[o.state], resource: o.resource, confidential: false,
      price: { amount: decimal(o.price_raw, 6), asset: 'USDC', chain: 'solana', recipient: o.merchant },
      deposit: { address: o.deposit_address, memo: o.deposit_memo, pay_with: o.label, amount: amt, amount_raw: o.amount_in, deadline: o.deadline,
        transfer_requirements: `Send only ${o.label.replace(' on ', ' from the ')} network to this address. Send exactly ${amt} before ${o.deadline}. `
          + `Less is refunded to ${o.refund_to} after the deadline; any excess is refunded after settlement. Other assets or networks may be lost.` },
      refund_to: o.refund_to, provider_status: o.provider_status, provider: pv, deposit_tx: o.deposit_tx,
      settlement: proof && { solana_tx: proof.sig, explorer: proof.explorer, merchant_delta: proof.delta, slot: proof.slot, reference: null },
    };
    if (o.state === 'REFUNDED') v.refund = { amount: pv.refundedAmount, reason: pv.refundReason, origin_txs: pv.originTx, refund_txs: pv.refundTx || [] };
    else if ((pv.refundTx || []).length && pv.refundedAmount && /[1-9]/.test(pv.refundedAmount)) v.excess_refund = { amount: pv.refundedAmount, refund_txs: pv.refundTx };
    return v;
  }

  /** One background pass: refresh the orders polled longest ago. Returns counts for the one-line log. */
  async function pollOnce(max = 3) {
    const rows = db.all(`SELECT id FROM orders WHERE state IN ${OPEN} OR (state='EXPIRED' AND created > ?) ORDER BY last_polled ASC LIMIT ?`, sec() - 86400, max);
    let errors = 0;
    for (const r of rows) {
      try { const v = await refresh(r.id, true); if (v.warning) errors += 1; } catch { errors += 1; }
    }
    const open = countOpen();
    const expired = Number(db.all("SELECT COUNT(*) AS n FROM orders WHERE state='EXPIRED' AND created > ?", sec() - 86400)[0].n);
    return { checked: rows.length, errors, open, expired };
  }

  return { origins, paymentRequired, createOrder, refresh, noteDeposit, deliver, view, get, pollOnce, countOpen, price, merchant: C.merchant, receiptKey: signer.pubkey };
}
