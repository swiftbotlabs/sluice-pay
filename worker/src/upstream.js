// Upstream calls of the hosted API. Fixed hosts only (no user-controlled URL reaches fetch, so no SSRF), https only,
// no redirects, a timeout on every call and a cap on every response body.
const AURORA = 'https://intents-api.aurora.dev';
// Keyless public Solana RPCs, tried in order (same set the checkout uses; Helium keeps full history).
export const SOLANA_RPCS = ['https://solana-rpc.web.helium.io', 'https://solana-mainnet.gateway.tatum.io', 'https://public.rpc.solanavibestation.com', 'https://solana.leorpc.com/?api_key=FREE'];
export const ALLOWED_HOSTS = new Set(['intents-api.aurora.dev', ...SOLANA_RPCS.map((u) => new URL(u).host)]);
const MAX_BODY = 2_000_000;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const KNOWN_MINTS = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT', So11111111111111111111111111111111111111112: 'wSOL', JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP' };

export class UpstreamError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function readCapped(res, cap = MAX_BODY) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > cap) throw new UpstreamError('response too large');
  if (!res.body) return '';
  const reader = res.body.getReader(); const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) { try { await reader.cancel(); } catch { /* ignore */ } throw new UpstreamError('response too large'); }
    parts.push(value);
  }
  const all = new Uint8Array(n); let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return new TextDecoder().decode(all);
}

export function makeUpstream({ fetch: f = globalThis.fetch, auroraKey, timeoutMs = 15000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(auroraKey || '')) throw new Error('invalid Aurora API key format');
  async function call(url, init = {}, timeout = timeoutMs) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.host)) throw new UpstreamError('host not allowed');
    const res = await f(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { 'content-type': 'application/json', 'user-agent': 'sluice-api/1 (+https://github.com/swiftbotlabs/sluice-pay)', ...(init.headers || {}) } });
    if (res.status >= 300 && res.status < 400) throw new UpstreamError('redirect refused', res.status);
    const text = await readCapped(res);
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { throw new UpstreamError(`bad JSON (HTTP ${res.status})`, res.status); }
    return { status: res.status, json: j, retryAfter: res.headers.get('retry-after') };
  }
  async function aurora(method, path, body, query) {
    let url = `${AURORA}${path}/${encodeURIComponent(auroraKey)}`;
    if (query) url += '?' + new URLSearchParams(query).toString();
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await call(url, body ? { method, body: JSON.stringify(body) } : { method }, body ? 25000 : timeoutMs);
      if (r.status === 429 && attempt === 0) { await sleep(Math.min(Number(r.retryAfter) || 1, 5) * 1000); continue; }
      if (r.status !== 200 && r.status !== 201) throw new UpstreamError(`HTTP ${r.status}: ${String((r.json && r.json.message) || '').slice(0, 160)}`, r.status);
      return r.json;
    }
    throw new UpstreamError('rate limited by the payment provider', 429);
  }
  async function rpc(method, params) {
    let last = null;
    for (const url of SOLANA_RPCS) {
      try {
        const r = await call(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, 12000);
        if (r.status !== 200 || !r.json || r.json.error) { last = new UpstreamError(`${method}: ${r.status}`); continue; }
        return r.json.result;
      } catch (e) { last = e; }
    }
    throw new UpstreamError(`solana rpc failed: ${String((last && last.message) || last).slice(0, 120)}`);
  }
  return {
    async tokens() { const d = await aurora('GET', '/api/tokens'); return Array.isArray(d) ? d : d && d.tokens; },
    quote: (body) => aurora('POST', '/api/quote', body),
    status: (addr, memo) => aurora('GET', '/api/status', null, memo ? { depositAddress: addr, depositMemo: memo } : { depositAddress: addr }),
    submitDeposit: (addr, txHash, memo) => aurora('POST', '/api/deposit/submit', memo ? { txHash, depositAddress: addr, memo } : { txHash, depositAddress: addr }),
    /** Health probe: can this Worker reach Aurora and a Solana RPC right now? */
    async probe() {
      const [a, b] = await Promise.allSettled([aurora('GET', '/api/tokens'), rpc('getSlot', [{ commitment: 'confirmed' }])]);
      return { aurora: a.status === 'fulfilled' && !!a.value, solana: b.status === 'fulfilled' && Number.isInteger(b.value) };
    },
    solTx: (sig) => rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]),
    /** The paid resource: a read-only snapshot of a Solana wallet (same fields as sluice/report.py). */
    async report(address) {
      const [info, toks, sigs] = await Promise.all([
        rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]),
        rpc('getTokenAccountsByOwner', [address, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
        rpc('getSignaturesForAddress', [address, { limit: 100, commitment: 'confirmed' }]),
      ]);
      const val = info && info.value;
      const holdings = [];
      for (const acc of ((toks && toks.value) || []).slice(0, 200)) {
        try {
          const p = acc.account.data.parsed.info; const amt = p.tokenAmount;
          if (!/^\d+$/.test(String(amt.amount)) || BigInt(amt.amount) === 0n) continue;
          holdings.push({ mint: String(p.mint), symbol: KNOWN_MINTS[p.mint] || null, amount: String(amt.uiAmountString), token_account: String(acc.pubkey) });
        } catch { /* skip malformed rows */ }
      }
      holdings.sort((a, b) => (a.symbol === null) - (b.symbol === null) || Number(b.amount) - Number(a.amount));
      const list = Array.isArray(sigs) ? sigs : [];
      const times = list.map((s) => s.blockTime).filter((t) => Number.isInteger(t));
      return { address, generated_at: Math.floor(Date.now() / 1000), exists: !!val, executable: !!(val && val.executable), owner_program: (val && val.owner) || null,
        sol: ((val && val.lamports) || 0) / 1e9, token_accounts_nonzero: holdings.length, top_holdings: holdings.slice(0, 15),
        recent_activity: { tx_count_last_100: list.length, failed_in_last_100: list.filter((s) => s.err !== null && s.err !== undefined).length,
          newest_tx_time: times.length ? Math.max(...times) : null, oldest_in_window: times.length ? Math.min(...times) : null },
        source: 'Solana mainnet RPC (read-only)' };
    },
  };
}
