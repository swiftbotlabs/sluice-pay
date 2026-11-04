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
  assert.equal(C.stage('INCOMPLETE_DEPOSIT').tone, 'warn'); assert.equal(C.stage('OPERATION_PROCESSING').step, 'ROUTE'); assert.equal(C.stage('SIGNING').step, 'ROUTE');
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

// ---------- merchant first run + merchant view ----------
const MERCHANT = '9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR';
const earnTx = JSON.parse(readFileSync(new URL('../fixture_tx_earn.json', import.meta.url)));
const usdcTx = JSON.parse(readFileSync(new URL('../fixture_tx_usdc.json', import.meta.url)));

test('names: any script, a little punctuation, nothing invisible', () => {
  assert.equal(C.cleanName('  Café   Lumière  '), 'Café Lumière');
  assert.equal(C.cleanName('Tienda de Ana & Co.'), 'Tienda de Ana & Co.');
  assert.equal(C.cleanName('द\u0941क\u093Eन'), 'द\u0941क\u093Eन');
  assert.equal(C.cleanName('Cafe\u0301'), 'Café'); // NFC
  for (const bad of ['', '   ', '...', 'a'.repeat(41), 'Shop\u202Egnp.exe', 'Sh\u200Bop', 'Shop<script>', 'Shop "x"', 'Shop\u00A0Two', 'Shop 🙂', 'Line\u2028Two', null, 42]) {
    assert.equal(C.cleanName(bad), null, JSON.stringify(bad));
  }
  assert.equal(C.cleanName('a'.repeat(40)), 'a'.repeat(40));
});
test('a pasted secret is recognised in every common shape, an address is not', () => {
  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  assert.equal(C.looksSecret(phrase), true);
  assert.equal(C.looksSecret(phrase.split(' ').concat(phrase.split(' ')).join(' ')), true); // 24 words
  assert.equal(C.looksSecret('0x' + 'ab'.repeat(32)), true);
  assert.equal(C.looksSecret('[' + Array.from({ length: 64 }, (_, i) => i).join(',') + ']'), true);
  assert.equal(C.looksSecret(C.b58encode(Uint8Array.from({ length: 64 }, (_, i) => i + 1))), true);
  for (const ok of [MERCHANT, '0x' + 'ab'.repeat(20), 'my shop', 'hello world this is a short note', '']) assert.equal(C.looksSecret(ok), false, ok);
});
test('payout address: wrong kinds are refused before and after the Solana read', async () => {
  const bad = (a, acct) => { const r = C.payoutCheck(a, acct); assert.equal(r.ok, false, a); return r; };
  assert.equal(C.payoutCheck('', undefined).level, 'empty');
  assert.equal(bad('abandon ability able about above absent absorb abstract absurd abuse access accident').level, 'secret');
  assert.match(bad('0x' + 'ab'.repeat(20)).msg, /Ethereum/);
  assert.match(bad('not-an-address').msg, /not a Solana address/);
  assert.match(bad(C.USDC_MINT).msg, /USDC token/);
  assert.match(bad(C.KLEND.cusdc).msg, /cUSDC/);
  assert.equal(C.payoutCheck(MERCHANT, undefined).level, 'pending');
  // what Solana says decides the rest (shapes as getAccountInfo jsonParsed returns them)
  const usdcAccount = await C.ata(MERCHANT);
  assert.match(bad(usdcAccount, { owner: C.TOKEN_PROGRAM, executable: false, type: 'account' }).msg, /token account/);
  assert.match(bad('So11111111111111111111111111111111111111112').msg, /wrapped SOL/);
  assert.match(bad(C.KLEND.program, { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true }).msg, /program/);
  const someMint = C.b58encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
  assert.match(bad(someMint, { owner: C.TOKEN_PROGRAM, executable: false, type: 'mint' }).msg, /mint/);
  // the real merchant wallet: an on-curve key owned by the System program
  const good = C.payoutCheck(MERCHANT, { owner: C.SYSTEM_PROGRAM, executable: false });
  assert.equal(good.ok, true); assert.equal(good.level, 'good'); assert.equal(good.canSign, true);
  assert.equal(C.payoutCheck(MERCHANT, null).level, 'good');
  assert.equal(C.payoutCheck(MERCHANT, 'error').level, 'warn');
  // a PDA (no private key) is allowed with a warning: multisig vaults are PDAs
  const pda = C.payoutCheck(usdcAccount, null);
  assert.equal(pda.ok, true); assert.equal(pda.level, 'warn'); assert.equal(pda.canSign, false);
  assert.equal(C.payoutCheck(MERCHANT, { owner: 'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu', executable: false }).level, 'warn');
});
test('link input is validated and normalised', () => {
  assert.deepEqual(C.linkInput({ to: ` ${MERCHANT} `, amt: '25,50', ref: 'inv-1', name: ' Demo  Shop ' }), { to: MERCHANT, amt: '25.50', ref: 'inv-1', name: 'Demo Shop' });
  assert.equal(C.linkInput({ to: MERCHANT, amt: '0.15' }).name, null);
  assert.throws(() => C.linkInput({ to: 'x', amt: '1' }), /Solana address/);
  for (const amt of ['0.14', '1.1234567', '-1', '1e3', '', '1,2,3', '1.5.5']) assert.throws(() => C.linkInput({ to: MERCHANT, amt }), /Amount/, amt);
  assert.throws(() => C.linkInput({ to: MERCHANT, amt: '1', ref: 'a b' }), /Reference/);
  assert.throws(() => C.linkInput({ to: MERCHANT, amt: '1', name: 'Sh\u200Bop' }), /Name/);
});
test('the signed message has sorted keys, carries the name and settlement, and the checkout can read it back', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const m = C.linkMessage({ to: MERCHANT, amt: '25.00', ref: 'inv-1', earn: true, name: 'Café Lumière', signer: MERCHANT, now });
  const f = JSON.parse(m);
  assert.deepEqual(Object.keys(f), [...Object.keys(f)].sort());
  assert.deepEqual(f, { amt: '25.00', exp: now / 1000 + 7 * 86400, k: MERCHANT, n: 'Café Lumière', ref: 'inv-1', s: 'earn', to: MERCHANT, v: 1 });
  const plain = JSON.parse(C.linkMessage({ to: MERCHANT, amt: '1', signer: MERCHANT, now }));
  assert.equal('n' in plain, false); assert.equal('s' in plain, false);
});
test('permanent page link: address plus an optional unsigned name', () => {
  assert.deepEqual(C.permanentLink(`#a=${MERCHANT}`), { merchant: MERCHANT, name: null });
  assert.deepEqual(C.permanentLink(`#a=${MERCHANT}&n=${encodeURIComponent('Tienda Ana')}`), { merchant: MERCHANT, name: 'Tienda Ana' });
  assert.equal(C.permanentLink(`#a=${MERCHANT}&n=${encodeURIComponent('x\u202Ey')}`).name, null);
});
test('merchant ledger reads real mainnet transactions: a Kamino deposit and a USDC credit', async () => {
  const dst = await C.ata(MERCHANT, C.KLEND.cusdc);
  const e = C.merchantCredit(earnTx.tx, MERCHANT, dst, earnTx.sig);
  assert.equal(e.kind, 'earn'); assert.equal(e.shares, 124074n); assert.ok(e.supplied >= 149990n && e.supplied <= 150000n, String(e.supplied));
  assert.equal(e.ref, 'Cg13sKZkqtvmJUmUVqH6GHWzMDNdsNnQfLyRWAWYNy9s');
  // a transaction that also deposits for someone else cannot inflate the merchant's figure: the vault grew 10x, the row does not
  const big = structuredClone(earnTx.tx);
  for (const side of ['preTokenBalances', 'postTokenBalances']) for (const b of big.meta[side]) if (b.owner === C.KLEND.authority && b.mint === C.USDC_MINT) b.uiTokenAmount.amount = String(BigInt(b.uiTokenAmount.amount) * (side === 'postTokenBalances' ? 10n : 1n));
  assert.ok(C.merchantCredit(big, MERCHANT, dst, earnTx.sig).supplied <= 150000n);
  // the same cUSDC credit does not count for a different destination account (positive control above)
  assert.equal(C.merchantCredit(earnTx.tx, MERCHANT, await C.ata(MERCHANT), earnTx.sig), null);
  const u = C.merchantCredit(usdcTx.tx, MERCHANT, dst, usdcTx.sig);
  assert.deepEqual(u, { kind: 'usdc', sig: usdcTx.sig, at: usdcTx.tx.blockTime, usdc: 500000n });
  // failed transactions and someone else's credits are nothing
  const failed = structuredClone(usdcTx.tx); failed.meta.err = { InstructionError: [0, 'Custom'] };
  assert.equal(C.merchantCredit(failed, MERCHANT, dst, 'x'), null);
  assert.equal(C.merchantCredit(usdcTx.tx, 'So11111111111111111111111111111111111111112', dst, 'x'), null);
});
test('the merchant moving its own USDC into Kamino, or out of it, is not income', () => {
  const tx = (usdcPre, usdcPost, cPre, cPost) => ({ blockTime: 1, meta: { err: null,
    preTokenBalances: [{ owner: MERCHANT, mint: C.USDC_MINT, uiTokenAmount: { amount: usdcPre } }, { owner: MERCHANT, mint: C.KLEND.cusdc, uiTokenAmount: { amount: cPre } }],
    postTokenBalances: [{ owner: MERCHANT, mint: C.USDC_MINT, uiTokenAmount: { amount: usdcPost } }, { owner: MERCHANT, mint: C.KLEND.cusdc, uiTokenAmount: { amount: cPost } }] },
    transaction: { message: { instructions: [] } } });
  assert.equal(C.merchantCredit(tx('100', '0', '0', '80'), MERCHANT, 'dst', 's'), null); // no Kamino deposit to dst named, and USDC fell
  assert.equal(C.merchantCredit(tx('0', '100', '80', '0'), MERCHANT, 'dst', 's').kind, 'withdraw');
});
test('ledger rows: Solana credits first-class, Aurora adds source and in-flight payments, unpaid quotes left out', async () => {
  const dst = await C.ata(MERCHANT, C.KLEND.cusdc);
  const credits = [C.merchantCredit(usdcTx.tx, MERCHANT, dst, usdcTx.sig), C.merchantCredit(earnTx.tx, MERCHANT, dst, earnTx.sig), { kind: 'withdraw', sig: 'w', at: 5, usdc: 9n }];
  const base = { originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', recipient: MERCHANT };
  const aurora = [
    { ...base, depositAddress: '0xd1EFDa88E49e98c3a9881C8CfcB0c9dfED19D8A5', status: 'SUCCESS', amountInFormatted: '0.773463', destinationChainTxHashes: [usdcTx.sig], createdAt: '2026-10-29T18:25:00Z' },
    { ...base, depositAddress: '0x399E9E3B0013C1D51148F19402d9A5ecC7e0AD56', status: 'REFUNDED', amountInFormatted: '0.4', destinationChainTxHashes: [], createdAt: '2026-10-29T18:27:00Z' },
    { ...base, depositAddress: '0x1111111111111111111111111111111111111111', status: 'PENDING_DEPOSIT', createdAt: '2026-10-30T00:00:00Z' },
    { ...base, recipient: 'someoneelse', depositAddress: '0x2222222222222222222222222222222222222222', status: 'SUCCESS', createdAt: '2026-10-30T00:00:00Z' },
  ];
  const rows = C.ledgerRows(credits, aurora, MERCHANT);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.kind), ['earn', 'aurora', 'usdc']); // newest first
  // Without the payment's own record there is no "paid with" amount: the list's amountIn is never shown as what the customer sent.
  const paid = rows[2]; assert.equal(paid.verified, true); assert.equal(paid.usdc, 500000n); assert.equal(paid.paidIn, null); assert.equal(paid.record, '#s=0xd1EFDa88E49e98c3a9881C8CfcB0c9dfED19D8A5');
  assert.equal(rows[1].status, 'REFUNDED'); assert.equal(rows[1].verified, false); assert.equal(rows[1].usdc, null);
  assert.equal(rows[0].record, `#c=Cg13sKZkqtvmJUmUVqH6GHWzMDNdsNnQfLyRWAWYNy9s.${MERCHANT}`);
});
test('daily totals count only verified credits, in the merchant\'s local day', () => {
  const now = Date.parse('2026-11-03T10:00:00Z');
  const rows = [
    { verified: true, at: Date.parse('2026-11-03T09:00:00Z') / 1000, usdc: 500000n },
    { verified: true, at: Date.parse('2026-11-02T20:00:00Z') / 1000, usdc: 150000n }, // 01:30 on Nov 3 in IST
    { verified: false, at: Date.parse('2026-11-03T08:00:00Z') / 1000, usdc: null },
    { verified: true, at: Date.parse('2026-10-01T08:00:00Z') / 1000, usdc: 999n }, // outside the window
  ];
  const utc = C.dailyTotals(rows, { days: 3, now });
  assert.deepEqual(utc.map((d) => [d.day, d.usdc, d.count]), [['2026-11-01', 0n, 0], ['2026-11-02', 150000n, 1], ['2026-11-03', 500000n, 1]]);
  const ist = C.dailyTotals(rows, { days: 3, now, tzOffsetMin: -330 });
  assert.deepEqual(ist.map((d) => [d.day, d.usdc, d.count]), [['2026-11-01', 0n, 0], ['2026-11-02', 0n, 0], ['2026-11-03', 650000n, 2]]);
});
test('earn value is a lower bound from the newest real deposit rate', async () => {
  const dst = await C.ata(MERCHANT, C.KLEND.cusdc);
  const rows = C.ledgerRows([C.merchantCredit(earnTx.tx, MERCHANT, dst, earnTx.sig)], [], MERCHANT);
  const v = C.earnValue(124074n, rows);
  assert.ok(v.usdc >= 149990n && v.usdc <= 150000n, String(v.usdc)); assert.equal(v.sig, earnTx.sig);
  assert.equal(C.earnValue(0n, rows), null); assert.equal(C.earnValue(5n, []), null);
});
test('links remembered on this device: newest first, no duplicates, capped', () => {
  let l = [];
  for (let i = 0; i < 10; i++) l = C.rememberLink(l, { url: `u${i}` }, 8);
  assert.equal(l.length, 8); assert.equal(l[0].url, 'u9');
  l = C.rememberLink(l, { url: 'u5', again: true }, 8);
  assert.equal(l[0].again, true); assert.equal(l.filter((x) => x.url === 'u5').length, 1);
  assert.deepEqual(C.rememberLink('junk', { url: 'a' }), [{ url: 'a' }]);
});

