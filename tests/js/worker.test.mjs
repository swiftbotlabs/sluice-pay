// Offline tests for the hosted 402 API (worker/). Real SQLite (node:sqlite), real Ed25519 (WebCrypto), a real mainnet
// Solana transaction (fixture_tx_usdc.json: 0.50 USDC to the demo merchant), and a scripted Aurora. Every guard has a
// positive control: the same flow with the guard's input made honest delivers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { makeEngine, makeSigner, SCHEMA, canonical, requestHash, sha256hex } from '../../worker/src/engine.js';
import { handle, RateLimiter, clientKey } from '../../worker/src/router.js';
import { makeUpstream, ALLOWED_HOSTS } from '../../worker/src/upstream.js';
import core from '../../docs/core.js';

const MERCHANT = '9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR';
const PAYER = '0x8d9716A9f13FE82BA59E74b3Ce032842EB357818';
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const fx = JSON.parse(readFileSync(new URL('../fixture_tx_usdc.json', import.meta.url)));
const SIG = fx.sig; const TX = fx.tx; // blockTime 1793298353, merchant +500000
const TEST_SECRET = core.b58encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1)); // seed only; public half added below
const TOKENS = [{ blockchain: 'base', symbol: 'USDC', assetId: BASE_USDC, decimals: 6, price: 1 }, { blockchain: 'arb', symbol: 'ETH', assetId: 'nep141:arb.omft.near', decimals: 18, price: 2400 }];

async function secret64() {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  const k = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', k);
  const pub = Uint8Array.from(atob(jwk.x.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return core.b58encode(new Uint8Array([...seed, ...pub]));
}

function memDb() {
  const d = new DatabaseSync(':memory:');
  for (const s of SCHEMA.split(';').map((x) => x.trim()).filter(Boolean)) d.exec(s);
  return { all: (q, ...a) => d.prepare(q).all(...a), raw: d };
}

/** A scripted Aurora + Solana. `script` decides what each call returns; `calls` records them. */
function fakeUp(over = {}) {
  const calls = { quote: 0, status: 0, solTx: 0, report: 0, submit: 0 };
  let n = 0;
  const up = {
    calls, statusReply: { status: 'PENDING_DEPOSIT', swapDetails: {} }, txReply: TX,
    async tokens() { return TOKENS; },
    async quote(body) {
      calls.quote += 1; n += 1;
      const addr = '0x' + String(n).padStart(40, 'a').slice(-40);
      return { quoteRequest: { ...body, ...(over.echo || {}) }, quote: { depositAddress: over.depositAddress || addr, amountIn: '523000', amountInUsd: '0.523', minAmountIn: '518000', amountOut: body.amount, refundFee: '2400', withdrawFee: '10007' } };
    },
    async status() { calls.status += 1; return typeof up.statusReply === 'function' ? up.statusReply() : up.statusReply; },
    async submitDeposit() { calls.submit += 1; return {}; },
    async solTx(sig) { calls.solTx += 1; return sig === SIG ? up.txReply : null; },
    async report(address) { calls.report += 1; if (up.reportFails) { up.reportFails -= 1; throw new Error('rpc down'); } await new Promise((r) => setTimeout(r, 5)); return { address, sol: 0.5, top_holdings: [{ symbol: 'USDC', amount: '2.45' }], generated_at: 1 }; },
  };
  return up;
}
const success = (sigs = [SIG]) => ({ status: 'SUCCESS', swapDetails: { originChainTxHashes: [{ hash: '0x' + 'ab'.repeat(32) }], destinationChainTxHashes: sigs.map((hash) => ({ hash })), amountInFormatted: '0.5', amountOutFormatted: '0.5', refundedAmount: '0' } });

async function setup({ clock = (1793298353 - 30) * 1000, upOver } = {}) {
  const db = memDb(); const up = fakeUp(upOver); const signer = await makeSigner(await secret64());
  const t = { now: clock };
  const engine = makeEngine({ db, up, signer, cfg: { merchant: MERCHANT, priceRaw: '500000' }, now: () => t.now });
  const limiter = new RateLimiter(20000, () => t.now);
  const call = (method, path, { body, headers = {}, client = '203.0.113.7' } = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['content-type'] ??= 'application/json'; init.headers['content-length'] ??= String(new TextEncoder().encode(init.body).length); }
    return handle(new Request('https://ledger' + path, init), { engine, limiter, client, publicUrl: 'https://sluice-api.example', health: () => ({ ok: true }) });
  };
  return { db, up, signer, engine, t, call };
}
const orderBody = (over = {}) => ({ resource: 'report', params: { address: MERCHANT }, pay_with: 'base:USDC', refund_to: PAYER, ...over });

test('canonical JSON and request hash match the Python reference (sluice/receipts.py)', async () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'é"\n'], c: { z: 0, y: 'x' } }), '{"a":[true,null,"é\\"\\n"],"b":1,"c":{"y":"x","z":0}}');
  assert.throws(() => canonical({ a: 0.5 }), /non-integer/);
  // value computed with: python3 -c 'from sluice import receipts; print(receipts.request_hash("report", {"address": "9cYF..."}))'
  assert.equal(await requestHash('report', { address: MERCHANT }), await sha256hex('{"params":{"address":"9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR"},"resource":"report"}'));
});

