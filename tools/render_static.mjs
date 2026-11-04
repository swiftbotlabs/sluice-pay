// Write the stored verification of every live proof (docs/proofs-snapshot.json) into docs/index.html as plain HTML, so the
// Live proof panel shows all rows, their transaction links and where every unit went without JavaScript. docs/app.js then
// rebuilds the panel with the same data and adds the live re-check. Rows, groups and wording come from docs/proofs.js.
//   node tools/render_static.mjs           rewrite the block between the static:proof markers
//   node tools/render_static.mjs --check   exit 1 if index.html is not what this script would write (used by the tests)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const P = req('../docs/proofs.js');
const C = req('../docs/core.js');

const START = '<!-- static:proof:start (tools/render_static.mjs writes this from proofs-snapshot.json; app.js replaces it) -->';
const END = '<!-- static:proof:end -->';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeHash = (h) => typeof h === 'string' && /^[A-Za-z0-9_-]{20,130}$/.test(h);
const short = (a) => (a && a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-6) : a);
function txLink(chain, hash) {
  const c = C.CHAINS[chain];
  if (!c || !c.tx || !safeHash(hash)) return esc(short(String(hash)));
  return `<a href="${esc(c.tx + hash)}" target="_blank" rel="noopener">${esc(short(hash))}</a>`;
}
function summary(items) {
  return (items || []).map((x) => (typeof x === 'string' ? esc(x) : x && x.tx && safeHash(x.tx) && C.CHAINS[x.chain] ? txLink(x.chain, x.tx) : '')).join('');
}
function fees(f) {
  if (!f) return '<div class="fees"></div>';
  const rows = (f.groups || []).map((g) => {
    const tr = (label, amount, unit, cls) => `<tr${cls ? ` class="${esc(cls)}"` : ''}><td>${esc(label)}</td><td>${esc(amount)}<span class="u">${unit ? ' ' + esc(unit) : ''}</span></td></tr>`;
    return `<table class="feetab">${tr(g.total.label, g.total.amount, g.total.unit, 'tot')}${g.parts.map((x) => tr(x.label, x.amount, x.unit, x.kind ? 'k-' + x.kind : '')).join('')}</table>`;
  }).join('');
  return `<div class="fees"><p class="feeline">${esc(f.sentence)}</p><details><summary>Where every unit went</summary>${rows}${f.network ? `<p class="muted">${esc(f.network)}</p>` : ''}</details></div>`;
}
function row(p, snap) {
  const s = snap.get(P.id(p));
  if (!s || !s.ok) throw new Error('no verified snapshot row for ' + p.name);
  const links = [];
  if (p.dep) links.push(`<span>${esc(C.CHAINS[p.chain].name)}: ${txLink(p.chain, p.dep)}</span>`);
  links.push(p.sol ? `<span>Solana: ${txLink('sol', p.sol)}</span>` : `<span>${esc(P.noSol(p))}</span>`);
  if (p.refund) links.push(`<span>Refund: ${txLink(p.chain, p.refund)}</span>`);
  const rl = P.recordLink(p); links.push(`<a href="${esc(rl.href)}">${esc(rl.label)}</a>`);
  return `<div class="proof${p.fresh ? ' fresh' : ''}" data-id="${esc(P.id(p))}"><b>${esc(p.name)}</b><div class="note">${esc(p.note)}</div>`
    + `<div class="links">${links.join('')}</div>`
    + `<div class="out ok"><span class="when">${esc(P.snapshotLabel(s))}: </span>${summary(s.summary)}${fees(s.fees)}</div></div>`;
}
export function render(snapJson) {
  const snap = new Map(snapJson.rows.map((r) => [r.id, r]));
  const n = P.PROOF.length; const ok = P.PROOF.filter((p) => (snap.get(P.id(p)) || {}).ok).length;
  if (ok !== n) throw new Error(`only ${ok} of ${n} rows verified in the snapshot`);
  const when = P.snapshotLabel({ checked_at: snapJson.generated_at });
  const parts = [`<p class="muted snapnote">${esc(when)}: all ${n} rows read from Aurora and Solana mainnet. Every hash opens the explorer. With JavaScript on, Check live reads both again from your browser.</p>`];
  for (const g of P.GROUPS) {
    const rows = P.PROOF.filter(g.has); if (!rows.length) continue;
    parts.push(`<h3 class="proof-head">${esc(g.title)}</h3>`, ...rows.map((p) => row(p, snap)));
  }
  return START + '\n' + parts.join('\n') + '\n' + END;
}
export function inject(html, block) {
  const a = html.indexOf(START); const b = html.indexOf(END);
  if (a < 0 || b < a || html.indexOf(START, a + 1) >= 0) throw new Error('static:proof markers missing or repeated in index.html');
  return html.slice(0, a) + block + html.slice(b + END.length);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = new URL('../docs/index.html', import.meta.url);
  const html = readFileSync(file, 'utf8');
  const snapJson = JSON.parse(readFileSync(new URL('../docs/proofs-snapshot.json', import.meta.url), 'utf8'));
  const next = inject(html, render(snapJson));
  if (process.argv.includes('--check')) {
    if (next !== html) { console.error('index.html static proof block is stale: run node tools/render_static.mjs'); process.exit(1); }
    console.log('static proof block up to date:', P.PROOF.length, 'rows');
  } else {
    writeFileSync(file, next); console.log('wrote', P.PROOF.length, 'static proof rows into docs/index.html');
  }
}