// ---------- hardening after review ----------
test('a name cannot pass for an address, and cannot draw over the page', () => {
  for (const bad of ['9cYFzr...DDReR', '9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2', '0x12ab Shop', 'Lumière2024Shop', 'AbCdEfGhIjKl',
    'a\u0301\u0301\u0301\u0301', 'b\u0301\u0302\u0303', 'a\u20DD', '\u3164', 'Shop\uFE0F', 'A\u034FB', '\u115FShop', 'Shop\uFFA0', 'Shop\u180B', 'x' + '\u0301'.repeat(39)]) {
    assert.equal(C.cleanName(bad), null, JSON.stringify(bad));
  }
  for (const ok of ['Restaurant Lumière', 'Café 24', "McDonald's", 'Shop no. 7', 'a\u0301\u0301']) assert.notEqual(C.cleanName(ok), null, ok);
});
test('recovery phrases are caught capitalised, numbered or long', () => {
  const w = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
  assert.equal(C.looksSecret(w.map((x) => x[0].toUpperCase() + x.slice(1)).join(' ')), true);
  assert.equal(C.looksSecret(w.map((x, i) => `${i + 1}. ${x}`).join(' ')), true);
  assert.equal(C.looksSecret(w.map((x, i) => `${i + 1}.${x}`).join('\n')), true);
  assert.equal(C.looksSecret([...w, ...w].join(' ')), true); // 24 words, over 200 characters
  assert.equal(C.looksSecret(w.slice(0, 8).join(' ')), true);
  assert.equal(C.looksSecret('pay me at my shop'), false);
});
test('dust never counts, Aurora text fields must be plain numbers, and the Kamino floor holds against a dust deposit', async () => {
  const dst = await C.ata(MERCHANT, C.KLEND.cusdc);
  const real = C.merchantCredit(earnTx.tx, MERCHANT, dst, earnTx.sig);
  const dustEarn = { kind: 'earn', sig: 'd', at: real.at + 60, shares: 1n, supplied: 2n, ref: null };
  const rows = C.ledgerRows([real, dustEarn, { kind: 'usdc', sig: 'u', at: real.at + 30, usdc: 1n }], [], MERCHANT);
  assert.deepEqual(rows.map((r) => r.dust), [true, true, false]);
  const v = C.earnValue(124074n, rows); assert.ok(v.usdc <= 150000n && v.usdc >= 149000n, String(v.usdc)); assert.equal(v.sig, earnTx.sig);
  // only a dust deposit in view: still a floor, never above shares * rate
  const only = C.earnValue(124074n, C.ledgerRows([dustEarn], [], MERCHANT)); assert.ok(only.usdc <= 124074n, String(only.usdc));
  const days = C.dailyTotals(rows, { days: 30, now: (real.at + 3600) * 1000 });
  assert.equal(days.reduce((s, d) => s + d.count, 0), 1);
  const aur = [{ recipient: MERCHANT, depositAddress: '0x1111111111111111111111111111111111111111', status: 'REFUNDED', amountInFormatted: '<b>9</b>', amountOutFormatted: '1e9', originAsset: 'x', createdAt: '2026-10-30T00:00:00Z' }];
  const r = C.ledgerRows([], aur, MERCHANT)[0]; assert.equal(r.paidIn, null); assert.equal(r.out, null);
});

