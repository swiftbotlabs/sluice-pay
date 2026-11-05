// Landing-page motion and small controls, separate from the checkout logic in app.js. No network, no innerHTML.
// - colour theme toggle (remembered in localStorage when storage works)
// - the hero payment record plays its sequence once (Replay restarts it); the HTML already holds the final state
// - the water ground behind it (caustics shader; a still on phones and under reduced motion; pause button)
// - "How a payment passes the gate": the stage follows the step being read (transform/opacity only)
// - the decoded-transaction tabs, and a copy button beside every explorer link in the hero and the proof rows
import fx from './fx/fx.js';

const d = document.documentElement;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const phone = () => window.matchMedia('(max-width: 639px)').matches;
const $ = (s, r = document) => r.querySelector(s);

// ---------- theme ----------
const themeBtn = $('#theme');
const isDark = () => d.dataset.theme ? d.dataset.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
const syncThemeBtn = () => { if (themeBtn) themeBtn.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode'); };
let fxCtl = null;
const fxPalette = () => {
  const cs = getComputedStyle(d);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { bg: v('--fx-bg'), ink: v('--fx-ink'), accent: v('--fx-accent'), accentInk: v('--accent-ink') };
};
if (themeBtn) {
  syncThemeBtn();
  const applyTheme = (next) => {
    d.classList.add('theming');
    d.dataset.theme = next;
    requestAnimationFrame(() => requestAnimationFrame(() => d.classList.remove('theming')));
  };
  themeBtn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    // the new theme opens as a circle from the button (View Transitions where supported; an instant switch elsewhere)
    if (document.startViewTransition && !reduced()) {
      const r = themeBtn.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
      const far = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      const vt = document.startViewTransition(() => applyTheme(next));
      vt.ready.then(() => d.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${far}px at ${x}px ${y}px)`] },
        { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)', pseudoElement: '::view-transition-new(root)' })).catch(() => {});
    } else applyTheme(next);
    try { localStorage.setItem('sluice-theme', next); } catch (e) { /* storage blocked: this visit only */ }
    syncThemeBtn();
    if (fxCtl) setTimeout(() => { try { fxCtl.setPalette(fxPalette()); } catch (e) { /* the CSS ground stays */ } }, 60);
    const meta = document.querySelectorAll('meta[name="theme-color"]');
    for (const m of meta) m.setAttribute('content', next === 'dark' ? '#071A1C' : '#ECEFEA');
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    syncThemeBtn();
    if (fxCtl && !d.dataset.theme) { try { fxCtl.setPalette(fxPalette()); } catch (e) { /* keep */ } }
  });
}

// ---------- hero sequence ----------
const hv = $('#hv');
if (hv) {
  const replay = $('.hv-replay', hv);
  const play = () => { hv.classList.remove('run'); void hv.offsetWidth; hv.classList.add('run'); };
  if (!reduced()) {
    play();
    if (replay) { replay.hidden = false; replay.addEventListener('click', play); }
  }
}

// ---------- water ground ----------
const fxEl = $('#hero-fx');
const mountFx = () => {
  if (phone()) fx.config.clock = 4.2; // a still frame on phones
  fx.mount(fxEl, 'caustics', { palette: fxPalette(), seed: 1104, params: { scale: 4.6, speed: 0.12, intensity: 0.62, calm: 0.15, depth: 0.5, distortion: 0.55 } })
    .then((c) => {
      fxCtl = c;
      if (phone() || reduced()) return;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'fx-pause'; b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', 'Pause the water animation');
      const ns = 'http://www.w3.org/2000/svg';
      const mk = (cls, dd) => { const s = document.createElementNS(ns, 'svg'); s.setAttribute('viewBox', '0 0 12 12'); s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS(ns, 'path'); p.setAttribute('d', dd); s.append(p); return s; };
      b.append(mk('i-pause', 'M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z'), mk('i-play', 'M3 1.5l7 4.5-7 4.5z'));
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Play the water animation' : 'Pause the water animation');
        if (on) c.pause(); else c.resume();
      });
      fxEl.closest('.hero-visual').append(b);
    })
    .catch(() => { /* no WebGL: the flat ground stays */ });
};
// the ground is decoration: mount it once the page is idle, so it never delays the first tap
if (fxEl) {
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 600));
  const go = () => idle(mountFx, { timeout: 2000 });
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
}

// ---------- the gate: stage follows the step in the middle of the screen ----------
const how = $('#how');
if (how) {
  const steps = [...how.querySelectorAll('.how-steps li')];
  if (reduced()) {
    for (const li of steps) li.classList.add('on');
  } else {
    let stage = -1; let queued = false;
    const read = () => {
      queued = false;
      const line = window.innerHeight * (phone() ? 0.78 : 0.6);
      let s = 0;
      for (const li of steps) if (li.getBoundingClientRect().top < line) s = Number(li.dataset.step);
      if (s !== stage) {
        stage = s; how.dataset.stage = String(s);
        for (const li of steps) li.classList.toggle('on', Number(li.dataset.step) === s);
      }
    };
    const ask = () => { if (!queued) { queued = true; requestAnimationFrame(read); } };
    read();
    window.addEventListener('scroll', ask, { passive: true });
    window.addEventListener('resize', ask, { passive: true });
  }
}

// ---------- decoded transactions: tabs ----------
const tabs = [...document.querySelectorAll('.dx-tabs [role="tab"]')];
if (tabs.length) {
  let cur = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab; const panel = document.getElementById(t.getAttribute('aria-controls'));
      t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
      if (panel) { if (on) { panel.removeAttribute('data-dx-hide'); if (t !== cur) { panel.classList.remove('swap'); void panel.offsetWidth; panel.classList.add('swap'); } } else panel.setAttribute('data-dx-hide', ''); }
    }
    cur = tab;
    if (focus) tab.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t, false));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault(); select(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true);
    });
  });
}

// ---------- copy buttons beside explorer links ----------
const HASH = /^[A-Za-z0-9]{20,130}$/;
const EXPLORER = /^https:\/\/(solscan\.io\/tx|basescan\.org\/tx|arbiscan\.io\/tx|optimistic\.etherscan\.io\/tx|etherscan\.io\/tx|tronscan\.org\/#\/transaction)\//;
const hashOf = (a) => { const h = (a.getAttribute('href') || '').split(/[/#]/).pop(); return EXPLORER.test(a.href) && HASH.test(h) ? h : null; };
const decorate = (root) => {
  for (const a of root.querySelectorAll('a[target="_blank"]')) {
    const h = hashOf(a);
    if (!h || (a.nextElementSibling && a.nextElementSibling.classList.contains('cp'))) continue;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cp'; b.dataset.v = h; b.title = 'Copy the full hash'; b.setAttribute('aria-label', 'Copy the full hash');
    a.after(b);
  }
};
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('button.cp');
  if (!b || !HASH.test(b.dataset.v || '')) return;
  const done = (ok) => { b.classList.add(ok ? 'ok' : 'no'); b.title = ok ? 'Copied' : 'Press and hold the link to copy'; setTimeout(() => { b.classList.remove('ok', 'no'); b.title = 'Copy the full hash'; }, 1600); };
  (navigator.clipboard ? navigator.clipboard.writeText(b.dataset.v) : Promise.reject(new Error('no clipboard'))).then(() => done(true), () => done(false));
});
for (const id of ['decode', 'private-check']) { const el = document.getElementById(id); if (el) decorate(el); }



// ---------- phones: the fixed "Start accepting payments" bar steps aside once the closing one is on screen ----------
const close = document.getElementById('close');
if (close && 'IntersectionObserver' in window) {
  new IntersectionObserver((es) => { for (const e of es) document.body.classList.toggle('at-close', e.isIntersecting); }).observe(close);
}
