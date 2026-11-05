// Runs in <head>, before first paint (same-origin file: the CSP is script-src 'self').
// 1. html.js marks that scripts run, so the landing's motion is keyed on it and every page reads in full without JavaScript.
// 2. The colour theme the visitor chose last time (light or dark), else the system's. Storage can be blocked: then the system's.
// 3. A routed link (#p=, #a=, #s=, #c=, #m=, #to=, #start) opens its own view, so the landing must not flash first;
//    app.js view() drops html.routed once that view is up, and style.css shows the landing anyway after 3 s if it never does.
(function () {
  var d = document.documentElement;
  d.classList.add('js');
  try {
    var t = localStorage.getItem('sluice-theme');
    if (t === 'light' || t === 'dark') d.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the system */ }
  if (/^#(p=|to=|s=|c=|m=|a=|start)/.test(location.hash)) {
    d.classList.add('routed');
    try { history.scrollRestoration = 'manual'; } catch (e) { /* older browsers */ }
  }
})();