test('receipt signer refuses a secret whose public half does not match', async () => {
  const good = core.b58decode(await secret64()); const bad = good.slice(); bad[40] ^= 1;
  await assert.rejects(makeSigner(core.b58encode(bad)), /do not match/);
  await assert.rejects(makeSigner(TEST_SECRET), /64 bytes/);
  assert.ok((await makeSigner(await secret64())).pubkey);
});

test('402 terms: price, merchant, accepted assets, receipt key and an indicative quote', async () => {
  const s = await setup();
  const r = await s.call('GET', `/api/report/${MERCHANT}`);
  assert.equal(r.status, 402);
  assert.match(r.headers.get('www-authenticate'), /Sluice/);
  const j = await r.json();
  assert.deepEqual(j.price, { amount: '0.5', asset: 'USDC', chain: 'solana', mint: core.USDC_MINT, recipient: MERCHANT });
  assert.deepEqual(j.accepts, ['base:USDC', 'arb:ETH']);
  assert.equal(j.receipt_key, s.signer.pubkey);
  assert.equal(j.indicative.send_about, '0.523');
  assert.deepEqual(j.request, { resource: 'report', params: { address: MERCHANT } });
  await s.call('GET', `/api/report/${MERCHANT}`); // cached: one dry quote a minute per asset
  assert.equal(s.up.calls.quote, 1);
  assert.equal((await s.call('GET', `/api/report/${MERCHANT}?pay_with=../../x`)).status, 400);
  assert.equal((await s.call('GET', '/api/report/not-an-address')).status, 404);
});

test('happy path: order -> Aurora SUCCESS -> credit read from Solana -> delivered once with a signed receipt', async () => {
  const s = await setup();
  const r = await s.call('POST', '/api/orders', { body: orderBody() });
  assert.equal(r.status, 201);
  const o = await r.json();
  assert.match(o.order_id, /^ord_[A-Za-z0-9]{16}$/);
  assert.equal(o.deposit.amount, '0.523'); assert.equal(o.state, 'AWAITING_DEPOSIT');
  assert.equal((await s.call('GET', `/api/report/${MERCHANT}`, { headers: { 'x-sluice-order': o.order_id } })).status, 402, 'unpaid: no delivery');
  s.up.statusReply = success(); s.t.now += 7000;
  const st = await (await s.call('GET', `/api/orders/${o.order_id}`)).json();
  assert.equal(st.state, 'SETTLED'); assert.equal(st.settlement.merchant_delta, 500000); assert.equal(st.settlement.solana_tx, SIG);
  const d1 = await s.call('GET', `/api/report/${MERCHANT}`, { headers: { 'x-sluice-order': o.order_id } });
  assert.equal(d1.status, 200);
  const b1 = await d1.text(); const rc = JSON.parse(d1.headers.get('x-sluice-receipt'));
  assert.equal(rc.payload.body_sha256, await sha256hex(b1));
  assert.equal(rc.payload.solana_tx, SIG); assert.equal(rc.payload.merchant, MERCHANT); assert.equal(rc.payload.price.amount, 500000);
  assert.equal(rc.payload.request_hash, await requestHash('report', { address: MERCHANT }));
  const pub = await crypto.subtle.importKey('raw', core.b58decode(rc.payload.signer), { name: 'Ed25519' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'Ed25519' }, pub, core.b58decode(rc.signature), new TextEncoder().encode(canonical(rc.payload))));
  const tampered = { ...rc.payload, merchant_delta: 1 };
  assert.ok(!(await crypto.subtle.verify({ name: 'Ed25519' }, pub, core.b58decode(rc.signature), new TextEncoder().encode(canonical(tampered)))));
  const d2 = await s.call('GET', `/api/report/${MERCHANT}`, { headers: { 'x-sluice-order': o.order_id } });
  assert.equal(await d2.text(), b1, 'a retry gets the same bytes');
  assert.equal(d2.headers.get('x-sluice-receipt'), d1.headers.get('x-sluice-receipt'), 'and the same receipt');
  assert.equal(s.up.calls.report, 1, 'the paid work ran once');
});

