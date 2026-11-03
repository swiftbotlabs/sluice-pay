/* Sluice core: the pure logic behind the checkout. No DOM, no network, no keys.
 * Everything that decides what a buyer is asked to send or sign lives here, so it can be unit-tested
 * (tests/js/core.test.mjs) and kept in step with the Python implementation (tests/test_parity.py).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SluiceCore = api;
})(typeof self !== 'undefined' ? self : globalThis, () => {
  'use strict';

  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  const SYSTEM_PROGRAM = '11111111111111111111111111111111';
  const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
  const SOL_USDC = 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';
  // Kamino Main Market USDC reserve (docs.intents.aurora.dev, Kamino stake scenario)
  const KLEND = {
    program: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
    market: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
    authority: '9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo',
    reserve: 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59',
    supply: 'Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6',
    cusdc: 'B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D',
    oracle: '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH',
    instructions: 'Sysvar1nstructions1111111111111111111111111',
    refresh: '02da8aeb4fc91966',
    deposit: 'a9c91e7e06cd6644',
  };

  // Intents Connect's Solana accounts are derived from this NEAR MPC root (v1.signer, public_key domain 1), so the page
  // can compute the payer's account itself instead of trusting an API answer.
  const MPC = { root: 'G9hwngxWNKdmqMCmU1Yt6LPhFpayJeKFxyAV1HqMNLtF', predecessor: 'proxy-signer-dev.near', verifying: 'intents.near', tag: 'near-mpc-recovery v0.1.0 epsilon derivation:' };

  // Networks the checkout can name. `id` = EVM chain id (wallet payments); `connect` = Intents Connect source chain.
  const CHAINS = {
    base: { name: 'Base', fam: 'evm', id: 8453, tx: 'https://basescan.org/tx/', connect: true },
    arb: { name: 'Arbitrum', fam: 'evm', id: 42161, tx: 'https://arbiscan.io/tx/', connect: true },
    eth: { name: 'Ethereum', fam: 'evm', id: 1, tx: 'https://etherscan.io/tx/', connect: true },
    op: { name: 'Optimism', fam: 'evm', id: 10, tx: 'https://optimistic.etherscan.io/tx/', connect: true },
    pol: { name: 'Polygon', fam: 'evm', id: 137, tx: 'https://polygonscan.com/tx/', connect: true },
    bsc: { name: 'BNB Chain', fam: 'evm', id: 56, tx: 'https://bscscan.com/tx/', connect: true },
    avax: { name: 'Avalanche', fam: 'evm', id: 43114, tx: 'https://snowtrace.io/tx/', connect: true },
    gnosis: { name: 'Gnosis', fam: 'evm', id: 100, tx: 'https://gnosisscan.io/tx/', connect: true },
    scroll: { name: 'Scroll', fam: 'evm', id: 534352, tx: 'https://scrollscan.com/tx/', connect: true },
    bera: { name: 'Berachain', fam: 'evm', id: 80094, tx: 'https://berascan.com/tx/', connect: true },
    monad: { name: 'Monad', fam: 'evm', id: 143, connect: true },
    xlayer: { name: 'X Layer', fam: 'evm', id: 196, connect: true },
    plasma: { name: 'Plasma', fam: 'evm', id: 9745, connect: true },
    abs: { name: 'Abstract', fam: 'evm', id: 2741 },
    hood: { name: 'Robinhood Chain', fam: 'evm' },
    adi: { name: 'ADI Chain', fam: 'evm' },
    sol: { name: 'Solana', fam: 'sol', tx: 'https://solscan.io/tx/' },
    btc: { name: 'Bitcoin', fam: 'btc', tx: 'https://mempool.space/tx/', scheme: 'bitcoin' },
    ltc: { name: 'Litecoin', fam: 'other', tx: 'https://litecoinspace.org/tx/', scheme: 'litecoin' },
    doge: { name: 'Dogecoin', fam: 'other', scheme: 'dogecoin' },
    bch: { name: 'Bitcoin Cash', fam: 'other' },
    dash: { name: 'Dash', fam: 'other' },
    zec: { name: 'Zcash', fam: 'other' },
    tron: { name: 'Tron', fam: 'tron', tx: 'https://tronscan.org/#/transaction/' },
    near: { name: 'NEAR', fam: 'other', tx: 'https://nearblocks.io/txns/' },
    ton: { name: 'TON', fam: 'other' },
    sui: { name: 'Sui', fam: 'other' },
    aptos: { name: 'Aptos', fam: 'other' },
    cardano: { name: 'Cardano', fam: 'other' },
    xrp: { name: 'XRP Ledger', fam: 'other' },
    stellar: { name: 'Stellar', fam: 'other', memo: true },
    starknet: { name: 'Starknet', fam: 'other' },
    aleo: { name: 'Aleo', fam: 'other' },
    fogo: { name: 'Fogo', fam: 'other' },
  };
  // Shown first; everything else in Aurora's live list sits behind "More assets".
  const POPULAR = [['base', 'USDC'], ['arb', 'USDC'], ['eth', 'USDC'], ['base', 'ETH'], ['arb', 'ETH'], ['eth', 'ETH'],
    ['op', 'USDC'], ['pol', 'USDC'], ['bsc', 'USDT'], ['tron', 'USDT'], ['btc', 'BTC'], ['sol', 'SOL']];

  // ---------- bytes ----------
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58decode(s) {
    if (typeof s !== 'string' || !s || s.length > 100) throw new Error('bad base58');
    let n = 0n;
    for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
    const out = [];
    while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
    for (const c of s) { if (c === '1') out.unshift(0); else break; }
    return new Uint8Array(out);
  }
  function b58encode(bytes) {
    let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
    let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
    return s;
  }
  const isSolAddr = (a) => { try { return b58decode(a).length === 32; } catch { return false; } };
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0;
    for (const p of parts) { out.set(p, i); i += p.length; }
    return out;
  };
  const utf8 = (s) => new TextEncoder().encode(s);
  const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  function fromHex(h) {
    if (typeof h !== 'string' || h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('bad hex');
    return Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
  }
  const u64le = (b, i = 0) => { let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[i + k]); return v; };
  async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }

  // ---------- amounts ----------
  function toUnits(dec, decimals) {
    if (!/^\d{1,12}(\.\d{1,18})?$/.test(dec)) throw new Error('bad amount');
    const [i, f = ''] = dec.split('.');
    if (f.length > decimals) throw new Error('too many decimals');
    return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
  }
  function fromUnits(raw, decimals) {
    const v = BigInt(raw); const d = 10n ** BigInt(decimals);
    const f = (v % d).toString().padStart(decimals, '0').replace(/0+$/, '');
    return (v / d).toString() + (f ? '.' + f : '');
  }
  const short = (a) => (a && a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-6) : a);

  // ---------- addresses ----------
  const FAMILY = {
    evm: /^0x[0-9a-fA-F]{40}$/,
    btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
    tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    other: /^[\x21-\x7e]{10,128}$/, // shape only: Aurora validates the address when the real quote is requested
  };
  const validRefund = (fam, a) => (fam === 'sol' ? isSolAddr(a) : !!(FAMILY[fam] && FAMILY[fam].test(a || '')));
  const isEvmAddr = (a) => FAMILY.evm.test(a || '');
  const isDepositAddr = (a) => typeof a === 'string' && /^[A-Za-z0-9:_.-]{10,130}$/.test(a);

  // ---------- ed25519 / PDAs ----------
  const P = 2n ** 255n - 19n;
  const mod = (a) => { const r = a % P; return r >= 0n ? r : r + P; };
  function pow(b, e) {
    let r = 1n; let x = mod(b); let k = e;
    while (k > 0n) { if (k & 1n) r = (r * x) % P; x = (x * x) % P; k >>= 1n; }
    return r;
  }
  const D = mod(-121665n * pow(121666n, P - 2n));
  function onCurve(b) {
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
    y &= (1n << 255n) - 1n;
    if (y >= P) return false;
    const sign = b[31] >> 7;
    const y2 = (y * y) % P; const u = mod(y2 - 1n); const v = (D * y2 + 1n) % P;
    const x2 = (u * pow(v, P - 2n)) % P;
    if (x2 === 0n) return sign === 0;
    let x = pow(x2, (P + 3n) / 8n);
    if (mod(x * x - x2) !== 0n) x = (x * pow(2n, (P - 1n) / 4n)) % P;
    return mod(x * x - x2) === 0n;
  }
  async function findPda(seeds, program) {
    const prog = b58decode(program); const tail = utf8('ProgramDerivedAddress');
    for (let bump = 255; bump >= 0; bump--) {
      const h = await sha256(concat(...seeds, Uint8Array.of(bump), prog, tail));
      if (!onCurve(h)) return b58encode(h);
    }
    throw new Error('no viable bump');
  }
  // Keccak-f[1600] / SHA3-256: WebCrypto has no SHA-3.
  function sha3_256(input) {
    const M = (1n << 64n) - 1n;
    const rol = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M);
    const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
    const a = Array.from({ length: 5 }, () => Array(5).fill(0n));
    let lfsr = 1;
    const rcBit = () => { const b = lfsr & 1; lfsr <<= 1; if (lfsr & 0x100) lfsr ^= 0x171; return b; };
    const RC = [];
    for (let r = 0; r < 24; r++) { let c = 0n; for (let j = 0; j < 7; j++) if (rcBit()) c ^= 1n << BigInt(2 ** j - 1); RC.push(c); }
    const f = () => {
      for (let r = 0; r < 24; r++) {
        const c = a.map((col) => col[0] ^ col[1] ^ col[2] ^ col[3] ^ col[4]);
        const d = c.map((_, x) => c[(x + 4) % 5] ^ rol(c[(x + 1) % 5], 1));
        for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x][y] ^= d[x];
        const b = Array.from({ length: 5 }, () => Array(5).fill(0n));
        for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y][(2 * x + 3 * y) % 5] = rol(a[x][y], ROT[x][y]);
        for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x][y] = b[x][y] ^ (~b[(x + 1) % 5][y] & M & b[(x + 2) % 5][y]);
        a[0][0] ^= RC[r];
      }
    };
    const rate = 136; const n = input.length + 1; const padded = new Uint8Array(n + ((rate - (n % rate)) % rate));
    padded.set(input); padded[input.length] = 0x06; padded[padded.length - 1] |= 0x80;
    for (let o = 0; o < padded.length; o += rate) {
      for (let i = 0; i < rate / 8; i++) a[i % 5][Math.floor(i / 5)] ^= u64le(padded, o + i * 8);
      f();
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((a[i % 5][0] >> BigInt(8 * k)) & 255n);
    return out;
  }
  const I = pow(2n, (P - 1n) / 4n);
  function decodePoint(b) {
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
    y &= (1n << 255n) - 1n;
    const u = mod(y * y - 1n); const v = mod(D * y * y + 1n); const x2 = (u * pow(v, P - 2n)) % P;
    let x = pow(x2, (P + 3n) / 8n);
    if (mod(x * x - x2) !== 0n) x = (x * I) % P;
    if (mod(x * x - x2) !== 0n) throw new Error('not a curve point');
    if ((x & 1n) !== BigInt(b[31] >> 7)) x = mod(-x);
    return [x, y, 1n, (x * y) % P];
  }
  function addPoints(p, q) {
    const a = mod((p[1] - p[0]) * (q[1] - q[0])); const b = ((p[1] + p[0]) * (q[1] + q[0])) % P;
    const c = (2n * p[3] * q[3] * D) % P; const d = (2n * p[2] * q[2]) % P;
    const e = mod(b - a); const f = mod(d - c); const g = (d + c) % P; const h = (b + a) % P;
    return [(e * f) % P, (g * h) % P, (f * g) % P, (e * h) % P];
  }
  function mulPoint(k, p0) {
    let r = [0n, 1n, 1n, 0n]; let p = p0; let n = k;
    while (n > 0n) { if (n & 1n) r = addPoints(r, p); p = addPoints(p, p); n >>= 1n; }
    return r;
  }
  function encodePoint(p) {
    const z = pow(p[2], P - 2n); const x = (p[0] * z) % P; const y = (p[1] * z) % P;
    let v = y | ((x & 1n) << 255n); const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) { out[i] = Number(v & 255n); v >>= 8n; }
    return out;
  }
  /** The Solana account Intents Connect controls for this EVM wallet, computed here rather than read from an API. */
  function deriveIntermediary(payer) {
    if (!isEvmAddr(payer)) throw new Error('bad payer');
    const h = sha3_256(utf8(`${MPC.tag}${MPC.predecessor},${payer.toLowerCase()}`));
    let t = 0n;
    for (let i = 31; i >= 0; i--) t = (t << 8n) | BigInt(h[i]);
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const G = (() => { const by = (4n * pow(5n, P - 2n)) % P; const b = new Uint8Array(32); let v = by; for (let i = 0; i < 32; i++) { b[i] = Number(v & 255n); v >>= 8n; } return decodePoint(b); })();
    const root = decodePoint(b58decode(MPC.root));
    return b58encode(encodePoint(addPoints(root, mulPoint(t % L, G))));
  }
  const ata = (owner, mint = USDC_MINT) => findPda([b58decode(owner), b58decode(TOKEN_PROGRAM), b58decode(mint)], ATA_PROGRAM);
  async function referenceKey(orderId) {
    if (!/^[A-Za-z0-9_-]{6,48}$/.test(orderId || '')) throw new Error('bad order id');
    return b58encode(await sha256(utf8('sluice:' + orderId)));
  }

  // ---------- Intents Connect steps (same bytes as sluice/connect.py) ----------
  const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
  const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
  const FUNDER = { pubkey: '{INTERMEDIARY}', isSigner: true, isWritable: true };
  const createAtaStep = (name, dst, owner, mint) => ({
    metadata: { name }, programId: ATA_PROGRAM, discriminator: '01', args: [],
    accounts: [FUNDER, rw(dst), ro(owner), ro(mint), ro(SYSTEM_PROGRAM), ro(TOKEN_PROGRAM)],
  });
  async function paySteps({ intermediary, merchant, orderId, price, createAta = true }) {
    if (!(isSolAddr(intermediary) && isSolAddr(merchant))) throw new Error('bad pubkey');
    const src = await ata(intermediary); const dst = await ata(merchant); const ref = await referenceKey(orderId);
    const steps = [];
    if (createAta) steps.push(createAtaStep('Create merchant USDC account (idempotent)', dst, merchant, USDC_MINT));
    steps.push({
      metadata: { name: 'Pay merchant', description: `USDC to ${merchant}` }, programId: TOKEN_PROGRAM, discriminator: '0c',
      args: [{ name: 'amount', type: 'u64', value: String(price) }, { name: 'decimals', type: 'u8', value: 6 }],
      accounts: [rw(src), ro(USDC_MINT), rw(dst), { pubkey: '{INTERMEDIARY}', isSigner: true, isWritable: false }, ro(ref)],
    });
    return steps;
  }
  async function earnSteps({ intermediary, merchant, orderId, price, createAta = true }) {
    if (!(isSolAddr(intermediary) && isSolAddr(merchant))) throw new Error('bad pubkey');
    if (BigInt(price) <= 0n) throw new Error('bad price');
    const src = await ata(intermediary); const dst = await ata(merchant, KLEND.cusdc); const ref = await referenceKey(orderId);
    const steps = [];
    if (createAta) steps.push(createAtaStep('Create merchant cUSDC account (idempotent)', dst, merchant, KLEND.cusdc));
    steps.push({
      metadata: { name: 'Refresh reserve', description: 'Refresh the Kamino USDC reserve' }, programId: KLEND.program,
      discriminator: KLEND.refresh, args: [],
      accounts: [rw(KLEND.reserve), ro(KLEND.market), ro(KLEND.program), ro(KLEND.program), ro(KLEND.program), ro(KLEND.oracle)],
    }, {
      metadata: { name: 'Settle into Kamino for the merchant', description: `cUSDC to ${merchant}` }, programId: KLEND.program,
      discriminator: KLEND.deposit, args: [{ name: 'liquidity_amount', type: 'u64', value: String(price) }],
      accounts: [{ pubkey: '{INTERMEDIARY}', isSigner: true, isWritable: false }, rw(KLEND.reserve), ro(KLEND.market), ro(KLEND.authority),
        ro(USDC_MINT), rw(KLEND.supply), rw(KLEND.cusdc), rw(src), rw(dst), ro(TOKEN_PROGRAM), ro(TOKEN_PROGRAM), ro(KLEND.instructions), ro(ref)],
    });
    return steps;
  }

  // ---------- payload audit: decode the exact Solana transaction the buyer is asked to authorise ----------
  function cu16(b, i0) {
    let v = 0; let s = 0; let i = i0;
    for (;;) {
      if (i >= b.length) throw new Error('truncated message');
      const x = b[i++]; v |= (x & 0x7f) << s;
      if (!(x & 0x80)) return [v, i];
      s += 7; if (s > 14) throw new Error('bad compact-u16');
    }
  }
  function decodeMessage(raw) {
    let i = 0; let version = null;
    if (raw[0] & 0x80) { version = raw[0] & 0x7f; i = 1; }
    const nSig = raw[i]; i += 3;
    let nKeys; [nKeys, i] = cu16(raw, i);
    const keys = [];
    for (let k = 0; k < nKeys; k++) { keys.push(b58encode(raw.slice(i, i + 32))); i += 32; }
    i += 32; // recent blockhash / durable nonce value
    let nIx; [nIx, i] = cu16(raw, i);
    const instructions = [];
    for (let n = 0; n < nIx; n++) {
      const prog = raw[i++];
      let nAcc; [nAcc, i] = cu16(raw, i);
      const accs = [...raw.slice(i, i + nAcc)]; i += nAcc;
      let nData; [nData, i] = cu16(raw, i);
      const data = raw.slice(i, i + nData); i += nData;
      if (prog >= nKeys || accs.some((a) => a >= nKeys)) throw new Error('instruction uses lookup-table accounts');
      instructions.push({ program: keys[prog], accounts: accs.map((a) => keys[a]), data });
    }
    if (version !== null && i < raw.length) {
      const [nLut] = cu16(raw, i);
      if (nLut) throw new Error('address lookup tables not expected');
    }
    return { version, signers: keys.slice(0, nSig), keys, instructions };
  }
  const exactKeys = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join() === [...keys].sort().join();
  /** The signature covers the WHOLE JSON, not only the Solana message, so every field of it is checked. Re-serialising
   *  must give the same bytes: that rules out duplicate keys, which different parsers read differently. */
  function messageFromPayload(payloadJson, now = Date.now()) {
    const p = JSON.parse(payloadJson);
    if (JSON.stringify(p) !== payloadJson) throw new Error('payload is not in canonical form');
    if (!exactKeys(p, ['deadline', 'intents', 'nonce', 'signer_id', 'verifying_contract'])) throw new Error('unexpected fields in payload');
    if (p.verifying_contract !== MPC.verifying) throw new Error('payload is for another contract');
    const until = Date.parse(p.deadline);
    if (!(until <= now + 8 * 86400 * 1000)) throw new Error('payload stays valid for too long');
    if (!Array.isArray(p.intents) || p.intents.length !== 1) throw new Error('expected exactly one auth_call intent');
    const it = p.intents[0];
    if (!exactKeys(it, ['contract_id', 'intent', 'min_gas', 'msg']) || it.intent !== 'auth_call') throw new Error('expected exactly one auth_call intent');
    if (it.contract_id !== MPC.predecessor) throw new Error('payload calls an unexpected contract');
    const msg = JSON.parse(it.msg);
    if (JSON.stringify(msg) !== it.msg || !exactKeys(msg, ['request'])) throw new Error('unexpected fields in signing request');
    const r = msg.request;
    if (!exactKeys(r, ['domain_id', 'path', 'payload_v2']) || r.domain_id !== 1) throw new Error('unexpected signing request');
    if (!exactKeys(r.payload_v2, ['Eddsa'])) throw new Error('no Solana message in payload');
    const hexmsg = r.payload_v2.Eddsa;
    if (typeof hexmsg !== 'string' || !/^[0-9a-f]{100,2600}$/.test(hexmsg)) throw new Error('no Solana message in payload');
    return { message: fromHex(hexmsg), signer: p.signer_id || '', path: r.path || '' };
  }
  const sameArr = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  /* Refuse to sign unless the Solana transaction does exactly what the invoice says.
   * ctx: { payer, intermediary, merchant, price: BigInt, settle: 'usdc'|'earn', src, dst, ref, maxFee: BigInt } */
  function auditPayload(payloadJson, ctx) {
    const { payer, intermediary, merchant, price, settle, src, dst, ref, maxFee, now } = ctx;
    const { message, signer, path } = messageFromPayload(payloadJson, now);
    if (signer.toLowerCase() !== payer.toLowerCase()) throw new Error('payload is for another signer');
    if (path.toLowerCase() !== payer.toLowerCase()) throw new Error('payload controls another account');
    const m = decodeMessage(message);
    if (!m.signers.includes(intermediary)) throw new Error('intermediary is not a signer');
    const mint = settle === 'earn' ? KLEND.cusdc : USDC_MINT;
    let paid = 0; let fees = 0; let fee = 0n; let refreshed = 0; let createsAccount = false;
    for (const ix of m.instructions) {
      const { program: prog, accounts: acc, data } = ix;
      if (prog === COMPUTE_BUDGET) continue;
      if (prog === SYSTEM_PROGRAM) {
        if (data.length < 4 || toHex(data.slice(0, 4)) !== '04000000') throw new Error('unexpected System instruction');
        continue;
      }
      if (prog === ATA_PROGRAM) {
        const merchantAcct = acc[1] === dst && acc[2] === merchant && acc[3] === mint;
        const ownUsdc = acc[1] === src && acc[2] === intermediary && acc[3] === USDC_MINT;
        if (data.length !== 1 || data[0] !== 1 || acc.length < 4 || !(merchantAcct || ownUsdc)) throw new Error('unexpected token-account creation');
        if (merchantAcct) createsAccount = true;
        continue;
      }
      if (prog === KLEND.program) {
        if (settle !== 'earn') throw new Error('unexpected lending instruction');
        const d = toHex(data.slice(0, 8));
        if (d === KLEND.refresh && data.length === 8) {
          if (acc[0] !== KLEND.reserve || acc[1] !== KLEND.market) throw new Error('unexpected reserve refresh');
          refreshed += 1;
          continue;
        }
        if (d === KLEND.deposit && data.length === 16) {
          const want = [intermediary, KLEND.reserve, KLEND.market, KLEND.authority, USDC_MINT, KLEND.supply, KLEND.cusdc, src, dst,
            TOKEN_PROGRAM, TOKEN_PROGRAM, KLEND.instructions, ref];
          if (!sameArr(acc, want)) throw new Error('deposit does not go to the merchant with this order reference');
          if (u64le(data, 8) !== price) throw new Error('deposit amount differs from the invoice');
          paid += 1;
          continue;
        }
        throw new Error('unexpected lending instruction');
      }
      if (prog === TOKEN_PROGRAM) {
        const op = data[0];
        if (op === 12 && data.length === 10 && acc.length >= 4) { // TransferChecked
          const amt = u64le(data, 1);
          if (acc[0] !== src || acc[1] !== USDC_MINT || acc[3] !== intermediary || data[9] !== 6) throw new Error('unexpected TransferChecked');
          if (settle === 'earn' || acc[2] !== dst || amt !== price) throw new Error('transfer to an unexpected account');
          if (!sameArr(acc.slice(4), [ref])) throw new Error('payment does not carry this order reference');
          paid += 1;
          continue;
        }
        if (op === 3 && data.length === 9 && acc.length >= 3) { // plain Transfer: only the service fee
          const amt = u64le(data, 1);
          if (acc[0] !== src || acc[2] !== intermediary || amt > maxFee) throw new Error('unexpected Transfer');
          fees += 1; fee += amt;
          continue;
        }
        throw new Error('unexpected Token instruction');
      }
      throw new Error('unexpected program ' + prog);
    }
    if (paid !== 1 || fees > 1) throw new Error(`expected one payment and at most one fee (got ${paid}/${fees})`);
    if (settle === 'earn' && refreshed !== 1) throw new Error('reserve refresh missing');
    return { ok: true, instructions: m.instructions.length, fee, createsAccount };
  }
  /** personal_sign result -> the wire form Intents Connect expects: `secp256k1:<base58(r||s||v)>`, v in {0,1}. */
  function secpWire(hexSig) {
    const h = String(hexSig).replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{130}$/.test(h)) throw new Error('bad signature');
    const b = fromHex(h);
    if (b[64] >= 27) b[64] -= 27;
    if (b[64] > 1) throw new Error('bad signature recovery id');
    return 'secp256k1:' + b58encode(b);
  }

  // ---------- Solana verification (pure part) ----------
  function tokenDelta(tx, owner, mint = USDC_MINT) {
    const sum = (rows) => (rows || []).filter((r) => r.owner === owner && r.mint === mint)
      .reduce((s, r) => s + BigInt(r.uiTokenAmount.amount), 0n);
    return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
  }
  const recent = (tx, notBefore) => !notBefore || (tx.blockTime || 0) >= notBefore - 120;
  // Kamino mints whole cUSDC units, so it can take a few micro-USDC less than asked; the dust stays with the payer.
  const EARN_ROUNDING = 10n;
  /** The deposit instruction itself must name the merchant's cUSDC account, this order's reference and the invoice amount,
   *  so a transaction that pays someone else and sends the merchant a crumb does not count. */
  function earnDepositIn(tx, { dst, ref, price }) {
    const ixs = ((tx.transaction || {}).message || {}).instructions || [];
    return ixs.some((ix) => {
      if (ix.programId !== KLEND.program || !Array.isArray(ix.accounts) || typeof ix.data !== 'string') return false;
      let d; try { d = b58decode(ix.data.length <= 100 ? ix.data : ''); } catch { return false; }
      return d.length === 16 && toHex(d.slice(0, 8)) === KLEND.deposit && u64le(d, 8) === BigInt(price)
        && ix.accounts[1] === KLEND.reserve && ix.accounts[8] === dst && ix.accounts[12] === ref;
    });
  }
  /** A settle-to-earn payment counts only if the deposit is bound to this order, the merchant's cUSDC grew, and the reserve took the invoiced USDC. */
  function verifyEarn(tx, merchant, price, { dst, ref, notBefore } = {}) {
    if (!tx || !tx.meta || tx.meta.err || !recent(tx, notBefore)) return null;
    if (!earnDepositIn(tx, { dst, ref, price })) return null;
    const shares = tokenDelta(tx, merchant, KLEND.cusdc);
    const supplied = tokenDelta(tx, KLEND.authority, USDC_MINT);
    if (shares <= 0n || supplied + EARN_ROUNDING < BigInt(price)) return null;
    return { shares, supplied };
  }
  /** A reference counts only as a read-only, non-signing key. Otherwise any busy account (a merchant's own token account, a mint) could pose as one. */
  function referenceIn(tx, ref) {
    const k = (((tx.transaction || {}).message || {}).accountKeys || []).find((x) => (x.pubkey || x) === ref);
    return !!k && k.signer === false && k.writable === false;
  }
  function verifyUsdc(tx, merchant, minRaw, exact, notBefore) {
    if (!tx || !tx.meta || tx.meta.err || !recent(tx, notBefore)) return null;
    const delta = tokenDelta(tx, merchant, USDC_MINT);
    if (delta < BigInt(minRaw) || (exact && delta !== BigInt(minRaw))) return null;
    return { delta };
  }
  /** Token balance from a base64 SPL token account (amount = u64 at offset 64). */
  function tokenAccountAmount(b64) {
    const b = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (b.length < 72) throw new Error('not a token account');
    return u64le(b, 64);
  }

  // ---------- payment request URIs (QR + "open in wallet"): amount prefilled, so nothing is typed ----------
  function paymentUri({ chain, address, raw, decimals, contract, memo }) {
    const c = CHAINS[chain] || {};
    if (memo) return address; // a memo cannot be carried reliably: the page shows it as its own field
    if (contract && !(c.fam === 'evm' ? isEvmAddr(contract) : c.fam === 'sol' ? isSolAddr(contract) : false)) return address;
    if (c.fam === 'evm' && c.id) {
      return contract
        ? `ethereum:${contract}@${c.id}/transfer?address=${address}&uint256=${BigInt(raw)}`
        : `ethereum:${address}@${c.id}?value=${BigInt(raw)}`;
    }
    if (c.fam === 'sol') return `solana:${address}?amount=${fromUnits(raw, decimals)}${contract ? `&spl-token=${contract}` : ''}`;
    if (c.scheme) return `${c.scheme}:${address}?amount=${fromUnits(raw, decimals)}`;
    return address;
  }
  function solanaPayUri({ recipient, raw, reference, label, message }) {
    const q = new URLSearchParams({ amount: fromUnits(raw, 6), 'spl-token': USDC_MINT, reference });
    if (label) q.set('label', label);
    if (message) q.set('message', message);
    return `solana:${recipient}?${q}`;
  }

  // ---------- assets and incidents ----------
  const ACTIVE = (i) => !i.status || i.status === 'active';
  /** Active Aurora incidents that block paying WITH this asset. */
  const assetIncident = (t, incidents) => (incidents || []).some((i) => ACTIVE(i)
    && (!i.direction || i.direction === '*' || i.direction === 'deposit')
    && ((i.scopeType === 'chain' && i.scopeValue === t.blockchain) || (i.scopeType === 'token' && i.scopeValue === t.assetId)));
  /** Active incidents that block delivering USDC on Solana (every route ends there). */
  const settlementIncident = (incidents) => (incidents || []).some((i) => ACTIVE(i)
    && (!i.direction || i.direction === '*' || i.direction === 'withdrawal' || i.direction === 'withdraw')
    && ((i.scopeType === 'chain' && i.scopeValue === 'sol') || (i.scopeType === 'token' && i.scopeValue === SOL_USDC)));

  /** Aurora's live list -> what the checkout offers. Popular routes first, then by chain and symbol. */
  function listAssets(tokens, incidents) {
    const named = (tokens || []).filter((t) => CHAINS[t.blockchain] && t.assetId !== SOL_USDC && !assetIncident(t, incidents));
    const rank = (t) => { const i = POPULAR.findIndex(([c, s]) => c === t.blockchain && s === t.symbol); return i < 0 ? 999 : i; };
    return named.slice().sort((a, b) => rank(a) - rank(b) || CHAINS[a.blockchain].name.localeCompare(CHAINS[b.blockchain].name) || a.symbol.localeCompare(b.symbol));
  }
  const isPopular = (t) => POPULAR.some(([c, s]) => c === t.blockchain && s === t.symbol);
  function matchAsset(t, q) {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    const hay = `${t.symbol} ${CHAINS[t.blockchain].name} ${t.blockchain}`.toLowerCase();
    return s.split(/\s+/).every((w) => hay.includes(w));
  }

  // ---------- independent checks: NEAR Intents' public API must agree with what Aurora's API returned ----------
  /** Aurora's token list and the public 1Click list must agree on contract and decimals. Only agreeing assets are offered. */
  function agreedTokens(tokens, oneclick) {
    const pub = new Map((oneclick || []).map((t) => [t.assetId, t]));
    return (tokens || []).filter((t) => {
      const o = pub.get(t.assetId);
      return !!o && o.decimals === t.decimals && String(o.contractAddress || '').toLowerCase() === String(t.contractAddress || '').toLowerCase();
    }).map((t) => ({ ...t, price: pub.get(t.assetId).price }));
  }
  const MAX_APP_FEE_BPS = 15; // this page's key runs at Aurora's floor: 2 bps on stables, 10 on the rest
  /** Before any QR, signature or send: the deposit address must be known publicly, with these exact terms. */
  function checkPublicQuote(st, { depositAddress, recipient, originAsset, refundTo, amountIn, amount, memo, fresh = true }) {
    const qr = (st && st.quoteResponse && st.quoteResponse.quoteRequest) || {}; const q = (st && st.quoteResponse && st.quoteResponse.quote) || {};
    const problems = [];
    if (String(q.depositAddress || '').toLowerCase() !== depositAddress.toLowerCase()) problems.push('deposit address unknown to NEAR Intents');
    if ((q.depositMemo || null) !== (memo || null)) problems.push('memo differs');
    if (qr.destinationAsset !== SOL_USDC) problems.push('destination is not USDC on Solana');
    if (qr.originAsset !== originAsset) problems.push('origin asset differs');
    if (qr.swapType !== 'EXACT_OUTPUT') problems.push('not an exact-output quote');
    if (qr.recipient !== recipient) problems.push('recipient differs');
    if (qr.recipientType && qr.recipientType !== 'DESTINATION_CHAIN') problems.push('funds would not leave for the recipient chain');
    if ((qr.appFees || []).reduce((n, f) => n + Number(f.fee || 0), 0) > MAX_APP_FEE_BPS) problems.push('fee is above this checkout\'s fee');
    if (refundTo && String(qr.refundTo || '').toLowerCase() !== refundTo.toLowerCase()) problems.push('refunds would not go to you');
    if (String(q.amountIn) !== String(amountIn)) problems.push('amount to send differs');
    if (amount !== undefined && String(qr.amount) !== String(amount)) problems.push('quoted output differs');
    if (fresh && st && st.status !== 'PENDING_DEPOSIT') problems.push(`address is not waiting for a deposit (${st.status})`);
    return problems;
  }
  /** The amount asked of the payer must be close to the invoice, priced with the public token list. */
  function amountSane(amountIn, token, invoiceRaw, maxFeeRaw) {
    const p = Number(token.price);
    if (!(p > 0)) return false;
    const usd = (Number(amountIn) / 10 ** token.decimals) * p;
    return usd <= ((Number(invoiceRaw) + Number(maxFeeRaw)) / 1e6) * 1.05 + 0.1;
  }
  /** A restored order must belong to this exact invoice and still make sense. */
  function restorable(o, invoice, now = Date.now()) {
    if (!o || !o.quote || !isDepositAddr(o.quote.depositAddress)) return false;
    if (o.to !== invoice.to || o.raw === undefined || (o.confidential ? BigInt(o.raw) - invoice.raw > 999n || BigInt(o.raw) < invoice.raw : BigInt(o.raw) !== invoice.raw)) return false;
    if ((o.settle || 'usdc') !== 'usdc' && o.settle !== invoice.settle) return false;
    if (o.deadline && !o.depositTx && now > new Date(o.deadline).getTime() + 600 * 1000) return false;
    return true;
  }

  // ---------- permanent addresses (Intents Deposits): one address per network, any amount, no expiry ----------
  const permanentRequest = (merchant, chain) => ({
    sender: `sluice:${merchant}`, recipient: merchant, recipientType: 'DESTINATION_CHAIN', depositChain: chain, destinationChain: 'sol', destinationAsset: SOL_USDC,
  });
  /** Aurora's stored record must say this address ends at this merchant, as USDC on Solana. This catches mistakes and mixed-up
   *  responses; it is not a second opinion, since both answers come from Aurora and no public record of these addresses exists. */
  const permanentMatches = (rec, address, merchant) => !!rec && rec.depositAddress === address && rec.recipient === merchant
    && rec.recipientType === 'DESTINATION_CHAIN' && rec.recipientChain === 'sol' && rec.destinationSymbol === 'USDC';
  // Aurora: "The recommended minimum deposit is $1. Or $2 for TRON." Less may never arrive.
  const permanentMinUsd = (chain) => (chain === 'tron' ? 2 : 1);
  /** The minimum in the asset itself, rounded up so that it never undershoots. Null when the price is unknown. */
  function minInAsset(token, usd) {
    const p = Number(token.price);
    if (!(p > 0)) return null;
    const v = (usd * 1.03) / p; const d = 10 ** (Math.floor(Math.log10(v)) - 1);
    return String(Number((Math.ceil(v / d) * d).toPrecision(2)));
  }
  /** Merge Aurora's received/success/failed lists into one newest-first timeline. */
  function depositRows({ received = [], success = [], failed = [] } = {}) {
    const fmt = (d) => (d.decimals != null && /^\d+$/.test(String(d.amount)) ? fromUnits(d.amount, d.decimals) : String(d.amount ?? ''));
    const row = (kind) => (d) => ({ kind, amount: fmt(d), assetId: d.asset_id || null, chain: d.fromChain || d.destinationChain || null, tx: d.tx_hash || null, at: d.created_at || null });
    const all = [...received.map(row('received')), ...success.map(row('delivered')), ...failed.map(row('failed'))];
    return all.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  // ---------- status -> what the buyer sees ----------
  /** Maps Swap API and Intents Connect statuses to one timeline. */
  function stage(status) {
    switch (status) {
      case 'PENDING_DEPOSIT': case 'CREATED': case 'DEPOSIT_PENDING': return { step: 'AWAIT' };
      case 'KNOWN_DEPOSIT_TX': return { step: 'SEEN' };
      case 'INCOMPLETE_DEPOSIT': return { step: 'SEEN', tone: 'warn' };
      case 'PROCESSING': case 'DEPOSIT_PROCESSING': case 'SIGNING': case 'OPERATION_PENDING': case 'OPERATION_PROCESSING': return { step: 'ROUTE' };
      case 'SUCCESS': return { step: 'SOLANA' };
      case 'REFUNDED': case 'DEPOSIT_FAILED': return { step: 'SEEN', end: 'refund' };
      case 'FAILED': case 'OPERATION_FAILED': return { step: 'ROUTE', end: 'fail' };
      case 'EXPIRED': return { step: 'AWAIT', end: 'expired' };
      default: return { step: 'AWAIT' };
    }
  }
  /** How much more the buyer must send to complete a short deposit before the deadline. */
  function shortfall(amountIn, deposited) {
    const a = BigInt(amountIn || 0); const d = BigInt(deposited || 0);
    return a > d ? a - d : 0n;
  }

  // ---------- merchant first run (pure: what the merchant typed, and what Solana says about it) ----------
  const NAME_MAX = 40;
  const NAME_OK = /^[\p{L}\p{M}\p{N} .,'&()!_-]+$/u;
  /** A display name for the checkout. Letters, marks and digits from any script, single spaces and a little punctuation.
   *  Control, zero-width, bidi and other invisible characters are refused, so a name cannot hide or reorder text. */
  // Code points that render as nothing (Unicode Default_Ignorable_Code_Point), listed so the Python CLI applies the same list.
  const IGNORABLE = [[0xAD, 0xAD], [0x34F, 0x34F], [0x61C, 0x61C], [0x115F, 0x1160], [0x17B4, 0x17B5], [0x180B, 0x180F], [0x200B, 0x200F],
    [0x202A, 0x202E], [0x2060, 0x206F], [0x3164, 0x3164], [0xFE00, 0xFE0F], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0], [0xFFF0, 0xFFF8],
    [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A], [0xE0000, 0xE0FFF]];
  const ignorable = (cp) => IGNORABLE.some(([a, b]) => cp >= a && cp <= b);
  function cleanName(s) {
    if (typeof s !== 'string') return null;
    const t = s.normalize('NFC').replace(/[ \t\n\r]+/g, ' ').replace(/^ +| +$/g, '');
    if (!t || [...t].length > NAME_MAX || !NAME_OK.test(t) || !/[\p{L}\p{N}]/u.test(t)) return null;
    // nothing invisible, no enclosing marks, no stacks of marks that draw over the text around the name
    if ([...t].some((c) => ignorable(c.codePointAt(0))) || /\p{Me}/u.test(t) || /\p{M}{3,}/u.test(t)) return null;
    // a name must not pass for an address: no '..' (a shortened address), no 0x word, no long word with digits or several capitals
    if (t.includes('..') || /(^| )0[xX]/.test(t)) return null;
    if (t.split(' ').some((w) => [...w].length >= 12 && (/\p{N}/u.test(w) || (w.match(/\p{Lu}/gu) || []).length >= 3))) return null;
    return t;
  }
  /** Something nobody should ever paste into a web page: a recovery phrase or a private key in any common format. */
  function looksSecret(s) {
    const t = String(s || '').trim();
    if (!t) return false;
    // any capitalisation, numbered or not ("1. abandon 2. ability"), and partial phrases too
    const words = t.toLowerCase().split(/\s+/).filter((w) => !/^\d{1,2}[.):]?$/.test(w)).map((w) => w.replace(/^\d{1,2}[.):]/, ''));
    const wordy = words.filter((w) => /^[a-z]{3,8}$/.test(w)).length;
    if (wordy >= 8 && wordy >= words.length * 0.8) return true;
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) return true;
    if (/^\[\s*\d{1,3}(\s*,\s*\d{1,3}){63}\s*\]$/.test(t)) return true;
    if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(t)) { try { return b58decode(t).length === 64; } catch { return false; } }
    return false;
  }
  const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const NOT_A_WALLET = {
    [USDC_MINT]: "the USDC token's own address", [KLEND.cusdc]: "Kamino's cUSDC token address", [TOKEN_PROGRAM]: 'the Token program',
    [TOKEN_2022]: 'the Token-2022 program', [ATA_PROGRAM]: 'a Solana program', [SYSTEM_PROGRAM]: 'the System program', [COMPUTE_BUDGET]: 'a Solana program',
    [KLEND.program]: "Kamino's program", [KLEND.market]: "Kamino's market", [KLEND.reserve]: "Kamino's USDC reserve", [KLEND.supply]: "Kamino's USDC vault",
    [KLEND.authority]: "Kamino's vault authority", So11111111111111111111111111111111111111112: "wrapped SOL's token address",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "the USDT token's own address",
  };
  /** What a merchant pasted as the payout address. `account` is Solana's getAccountInfo value (jsonParsed): undefined while
   *  unchecked, null when the address has no account yet, or 'error' when Solana could not be read. */
  function payoutCheck(input, account) {
    const a = String(input || '').trim();
    if (!a) return { ok: false, level: 'empty', msg: '' };
    if (looksSecret(a)) return { ok: false, level: 'secret', msg: 'That looks like a secret recovery phrase or private key. Never paste it into any page, this one included. It has been cleared from the field.' };
    if (isEvmAddr(a)) return { ok: false, level: 'bad', msg: 'That is an Ethereum-style 0x address. Paste your Solana address: in Phantom it is the one next to Solana.' };
    if (!isSolAddr(a)) return { ok: false, level: 'bad', msg: 'That is not a Solana address. It is 32 to 44 letters and numbers: copy it from your wallet.' };
    if (NOT_A_WALLET[a]) return { ok: false, level: 'bad', msg: `That is ${NOT_A_WALLET[a]}, not a wallet. Paste your own wallet address.` };
    const canSign = onCurve(b58decode(a));
    if (account === undefined) return { ok: false, level: 'pending', msg: 'Checking this address on Solana…', canSign };
    if (account === 'error') return { ok: true, level: 'warn', msg: 'Could not check this address on Solana right now. Make sure you copied it from your wallet.', canSign };
    if (account === null) {
      return canSign ? { ok: true, level: 'good', msg: 'A Solana wallet address. It holds no SOL, which is fine: you need none to receive USDC. Double-check you copied all of it.', canSign }
        : { ok: true, level: 'warn', msg: 'This address has no private key (it is not a regular wallet). Only use it if it is a vault you control.', canSign };
    }
    if (account.executable) return { ok: false, level: 'bad', msg: 'That is a program, not a wallet. Paste your own wallet address.', canSign };
    if (account.owner === TOKEN_PROGRAM || account.owner === TOKEN_2022) {
      return account.type === 'mint' ? { ok: false, level: 'bad', msg: "That is a token's own address (a mint), not a wallet. Paste your own wallet address.", canSign }
        : { ok: false, level: 'bad', msg: "That is a token account. Paste your wallet's main Solana address instead: payments go to the USDC account that belongs to it.", canSign };
    }
    if (account.owner === SYSTEM_PROGRAM) {
      return canSign ? { ok: true, level: 'good', msg: 'A Solana wallet address, active on Solana.', canSign }
        : { ok: true, level: 'warn', msg: 'This address has no private key: it is controlled by a program (for example a multisig vault). Only use it if that vault is yours.', canSign };
    }
    return { ok: true, level: 'warn', msg: 'This account belongs to a program (for example a multisig or smart wallet). Only use it if it is yours and can hold USDC.', canSign };
  }
  /** Amount, reference and name for a fixed-price link, validated and normalised. Throws with a message the form can show. */
  function linkInput({ to, amt, ref = '', name = '' }) {
    if (!isSolAddr(String(to || '').trim())) throw new Error('Enter a valid Solana address');
    let a = String(amt || '').trim();
    if (/^\d+,\d+$/.test(a)) a = a.replace(',', '.'); // phones in many countries type a decimal comma
    if (!/^\d{1,9}(\.\d{1,6})?$/.test(a) || Number(a) < 0.15) throw new Error('Amount must be at least 0.15 USDC (the cross-chain minimum), with up to 6 decimals');
    const r = String(ref || '').trim();
    if (!/^[\w.-]{0,40}$/.test(r)) throw new Error('Reference: letters, digits, . _ - only, up to 40');
    const n = name ? cleanName(name) : null;
    if (name && !n) throw new Error('Name: up to 40 letters, digits, spaces and . , \' & ( ) ! _ -');
    return { to: String(to).trim(), amt: a, ref: r, name: n };
  }
  /** The exact text a merchant signs for a pay link: keys in sorted order, byte for byte what the Python CLI signs. */
  function linkMessage({ to, amt, ref = '', earn = false, name = null, signer, now = Date.now(), days = 7 }) {
    const f = { amt, exp: Math.floor(now / 1000) + days * 86400, k: signer };
    if (name) f.n = name;
    f.ref = ref; if (earn) f.s = 'earn';
    f.to = to; f.v = 1;
    return JSON.stringify(f);
  }
  /** `#a=<merchant>` or `#a=<merchant>&n=<name>`: the permanent pay page. The name is unsigned and labelled so on the page. */
  function permanentLink(hash) {
    const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    return { merchant: q.get('a') || '', name: cleanName(q.get('n') || '') };
  }

  // ---------- merchant view: Solana is the ledger, Aurora only says where a credit came from ----------
  /** Kamino deposits in this transaction whose cUSDC goes to `dst`: their total USDC amount and the first order reference. */
  function kaminoDepositTo(tx, dst) {
    const ixs = ((tx.transaction || {}).message || {}).instructions || [];
    let amount = 0n; let ref = null; let hit = false;
    for (const ix of ixs) {
      if (ix.programId !== KLEND.program || !Array.isArray(ix.accounts) || typeof ix.data !== 'string' || ix.data.length > 100) continue;
      let d; try { d = b58decode(ix.data); } catch { continue; }
      if (d.length === 16 && toHex(d.slice(0, 8)) === KLEND.deposit && ix.accounts[1] === KLEND.reserve && ix.accounts[8] === dst) {
        hit = true; amount += u64le(d, 8);
        if (!ref && isSolAddr(ix.accounts[12])) ref = ix.accounts[12];
      }
    }
    return hit ? { amount, ref } : null;
  }
  /** One Solana transaction seen from the merchant's side. A USDC credit, a Kamino deposit into the merchant's own cUSDC
   *  account paid by someone else, a withdrawal from Kamino, or nothing. The merchant moving its own USDC into Kamino is not income. */
  function merchantCredit(tx, merchant, cusdcAccount, sig) {
    if (!tx || !tx.meta || tx.meta.err) return null;
    const usdc = tokenDelta(tx, merchant, USDC_MINT); const shares = tokenDelta(tx, merchant, KLEND.cusdc);
    const at = tx.blockTime || null;
    if (shares > 0n) {
      const dep = cusdcAccount ? kaminoDepositTo(tx, cusdcAccount) : null;
      if (!dep || usdc < 0n) return null;
      // Only the deposits that name the merchant's account count, never what else the same transaction put into Kamino.
      const vault = tokenDelta(tx, KLEND.authority, USDC_MINT);
      const supplied = vault <= 0n ? 0n : vault < dep.amount ? vault : dep.amount;
      return { kind: 'earn', sig, at, shares, supplied, ref: dep.ref };
    }
    if (shares < 0n) return usdc > 0n ? { kind: 'withdraw', sig, at, usdc, shares: -shares } : null;
    return usdc > 0n ? { kind: 'usdc', sig, at, usdc } : null;
  }
  const AURORA_LIVE = new Set(['KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED']);
  const DUST = 10000n; // credits under 0.01 USDC are listed as dust and never counted: anyone can send them to flood the view
  const decimalText = (v) => (typeof v === 'string' && /^\d{1,20}(\.\d{1,18})?$/.test(v) ? v : null);
  /** Newest-first rows for the merchant view. Every credit row comes from Solana; Aurora's list adds the source asset and a record
   *  link when it routed that exact Solana transaction, and shows payments still on the way or refunded. Unpaid quotes are left out. */
  function ledgerRows(credits, aurora, merchant) {
    const bySig = new Map(); const mine = (aurora || []).filter((x) => x && x.recipient === merchant && isDepositAddr(x.depositAddress));
    for (const x of mine) for (const h of x.destinationChainTxHashes || []) { const s = typeof h === 'string' ? h : h && h.hash; if (s) bySig.set(s, x); }
    const used = new Set(); const rows = [];
    for (const c of credits || []) {
      if (!c || (c.kind !== 'usdc' && c.kind !== 'earn')) continue;
      const x = bySig.get(c.sig) || null; if (x) used.add(x.depositAddress);
      const usdc = c.kind === 'earn' ? c.supplied : c.usdc;
      rows.push({ kind: c.kind, verified: true, dust: usdc < DUST, sig: c.sig, at: c.at, usdc, shares: c.shares || 0n,
        origin: x ? x.originAsset : null, paidIn: x ? decimalText(x.amountInFormatted) : null,
        record: x ? `#s=${x.depositAddress}` : c.ref ? `#c=${c.ref}.${merchant}` : null });
    }
    for (const x of mine) {
      if (used.has(x.depositAddress) || !AURORA_LIVE.has(x.status)) continue;
      rows.push({ kind: 'aurora', verified: false, status: x.status, at: Math.floor(Date.parse(x.createdAt || '') / 1000) || null, usdc: null,
        out: decimalText(x.amountOutFormatted), origin: x.originAsset || null, paidIn: decimalText(x.amountInFormatted), record: `#s=${x.depositAddress}` });
    }
    return rows.sort((p, q) => (q.at || 0) - (p.at || 0));
  }
  /** Verified USDC received per local day, oldest first, ending today. tzOffsetMin = Date#getTimezoneOffset(). */
  function dailyTotals(rows, { days = 14, now = Date.now(), tzOffsetMin = 0 } = {}) {
    const key = (ms) => new Date(ms - tzOffsetMin * 60000).toISOString().slice(0, 10);
    const out = []; const idx = new Map();
    for (let i = days - 1; i >= 0; i--) { const k = key(now - i * 86400000); idx.set(k, out.length); out.push({ day: k, usdc: 0n, count: 0 }); }
    for (const r of rows || []) {
      if (!r.verified || r.dust || !r.at || r.usdc === null || r.usdc === undefined) continue;
      const i = idx.get(key(r.at * 1000)); if (i === undefined) continue;
      out[i].usdc += BigInt(r.usdc); out[i].count += 1;
    }
    return out;
  }
  /** A lower bound for what a cUSDC balance is worth: the USDC-per-cUSDC rate of the newest real deposit seen on Solana.
   *  Kamino's rate only grows as interest accrues, and it rounds the shares it mints down, so dividing by shares + 1 never
   *  overstates. A dust deposit is not used when a real one is in view. */
  function earnValue(balanceShares, rows) {
    const bal = BigInt(balanceShares || 0);
    const deps = (rows || []).filter((r) => r.kind === 'earn' && r.shares > 0n && r.usdc > 0n).sort((p, q) => (q.at || 0) - (p.at || 0));
    const last = deps.find((r) => r.shares >= DUST) || deps[0];
    if (!last || bal <= 0n) return null;
    return { usdc: (bal * BigInt(last.usdc)) / (BigInt(last.shares) + 1n), at: last.at, sig: last.sig };
  }
  /** Links a merchant made on this device: newest first, no duplicates, at most `max`. */
  function rememberLink(list, item, max = 8) {
    const rest = (Array.isArray(list) ? list : []).filter((x) => x && typeof x.url === 'string' && x.url !== item.url);
    return [item, ...rest].slice(0, max);
  }

  return {
    cleanName, looksSecret, payoutCheck, linkInput, linkMessage, permanentLink, merchantCredit, ledgerRows, dailyTotals, earnValue, rememberLink, kaminoDepositTo,
    USDC_MINT, TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM_PROGRAM, SOL_USDC, KLEND, CHAINS, POPULAR,
    b58decode, b58encode, isSolAddr, concat, utf8, toHex, fromHex, sha256, toUnits, fromUnits, short,
    validRefund, isEvmAddr, isDepositAddr, onCurve, findPda, ata, referenceKey, paySteps, earnSteps,
    decodeMessage, messageFromPayload, auditPayload, secpWire, tokenDelta, verifyEarn, verifyUsdc, tokenAccountAmount,
    paymentUri, solanaPayUri, assetIncident, settlementIncident, listAssets, isPopular, matchAsset, stage, shortfall,
    permanentRequest, permanentMatches, permanentMinUsd, minInAsset, depositRows,
    MPC, sha3_256, deriveIntermediary, agreedTokens, checkPublicQuote, amountSane, restorable, earnDepositIn, referenceIn,
  };
});
