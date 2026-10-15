// ============================================================================
// page.ts — the xterm.js terminal page rendered inside a webui view.
//
// The page talks to the host over window.downdraft:
//   page → host: {t:"in", d:<base64>}        keystroke bytes for the PTY
//                {t:"size", c, r}            xterm cols/rows after fit()
//                {t:"ready"}                 terminal booted — flush early output
//   host → page: {t:"out", d:<base64>}       PTY bytes → term.write
//                {t:"status", s}             status text ("connecting…", "exited 0")
//
// TERM_JS/TERM_CSS come from term-bundle.gen.ts (bun bundle of
// page-entry.ts — xterm.js + the fit addon) and are inlined so the view
// needs no URL scheme, no node_modules, and no network.
// ============================================================================

import { TERM_CSS, TERM_JS } from "./term-bundle.gen";

export function termBundleReady(): boolean {
    return TERM_JS.length > 0;
}

export function termPageHtml(fontSize = 13): string {
    const statusPx = Math.max(10, Math.round(fontSize * 11 / 13));
    return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin:0; padding:0; height:100%; background:#0b0e13; overflow:hidden; }
#term { height:100%; width:100%; box-sizing:border-box; padding:8px 10px; }
#status { position:absolute; left:0; right:0; bottom:0; padding:2px 10px;
          font:${statusPx}px monospace; color:#5d6775; background:#0b0e13;
          border-top:1px solid #212933; white-space:nowrap; overflow:hidden; }
${TERM_CSS}
</style></head>
<body>
<div id="term"></div>
<div id="status"></div>
<script>${TERM_JS}</script>
<script>
const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
const b64dec = (s) => decodeURIComponent(escape(atob(s)));
const term = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace",
    fontSize: ${fontSize},
    scrollback: 5000,
    theme: {
        background: "#0b0e13", foreground: "#c8d2e0",
        cursor: "#7fd0ff", cursorAccent: "#0b0e13",
        selectionBackground: "#2e4361",
    },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term"));
const post = (m) => window.downdraft && window.downdraft.postMessage(m);
term.onData((d) => post({ t: "in", d: b64enc(d) }));
window.downdraft && window.downdraft.onMessage((m) => {
    if (m.t === "out") term.write(b64dec(m.d));
    else if (m.t === "status") document.getElementById("status").textContent = m.s;
    else if (m.t === "reset") term.reset();
});
const refit = () => {
    fit.fit();
    post({ t: "size", c: term.cols, r: term.rows });
};
new ResizeObserver(refit).observe(document.getElementById("term"));
refit();
post({ t: "ready" });
</script>
</body></html>`;
}
