// Re-check all 13 live proofs against Aurora and Solana mainnet, with the same code the page runs (docs/proofs.js), and write
// docs/proofs-snapshot.json: what each check read (Aurora's record, the Solana transaction) and when. The page shows this
// stored verification at once and then refreshes it live. Public data only; no keys besides the page's public integrator id.
//   node tools/snapshot_proofs.mjs            (refuses to write unless every row verifies)
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const P = req('../docs/proofs.js');
const AURORA = 'https://intents-api.aurora.dev'; const KEY = '53042395-08f3-4382-a78e-b2208d0397c1';
const RPCS = ['https://solana-rpc.web.helium.io', 'https://solana-mainnet.gateway.tatum.io', 'https://public.rpc.solanavibestation.com'];
const getJson = async (url, init = {}) => { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
async function getTx(sig) {
  for (const u of RPCS) {
    try {
      const j = await getJson(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] }) });
      if (j.result) return j.result;
    } catch { /* next endpoint */ }
  }
  throw new Error('no Solana RPC answered for ' + sig.slice(0, 8));
}
const io = {
  swapStatus: (addr) => getJson(`${AURORA}/api/status/${KEY}?depositAddress=${encodeURIComponent(addr)}`),
  getTx,
  permList: (addr, type) => getJson(`${AURORA}/api/persistent-deposit-status/${KEY}?address=${encodeURIComponent(addr)}&type=${type}&limit=20`).then((j) => (Array.isArray(j.deposits) ? j.deposits : [])),
};
const rows = [];
for (const p of P.PROOF) {
  const r = await P.checkRow(p, io);
  console.log(r.ok ? 'ok  ' : 'FAIL', p.name);
  rows.push(r);
}
if (rows.some((r) => !r.ok)) { console.error('not every row verified: snapshot not written'); process.exit(1); }
writeFileSync(new URL('../docs/proofs-snapshot.json', import.meta.url), JSON.stringify({
  generated_at: new Date().toISOString(), by: 'tools/snapshot_proofs.mjs (same checks as the page: docs/proofs.js checkRow)',
  sources: { aurora: AURORA + '/api/status and /api/persistent-deposit-status (public integrator key)', solana: 'getTransaction jsonParsed, commitment confirmed: ' + RPCS.join(', ') },
  rows,
}, null, 1) + '\n');
console.log('wrote docs/proofs-snapshot.json with', rows.length, 'verified rows');
