// HTTP layer of the hosted API (inside the Durable Object): routes, strict input handling, rate limits, response headers.
import { OrderError, ORDER_RE } from './engine.js';

export const MAX_BODY = 8 * 1024;
const ADDR_RE = /^\/api\/report\/([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const PAY_WITH_RE = /^[a-z]{2,5}:[A-Z]{2,5}$/;

/** Token buckets per (client, bucket); LRU-bounded so a flood of new keys evicts the oldest instead of resetting everyone. */
export class RateLimiter {
  constructor(maxKeys = 20000, now = () => Date.now()) { this.b = new Map(); this.maxKeys = maxKeys; this.now = now; }
  allow(client, bucket, perMin, burst) {
    const key = client + '|' + bucket; const t = this.now();
    let [tokens, last] = this.b.get(key) || [burst, t];
    this.b.delete(key);
    while (this.b.size >= this.maxKeys) this.b.delete(this.b.keys().next().value);
    tokens = Math.min(burst, tokens + ((t - last) / 60000) * perMin);
    if (tokens < 1) { this.b.set(key, [tokens, t]); return false; }
    this.b.set(key, [tokens - 1, t]);
    return true;
  }
}

/** Rate-limit key: the IPv4 address, or the /64 of an IPv6 address. */
export function clientKey(ip) {
  const s = String(ip || '').trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s;
  if (/^[0-9a-fA-F:]{2,39}$/.test(s) && s.includes(':')) {
    const [head, tail = ''] = s.split('::');
    const h = head ? head.split(':') : []; const tl = tail ? tail.split(':') : [];
    const full = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - tl.length)).fill('0'), ...tl] : h;
    if (full.length !== 8) return 'invalid';
    return full.slice(0, 4).map((x) => (parseInt(x || '0', 16) || 0).toString(16)).join(':') + '::/64';
  }
  return 'invalid';
}

export const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
  'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Sluice-Receipt, WWW-Authenticate, Retry-After',
};
export const json = (code, body, extra = {}) => new Response(JSON.stringify(body, null, 1), { status: code, headers: { ...BASE_HEADERS, ...extra } });

async function readJson(req) {
  const len = req.headers.get('content-length');
  if (!len || !/^\d{1,6}$/.test(len) || Number(len) > MAX_BODY) throw new OrderError('body missing or too large', 413);
  if (!(req.headers.get('content-type') || '').includes('application/json')) throw new OrderError('Content-Type must be application/json', 415);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > MAX_BODY) throw new OrderError('body too large', 413);
  let d;
  try { d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf)); } catch { throw new OrderError('invalid JSON'); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new OrderError('JSON object expected');
  return d;
}

/**
 * handle(req, { engine, limiter, client, health, onOrder }) -> Response
 * `client` is the rate-limit key the front Worker derived from CF-Connecting-IP; nothing in the request can set it.
 */
export async function handle(req, { engine, limiter, client, health, publicUrl, onOrder = () => {} }) {
  const url = new URL(req.url); const path = url.pathname;
  const limited = () => json(429, { error: 'rate_limited' }, { 'retry-after': '10' });
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!limiter.allow(client, 'get', 120, 40)) return limited();
      if (path === '/healthz') { const h = await health(); return json(h.ok ? 200 : 503, h); }
      if (path === '/.well-known/sluice.json') {
        return json(200, { merchant: engine.merchant, receipt_key: engine.receiptKey, settles_in: 'USDC on Solana', rails: ['swap'],
          resources: { report: { price_usdc: Number(engine.price) / 1e6, path: '/api/report/<solana-address>' } }, source: 'https://github.com/swiftbotlabs/sluice-pay/tree/main/worker' });
      }
      if (path === '/api/origins') return json(200, { origins: await engine.origins() });
      let m = /^\/api\/orders\/([^/]+)$/.exec(path);
      if (m) {
        if (!ORDER_RE.test(m[1])) return json(404, { error: 'bad order id' });
        if (!limiter.allow(client, 'status', 60, 20)) return limited();
        return json(200, await engine.refresh(m[1]));
      }
      m = ADDR_RE.exec(path);
      if (m) {
        const params = { address: m[1] };
        const oid = (req.headers.get('x-sluice-order') || '').trim();
        if (!oid) {
          const pw = url.searchParams.get('pay_with');
          if (pw !== null && !PAY_WITH_RE.test(pw)) return json(400, { error: 'pay_with looks like base:USDC (see /api/origins)' });
          if (pw !== null && !limiter.allow(client, 'quote', 10, 4)) return limited();
          const terms = await engine.paymentRequired('report', pw);
          terms.request = { resource: 'report', params };
          terms.try_it = { create_order: `curl -s -X POST ${publicUrl}/api/orders -H 'content-type: application/json' -d '{"resource":"report","params":{"address":"${m[1]}"},"pay_with":"base:USDC","refund_to":"<your 0x address>"}'` };
          return json(402, terms, { 'www-authenticate': 'Sluice realm="report"' });
        }
        if (!ORDER_RE.test(oid)) return json(404, { error: 'bad order id' });
        if (!limiter.allow(client, 'status', 60, 20)) return limited();
        const { body, receipt } = await engine.deliver(oid, 'report', params);
        return new Response(body, { status: 200, headers: { ...BASE_HEADERS, 'x-sluice-receipt': JSON.stringify(receipt) } });
      }
      return json(404, { error: 'not found' });
    }
    if (req.method === 'POST') {
      if (path === '/api/orders') {
        if (!limiter.allow(client, 'create', 6, 3) || !limiter.allow('global', 'create', 60, 20)) return limited();
        const v = await engine.createOrder(await readJson(req), client);
        onOrder(v);
        return json(201, v);
      }
      const m = /^\/api\/orders\/([^/]+)\/deposit$/.exec(path);
      if (m) {
        if (!ORDER_RE.test(m[1])) return json(404, { error: 'bad order id' });
        if (!limiter.allow(client, 'post', 20, 6)) return limited();
        const d = await readJson(req);
        if (Object.keys(d).some((k) => k !== 'tx_hash')) throw new OrderError('unknown fields');
        return json(200, await engine.noteDeposit(m[1], String(d.tx_hash || '')));
      }
      return json(404, { error: 'not found' });
    }
    return json(405, { error: 'method not allowed' }, { allow: 'GET, HEAD, POST, OPTIONS' });
  } catch (e) {
    if (e instanceof OrderError) return json(e.http, { error: e.message });
    console.log(JSON.stringify({ t: new Date().toISOString(), err: String((e && e.name) || 'Error') }));
    return json(500, { error: 'internal error' });
  }
}
