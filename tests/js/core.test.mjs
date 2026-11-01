// Offline tests for the checkout's money logic. Fixture = a REAL Intents Connect payload from mainnet (unsigned, deleted).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../../docs/core.js');
const fx = JSON.parse(readFileSync(new URL('../fixture_connect_payload_earn.json', import.meta.url)));
const refFx = JSON.parse(readFileSync(new URL('../fixture_connect_payload_ref.json', import.meta.url)));

const earnCtx = async (over = {}) => ({
  now: Date.parse('2026-11-01T12:00:00Z'),
  payer: fx.payer, intermediary: fx.intermediary, merchant: fx.merchant, price: BigInt(fx.price), settle: 'earn',
  src: await C.ata(fx.intermediary), dst: await C.ata(fx.merchant, C.KLEND.cusdc), ref: await C.referenceKey(fx.order_id),
  maxFee: 200000n, ...over,
});
// rewrite one account key inside the real payload, as a hostile service would
function tamper(payloadJson, fromKey, toKey) {
  const p = JSON.parse(payloadJson); const msg = JSON.parse(p.intents[0].msg);
  const a = C.toHex(C.b58decode(fromKey)); const b = C.toHex(C.b58decode(toKey));
  const h = msg.request.payload_v2.Eddsa; assert.ok(h.includes(a), 'key present in payload');
  msg.request.payload_v2.Eddsa = h.replaceAll(a, b); p.intents[0].msg = JSON.stringify(msg);
  return JSON.stringify(p);
}
const patchHex = (payloadJson, from, to) => {
  const p = JSON.parse(payloadJson); const msg = JSON.parse(p.intents[0].msg);
  assert.ok(msg.request.payload_v2.Eddsa.includes(from)); msg.request.payload_v2.Eddsa = msg.request.payload_v2.Eddsa.replace(from, to);
  p.intents[0].msg = JSON.stringify(msg); return JSON.stringify(p);
};