// ---------- merchant view on real mainnet reads (tests/fixture_merchant_view.json) ----------
const mv = JSON.parse(readFileSync(new URL('../fixture_merchant_view.json', import.meta.url)));
const NOW_MV = Date.parse('2026-11-03T12:00:00Z');
const CUTOFF_MV = Math.floor(NOW_MV / 1000) - 14 * 86400;
/** A fake RPC endpoint that serves a fixed signature list the way getSignaturesForAddress does: newest first, limit, before. */
const endpoint = (lists, log = []) => async (url, method, [acct, opts]) => {
  log.push({ url, acct, before: opts.before || null, limit: opts.limit });
  const all = lists[acct]; if (all instanceof Error) throw all; if (!all) return [];
  const from = opts.before ? all.findIndex((s) => s.signature === opts.before) + 1 : 0;
  return all.slice(from, from + opts.limit);
};
const fxTx = async (sig) => mv.txs[sig] || null;

test('account creation is read from lamports: the oldest real transaction opened each account, a later one did not', () => {
  const oldest = mv.sigs.usdc_full[mv.sigs.usdc_full.length - 1].signature;
  assert.equal(C.createdIn(mv.txs[oldest], mv.usdcAta), true);
  assert.equal(C.createdIn(mv.txs[mv.sigs.usdc_full[0].signature], mv.usdcAta), false); // today's payment
  assert.equal(C.createdIn(mv.txs[mv.sigs.cusdc_full[0].signature], mv.cusdcAta), true); // the settle-to-earn run opened the cUSDC account
  assert.equal(C.createdIn(mv.txs[oldest], mv.cusdcAta), false); // not in that transaction at all
  assert.equal(C.createdIn(null, mv.usdcAta), false); assert.equal(C.createdIn({ meta: {} }, mv.usdcAta), false);
});
test('history verdict: complete only with proof, a short list without an error is partial', () => {
  const sig = (n, t) => ({ signature: 'S'.repeat(64) + n, blockTime: t });
  const c = 1000;
  assert.deepEqual(C.historyVerdict({ sigs: [sig(1, 2000), sig(2, 999)], exhausted: false, cutoff: c }), { complete: true, reason: 'window', from: 999 });
  assert.equal(C.historyVerdict({ sigs: [sig(1, 2000), sig(2, 1500)], exhausted: true, cutoff: c, createdBy: 'S'.repeat(64) + 2 }).reason, 'created');
  assert.equal(C.historyVerdict({ sigs: [sig(1, 2000), sig(2, 1500)], exhausted: true, cutoff: c, createdBy: 'S'.repeat(64) + 1 }).complete, false);
  assert.equal(C.historyVerdict({ sigs: [sig(1, 2000)], exhausted: true, cutoff: c }).reason, 'short');
  assert.equal(C.historyVerdict({ sigs: [sig(1, 2000)], exhausted: false, cutoff: c }).reason, 'error');
  assert.equal(C.historyVerdict({ sigs: [sig(1, 2000)], exhausted: false, capped: true, cutoff: c }).reason, 'cap');
  assert.deepEqual(C.historyVerdict({ sigs: [], exhausted: true, cutoff: c, accountExists: false }), { complete: true, reason: 'none', from: null });
  assert.equal(C.historyVerdict({ sigs: [], exhausted: true, cutoff: c, accountExists: true }).complete, false);
  assert.equal(C.historyVerdict({ sigs: [], exhausted: true, cutoff: c }).complete, false); // unknown account: not proven
});
test('the cut-short node seen on 2026-11-03 is never taken as complete; the full node is found and proven', async () => {
  // vibe returned 1 of 8 signatures with no error; leo errored; Helium returned all 8.
  const short = endpoint({ [mv.usdcAta]: mv.sigs.usdc_short }); const full = endpoint({ [mv.usdcAta]: mv.sigs.usdc_full });
  const broken = async () => { throw new Error('Internal JSON-RPC error.'); };
  const call = (u, m, p) => ({ leo: broken, vibe: short, helium: full }[u](u, m, p));
  const alone = await C.readHistory({ urls: ['leo', 'vibe'], account: mv.usdcAta, cutoff: CUTOFF_MV, call, getTx: fxTx });
  assert.equal(alone.complete, false); assert.equal(alone.reason, 'short'); assert.equal(alone.sigs.length, 1);
  assert.equal(alone.from, mv.sigs.usdc_short[0].blockTime);
  assert.deepEqual(alone.tried.map((t) => t.error ? 'error' : t.reason), ['error', 'short']);
  const h = await C.readHistory({ urls: ['leo', 'vibe', 'helium'], account: mv.usdcAta, cutoff: CUTOFF_MV, call, getTx: fxTx });
  assert.equal(h.complete, true); assert.equal(h.reason, 'created'); assert.equal(h.url, 'helium'); assert.equal(h.sigs.length, 8);
  assert.deepEqual(h.sigs.map((s) => s.signature), mv.sigs.usdc_full.map((s) => s.signature)); // newest first, merged without duplicates
  const first = await C.readHistory({ urls: ['helium', 'vibe'], account: mv.usdcAta, cutoff: CUTOFF_MV, call, getTx: fxTx });
  assert.equal(first.url, 'helium'); assert.equal(first.tried.length, 1); // proven complete, so no second endpoint is asked
});
test('history pages with before until the list runs out, stops at the window, the cap, or a node that repeats itself', async () => {
  const log = []; const call = endpoint({ [mv.usdcAta]: mv.sigs.usdc_full }, log);
  const h = await C.readHistory({ urls: ['x'], account: mv.usdcAta, cutoff: CUTOFF_MV, page: 3, call, getTx: fxTx });
  assert.equal(h.complete, true); assert.equal(h.sigs.length, 8); assert.equal(log.length, 3);
  assert.deepEqual(log.map((l) => l.before), [null, mv.sigs.usdc_full[2].signature, mv.sigs.usdc_full[5].signature]);
  // A window that starts inside the list: the first page already reaches past it.
  const w = await C.readHistory({ urls: ['x'], account: mv.usdcAta, cutoff: mv.sigs.usdc_full[1].blockTime - 1, page: 3, call: endpoint({ [mv.usdcAta]: mv.sigs.usdc_full }), getTx: fxTx });
  assert.equal(w.reason, 'window'); assert.equal(w.sigs.length, 3);
  // More than the cap: partial, and the next endpoint is not asked (it would hit the same cap).
  const capLog = []; const cap = await C.readHistory({ urls: ['x', 'y'], account: mv.usdcAta, cutoff: CUTOFF_MV, page: 3, cap: 5, call: endpoint({ [mv.usdcAta]: mv.sigs.usdc_full }, capLog), getTx: fxTx });
  assert.equal(cap.complete, false); assert.equal(cap.reason, 'cap'); assert.ok(capLog.every((l) => l.url === 'x'));
  // A hostile node that serves the same full page forever ends with an error, not a hang.
  let n = 0; const loop = async () => { n++; return mv.sigs.usdc_full.slice(0, 3); };
  const bad = await C.readHistory({ urls: ['x'], account: mv.usdcAta, cutoff: CUTOFF_MV, page: 3, call: loop, getTx: fxTx });
  assert.equal(bad.complete, false); assert.equal(bad.reason, 'error'); assert.ok(n <= 3, String(n));
  // Garbage instead of a list, or invalid signatures, never count.
  const junk = await C.readHistory({ urls: ['x'], account: mv.usdcAta, cutoff: CUTOFF_MV, call: async () => ({ result: 'nope' }), getTx: fxTx });
  assert.equal(junk.complete, false); assert.equal(junk.sigs.length, 0);
  const bogus = await C.readHistory({ urls: ['x'], account: mv.usdcAta, cutoff: CUTOFF_MV, call: async () => [{ signature: '<img>' }], getTx: fxTx });
  assert.equal(bogus.complete, false); assert.equal(bogus.sigs.length, 0);
  // A new merchant: no account, no signatures, complete. The account check is asked only for an empty list.
  let asked = 0; const none = await C.readHistory({ urls: ['x'], account: mv.usdcAta, cutoff: CUTOFF_MV, call: async () => [], getTx: fxTx, accountExists: () => { asked++; return false; } });
  assert.equal(none.complete, true); assert.equal(none.reason, 'none'); assert.equal(asked, 1);
  asked = 0; await C.readHistory({ urls: ['x'], account: mv.usdcAta, cutoff: CUTOFF_MV, call, getTx: fxTx, accountExists: () => { asked++; return true; } });
  assert.equal(asked, 0);
  // A page that fails after the first: partial ('error'), what was read is kept.
  let k = 0; const flaky = async (u, m, p) => { if (k++) throw new Error('busy'); return mv.sigs.usdc_full.slice(0, 3); };
  const fl = await C.readHistory({ urls: ['x'], account: mv.usdcAta, cutoff: CUTOFF_MV, page: 3, call: flaky, getTx: fxTx });
  assert.equal(fl.complete, false); assert.equal(fl.reason, 'error'); assert.equal(fl.sigs.length, 3);
});
test('positive control on the demo merchant: 9 payments, 2.45 USDC in 14 days, and the USDC credits add up to its balance', async () => {
  const lists = { [mv.usdcAta]: mv.sigs.usdc_full, [mv.cusdcAta]: mv.sigs.cusdc_full };
  const read = async (acct, urls, call) => C.readHistory({ urls, account: acct, cutoff: CUTOFF_MV, call, getTx: fxTx });
  const credits = async (hs) => {
    const seen = new Set(); const out = [];
    for (const s of hs.flatMap((h) => h.sigs)) if (!seen.has(s.signature) && seen.add(s.signature)) { const c = C.merchantCredit(mv.txs[s.signature], mv.merchant, mv.cusdcAta, s.signature); if (c) out.push(c); }
    return out;
  };
  const full = endpoint(lists);
  const hs = [await read(mv.usdcAta, ['helium'], full), await read(mv.cusdcAta, ['helium'], full)];
  assert.ok(hs.every((h) => h.complete), JSON.stringify(hs.map((h) => h.reason)));
  const rows = C.ledgerRows(await credits(hs), mv.aurora, mv.merchant);
  const days = C.dailyTotals(rows, { days: 14, now: NOW_MV });
  assert.equal(days.reduce((s, d) => s + d.count, 0), 9);
  assert.equal(C.fromUnits(days.reduce((s, d) => s + d.usdc, 0n), 6), '2.45');
  // Independent check: no USDC ever left this account, so the sum of its credits equals its balance after the newest one.
  const usdcSum = rows.filter((r) => r.kind === 'usdc').reduce((s, r) => s + r.usdc, 0n);
  const newest = mv.txs[mv.sigs.usdc_full[0].signature];
  const bal = newest.meta.postTokenBalances.find((b) => b.owner === mv.merchant && b.mint === C.USDC_MINT).uiTokenAmount.amount;
  assert.equal(usdcSum, BigInt(bal)); assert.equal(C.fromUnits(usdcSum, 6), '2.3');
  // The cut-short node alone gives 1 of the 8 USDC credits and must be flagged partial, which is what the page then says.
  const shortHs = [await read(mv.usdcAta, ['vibe'], endpoint({ [mv.usdcAta]: mv.sigs.usdc_short })), await read(mv.cusdcAta, ['helium'], full)];
  assert.equal(shortHs[0].complete, false);
  const shortRows = C.ledgerRows(await credits(shortHs), mv.aurora, mv.merchant);
  const shortDays = C.dailyTotals(shortRows, { days: 14, now: NOW_MV }); // exactly what the live page showed: 2 payments, 0.30 USDC
  assert.equal(shortDays.reduce((s, d) => s + d.count, 0), 2); assert.equal(C.fromUnits(shortDays.reduce((s, d) => s + d.usdc, 0n), 6), '0.3');
});
test('paid with = what reached the deposit address, from that payment\'s own record, never the list\'s amountIn', async () => {
  const dep = '0x3ceB7E53E2127be1Ae70477AB53aE8e2955c34ba'; const today = mv.sigs.usdc_full[0].signature;
  const r = C.recordAmounts(mv.status[dep], dep, mv.merchant);
  assert.equal(r.paid, '0.161563'); assert.equal(r.invoice, 150000n); assert.equal(r.refunded, null); assert.deepEqual(r.sols, [today]);
  assert.equal(mv.aurora.find((x) => x.depositAddress === dep).amountInFormatted, '0.160046'); // the number the page used to show
  assert.equal(C.recordAmounts(mv.status[dep], dep.toLowerCase(), mv.merchant).paid, '0.161563'); // EVM case does not matter
  assert.equal(C.recordAmounts(mv.status[dep], '0xDF4FE7105893cB3BC78579A703b551d65eBa7c54', mv.merchant), null); // another deposit's record
  assert.equal(C.recordAmounts(mv.status[dep], dep, mv.usdcAta), null); // another merchant
  assert.equal(C.recordAmounts(null, dep, mv.merchant), null); assert.equal(C.recordAmounts({ message: 'not found' }, dep, mv.merchant), null);
  const records = new Map(Object.entries(mv.status).map(([k, s]) => [k, C.recordAmounts(s, k, mv.merchant)]));
  const credits = mv.sigs.usdc_full.map((s) => C.merchantCredit(mv.txs[s.signature], mv.merchant, mv.cusdcAta, s.signature)).filter(Boolean);
  const rows = C.ledgerRows(credits, mv.aurora, mv.merchant, records);
  const by = (sig) => rows.find((x) => x.sig === sig);
  assert.equal(by(today).paidIn, '0.161563'); assert.equal(by(today).record, `#s=${dep}`);
  assert.equal(by('4oPn2qbtaHY2JiDi88BAFivHjDcHJs8QbmBDhbPezWuuZT2VVPcU7m5tb7kSwxxeY7pN6CNPj448xEZT3q7PL9Hs').paidIn, '0.161535');
  assert.equal(by('49Uz6rAsJMQEx2qcX9JdCJqSzCdbpWSKBttYaJNrjaPKjAfZ5qH6SdLr3mwAw34rucxM6hy2i91FcAJe1nVVAxZV').paidIn, '0.161561');
  for (const row of rows) for (const x of mv.aurora) assert.notEqual(row.paidIn, x.amountInFormatted);
  // Without records: no amount at all. A record that names another Solana transaction is not used for this credit.
  assert.equal(C.ledgerRows(credits, mv.aurora, mv.merchant).find((x) => x.sig === today).paidIn, null);
  const wrongSol = new Map([[dep, { ...records.get(dep), sols: ['4oPn2qbtaHY2JiDi88BAFivHjDcHJs8QbmBDhbPezWuuZT2VVPcU7m5tb7kSwxxeY7pN6CNPj448xEZT3q7PL9Hs'] }]]);
  assert.equal(C.ledgerRows(credits, mv.aurora, mv.merchant, wrongSol).find((x) => x.sig === today).paidIn, null);
});
test('a record with a refund shows what was sent and what came back; one still in flight shows its invoice, not a list number', async () => {
  const t2 = '0xd1EFDa88E49e98c3a9881C8CfcB0c9dfED19D8A5'; const t1 = '0x399E9E3B0013C1D51148F19402d9A5ecC7e0AD56';
  const r2 = C.recordAmounts(mv.status[t2], t2, mv.merchant); assert.equal(r2.paid, '0.773463'); assert.equal(r2.refunded, '0.002659');
  assert.equal(mv.status[t2].swapDetails.amountInFormatted, '0.768404'); // swapped amount, not what the customer sent
  const r1 = C.recordAmounts(mv.status[t1], t1, mv.merchant); assert.equal(r1.paid, '0.4'); assert.equal(r1.refunded, '0.3976'); assert.equal(r1.invoice, 1000000n);
  const base = { originAsset: mv.status[t1].quoteResponse.quoteRequest.originAsset, recipient: mv.merchant };
  const aur = [{ ...base, depositAddress: t1, status: 'REFUNDED', amountInFormatted: '9.99', amountOutFormatted: '9.99', destinationChainTxHashes: [], createdAt: '2026-10-29T18:27:00Z' }];
  const row = C.ledgerRows([], aur, mv.merchant, new Map([[t1, r1]]))[0];
  assert.equal(row.paidIn, '0.4'); assert.equal(row.refunded, '0.3976'); assert.equal(row.out, '1');
  const bare = C.ledgerRows([], aur, mv.merchant)[0]; assert.equal(bare.paidIn, null); assert.equal(bare.out, null);
  // A record before any deposit has no paid amount.
  const pending = structuredClone(mv.status[t1]); pending.swapDetails.depositedAmountFormatted = '0'; pending.swapDetails.refundedAmountFormatted = '0';
  const rp = C.recordAmounts(pending, t1, mv.merchant); assert.equal(rp.paid, null); assert.equal(rp.refunded, null);
  pending.swapDetails.depositedAmountFormatted = '<b>1</b>'; assert.equal(C.recordAmounts(pending, t1, mv.merchant).paid, null);
});

