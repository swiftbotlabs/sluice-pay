// Cloudflare Worker entry for the hosted Sluice 402 API (https://sluice-api.swiftbotlab.workers.dev).
// The front Worker only shapes requests; one Durable Object ("ledger") holds every order in its own SQLite database, so the
// UNIQUE deposit address / settlement signature rules and the exactly-once delivery hold across all requests.
// Secrets (wrangler secret): AURORA_API_KEY (an integrator id, cannot move funds), RECEIPT_SECRET_B58 (signs receipts only).
// No key that can move money exists here: the merchant's wallet is a public address in [vars].
import { DurableObject } from 'cloudflare:workers';
import { makeEngine, makeSigner, SCHEMA } from './engine.js';
import { makeUpstream } from './upstream.js';
import { handle, json, RateLimiter, clientKey, MAX_BODY, BASE_HEADERS } from './router.js';

const ALARM_MS = 10000; const ALARM_IDLE_MS = 300000; const FAIL_LIMIT = 5;

function docs(env) {
  const u = env.PUBLIC_URL;
  return [
    'Sluice pay-per-call API: HTTP 402, paid from any chain through Aurora Intents, settled as USDC on Solana.',
    '',
    `1. Ask:      curl -i ${u}/api/report/9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR`,
    '             -> 402 Payment Required: price in USDC on Solana, merchant, accepted assets, receipt key, an indicative quote',
    `2. Order:    curl -s -X POST ${u}/api/orders -H 'content-type: application/json' \\`,
    `               -d '{"resource":"report","params":{"address":"<solana address>"},"pay_with":"base:USDC","refund_to":"<your 0x address>"}'`,
    '             -> deposit address, exact amount, deadline (a quote made for you by Aurora; check it at https://1click.chaindefuser.com/v0/status?depositAddress=...)',
    '3. Pay:      send exactly that amount from your own wallet to the deposit address',
    `4. Watch:    curl -s ${u}/api/orders/<order id>`,
    `5. Collect:  curl -si ${u}/api/report/<solana address> -H 'X-Sluice-Order: <order id>'`,
    '             -> 200 with the report and an X-Sluice-Receipt header signed by the receipt key in /.well-known/sluice.json',
    '',
    'Rule: nothing is delivered until the merchant\'s USDC credit is read from Solana. Retries get the same bytes and receipt.',
    'Headless buyer with every check built in: python3 cli/sluice_buy.py <url> --pay base:USDC --key-file payer.key --max-usd 0.30',
    'Source and security notes: https://github.com/swiftbotlabs/sluice-pay (worker/, SECURITY.md)',
  ].join('\n') + '\n';
}

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.limiter = new RateLimiter();
    this.fails = 0; this.lastPoll = null; this.engine = null;
    const sql = ctx.storage.sql;
    this.db = { all: (q, ...a) => sql.exec(q, ...a).toArray() };
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) sql.exec(stmt);
      try {
        const signer = await makeSigner(env.RECEIPT_SECRET_B58);
        const up = makeUpstream({ auroraKey: env.AURORA_API_KEY });
        this.up = up;
        this.engine = makeEngine({ db: this.db, up, signer, cfg: { merchant: env.MERCHANT, priceRaw: env.PRICE_RAW, deadlineS: Number(env.DEADLINE_S) || 1800 } });
      } catch (e) {
        this.setupError = String((e && e.message) || e).slice(0, 80); // fail closed: every paid route answers 503
      }
    });
  }
  /** "Active" is not "healthy": a live probe of Aurora and Solana (cached 60 s) plus the poller's failure streak. */
  async health() {
    if (this.up && (!this.probeAt || Date.now() - this.probeAt > 60000)) {
      this.probeAt = Date.now();
      try { this.probeRes = await this.up.probe(); } catch { this.probeRes = { aurora: false, solana: false }; }
    }
    const p = this.probeRes || { aurora: false, solana: false };
    const ok = !!this.engine && this.fails < FAIL_LIMIT && p.aurora && p.solana;
    return { ok, aurora_reachable: p.aurora, solana_reachable: p.solana, probed_at: this.probeAt ? new Date(this.probeAt).toISOString() : null,
      consecutive_poll_failures: this.fails, last_poll: this.lastPoll, open_orders: this.engine ? this.engine.countOpen() : null, setup: this.setupError ? 'error' : 'ok' };
  }
  async fetch(req) {
    if (!this.engine) return json(503, { error: 'service not configured' });
    const client = req.headers.get('x-client') || 'invalid';
    return handle(req, { engine: this.engine, limiter: this.limiter, client, publicUrl: this.env.PUBLIC_URL, health: () => this.health(),
      onOrder: () => this.ctx.storage.getAlarm().then((a) => (a ? null : this.ctx.storage.setAlarm(Date.now() + ALARM_MS))) });
  }
  /** Background poller: refreshes the open orders polled longest ago, one log line per pass, backs off after repeated failures. */
  async alarm() {
    if (!this.engine) return;
    let r;
    try { r = await this.engine.pollOnce(3); this.fails = r.checked && r.errors === r.checked ? this.fails + 1 : 0; } catch { r = { error: true }; this.fails += 1; }
    this.lastPoll = new Date().toISOString();
    console.log(JSON.stringify({ t: this.lastPoll, poll: r, consecutive_failures: this.fails }));
    const busy = r && r.open > 0; const waiting = r && r.expired > 0;
    if (busy || waiting) await this.ctx.storage.setAlarm(Date.now() + (this.fails >= FAIL_LIMIT ? 60000 : busy ? ALARM_MS : ALARM_IDLE_MS));
  }
}

export default {
  async fetch(req, env) {
    const t0 = Date.now(); const url = new URL(req.url);
    let res;
    if (req.method === 'OPTIONS') {
      res = new Response(null, { status: 204, headers: { ...BASE_HEADERS, 'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-sluice-order', 'access-control-max-age': '600' } });
    } else if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '')) {
      res = new Response(docs(env), { status: 200, headers: { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
    } else if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
      res = json(405, { error: 'method not allowed' });
    } else if (url.pathname.length > 200 || url.search.length > 200) {
      res = json(414, { error: 'URL too long' });
    } else {
      // A clean request for the ledger: only the headers it needs, the client key from Cloudflare's own header, a capped body.
      const h = { 'x-client': clientKey(req.headers.get('cf-connecting-ip')) };
      for (const k of ['content-type', 'x-sluice-order']) { const v = req.headers.get(k); if (v) h[k] = v.slice(0, 200); }
      let body = null;
      if (req.method === 'POST') {
        const len = req.headers.get('content-length');
        if (len && /^\d{1,6}$/.test(len) && Number(len) <= MAX_BODY) {
          body = await req.arrayBuffer();
          if (body.byteLength > MAX_BODY) body = null;
        }
        if (body) h['content-length'] = String(body.byteLength);
      }
      const stub = env.LEDGER.get(env.LEDGER.idFromName('ledger-v1'));
      res = await stub.fetch(new Request('https://ledger' + url.pathname + url.search, { method: req.method === 'HEAD' ? 'GET' : req.method, headers: h, body }));
      if (req.method === 'HEAD') res = new Response(null, { status: res.status, headers: res.headers });
    }
    console.log(JSON.stringify({ t: new Date(t0).toISOString(), m: req.method, p: url.pathname.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, '<addr>').replace(/ord_[A-Za-z0-9]+/g, '<order>').slice(0, 80), s: res.status, ms: Date.now() - t0 }));
    return res;
  },
};
