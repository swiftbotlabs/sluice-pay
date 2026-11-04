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

test('fixture rows line up with the 13 proof rows', () => {
  assert.equal(P.PROOF.length, 13); assert.equal(fx.length, 13);
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
  const out = await P.checkRow(P.PROOF[1], ioFor(fx[1]), T);
  assert.match(out.fees.sentence, /^0\.30 sent = 0\.25 to the merchant \+ 0\.037512 refunded \+ 0\.012488 USDC in fees \(0\.0024 refund gas, 0\.010007 Solana delivery, 0\.000081 Aurora's 2 bps fee and the solver's price\)\.$/);
  const [sent, swap] = out.fees.groups;
  assert.deepEqual(sent.parts.map((x) => x.amount), ['0.260088', '0.037512', '0.0024']);
  assert.deepEqual(swap.parts.map((x) => x.amount), ['0.25', '0.010007', '0.000081']);
});

test('first payment to a merchant: rent shows inside the delivery fee; settle-to-earn shows the Connect fee and the leftover', async () => {
  const first = await P.checkRow(P.PROOF[6], ioFor(fx[6]), T);
  assert.match(first.fees.groups[1].parts[1].label, /rent for the merchant's new USDC account \(0\.00148844 SOL\)/);
  const earn = await P.checkRow(P.PROOF[5], ioFor(fx[5]), T);
  const steps = earn.fees.groups[2];
  assert.deepEqual(steps.parts.map((x) => x.amount), ['0.15', '0.14683', '0.002']);
  assert.match(earn.fees.sentence, /includes opening the merchant's new cUSDC account/);
});

test('ETH rows: source side exact in wei, USD side marked approximate', async () => {
  const op = await P.checkRow(P.PROOF[3], ioFor(fx[3]), T);
  const sent = op.fees.groups[0];
  assert.equal(sent.parts.reduce((n, x) => n + BigInt(x.raw), 0n), BigInt(sent.total.raw));
  assert.equal(sent.parts[2].amount, '0.0000002600774');
  assert.match(op.fees.groups[1].parts[2].amount, /^≈\$0\.000\d$/);
});

test('guard: tampered data does not verify (positive control: the real data above does)', async () => {
  const short = structuredClone(fx[1]);
  short.tx.meta.postTokenBalances.find((b) => b.owner === P.MERCHANT && b.mint.startsWith('EPjF')).uiTokenAmount.amount = '2000000';
  short.tx.meta.preTokenBalances.find((b) => b.owner === P.MERCHANT && b.mint.startsWith('EPjF')).uiTokenAmount.amount = '1800000';
  assert.equal((await P.checkRow(P.PROOF[1], ioFor(short), T)).ok, false, 'merchant credited 0.20 < 0.25');
  const pending = structuredClone(fx[1]); pending.status.status = 'PROCESSING';
  assert.equal((await P.checkRow(P.PROOF[1], ioFor(pending), T)).ok, false, 'Aurora not at SUCCESS');
  const failed = structuredClone(fx[0]); failed.tx.meta.err = { InstructionError: [0, 'x'] };
  assert.equal((await P.checkRow(P.PROOF[0], ioFor(failed), T)).ok, false, 'failed Solana tx');
  const unlisted = structuredClone(fx[0]); unlisted.success = { deposits: [] };
  assert.equal((await P.checkRow(P.PROOF[0], ioFor(unlisted), T)).ok, false, 'permanent delivery not listed');
});

test('shipped snapshot: all 13 rows, verified, with the chain data each check read and when', () => {
  assert.equal(snap.rows.length, 13);
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