test('guard: provider SUCCESS is not enough; a short Solana credit is not delivered (positive control above delivers)', async () => {
  const s = await setup();
  const o = await (await s.call('POST', '/api/orders', { body: orderBody() })).json();
  const short = structuredClone(TX);
  short.meta.postTokenBalances.find((b) => b.owner === MERCHANT).uiTokenAmount.amount = '499999';
  s.up.txReply = short; s.up.statusReply = success(); s.t.now += 7000;
  const st = await (await s.call('GET', `/api/orders/${o.order_id}`)).json();
  assert.equal(st.state, 'PROCESSING');
  assert.equal((await s.call('GET', `/api/report/${MERCHANT}`, { headers: { 'x-sluice-order': o.order_id } })).status, 402);
  assert.equal(s.up.calls.report, 0);
  s.up.txReply = TX; s.t.now += 7000; // positive control: the real credit settles the same order
  assert.equal((await (await s.call('GET', `/api/orders/${o.order_id}`)).json()).state, 'SETTLED');
});

test('guard: failed transaction, a transaction older than the order, and a refund hash are never read as payment', async () => {
  const failed = structuredClone(TX); failed.meta.err = { InstructionError: [0, 'Custom'] };
  for (const [label, prep] of [['failed tx', (s) => { s.up.txReply = failed; }], ['tx predates the order', (s) => { s.t.now += 3 * 3600e3; }]]) {
    const s = await setup();
    prep(s);
    const o = await (await s.call('POST', '/api/orders', { body: orderBody() })).json();
    s.up.statusReply = success(); s.t.now += 7000;
    assert.equal((await (await s.call('GET', `/api/orders/${o.order_id}`)).json()).state, 'PROCESSING', label);
  }
  const s = await setup();
  const o = await (await s.call('POST', '/api/orders', { body: orderBody() })).json();
  s.up.statusReply = success(['0x' + 'cd'.repeat(32)]); s.t.now += 7000; // only an EVM refund hash on the destination list
  assert.equal((await (await s.call('GET', `/api/orders/${o.order_id}`)).json()).state, 'PROCESSING');
  assert.equal(s.up.calls.solTx, 0, 'an EVM hash is never looked up on Solana');
});

test('guard: one Solana transaction can pay for one order only (UNIQUE settle_sig)', async () => {
  const s = await setup();
  const a = await (await s.call('POST', '/api/orders', { body: orderBody() })).json();
  const b = await (await s.call('POST', '/api/orders', { body: orderBody() })).json();
  s.up.statusReply = success(); s.t.now += 7000;
  assert.equal((await (await s.call('GET', `/api/orders/${a.order_id}`)).json()).state, 'SETTLED');
  assert.equal((await (await s.call('GET', `/api/orders/${b.order_id}`)).json()).state, 'PROCESSING');
  assert.equal((await s.call('GET', `/api/report/${MERCHANT}`, { headers: { 'x-sluice-order': b.order_id } })).status, 402);
});

test('exactly once under concurrency: parallel collects run the paid work once and get identical bytes', async () => {
  const s = await setup();
  const o = await (await s.call('POST', '/api/orders', { body: orderBody() })).json();
  s.up.statusReply = success(); s.t.now += 7000;
  await s.call('GET', `/api/orders/${o.order_id}`);
  const rs = await Promise.all(Array.from({ length: 6 }, () => s.call('GET', `/api/report/${MERCHANT}`, { headers: { 'x-sluice-order': o.order_id } })));
  const bodies = await Promise.all(rs.map((r) => r.text()));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(new Set(bodies).size, 1); assert.equal(new Set(rs.map((r) => r.headers.get('x-sluice-receipt'))).size, 1);
  assert.equal(s.up.calls.report, 1);
});