test('base58 round trip and bad input', () => {
  const k = C.b58decode(C.USDC_MINT); assert.equal(k.length, 32); assert.equal(C.b58encode(k), C.USDC_MINT);
  assert.throws(() => C.b58decode('0OIl')); assert.throws(() => C.b58decode('')); assert.equal(C.isSolAddr('nope'), false);
});
test('amounts stay exact in integers', () => {
  assert.equal(C.toUnits('0.15', 6), 150000n); assert.equal(C.fromUnits(150000n, 6), '0.15'); assert.equal(C.fromUnits(1n, 18), '0.000000000000000001');
  assert.throws(() => C.toUnits('1.2345678', 6)); assert.throws(() => C.toUnits('-1', 6)); assert.throws(() => C.toUnits('1e3', 6));
});
test('token account and reference derive to the on-chain values', async () => {
  assert.equal(await C.ata('9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR', C.KLEND.cusdc) !== '', true);
  // reference of the settled Connect run (README: AAkRmupG...MDM6)
  const r = await C.referenceKey('ord_oDUi3dtBBUIp2OKq'); assert.ok(r.startsWith('AAkRmupG') && r.endsWith('MDM6'), r);
  await assert.rejects(C.referenceKey('x y'));
});
test('audit accepts the real settle-to-earn payload', async () => {
  const r = C.auditPayload(fx.payload_json, await earnCtx());
  assert.equal(r.ok, true); assert.equal(r.createsAccount, true); assert.equal(r.fee, 147409n);
});
test('audit refuses a cUSDC destination other than the merchant', async () => {
  const c = await earnCtx(); const evil = await C.ata('B5jEjGHi5HyNomGTPerQYVsJ5biMZyGp7G5rWG3ZfwMW'); // any other account
  assert.throws(() => C.auditPayload(tamper(fx.payload_json, c.dst, evil), c), /token-account creation|merchant/);
});
test('audit refuses a different signer, reference, reserve, or amount', async () => {
  const c = await earnCtx();
  assert.throws(() => C.auditPayload(fx.payload_json, { ...c, payer: '0x' + '1'.repeat(40) }), /another signer/);
  assert.throws(() => C.auditPayload(fx.payload_json, { ...c, ref: C.USDC_MINT }), /reference/);
  assert.throws(() => C.auditPayload(tamper(fx.payload_json, C.KLEND.reserve, C.USDC_MINT), c), /refresh|merchant|unexpected/);
  assert.throws(() => C.auditPayload(patchHex(fx.payload_json, 'a9c91e7e06cd6644f049020000000000', 'a9c91e7e06cd6644f149020000000000'), c), /amount differs/);
});
test('audit refuses a fee above the cap (positive control: the same payload passes with the cap raised)', async () => {
  const c = await earnCtx();
  assert.throws(() => C.auditPayload(fx.payload_json, { ...c, maxFee: 147408n }), /unexpected Transfer/);
  assert.equal(C.auditPayload(fx.payload_json, { ...c, maxFee: 147409n }).ok, true);
});
test('audit refuses lending instructions on a plain USDC invoice', async () => {
  await assert.rejects(async () => C.auditPayload(fx.payload_json, await earnCtx({ settle: 'usdc', dst: await C.ata(fx.merchant) })), /token-account creation|lending/);
});
test('audit accepts the real pay+reference payload from the settled mainnet run', async () => {
  const ctx = {
    payer: refFx.payer || '0x8d9716A9f13FE82BA59E74b3Ce032842EB357818', intermediary: refFx.intermediary || 'Eg6brpDagWxXdYNDmsFpDUb3wjyrCZeHhBfu6jxndvcr',
    merchant: refFx.merchant || '9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR', price: BigInt(refFx.price || 150000), settle: 'usdc', maxFee: 20000n,
  };
  ctx.src = await C.ata(ctx.intermediary); ctx.dst = await C.ata(ctx.merchant); ctx.ref = await C.referenceKey(refFx.order_id || refFx.order);
  assert.equal(C.auditPayload(refFx.payload, ctx).ok, true);
});
test('audit accepts the real steps-only payload used by Retry', async () => {
  const f = JSON.parse(readFileSync(new URL('../fixture_connect_payload_steps.json', import.meta.url)));
  const r = C.auditPayload(f.payload_json, {
    payer: f.payer, intermediary: f.intermediary, merchant: f.merchant, price: BigInt(f.price), settle: 'usdc',
    src: await C.ata(f.intermediary), dst: await C.ata(f.merchant), ref: await C.referenceKey(f.order_id), maxFee: 20000n,
  });
  assert.equal(r.ok, true);
  assert.equal(r.fee > 0n, true, 'the service fee is seen');
});
test('the whole signed envelope is checked, not only the Solana message', async () => {
  const c = await earnCtx();
  const edit = (f) => { const p = JSON.parse(fx.payload_json); const m = JSON.parse(p.intents[0].msg); f(p, m); p.intents[0].msg = JSON.stringify(m); return JSON.stringify(p); };
  const cases = {
    'other contract': edit((p) => { p.intents[0].contract_id = 'evil.near'; }),
    'attached deposit': edit((p) => { p.intents[0].attached_deposit = '1000'; }),
    'other verifying contract': edit((p) => { p.verifying_contract = 'evil.near'; }),
    'long deadline': edit((p) => { p.deadline = '2099-01-01T00:00:00Z'; }),
    'other domain': edit((p, m) => { m.request.domain_id = 0; }),
    'missing path': edit((p, m) => { delete m.request.path; }),
    'other path': edit((p, m) => { m.request.path = '0x' + '1'.repeat(40); }),
    'extra intent': edit((p) => { p.intents.push({ intent: 'transfer' }); }),
    'extra field': edit((p) => { p.extra = 1; }),
    'duplicate intents key': fx.payload_json.replace('"intents":', '"intents":[{"intent":"transfer"}],"intents":'),
    'duplicate field in msg': (() => { const p = JSON.parse(fx.payload_json); p.intents[0].msg = '{"request":{},' + p.intents[0].msg.slice(1); return JSON.stringify(p); })(),
  };
  for (const [name, bad] of Object.entries(cases)) assert.throws(() => C.auditPayload(bad, c), Error, name);
  assert.equal(C.auditPayload(fx.payload_json, c).ok, true, 'positive control');
});
test('the Solana account is derived locally and matches mainnet', () => {
  assert.equal(C.toHex(C.sha3_256(new Uint8Array(0))), 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
  assert.equal(C.toHex(C.sha3_256(C.utf8('abc'))), '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');
  assert.equal(C.toHex(C.sha3_256(new Uint8Array(200).fill(97))).length, 64);
  assert.equal(C.deriveIntermediary(fx.payer), fx.intermediary, 'the settled mainnet intermediary');
  assert.equal(C.deriveIntermediary(fx.payer.toUpperCase().replace('0X', '0x')), fx.intermediary, 'case does not matter');
  assert.notEqual(C.deriveIntermediary('0x' + '1'.repeat(40)), fx.intermediary);
  assert.throws(() => C.deriveIntermediary('nope'));
});
test('public cross-check refuses a quote that differs', () => {
  const dep = '0x' + 'a'.repeat(40); const inv = 'B5jEjGHi5HyNomGTPerQYVsJ5biMZyGp7G5rWG3ZfwMW';
  const st = (o = {}, q = {}) => ({ status: 'PENDING_DEPOSIT', quoteResponse: { quote: { depositAddress: dep, amountIn: '100', ...q }, quoteRequest: { destinationAsset: C.SOL_USDC, originAsset: 'a', swapType: 'EXACT_OUTPUT', recipient: inv, refundTo: '0xAB', amount: '90', ...o } } });
  const want = { depositAddress: dep, recipient: inv, originAsset: 'a', refundTo: '0xab', amountIn: '100', amount: '90' };
  assert.deepEqual(C.checkPublicQuote(st(), want), []);
  assert.ok(C.checkPublicQuote({}, want).length > 0, 'address unknown publicly: the review attack');
  for (const [o, q] of [[{ recipient: 'x' }, {}], [{ refundTo: '0xcd' }, {}], [{ originAsset: 'b' }, {}], [{ swapType: 'EXACT_INPUT' }, {}], [{ destinationAsset: 'x' }, {}], [{ amount: '91' }, {}], [{}, { amountIn: '101' }], [{}, { depositAddress: '0x' + 'b'.repeat(40) }], [{}, { depositMemo: '1' }]]) assert.ok(C.checkPublicQuote(st(o, q), want).length > 0, JSON.stringify([o, q]));
  assert.ok(C.checkPublicQuote({ ...st(), status: 'SUCCESS' }, want).length > 0);
  assert.deepEqual(C.checkPublicQuote({ ...st(), status: 'SUCCESS' }, { ...want, fresh: false }), [], 'a resumed order may have moved on');
  assert.deepEqual(C.checkPublicQuote(st({ appFees: [{ fee: 10, recipient: 'x' }] }), want), [], 'the floor fee is fine');
  assert.ok(C.checkPublicQuote(st({ appFees: [{ fee: 500, recipient: 'evil' }] }), want).length > 0, 'a skimming fee is refused');
  assert.ok(C.checkPublicQuote(st({ recipientType: 'INTENTS' }), want).length > 0, 'funds parked elsewhere are refused');
});
test('token data must agree with the public list; the amount must fit the invoice', () => {
  const mk = (id, contractAddress, decimals) => ({ assetId: id, contractAddress, decimals, price: 2 });
  const pub = [mk('a', '0xAA', 6), mk('b', '0xBB', 6), mk('c', null, 18)];
  const got = C.agreedTokens([mk('a', '0xaa', 6), mk('b', '0xEVIL', 6), mk('c', null, 18), mk('d', '0xDD', 6)], pub).map((t) => t.assetId);
  assert.deepEqual(got, ['a', 'c'], 'a swapped contract and an unknown asset are dropped');
  const usdc = { decimals: 6, price: 1 };
  assert.equal(C.amountSane(1020000n, usdc, 1000000n, 300000n), true);
  assert.equal(C.amountSane(50000000n, usdc, 1000000n, 300000n), false, 'fifty dollars asked for a one dollar invoice');
  assert.equal(C.amountSane(1279000n, usdc, 1000000n, 300000n), true, 'the real first-payment quote with token-account rent');
  assert.equal(C.amountSane(1500000n, usdc, 1000000n, 300000n), false, 'a quiet skim above 5%');
  assert.equal(C.amountSane(1n, { decimals: 6, price: null }, 1000000n, 300000n), false, 'unknown price fails closed');
});
test('a stored order only resumes for the same invoice', () => {
  const inv = { to: 'B5jEjGHi5HyNomGTPerQYVsJ5biMZyGp7G5rWG3ZfwMW', raw: 1000000n, settle: 'usdc' };
  const o = { to: inv.to, raw: '1000000', quote: { depositAddress: '0x' + 'a'.repeat(40) }, deadline: new Date(1000000).toISOString() };
  assert.equal(C.restorable(o, inv, 1000000), true);
  assert.equal(C.restorable({ ...o, to: 'other' }, inv, 1000000), false, 'order made for another merchant');
  assert.equal(C.restorable({ ...o, raw: '5' }, inv, 1000000), false, 'another amount');
  assert.equal(C.restorable({ ...o, quote: { depositAddress: '<x>' } }, inv, 1000000), false);
  assert.equal(C.restorable(o, inv, 1000000 + 7200 * 1000), false, 'long expired with no deposit');
  assert.equal(C.restorable({ ...o, depositTx: '0x1' }, inv, 1000000 + 7200 * 1000), true, 'a sent deposit stays trackable');
  assert.equal(C.restorable({ ...o, confidential: true, raw: '1000500' }, inv, 1000000), true, 'private tag');
  assert.equal(C.restorable({ ...o, confidential: true, raw: '1001000' }, inv, 1000000), false);
  assert.equal(C.restorable(null, inv), false);
});
test('a reference must be a read-only non-signer', () => {
  const tx = (k) => ({ transaction: { message: { accountKeys: k } } });
  assert.equal(C.referenceIn(tx([{ pubkey: 'R', signer: false, writable: false }]), 'R'), true);
  assert.equal(C.referenceIn(tx([{ pubkey: 'R', signer: false, writable: true }]), 'R'), false, 'a token account is writable: the forged record attack');
  assert.equal(C.referenceIn(tx([{ pubkey: 'R', signer: true, writable: false }]), 'R'), false);
  assert.equal(C.referenceIn(tx([{ pubkey: 'X', signer: false, writable: false }]), 'R'), false);
  assert.equal(C.referenceIn({}, 'R'), false);
});
test('secp256k1 wire form normalises v and rejects junk', () => {
  const r = '11'.repeat(32); const s = '22'.repeat(32);
  assert.equal(C.secpWire('0x' + r + s + '1b'), C.secpWire(r + s + '00'));
  assert.notEqual(C.secpWire('0x' + r + s + '1c'), C.secpWire(r + s + '00'));
  assert.throws(() => C.secpWire('0x1234')); assert.throws(() => C.secpWire('0x' + r + s + '05'));
});
test('verifyEarn binds the deposit instruction to this order', async () => {
  const row = (owner, mint, amount) => ({ owner, mint, uiTokenAmount: { amount: String(amount) } });
  const m = 'B5jEjGHi5HyNomGTPerQYVsJ5biMZyGp7G5rWG3ZfwMW'; const A = C.KLEND.authority;
  const dst = await C.ata(m, C.KLEND.cusdc); const ref = await C.referenceKey('ord_verifyEarn1'); const other = await C.ata('9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR', C.KLEND.cusdc);
  const data = (amt) => { const b = new Uint8Array(16); b.set(C.fromHex(C.KLEND.deposit)); let v = BigInt(amt); for (let i = 8; i < 16; i++) { b[i] = Number(v & 255n); v >>= 8n; } return C.b58encode(b); };
  const ix = (to, amt, r = ref) => ({ programId: C.KLEND.program, data: data(amt), accounts: ['x', C.KLEND.reserve, 'x', 'x', 'x', 'x', 'x', 'x', to, 'x', 'x', 'x', r] });
  const tx = (ixs, err = null, blockTime = 2000) => ({ blockTime, transaction: { message: { instructions: ixs } }, meta: { err, preTokenBalances: [row(A, C.USDC_MINT, 1000000)], postTokenBalances: [row(A, C.USDC_MINT, 1150000), row(m, C.KLEND.cusdc, 124075)] } });
  const ctx = { dst, ref, notBefore: 1000 };
  assert.deepEqual(C.verifyEarn(tx([ix(dst, 150000)]), m, 150000n, ctx), { shares: 124075n, supplied: 150000n });
  assert.equal(C.verifyEarn(tx([ix(other, 150000)]), m, 150000n, ctx), null, 'deposit to another account, merchant got a crumb: the review attack');
  assert.equal(C.verifyEarn(tx([ix(dst, 150000, 'somethingelse')]), m, 150000n, ctx), null, 'another order');
  assert.equal(C.verifyEarn(tx([ix(dst, 149999)]), m, 150000n, ctx), null, 'another amount');
  assert.equal(C.verifyEarn(tx([ix(dst, 150000)], { x: 1 }), m, 150000n, ctx), null, 'failed tx');
  assert.equal(C.verifyEarn(tx([ix(dst, 150000)], null, 100), m, 150000n, ctx), null, 'replay of an older transaction');
  assert.equal(C.verifyEarn(tx([]), m, 150000n, ctx), null, 'no deposit at all');
  const shy = tx([ix(dst, 150005)]); assert.equal(C.verifyEarn(shy, m, 150005n, ctx).supplied, 150000n, 'share rounding of a few micro-USDC is tolerated');
  assert.equal(C.verifyUsdc({ blockTime: 100, meta: { err: null, preTokenBalances: [], postTokenBalances: [row(m, C.USDC_MINT, 5)] } }, m, 5n, false, 1000), null, 'old credit replayed by a hostile status');
});
test('payment URIs prefill the exact amount and never drop a memo', () => {
  const dep = '0x' + 'a'.repeat(40); const usdc = '0x' + 'b'.repeat(40);
  assert.equal(C.paymentUri({ chain: 'base', address: dep, raw: 312528n, decimals: 6, contract: usdc }), `ethereum:${usdc}@8453/transfer?address=${dep}&uint256=312528`);
  assert.equal(C.paymentUri({ chain: 'arb', address: dep, raw: 71028266525738n, decimals: 18 }), `ethereum:${dep}@42161?value=71028266525738`);
  assert.equal(C.paymentUri({ chain: 'btc', address: 'bc1qabc', raw: 6508n, decimals: 8 }), 'bitcoin:bc1qabc?amount=0.00006508');
  assert.equal(C.paymentUri({ chain: 'stellar', address: 'GABC', raw: 1n, decimals: 7, memo: '42' }), 'GABC');
  assert.equal(C.paymentUri({ chain: 'hood', address: dep, raw: 1n, decimals: 18 }), dep, 'unknown chain id = plain address, never a wrong chain');
  assert.equal(C.paymentUri({ chain: 'base', address: dep, raw: 1n, decimals: 6, contract: '<bad>' }), dep, 'a malformed contract never reaches a URI');
  assert.match(C.solanaPayUri({ recipient: 'R', raw: 150000n, reference: 'X' }), /^solana:R\?amount=0\.15&spl-token=EPjF.+&reference=X$/);
});
test('incidents hide affected routes and only those', () => {
  const inc = [{ scopeType: 'chain', scopeValue: 'hypercore', direction: 'deposit', status: 'active' }, { scopeType: 'token', scopeValue: 'nep141:x', direction: '*', status: 'active' }, { scopeType: 'chain', scopeValue: 'base', direction: 'deposit', status: 'resolved' }];
  assert.equal(C.assetIncident({ blockchain: 'hypercore', assetId: 'y' }, inc), true);
  assert.equal(C.assetIncident({ blockchain: 'near', assetId: 'nep141:x' }, inc), true);
  assert.equal(C.assetIncident({ blockchain: 'base', assetId: 'y' }, inc), false, 'resolved incident');
  assert.equal(C.assetIncident({ blockchain: 'arb', assetId: 'y' }, [{ scopeType: 'chain', scopeValue: 'arb', direction: 'withdrawal', status: 'active' }]), false, 'direction matters');
  assert.equal(C.settlementIncident([{ scopeType: 'chain', scopeValue: 'sol', direction: 'withdrawal' }]), true);
  assert.equal(C.settlementIncident(inc), false);
});
test('asset list: popular first, destination asset and unknown chains left out', () => {
  const t = [{ blockchain: 'zzz', symbol: 'Q', assetId: 'a' }, { blockchain: 'near', symbol: 'wNEAR', assetId: 'b' }, { blockchain: 'base', symbol: 'USDC', assetId: 'c' }, { blockchain: 'sol', symbol: 'USDC', assetId: C.SOL_USDC }];
  assert.deepEqual(C.listAssets(t, []).map((x) => x.assetId), ['c', 'b']);
  assert.equal(C.matchAsset(t[1], 'near'), true); assert.equal(C.matchAsset(t[2], 'usdc base'), true); assert.equal(C.matchAsset(t[2], 'tron'), false);
});
test('stages cover both APIs; short deposit computes the top-up', () => {
  assert.equal(C.stage('OPERATION_FAILED').end, 'fail'); assert.equal(C.stage('REFUNDED').end, 'refund'); assert.equal(C.stage('DEPOSIT_FAILED').end, 'refund');
  assert.equal(C.stage('INCOMPLETE_DEPOSIT').tone, 'warn'); assert.equal(C.stage('OPERATION_PROCESSING').step, 'ROUTE');
  assert.equal(C.shortfall('1020349', '400000'), 620349n); assert.equal(C.shortfall('100', '200'), 0n); assert.equal(C.shortfall('100', null), 100n);
});
test('deposit addresses of every family pass, markup does not', () => {
  for (const a of ['0x' + 'a'.repeat(40), 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'TKgqof7VzSHa11KnGAqnPbm8g4DRQLKGN4', 'rs2Fj6WTTDW1gG1AMdmWMWEQUYF99ttLKj', 'GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK', 'bitcoincash:qqqqqqqqqqqq', 'EQAbc-def_123456', 'alice.near-deposit']) assert.equal(C.isDepositAddr(a), true, a);
  for (const a of ['<script>alert(1)</script>', 'a b c d e f g h i', '"onmouseover=x"', 'short', null]) assert.equal(C.isDepositAddr(a), false, String(a));
});
test('a permanent address is shown only if Aurora ties it to this merchant', () => {
  const m = 'B5jEjGHi5HyNomGTPerQYVsJ5biMZyGp7G5rWG3ZfwMW'; const addr = '0x' + 'a'.repeat(40);
  const rec = { depositAddress: addr, recipient: m, recipientType: 'DESTINATION_CHAIN', recipientChain: 'sol', destinationSymbol: 'USDC' };
  assert.equal(C.permanentMatches(rec, addr, m), true);
  assert.equal(C.permanentMatches({ ...rec, recipient: 'someoneelse' }, addr, m), false);
  assert.equal(C.permanentMatches({ ...rec, depositAddress: '0x' + 'b'.repeat(40) }, addr, m), false);
  assert.equal(C.permanentMatches({ ...rec, recipientChain: 'base' }, addr, m), false);
  assert.equal(C.permanentMatches({ ...rec, destinationSymbol: 'USDT' }, addr, m), false);
  assert.equal(C.permanentMatches({ ...rec, recipientType: 'INTENTS' }, addr, m), false);
  assert.equal(C.permanentMatches(null, addr, m), false);
  assert.deepEqual(C.permanentRequest(m, 'tron'), { sender: `sluice:${m}`, recipient: m, recipientType: 'DESTINATION_CHAIN', depositChain: 'tron', destinationChain: 'sol', destinationAsset: C.SOL_USDC });
});
test('permanent minimums follow Aurora and round up', () => {
  assert.equal(C.permanentMinUsd('tron'), 2); assert.equal(C.permanentMinUsd('base'), 1);
  assert.ok(Number(C.minInAsset({ price: 2266 }, 1)) * 2266 >= 1, 'never undershoots');
  assert.ok(Number(C.minInAsset({ price: 76000 }, 1)) * 76000 >= 1);
  assert.equal(C.minInAsset({ price: 1 }, 2), '2.1');
  assert.equal(C.minInAsset({ price: null }, 1), null); assert.equal(C.minInAsset({}, 1), null);
});
test('deposit timeline merges Aurora lists newest first', () => {
  const r = C.depositRows({
    received: [{ tx_hash: 'a', fromChain: 'tron', asset_id: 'x', decimals: 6, amount: '5000000', created_at: '2026-11-01T10:00:00Z' }],
    success: [{ tx_hash: 'b', destinationChain: 'sol', asset_id: 'y', decimals: 6, amount: '4980000', created_at: '2026-11-01T10:01:00Z' }],
    failed: [{ tx_hash: 'c', asset_id: 'z', decimals: null, amount: '12', created_at: '2026-11-01T09:00:00Z' }],
  });
  assert.deepEqual(r.map((x) => [x.kind, x.amount]), [['delivered', '4.98'], ['received', '5'], ['failed', '12']]);
  assert.deepEqual(C.depositRows({}), []);
});
test('refund address shapes', () => {
  assert.equal(C.validRefund('evm', '0x' + 'a'.repeat(40)), true); assert.equal(C.validRefund('evm', '0x123'), false);
  assert.equal(C.validRefund('btc', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'), true); assert.equal(C.validRefund('tron', 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7'), true);
  assert.equal(C.validRefund('sol', 'nope'), false); assert.equal(C.validRefund('other', 'x y z'), false); assert.equal(C.validRefund('nofam', 'abcdefghijkl'), false);
});
