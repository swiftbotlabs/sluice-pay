// Offline tests for the live-proof rows (docs/proofs.js): every row re-checks green on the real 4 Nov data, every fee group
// adds up exactly, and tampered data does not pass. Fixture = public mainnet data read on 4 Nov (tests/fixture_proof_rows.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const P = req('../../docs/proofs.js');
const fx = JSON.parse(readFileSync(new URL('../fixture_proof_rows.json', import.meta.url))).rows;
const snap = JSON.parse(readFileSync(new URL('../../docs/proofs-snapshot.json', import.meta.url)));
const ioFor = (r) => ({ swapStatus: async () => r.status, getTx: async () => r.tx, permList: async (a, t) => (r[t] || {}).deposits || [] });
const T = Date.parse('2026-11-04T16:30:00Z');
const units = (amount) => { const [i, f = ''] = amount.split('.'); return { i, f }; };
const toRaw = (amount, dec) => { const { i, f } = units(amount); return BigInt(i) * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0'); };

// Rows are looked up by name, so adding a run does not shift the checks below.
const N = (start) => { const i = P.PROOF.findIndex((p) => p.name.startsWith(start)); assert.ok(i >= 0, start); return [P.PROOF[i], fx[i]]; };
test('fixture rows line up with the proof rows', () => {
  assert.equal(P.PROOF.length, 17); assert.equal(fx.length, P.PROOF.length);
  fx.forEach((r, i) => assert.equal(r.name, P.PROOF[i].name));
});

test('every row verifies on the real data, and every fee group adds up exactly', async () => {
  for (const [i, p] of P.PROOF.entries()) {
    const out = await P.checkRow(p, ioFor(fx[i]), T);
    assert.equal(out.ok, true, p.name);
    assert.ok(out.fees && out.fees.sentence, p.name + ': fee sentence');
    for (const g of out.fees.groups) {
      const same = g.parts.filter((x) => x.unit === g.total.unit && x.raw !== undefined);
      if (same.length !== g.parts.length) continue; // a swap into another asset: checked in source units only
      assert.equal(same.reduce((n, x) => n + BigInt(x.raw), 0n), BigInt(g.total.raw), `${p.name}: ${g.total.label}`);
    }
  }
});

test('the overpaid invoice itemises the 0.012488 USDC between sent, delivered and refunded', async () => {
  const [ov, ovx] = N('Overpaid invoice');
  const out = await P.checkRow(ov, ioFor(ovx), T);
  assert.match(out.fees.sentence, /^0\.30 sent = 0\.25 to the merchant \+ 0\.037512 refunded \+ 0\.012488 USDC in fees \(0\.0024 refund gas, 0\.010007 Solana delivery, 0\.000081 Aurora's 2 bps fee and the solver's price\)\.$/);
  const [sent, swap] = out.fees.groups;
  assert.deepEqual(sent.parts.map((x) => x.amount), ['0.260088', '0.037512', '0.0024']);
  assert.deepEqual(swap.parts.map((x) => x.amount), ['0.25', '0.010007', '0.000081']);
});

test('first payment to a merchant: rent shows inside the delivery fee; settle-to-earn shows the Connect fee and the leftover', async () => {
  const first = await P.checkRow(...((r) => [r[0], ioFor(r[1]), T])(N('Paid from Base USDC')));
  assert.match(first.fees.groups[1].parts[1].label, /rent for the merchant's new USDC account \(0\.00148844 SOL\)/);
  const earn = await P.checkRow(...((r) => [r[0], ioFor(r[1]), T])(N('Invoice settled into Kamino')));
  const steps = earn.fees.groups[2];
  assert.deepEqual(steps.parts.map((x) => x.amount), ['0.15', '0.14683', '0.002']);
  assert.match(earn.fees.sentence, /includes opening the merchant's new cUSDC account/);
});

test('ETH rows: source side exact in wei, USD side marked approximate', async () => {
  const op = await P.checkRow(...((r) => [r[0], ioFor(r[1]), T])(N('Paid from ETH on Optimism')));
  const sent = op.fees.groups[0];
  assert.equal(sent.parts.reduce((n, x) => n + BigInt(x.raw), 0n), BigInt(sent.total.raw));
  assert.equal(sent.parts[2].amount, '0.0000002600774');
  assert.match(op.fees.groups[1].parts[2].amount, /^≈\$0\.000\d$/);
});

test('guard: tampered data does not verify (positive control: the real data above does)', async () => {
  const [ovp, ovf] = N('Overpaid invoice'); const [pmp, pmf] = N('Permanent address');
  const short = structuredClone(ovf);
  short.tx.meta.postTokenBalances.find((b) => b.owner === P.MERCHANT && b.mint.startsWith('EPjF')).uiTokenAmount.amount = '2000000';
  short.tx.meta.preTokenBalances.find((b) => b.owner === P.MERCHANT && b.mint.startsWith('EPjF')).uiTokenAmount.amount = '1800000';
  assert.equal((await P.checkRow(ovp, ioFor(short), T)).ok, false, 'merchant credited 0.20 < 0.25');
  const pending = structuredClone(ovf); pending.status.status = 'PROCESSING';
  assert.equal((await P.checkRow(ovp, ioFor(pending), T)).ok, false, 'Aurora not at SUCCESS');
  const failed = structuredClone(pmf); failed.tx.meta.err = { InstructionError: [0, 'x'] };
  assert.equal((await P.checkRow(pmp, ioFor(failed), T)).ok, false, 'failed Solana tx');
  const unlisted = structuredClone(pmf); unlisted.success = { deposits: [] };
  assert.equal((await P.checkRow(pmp, ioFor(unlisted), T)).ok, false, 'permanent delivery not listed');
});

test('shipped snapshot: every row, verified, with the chain data each check read and when', () => {
  assert.equal(snap.rows.length, P.PROOF.length);
  for (const [i, p] of P.PROOF.entries()) {
    const r = snap.rows[i];
    assert.equal(r.id, P.id(p)); assert.equal(r.ok, true, p.name);
    assert.ok(Date.parse(r.checked_at) > Date.parse('2026-11-04T00:00:00Z'), 'stamped');
    if (p.sol) assert.ok(Number.isInteger(r.solana.slot) && r.solana.err === null, p.name + ': Solana facts');
    if (p.addr && p.kind !== 'perm') assert.ok(r.aurora && r.aurora.status, p.name + ': Aurora facts');
    assert.ok(r.fees && r.fees.sentence);
  }
  assert.match(P.snapshotLabel(snap.rows[0]), /^Verified 4 Nov, \d\d:\d\d UTC$/);
});

// The static copy of the panel in index.html (tools/render_static.mjs): what a reader without JavaScript gets.
test('index.html carries every proof row, verified, with its transaction links, and is in step with the snapshot', async () => {
  const R = await import('../../tools/render_static.mjs');
  const html = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
  assert.equal(R.inject(html, R.render(snap)), html, 'static block is stale: run node tools/render_static.mjs');
  const block = html.slice(html.indexOf('<!-- static:proof:start'), html.indexOf('<!-- static:proof:end -->'));
  const rows = block.match(/<div class="proof[^"]*" data-id="[^"]+">/g) || [];
  assert.equal(rows.length, P.PROOF.length);
  for (const p of P.PROOF) {
    assert.ok(block.includes(`data-id="${P.id(p)}"`), p.name);
    if (p.dep) assert.ok(block.includes(p.dep), p.name + ': deposit link');
    if (p.sol) assert.ok(block.includes('https://solscan.io/tx/' + p.sol), p.name + ': Solana link');
    if (p.refund) assert.ok(block.includes(p.refund), p.name + ': refund link');
  }
  assert.equal((block.match(/class="out ok"><span class="when">Verified /g) || []).length, P.PROOF.length);
  assert.ok(!/<script/i.test(block));
});

test('the static renderer refuses a snapshot with an unverified or missing row, and escapes what it writes', async () => {
  const R = await import('../../tools/render_static.mjs');
  const bad = JSON.parse(JSON.stringify(snap)); bad.rows[0].ok = false;
  assert.throws(() => R.render(bad), /verified/);
  const gone = JSON.parse(JSON.stringify(snap)); gone.rows.pop();
  assert.throws(() => R.render(gone));
  const evil = JSON.parse(JSON.stringify(snap)); evil.rows[0].summary = ['<img src=x onerror=alert(1)>'];
  const out = R.render(evil);
  assert.ok(!out.includes('<img src=x'), 'summary text is escaped');
  assert.ok(out.includes('&lt;img src=x'));
  // stale-block positive control: a changed snapshot no longer matches the file
  const html = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
  const moved = JSON.parse(JSON.stringify(snap)); moved.generated_at = '2026-11-01T00:00:00.000Z';
  assert.notEqual(R.inject(html, R.render(moved)), html);
});

test('the 5.00 USDC run itemises Sluice\'s fee inside the one Solana transaction, and every unit adds up', async () => {
  const [p, f] = N('A 5.00 USDC invoice');
  const out = await P.checkRow(p, ioFor(f), T);
  assert.equal(out.ok, true);
  const steps = out.fees.groups[2];
  assert.equal(steps.total.amount, '5.19');
  assert.deepEqual(steps.parts.map((x) => [x.kind, x.amount]), [['merchant', '5.00'], ['sluice', '0.025'], ['fee', '0.149068'], ['', '0.015932']]);
  assert.match(out.fees.sentence, /paid Sluice's 0\.025 USDC fee, paid a 0\.149068 USDC Intents Connect fee \(it includes opening Sluice's fee account, once\) and kept 0\.015932\./);
  assert.equal(out.solana.sluiceUsdc, '25000'); assert.equal(out.solana.sluiceOpened, true);
  // positive control: the same transaction without the fee credit no longer itemises a Sluice fee
  const nofee = structuredClone(f); nofee.tx.meta.postTokenBalances = nofee.tx.meta.postTokenBalances.filter((b) => b.owner !== P.MERCHANT || true).map((b) => (b.owner === '8b9QYitFTUMoqZhGTZXX43fND4CLTQXkgxX45mwRFEY8' ? { ...b, uiTokenAmount: { ...b.uiTokenAmount, amount: '0' } } : b));
  const o2 = await P.checkRow(p, ioFor(nofee), T);
  assert.ok(!o2.fees.groups[2].parts.some((x) => x.kind === 'sluice'));
});

test('the 5.00 USDC redemption: 4.134567 cUSDC burned for the 5.00 supplied plus interest', async () => {
  const [p, f] = N('The merchant redeemed the 5.00');
  const out = await P.checkRow(p, ioFor(f), T);
  assert.equal(out.ok, true);
  assert.deepEqual(out.fees.groups[0].parts.map((x) => x.amount), ['5.00', '0.000006']);
  assert.match(out.fees.sentence, /^The merchant burned 4\.134567 cUSDC and received 5\.000006 USDC: the 5\.00 supplied plus 0\.000006 interest/);
  const [p1, f1] = N('Merchant took its Kamino position out');
  assert.match((await P.checkRow(p1, ioFor(f1), T)).fees.sentence, /the 0\.15 supplied plus 0\.000041 interest/);
});

test('the page states the number of runs the proof list holds', () => {
  const html = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
  const words = { 17: 'Seventeen' }; const n = P.PROOF.length;
  assert.ok(html.includes(`<b>${n}</b> mainnet runs`), 'hero line count');
  assert.ok(html.includes(`<p class="muted">${words[n]} real payments`), 'proof lead count');
});
test('the payer\'s first Solana account is named inside the delivery fee of the 5.00 run', async () => {
  const [p, f] = N('A 5.00 USDC invoice');
  const out = await P.checkRow(p, ioFor(f), T);
  assert.match(out.fees.sentence, /0\.257261 Solana delivery \(it includes opening the payer's Solana USDC account, once\)/);
});