test('a failed report build keeps the payment: 503, then the retry delivers (still once)', async () => {
  const s = await setup();
  const o = await (await s.call('POST', '/api/orders', { body: orderBody() })).json();
  s.up.statusReply = success(); s.t.now += 7000; s.up.reportFails = 1;
  const r1 = await s.call('GET', `/api/report/${MERCHANT}`, { headers: { 'x-sluice-order': o.order_id } });
  assert.equal(r1.status, 503); assert.match((await r1.json()).error, /will not pay again/);
  const r2 = await s.call('GET', `/api/report/${MERCHANT}`, { headers: { 'x-sluice-order': o.order_id } });
  assert.equal(r2.status, 200);
});

test('an order paid for one address does not deliver another', async () => {
  const s = await setup();
  const o = await (await s.call('POST', '/api/orders', { body: orderBody() })).json();
  s.up.statusReply = success(); s.t.now += 7000;
  const other = 'B5jEjGHi5HyNomGTPerQYVsJ5biMZyGp7G5rWG3ZfwMW';
  assert.equal((await s.call('GET', `/api/report/${other}`, { headers: { 'x-sluice-order': o.order_id } })).status, 409);
});

test('refunds, expiry and unknown provider states', async () => {
  const s = await setup();
  const o = await (await s.call('POST', '/api/orders', { body: orderBody() })).json();
  s.up.statusReply = { status: 'REFUNDED', swapDetails: { originChainTxHashes: [{ hash: '0x' + 'ab'.repeat(32) }, { hash: '0x' + 'cd'.repeat(32) }], refundedAmount: '397600', refundedAmountFormatted: '0.3976', depositedAmountFormatted: '0.4' } };
  s.t.now += 7000;
  const v = await (await s.call('GET', `/api/orders/${o.order_id}`)).json();
  assert.equal(v.state, 'REFUNDED'); assert.equal(v.refund.amount, '0.3976'); assert.deepEqual(v.refund.refund_txs, ['0x' + 'cd'.repeat(32)]);
  const e = await (await s.call('POST', '/api/orders', { body: orderBody() })).json();
  s.up.statusReply = { status: 'PENDING_DEPOSIT', swapDetails: {} }; s.t.now += 900e3 + 1800e3 + 1000;
  assert.equal((await (await s.call('GET', `/api/orders/${e.order_id}`)).json()).state, 'EXPIRED');
  const u = await (await s.call('POST', '/api/orders', { body: orderBody() })).json();
  s.up.statusReply = { status: 'SOMETHING_NEW' }; s.t.now += 7000;
  const w = await (await s.call('GET', `/api/orders/${u.order_id}`)).json();
  assert.equal(w.state, 'AWAITING_DEPOSIT'); assert.match(w.warning, /unreachable/);
});