// ---------- 4 Nov live proofs: refunds by role, merchant redemption, permanent-address delivery ----------
const overpay = JSON.parse(readFileSync(new URL('../fixture_status_overpay.json', import.meta.url)));
const redeemTx = JSON.parse(readFileSync(new URL('../fixture_tx_redeem.json', import.meta.url)));
const permFx = JSON.parse(readFileSync(new URL('../fixture_permanent_lists.json', import.meta.url)));
test('refund hashes are told apart from the Solana settlement, in both record formats Aurora has used', () => {
  // 4 Nov: the refund sits in destinationChainTxHashes next to the Solana signature (real record, overpaid 0.30 for 0.25)
  const r = C.txRoles(overpay.swapDetails);
  assert.equal(r.deposit, '0xcef3352b2ba6fd3cf1ceae4bdcf5bbdc284525c0d783611e9afb4f5ac04b85a4');
  assert.deepEqual(r.solana, ['55V6UFtjVaCzWuK7WEDxBnS8LvXb2GLqdZFoDRXRXkbR472Rw4h9n9nWNdYJEKKYXaNxfrs9apB1WmiQVYzp7eM7']);
  assert.deepEqual(r.refunds, ['0x32c814bfd4e1c22fc1bd34d0c44228cd3ee5c70cd44b5058a35445c5a136b135']); assert.equal(r.refunded, true);
  // the refund listed first must not be taken for the settlement
  const flipped = structuredClone(overpay.swapDetails); flipped.destinationChainTxHashes.reverse();
  assert.deepEqual(C.txRoles(flipped).solana, r.solana); assert.deepEqual(C.txRoles(flipped).refunds, r.refunds);
  // October records: the refund is the second paying-chain hash (real T2 overpay and T1 short payment)
  const t2 = C.txRoles(mv.status['0xd1EFDa88E49e98c3a9881C8CfcB0c9dfED19D8A5'].swapDetails);
  assert.equal(t2.solana.length, 1); assert.equal(t2.refunds.length, 1); assert.ok(t2.refunds[0].startsWith('0x291a1b7a'));
  const t1 = C.txRoles(mv.status['0x399E9E3B0013C1D51148F19402d9A5ecC7e0AD56'].swapDetails);
  assert.deepEqual(t1.solana, []); assert.ok(t1.refunds[0].startsWith('0x7654c9ed')); assert.ok(t1.deposit.startsWith('0x926b1cce'));
  // with nothing refunded, a second paying-chain hash is a top-up, not a refund
  const topped = { originChainTxHashes: [{ hash: '0x' + 'a'.repeat(64) }, { hash: '0x' + 'b'.repeat(64) }], destinationChainTxHashes: [], refundedAmount: '0', refundedAmountFormatted: '0' };
  assert.deepEqual(C.txRoles(topped).refunds, []); assert.deepEqual(C.txRoles(topped).topups, ['0x' + 'b'.repeat(64)]);
  // junk never becomes a link
  const junk = { originChainTxHashes: [{ hash: '<img src=x>' }, null, 5], destinationChainTxHashes: [{ hash: 'javascript:alert(1)' }, { hash: 'x'.repeat(200) }] };
  assert.deepEqual(C.txRoles(junk), { deposit: null, solana: [], refunds: [], topups: [], refunded: false });
  assert.deepEqual(C.txRoles(undefined).solana, []);
});
test('merchant redemption is verified from the real mainnet transaction, and only for the merchant\'s own accounts', async () => {
  const usdcAcct = await C.ata(MERCHANT); const cusdcAcct = await C.ata(MERCHANT, C.KLEND.cusdc);
  assert.deepEqual(C.verifyRedeem(redeemTx, MERCHANT, { usdcAcct, cusdcAcct }), { usdc: 150041n, shares: 124074n });
  assert.equal(C.merchantCredit(redeemTx, MERCHANT, cusdcAcct, 's').kind, 'withdraw'); // listed, never counted as a payment
  assert.equal(C.verifyRedeem(redeemTx, 'So11111111111111111111111111111111111111112', {}), null);
  assert.equal(C.verifyRedeem(redeemTx, MERCHANT, { usdcAcct: cusdcAcct, cusdcAcct }), null); // USDC paid elsewhere
  const failed = structuredClone(redeemTx); failed.meta.err = { InstructionError: [2, 'Custom'] }; assert.equal(C.verifyRedeem(failed, MERCHANT, {}), null);
  // the merchant's settle-to-earn deposit and a plain USDC credit are not redemptions
  assert.equal(C.verifyRedeem(earnTx.tx, MERCHANT, {}), null); assert.equal(C.verifyRedeem(usdcTx.tx, MERCHANT, {}), null);
  // balances alone are not enough: without Kamino's redeem instruction it is not a redemption
  const noIx = structuredClone(redeemTx); noIx.transaction.message.instructions = noIx.transaction.message.instructions.filter((i) => i.programId !== C.KLEND.program);
  assert.equal(C.verifyRedeem(noIx, MERCHANT, {}), null);
});
test('a permanent-address payment counts only when Aurora lists that deposit and that delivery for this address and merchant', () => {
  const q = { address: permFx.address, merchant: permFx.merchant, depositTx: '0xc6b89c8e5f80eeae72b9eb7b428b035c5b907c67cac238d899f649a4541ada9b',
    solanaTx: '2Jhg3e1bBxCi3oE1BogFcvTn7bivpY3SaJbfnqqbDUzviswDczjU9Fi4WuHbLqw7EVtgqmR7qsz6hgQRHxcvksiE' };
  const hit = C.permanentDelivered(permFx.lists, q);
  assert.ok(hit); assert.equal(hit.received.amount, '1100000'); assert.equal(hit.delivered.amount, '1089777');
  assert.equal(C.permanentDelivered(permFx.lists, { ...q, address: permFx.address.toLowerCase() }) !== null, true); // EVM case-insensitive
  assert.equal(C.permanentDelivered(permFx.lists, { ...q, merchant: 'So11111111111111111111111111111111111111112' }), null);
  assert.equal(C.permanentDelivered(permFx.lists, { ...q, address: '0x57c2C008e9739E012D6878164E5E70BcA555b6B4' }), null);
  assert.equal(C.permanentDelivered(permFx.lists, { ...q, solanaTx: '55V6UFtjVaCzWuK7WEDxBnS8LvXb2GLqdZFoDRXRXkbR472Rw4h9n9nWNdYJEKKYXaNxfrs9apB1WmiQVYzp7eM7' }), null);
  assert.equal(C.permanentDelivered({ received: permFx.lists.received, success: [] }, q), null);
  assert.equal(C.permanentDelivered(null, q), null);
});
test('the permanent page names the asset of a real received deposit, whose id comes without the nep141: prefix', () => {
  const rows = C.depositRows(permFx.lists);
  assert.deepEqual(rows.map((r) => [r.kind, r.amount, r.assetId]), [
    ['delivered', '1.089777', 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near'],
    ['received', '1.1', 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near']]);
  assert.equal(C.depositRows({ received: [{ asset_id: 'nep245:v2_1.omni.hot.tg:10_11111111111111111111', amount: '1', decimals: 18 }] })[0].assetId, 'nep245:v2_1.omni.hot.tg:10_11111111111111111111');
  assert.equal(C.depositRows({ received: [{ asset_id: '', amount: '1' }] })[0].assetId, null);
});
