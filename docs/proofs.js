/* Sluice live proofs: the 13 mainnet runs, how each is re-checked, and where every unit of each payment went.
 * Shared by the page (docs/app.js, in the browser) and the snapshot builder (tools/snapshot_proofs.mjs, in node), so the
 * stored 4 Nov verification and a live re-check run the same code. No DOM, no network: the caller passes `io`.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.SluiceCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SluiceProofs = api;
})(typeof self !== 'undefined' ? self : globalThis, (C) => {
  'use strict';
  const MERCHANT = '9cYFzrmHRcsYzLhAWsNemzCy75ZhETn2px4MS8oDDReR';
  const ASSETS = { base: ['USDC', 6], op: ['ETH', 18], arb: ['ETH', 18] };
  // `fresh` = run on 4 Nov 2026. `refund` = the refund tx on the paying chain. `src` = what the payer sent (symbol, decimals).
  const PROOF = [
    { kind: 'perm', fresh: true, name: 'Permanent address, real money (Intents Deposits)', chain: 'base', dep: '0xc6b89c8e5f80eeae72b9eb7b428b035c5b907c67cac238d899f649a4541ada9b', addr: '0xF06Ae506D1591aB9c49D442A7520671ab5c4Ea7E', sol: '2Jhg3e1bBxCi3oE1BogFcvTn7bivpY3SaJbfnqqbDUzviswDczjU9Fi4WuHbLqw7EVtgqmR7qsz6hgQRHxcvksiE', raw: 1n, note: '1.10 USDC sent on Base to the merchant\'s permanent address, with no quote and no form. 1.089777 USDC arrived on Solana 14 s later' },
    { fresh: true, name: 'Overpaid invoice: the excess came back', chain: 'base', dep: '0xcef3352b2ba6fd3cf1ceae4bdcf5bbdc284525c0d783611e9afb4f5ac04b85a4', addr: '0x57c2C008e9739E012D6878164E5E70BcA555b6B4', sol: '55V6UFtjVaCzWuK7WEDxBnS8LvXb2GLqdZFoDRXRXkbR472Rw4h9n9nWNdYJEKKYXaNxfrs9apB1WmiQVYzp7eM7', refund: '0x32c814bfd4e1c22fc1bd34d0c44228cd3ee5c70cd44b5058a35445c5a136b135', raw: 250000n, note: '0.30 USDC sent for a 0.25 invoice: exactly 0.25 to the merchant, and 0.037512 USDC back to the payer on Base 26 s later' },
    { fresh: true, name: 'Short invoice: refunded', chain: 'base', dep: '0x40689997843ddba14ce0ed20c401249e98dc35beed7e48730097317324f093a0', addr: '0xC7F06250568abB20Cf004dBC60fD9EC79bEF196B', sol: null, refund: '0x3c2630ff73008fcf2f8956511bb954b8d97fca18f72261e38f338a0156ead7c9', raw: 0n, note: '0.20 USDC sent for a 0.25 invoice: nothing reached the merchant, and 0.1976 USDC went back to the payer after the quote deadline (4 Nov, 14:58 UTC)' },
    { fresh: true, name: 'Paid from ETH on Optimism', chain: 'op', dep: '0x11333f321d7893103abc3b6a212e1d0a41bbfbe6b44b12cc3635c0d3c5b58370', addr: '0xcd4587f5e161475a9b3ECFA6DDD22233634b0653', sol: '39uawZ5pSTz4jZEPv3DYZHYjxpQurRC6bvZWiac7GNkjqryzP3jpzfxKXs6e1aEgYye9WgjqHXDaYtBHUYwVJMfy', refund: '0x996f9e7fcc848f7068a2fb2a2727e0fbf9497c88674400f2a4c4e2234ee44c80', raw: 250000n, note: 'A second source chain: ETH on Optimism paid a 0.25 USDC invoice, and the 0.000021 ETH over-sent came back' },
    { kind: 'redeem', fresh: true, name: 'Merchant took its Kamino position out', chain: 'sol', sol: '3PoYZEFgy4XaJEhKPB3gmrNjnMKNoiKtNDvekybz45JnDRxtvBm7263FPct2EiaLC75fUpsQQtqjL1yi8BtfeK35', note: 'The merchant\'s own wallet turned 0.124074 cUSDC back into 0.150041 USDC (the 0.15 supplied plus interest), paid into its own USDC account' },
    { kind: 'connect', name: 'Invoice settled into Kamino', chain: 'base', dep: '0x8e14bae0049ac8491469eac7087793f988bde603b515603095175b291f298379', addr: '0xeE62051e14B6d668CD3A55fe6C3dC091572759CE', sol: '558Qh7GUjopxDNUfzDib42h7CwtAhDfCvDBAAwCCAc9zNWHaayHaSq3GUuUtzN6SEWBZwr8CWsBaCvJfqFCThgrv', ref: 'Cg13sKZkqtvmJUmUVqH6GHWzMDNdsNnQfLyRWAWYNy9s', intermediary: 'Eg6brpDagWxXdYNDmsFpDUb3wjyrCZeHhBfu6jxndvcr', raw: 150000n, note: 'One signature on Base: USDC supplied to Kamino, cUSDC in the merchant\'s own account, order reference attached' },
    { name: 'Paid from Base USDC', chain: 'base', dep: '0x041579bb7dfcdc42b09b50b5809f746981a6b4cc8e46de22acca7e571bdd6f52', addr: '0xd1EFDa88E49e98c3a9881C8CfcB0c9dfED19D8A5', sol: '3uyHowgryQxRWjsC9DrxMSxFd1nvpEtq3xsrR6iGJfodAdsRC6TyVN8Zk1GgUWunsLH1j6dnz9Tz2tsMhu3xiSG2', refund: '0x291a1b7a6eb2af6acc8a62da930f74c9a7fb92e123a42a0d943dfb81a87fe9d4', raw: 500000n, note: '0.50 USDC received; the 0.002659 USDC over-sent came back on its own' },
    { name: 'Refund: payer sent too little', chain: 'base', dep: '0x926b1cce75dac5750c8cbe0364519987aa3d56d93f7bfaae6bad08fe9084b6ed', addr: '0x399E9E3B0013C1D51148F19402d9A5ecC7e0AD56', sol: null, refund: '0x7654c9edaf4e4dc2f4dbca8e23638b8570baa736d3ea1b532836b0471314071b', raw: 0n, note: '0.40 sent for a 1.00 invoice; 0.3976 USDC refunded to the payer 30 s after the deadline' },
    { kind: 'private', name: 'Private payment from Arbitrum ETH', chain: 'arb', dep: '0x51fdff2ad7247d23f443f9611bd333d8b7398766b57d1e6cde8983d5ac94564a', addr: '0xFAae838d6717EBE699118255Ae94e0a970064CC1', sol: '44GN5eYQhed3UHLkwCXxi2nJU53xeHot1Ff5x4YQNNZn9PG4vy8XVMhrvof6V4fJ9C2SEKCJ9ev8dAXUDZtuB6Cj', raw: 500000n, sent: '222930139609761', note: 'Confidential Intents: the provider shows no hashes, the credit is found on Solana' },
    { name: 'Signed link on this checkout', chain: 'base', dep: '0x1f0c7e5f28450751799f7594f0ba5272b4b883c9efdd95b6c2f812017b240852', addr: '0x6919bC22A44a4E3941318dBa908e7a282C2B22BE', sol: '49Uz6rAsJMQEx2qcX9JdCJqSzCdbpWSKBttYaJNrjaPKjAfZ5qH6SdLr3mwAw34rucxM6hy2i91FcAJe1nVVAxZV', raw: 150000n, note: 'Signed link, deposit address and QR, paid from another wallet, verified by the page' },
    { name: 'Filmed for the demo video', chain: 'base', dep: '0x4c5789409a649fd11ed158476265c9230beda4104fa595944acfc96651a2e7b9', addr: '0xDF4FE7105893cB3BC78579A703b551d65eBa7c54', sol: '4oPn2qbtaHY2JiDi88BAFivHjDcHJs8QbmBDhbPezWuuZT2VVPcU7m5tb7kSwxxeY7pN6CNPj448xEZT3q7PL9Hs', raw: 150000n, note: 'One take on the published checkout' },
    { kind: 'connect', name: 'Intents Connect with order reference', chain: 'arb', dep: '0xb990e1e3b603c01bd25baa4d768c1ec3206f24c36938ca23d604fc1460fe91fc', addr: '0xBE59F73BB339EA403102cDCb17f85Bd807a469fE', sol: '3za9WNavihGUH9SxoTkA5USHp7BA6T61CA55sZXUi9X7PsowSuZeWRzS9RT8CwZgPbFZkM2np8md8Tnh7YMW9zCs', intermediary: 'Eg6brpDagWxXdYNDmsFpDUb3wjyrCZeHhBfu6jxndvcr', raw: 150000n, note: 'Bridged into the payer\'s Solana account, which paid with the order reference attached' },
    { name: 'API call paid by the CLI', chain: 'base', dep: '0x7fb6497012291c7da94c4998f151c4c6740cd9d0df4b2f59bc3619b8105a0708', addr: '0x0497bb48C0335f1D22f147B2983ffDC6dA054042', sol: '45WMgPZthD5cn8RNdrEBKVDD95a8pzZ7sDrU7rZMyAabJBwDSCbZ8oHhhtgioGB4G8jQcitgypadhpTWTtURcMaX', raw: 400000n, note: '402, order, deposit, verified, report plus a signed receipt' },
  ];
  const id = (p) => p.dep || p.sol;
  const big = (v) => (typeof v === 'string' && /^\d{1,40}$/.test(v) ? BigInt(v) : null);
  // amounts as text; USDC keeps at least two decimals so 0.30 reads as money
  const fmt = (raw, dec) => { const s = C.fromUnits(raw, dec); if (dec !== 6) return s; const [i, f = ''] = s.replace(/^-/, '').split('.'); return (s.startsWith('-') ? '-' : '') + i + '.' + f.padEnd(2, '0'); };
  const bps = (qr) => ((qr && qr.appFees) || []).reduce((n, f) => n + (Number(f && f.fee) || 0), 0);

  /** Solana facts the checks read: who gained what, the network fee, and accounts the transaction created (rent). */
  function solFacts(tx, owner, ownAccounts = []) {
    if (!tx || !tx.meta) return null;
    const keys = (((tx.transaction || {}).message || {}).accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
    // rent counts only for the merchant's own token accounts that this transaction opened (pre-balance 0)
    const created = keys.map((k, i) => ({ k, pre: (tx.meta.preBalances || [])[i], post: (tx.meta.postBalances || [])[i] }))
      .filter((a) => a.pre === 0 && a.post > 0 && ownAccounts.includes(a.k)).map((a) => ({ account: a.k, lamports: a.post }));
    const d = (who, mint) => C.tokenDelta(tx, who, mint).toString();
    return { slot: tx.slot, blockTime: tx.blockTime || null, err: tx.meta.err === null || tx.meta.err === undefined ? null : 'failed', feeLamports: tx.meta.fee, feePayer: keys[0] || null,
      merchantUsdc: d(owner, C.USDC_MINT), merchantCusdc: d(owner, C.KLEND.cusdc), relayerUsdc: d(C.CONNECT_FEE.relayer, C.USDC_MINT), created };
  }

  /** Where every unit went, from Aurora's record and the Solana transaction. Each group is a total and the parts it splits
   *  into; when they share a unit, the parts add up to the total exactly (tests/js/proofs.test.mjs checks every row). */
  function feeBreakdown(p, a, s) {
    const [sym, dec] = ASSETS[p.chain] || ['?', 0];
    const groups = []; let g = null;
    const T = (label, raw, d = dec, u = sym) => { g = { total: { label, amount: fmt(raw, d), raw: raw.toString(), unit: u }, parts: [] }; groups.push(g); };
    const P = (label, raw, d = dec, u = sym, kind = '') => g.parts.push({ label, amount: fmt(raw, d), raw: raw.toString(), unit: u, kind });
    if (p.kind === 'redeem') {
      if (!s) return null;
      const usdc = BigInt(s.merchantUsdc); const shares = -BigInt(s.merchantCusdc);
      T('USDC paid into the merchant\'s own account, for ' + fmt(shares, 6) + ' cUSDC burned', usdc, 6, 'USDC');
      P('the 0.15 USDC supplied on 1 Nov', 150000n, 6, 'USDC', 'merchant'); P('interest earned since', usdc - 150000n, 6, 'USDC', 'merchant');
      return { groups, network: `${fmt(BigInt(s.feeLamports), 9)} SOL network fee, paid by the merchant`,
        sentence: `The merchant burned ${fmt(shares, 6)} cUSDC and received ${fmt(usdc, 6)} USDC: the 0.15 supplied plus ${fmt(usdc - 150000n, 6)} interest, for a ${fmt(BigInt(s.feeLamports), 9)} SOL network fee.` };
    }
    if (p.kind === 'perm') {
      if (!a || !s || big(a.sent) === null) return null;
      const sent = big(a.sent); const got = BigInt(s.merchantUsdc);
      T('Sent on Base to the permanent address', sent);
      P('to the merchant on Solana (read from Solana)', got, 6, 'USDC', 'merchant');
      P('Solana delivery and Aurora\'s fee (Aurora\'s record of a permanent address does not split the two)', sent - got, 6, 'USDC', 'fee');
      return { groups, sentence: `${fmt(sent, 6)} sent = ${fmt(got, 6)} to the merchant + ${fmt(sent - got, 6)} USDC for Solana delivery and Aurora's fee.` };
    }
    if (p.kind === 'private') {
      if (!s) return null;
      T('Sent on Arbitrum (the deposit transaction)', BigInt(p.sent), 18, 'ETH');
      P('to the merchant on Solana (read from Solana)', BigInt(s.merchantUsdc), 6, 'USDC', 'merchant');
      return { groups, sentence: `${fmt(BigInt(p.sent), 18)} ETH sent, ${fmt(BigInt(s.merchantUsdc), 6)} USDC to the merchant. Aurora publishes no amounts for a private payment, so the fee split is not public (the quote listed 45 bps of app fees).` };
    }
    if (!a || big(a.deposited) === null) return null;
    const D = big(a.deposited); const U = big(a.amountIn) || 0n; const R = big(a.refunded) || 0n; const O = big(a.amountOut) || 0n; const W = big(a.withdrawFee); const RF = big(a.refundFee);
    const chainName = (C.CHAINS[p.chain] || {}).name || p.chain; const fees = bps(a.quoteRequest);
    T(`Sent on ${chainName}`, D);
    if (a.status === 'REFUNDED' || U === 0n) {
      P('refunded to the payer', R, dec, sym, 'refund'); P('refund fee (gas for the refund transaction)', D - R, dec, sym, 'fee');
      return { groups, sentence: `${fmt(D, dec)} sent = ${fmt(R, dec)} refunded + ${fmt(D - R, dec)} ${sym} refund fee. Nothing reached the merchant.` };
    }
    const left = D - U - R;
    P('swapped', U);
    if (R > 0n) { P('refunded to the payer (the excess)', R, dec, sym, 'refund'); P('refund fee (gas for the refund transaction)', left, dec, sym, 'fee'); }
    else if (left > 0n) P(`left over after the swap, not refunded (less than the ${RF !== null ? fmt(RF, dec) : '?'} ${sym} refund fee)`, left, dec, sym, 'fee');
    const connect = p.kind === 'connect';
    const rentSol = s && s.created && s.created.length ? s.created.reduce((n, c) => n + BigInt(c.lamports), 0n) : 0n;
    const wLabel = 'Solana delivery fee (from the quote)' + (!connect && rentSol > 0n ? `, including rent for the merchant's new USDC account (${fmt(rentSol, 9)} SOL)` : '');
    const words = [];
    if (sym === 'USDC') {
      T('Swapped', U);
      P(connect ? 'to the payer\'s own Solana account (Intents Connect)' : 'to the merchant on Solana (read from Solana)', O, 6, 'USDC', connect ? '' : 'merchant');
      P(wLabel, W, 6, 'USDC', 'fee'); P(`Aurora's ${fees} bps fee and the solver's price`, U - O - W, 6, 'USDC', 'fee');
      words.push(`${fmt(W, 6)} Solana delivery`, `${fmt(U - O - W, 6)} Aurora's ${fees} bps fee and the solver's price`);
    } else {
      const usd = Number(a.amountInUsd); const usdcPx = Number(a.amountOutUsd) / (Number(O) / 1e6);
      const rest = usd - (Number(O + W) / 1e6) * usdcPx;
      g = { total: { label: `Swapped (Aurora values it at $${usd.toFixed(4)})`, amount: fmt(U, dec), raw: U.toString(), unit: sym }, parts: [] }; groups.push(g);
      P(connect ? 'to the payer\'s own Solana account (Intents Connect)' : 'to the merchant on Solana (read from Solana)', O, 6, 'USDC', connect ? '' : 'merchant');
      P(wLabel, W, 6, 'USDC', 'fee');
      g.parts.push({ label: `Aurora's ${fees} bps fee and the solver's price`, amount: '≈$' + rest.toFixed(4), unit: '', kind: 'fee' });
      words.push(`${fmt(W, 6)} USDC Solana delivery`, `about $${rest.toFixed(4)} Aurora's ${fees} bps fee and the solver's price`);
    }
    if (connect && s) {
      const fee = BigInt(s.relayerUsdc); const paid = p.ref ? BigInt(p.raw) : BigInt(s.merchantUsdc);
      T('Reached the payer\'s own Solana account, which then ran one transaction', O, 6, 'USDC');
      P(p.ref ? `supplied to Kamino for the merchant (who got ${fmt(BigInt(s.merchantCusdc), 6)} cUSDC)` : 'paid to the merchant, with the order reference (read from Solana)', paid, 6, 'USDC', 'merchant');
      P('Intents Connect fee, to its relayer (pinned in the audit)' + (rentSol > 0n ? `, including rent for the merchant's new cUSDC account (${fmt(rentSol, 9)} SOL)` : ''), fee, 6, 'USDC', 'fee');
      P('left in the payer\'s own Solana account', O - paid - fee, 6, 'USDC');
      var steps = `That account ${p.ref ? `supplied ${fmt(paid, 6)} USDC to Kamino for the merchant` : `paid the merchant ${fmt(paid, 6)} USDC with the order reference`}, paid a ${fmt(fee, 6)} USDC Intents Connect fee${rentSol > 0n ? ' (it includes opening the merchant\'s new cUSDC account)' : ''} and kept ${fmt(O - paid - fee, 6)}.`;
    }
    const back = R > 0n ? `${fmt(R, dec)} refunded` : null;
    const gas = R > 0n ? `${fmt(left, dec)} refund gas` : left > 0n ? `${fmt(left, dec)} left over, too small to refund` : null;
    const sentence = sym === 'USDC' && !connect
      ? `${fmt(D, 6)} sent = ${fmt(O, 6)} to the merchant${back ? ' + ' + back : ''} + ${fmt(D - O - R, 6)} USDC in fees (${[gas, ...words].filter(Boolean).join(', ')}).`
      : `${fmt(D, dec)} ${sym} sent${back ? `, ${back} and ${fmt(left, dec)} ${sym} refund gas` : gas ? `, ${gas}` : ''}. The ${fmt(U, dec)} ${sym} swapped became ${fmt(O, 6)} USDC ${connect ? 'in the payer\'s own Solana account' : 'to the merchant'}, after ${words.join(' and ')}.${connect && steps ? ' ' + steps : ''}`;
    return { groups, sentence };
  }

  /** One check of a proof row, from Aurora and Solana. io: { swapStatus(addr), getTx(sig), permList(addr, type) }.
   *  Returns plain data (the page renders it, the snapshot stores it); `summary` items are text or { tx, chain }. */
  async function checkRow(p, io, now = Date.now()) {
    const out = { id: id(p), checked_at: new Date(now).toISOString(), ok: false, aurora: null, solana: null, summary: [] };
    const S = out.summary;
    const own = await Promise.all([C.ata(MERCHANT), C.ata(MERCHANT, C.KLEND.cusdc)]);
    if (p.kind === 'redeem') {
      const [usdcAcct, cusdcAcct] = await Promise.all([C.ata(MERCHANT), C.ata(MERCHANT, C.KLEND.cusdc)]);
      const tx = await io.getTx(p.sol); const v = C.verifyRedeem(tx, MERCHANT, { usdcAcct, cusdcAcct });
      out.solana = { sig: p.sol, ...solFacts(tx, MERCHANT, own) };
      S.push(v ? `Solana: merchant −${C.fromUnits(v.shares, 6)} cUSDC, +${C.fromUnits(v.usdc, 6)} USDC in its own account ✓` : 'Solana: not verified');
      out.ok = !!v;
    } else if (p.kind === 'perm') {
      const [received, success] = await Promise.all([io.permList(p.addr, 'received'), io.permList(p.addr, 'success')]);
      const hit = C.permanentDelivered({ received, success }, { address: p.addr, merchant: MERCHANT, depositTx: p.dep, solanaTx: p.sol });
      const got = (received || []).find((d) => d && d.tx_hash === p.dep);
      out.aurora = { status: hit ? 'DELIVERED' : 'NOT_LISTED', sent: got && /^\d+$/.test(String(got.amount)) ? String(got.amount) : null, received_at: got ? String(got.created_at || '').slice(0, 30) : null };
      S.push(hit ? 'Aurora: received and delivered' : 'Aurora: not listed for this address');
      const tx = await io.getTx(p.sol); const v = C.verifyUsdc(tx, MERCHANT, p.raw, false);
      out.solana = { sig: p.sol, ...solFacts(tx, MERCHANT, own) };
      S.push(v ? ` · Solana: merchant +${C.fromUnits(v.delta, 6)} USDC ✓` : ' · Solana: not verified');
      out.ok = !!(hit && v);
    } else {
      const st = await io.swapStatus(p.addr); const d = (st && st.swapDetails) || {}; const roles = C.txRoles(d);
      const qr = ((st && st.quoteResponse) || {}).quoteRequest || {}; const q = ((st && st.quoteResponse) || {}).quote || {};
      const num = (x) => (typeof x === 'string' && /^\d{1,40}$/.test(x) ? x : null);
      out.aurora = { status: String((st && st.status) || 'UNKNOWN').slice(0, 30), updatedAt: String((st && st.updatedAt) || '').slice(0, 30), deposited: num(d.depositedAmount), amountIn: num(d.amountIn),
        amountOut: num(d.amountOut), refunded: num(d.refundedAmount), amountInUsd: typeof d.amountInUsd === 'string' ? d.amountInUsd.slice(0, 20) : null, amountOutUsd: typeof d.amountOutUsd === 'string' ? d.amountOutUsd.slice(0, 20) : null,
        refundFormatted: typeof d.refundedAmountFormatted === 'string' ? d.refundedAmountFormatted.slice(0, 30) : null, refundReason: typeof d.refundReason === 'string' ? d.refundReason.slice(0, 60) : null,
        refundTxs: roles.refunds.slice(0, 2), withdrawFee: num(q.withdrawFee), refundFee: num(q.refundFee), quoteRequest: { appFees: (qr.appFees || []).slice(0, 4).map((f) => ({ fee: Number(f && f.fee) || 0 })) } };
      const amt = (v) => { const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v || '')); return m ? (m[2] ? `${m[1]}.${m[2].slice(0, 8)}`.replace(/0+$/, '') : m[1]) : '?'; };
      let msg = `Aurora: ${String(out.aurora.status).toLowerCase().replace(/_/g, ' ')}`;
      if (st.status === 'INCOMPLETE_DEPOSIT') msg += `: only ${amt(d.depositedAmountFormatted)} arrived, so it goes back to the payer after the deadline`;
      else if (st.status === 'REFUNDED') msg += ` ${amt(d.refundedAmountFormatted)} to the payer${d.refundReason ? ` (${String(d.refundReason).toLowerCase().replace(/_/g, ' ')})` : ''}`;
      else if (roles.refunded) msg += `, ${amt(d.refundedAmountFormatted)} returned to the payer`;
      S.push(msg);
      if (roles.refunded && roles.refunds[0]) S.push(' · refund ', { tx: roles.refunds[0], chain: p.chain });
      let v = null;
      if (p.sol) {
        const tx = await io.getTx(p.sol);
        out.solana = { sig: p.sol, ...solFacts(tx, MERCHANT, own) };
        if (p.ref) {
          const dst = await C.ata(MERCHANT, C.KLEND.cusdc);
          v = C.verifyEarn(tx, MERCHANT, p.raw, { dst, ref: p.ref });
          S.push(v ? ` · Solana: merchant +${C.fromUnits(v.shares, 6)} cUSDC, Kamino +${C.fromUnits(v.supplied, 6)} USDC ✓` : ' · Solana: not verified');
        } else {
          v = C.verifyUsdc(tx, MERCHANT, p.raw, false);
          S.push(v ? ` · Solana: merchant +${C.fromUnits(v.delta, 6)} USDC ✓` : ' · Solana: not verified');
        }
      }
      out.ok = p.sol ? !!v && st.status === 'SUCCESS' : st.status === 'REFUNDED';
    }
    out.fees = feeBreakdown(p, out.aurora, out.solana);
    return out;
  }

  /** Text for a row whose live check is not back (or failed): the stored verification, labelled with its date. */
  function snapshotLabel(snap) {
    const t = snap && snap.checked_at ? new Date(snap.checked_at) : null;
    const when = t && !Number.isNaN(t.getTime()) ? `${t.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()]}, ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')} UTC` : 'earlier';
    return `Verified ${when}`;
  }

  return { PROOF, MERCHANT, id, checkRow, feeBreakdown, solFacts, snapshotLabel };
});