test('input validation: fields, sizes, types, rails, refund address, ids', async () => {
  const s = await setup();
  let ip = 0;
  const code = async (body, extra) => (await s.call('POST', '/api/orders', { body, client: `192.0.2.${++ip}`, ...extra })).status;
  assert.equal(await code(orderBody({ admin: true })), 400);
  assert.equal(await code(orderBody({ confidential: true })), 400);
  assert.equal(await code(orderBody({ rail: 'connect' })), 400);
  assert.equal(await code(orderBody({ rail: 'swap', confidential: false })), 201, 'the CLI sends these defaults');
  assert.equal(await code(orderBody({ refund_to: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' })), 400);
  assert.equal(await code(orderBody({ pay_with: 'doge:DOGE' })), 400);
  assert.equal(await code(orderBody({ params: { address: '0xabc' } })), 400);
  assert.equal(await code(orderBody({ params: { address: MERCHANT, extra: 1 } })), 400);
  assert.equal(await code('[1,2]'), 400);
  assert.equal(await code('{"resource":'), 400);
  assert.equal(await code(orderBody(), { headers: { 'content-type': 'text/plain' } }), 415);
  assert.equal(await code('x'.repeat(9000)), 413);
  assert.equal(await code(orderBody(), { headers: { 'content-length': '20000' } }), 413);
  assert.equal((await s.call('GET', '/api/orders/ord_short')).status, 404);
  assert.equal((await s.call('GET', '/api/orders/ord_AAAAAAAAAAAAAAAA')).status, 404);
  assert.equal((await s.call('GET', `/api/report/${MERCHANT}`, { headers: { 'x-sluice-order': 'ord_<script>' } })).status, 404);
  assert.equal((await s.call('DELETE', '/api/orders')).status, 405);
});

test('guard: a quote that does not echo our recipient or amount is discarded (positive control: honest echo -> 201)', async () => {
  for (const echo of [{ recipient: 'B5jEjGHi5HyNomGTPerQYVsJ5biMZyGp7G5rWG3ZfwMW' }, { amount: '1' }, { refundTo: '0x' + '11'.repeat(20) }, { appFees: [{ fee: 100 }] }]) {
    const s = await setup({ upOver: { echo } });
    const r = await s.call('POST', '/api/orders', { body: orderBody() });
    assert.equal(r.status, 502, JSON.stringify(echo));
    assert.equal(Number(s.db.all('SELECT COUNT(*) AS n FROM orders')[0].n), 0, 'no order stored');
  }
  const bad = await setup({ upOver: { depositAddress: 'javascript:alert(1)' } });
  assert.equal((await bad.call('POST', '/api/orders', { body: orderBody() })).status, 502);
  const ok = await setup({ upOver: { echo: {} } });
  assert.equal((await ok.call('POST', '/api/orders', { body: orderBody() })).status, 201);
});

test('limits: per-client order burst, open orders per client, and IPv6 /64 grouping', async () => {
  const s = await setup();
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await s.call('POST', '/api/orders', { body: orderBody() })).status);
  assert.deepEqual(codes, [201, 201, 201, 429, 429]);
  s.t.now += 60e3;
  const more = [];
  for (let i = 0; i < 4; i++) { more.push((await s.call('POST', '/api/orders', { body: orderBody() })).status); s.t.now += 11e3; }
  assert.deepEqual(more, [201, 201, 429, 429], 'at most 5 unpaid orders per client');
  assert.equal((await s.call('POST', '/api/orders', { body: orderBody(), client: '198.51.100.9' })).status, 201, 'another client is unaffected');
  assert.equal(clientKey('2001:db8:1:2:aaaa::1'), clientKey('2001:db8:1:2:ffff:1:2:3'));
  assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:3::1'));
  assert.equal(clientKey('not an ip'), 'invalid');
  const rl = new RateLimiter(3, () => 0);
  for (const k of ['a', 'b', 'c', 'd']) rl.allow(k, 'x', 1, 1);
  assert.equal(rl.b.size, 3, 'LRU-bounded');
});

test('upstream: fixed hosts only, no redirects, capped bodies', async () => {
  const seen = [];
  const mk = (res) => makeUpstream({ auroraKey: 'abcd1234-ef', fetch: async (url, init) => { seen.push(new URL(url).host); assert.equal(init.redirect, 'manual'); return res(); } });
  const j = (o, h = {}) => () => new Response(JSON.stringify(o), { status: 200, headers: h });
  await mk(j({ tokens: TOKENS })).tokens();
  await mk(j({ jsonrpc: '2.0', result: TX })).solTx(SIG);
  assert.ok(seen.length >= 2 && seen.every((h) => ALLOWED_HOSTS.has(h)), seen.join(','));
  await assert.rejects(mk(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })).tokens(), /redirect refused/);
  await assert.rejects(mk(() => new Response('x'.repeat(2_100_000))).tokens(), /too large/);
  await assert.rejects(mk(j({}, { 'content-length': '9999999' })).tokens(), /too large/);
  assert.throws(() => makeUpstream({ auroraKey: '../../etc' }), /key format/);
});

test('poller pass refreshes open orders and reports counts', async () => {
  const s = await setup();
  await s.call('POST', '/api/orders', { body: orderBody() });
  s.up.statusReply = success(); s.t.now += 7000;
  const r = await s.engine.pollOnce(3);
  assert.deepEqual(r, { checked: 1, errors: 0, open: 0, expired: 0 });
});
