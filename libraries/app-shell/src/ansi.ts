// ============================================================================
// ansi.ts — terminal escape sequences → styled HTML for the .logpre pane.
// store.logs.text keeps the raw bytes (serial + journal both carry ANSI);
// the pane converts them at render time.
// ============================================================================

const FG = "#c8d2e0";            // .logpre foreground
const BG = "#0b0e13";            // .logpre background
const LINK = "#7fd0ff";          // hyperlink accent

// Palette indices 0–15, tuned to the pane's dark theme — values borrowed
// from the app palette so log colors read like the rest of the UI.
const BASE16 = [
    "#4a515d", "#f08aa8", "#9fd89f", "#f0c98a",
    "#7fd0ff", "#b39af0", "#7fd0b0", "#c8d2e0",
    "#5d6775", "#ff9ec0", "#b5e8b5", "#ffd9a3",
    "#9cddff", "#ceb7f5", "#9fe8cf", "#f2f5f9",
];

// DEC special-graphics set (charset "0") mapped to Unicode — serial boot
// menus and dialog boxes draw their frames through it (chars 0x60–0x7e).
const DECG = "◆▒␉␌␍␊°±␤␋┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│≤≥π≠£·";

// SGR 4:n underline styles — index is the n value.
const UL_STYLE = ["", "single", "double", "wavy", "dotted", "dashed"];

const escHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const rgb = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** xterm 256-entry palette: 0–15 system, 16–231 color cube, 232–255 gray. */
function palette256(n: number): string {
    n = Math.max(0, Math.min(255, n));
    if (n < 16) return BASE16[n]!;
    if (n < 232) {
        const i = n - 16, c = (v: number) => (v === 0 ? 0 : 55 + 40 * v);
        return rgb(c(Math.floor(i / 36)), c(Math.floor((i % 36) / 6)), c(i % 6));
    }
    const v = 8 + (n - 232) * 10;
    return rgb(v, v, v);
}

/** Blend two #rrggbb colors (t=0 → a) — faint text flattens toward the
 *  background instead of using opacity (subpixel fringing, see .opt.dim). */
function mix(a: string, b: string, t: number): string {
    const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
    return rgb(p(a, 0) + (p(b, 0) - p(a, 0)) * t,
        p(a, 1) + (p(b, 1) - p(a, 1)) * t, p(a, 2) + (p(b, 2) - p(a, 2)) * t);
}

/** A color as written by SGR: {n} = 16-color index (bold brightens 0–7),
 *  {c} = already-resolved #rrggbb (256/truecolor). */
type Col = { n: number } | { c: string };

interface Sgr {
    fg: Col | null; bg: Col | null; ul: Col | null;
    bold: boolean; faint: boolean; italic: boolean;
    underline: number;           // 0 off, 1–5 = UL_STYLE index
    blink: boolean;              // accepted, rendered static (no animation)
    inverse: boolean; conceal: boolean;
    strike: boolean; overline: boolean;
    framed: boolean;             // 51 framed / 52 encircled → border
    subSup: boolean;             // 73/74 → smaller text
}

const freshSgr = (): Sgr => ({
    fg: null, bg: null, ul: null,
    bold: false, faint: false, italic: false, underline: 0, blink: false,
    inverse: false, conceal: false, strike: false, overline: false,
    framed: false, subSup: false,
});

const resetSgr = (st: Sgr) => Object.assign(st, freshSgr());

function resolveCol(c: Col | null, bold: boolean): string | null {
    if (!c) return null;
    if ("c" in c) return c.c;
    return BASE16[c.n + (bold && c.n < 8 ? 8 : 0)]!;
}

/** SGR 38/48/58 argument — colon sub-param form (38:5:n / 38:2:[cs:]r:g:b)
 *  consumes nothing; the semicolon form eats following segments. Returns
 *  the color and the index of the last segment it consumed. */
function extColor(segs: string[], k: number, sub: string[]): { c: Col | null; consumed: number } {
    const n = (s: string | undefined) => (s === undefined || s === "" ? NaN : Number(s));
    const pal = (v: number): Col => (v < 16 ? { n: v } : { c: palette256(v) });
    if (sub.length > 1) {
        const mode = n(sub[1]);
        if (mode === 5) return { c: pal(n(sub[2]) || 0), consumed: k };
        if (mode === 2) {
            // "2:r:g:b" vs "2:<colorspace>:r:g:b" — a 6th field (or an
            // empty colorspace slot) means the r/g/b triple starts at 3.
            const off = sub.length >= 6 || sub[2] === "" ? 3 : 2;
            return { c: { c: rgb(n(sub[off]) || 0, n(sub[off + 1]) || 0, n(sub[off + 2]) || 0) }, consumed: k };
        }
        return { c: null, consumed: k };
    }
    const mode = n(segs[k + 1]);
    if (mode === 5) return { c: pal(n(segs[k + 2]) || 0), consumed: k + 2 };
    if (mode === 2) return { c: { c: rgb(n(segs[k + 2]) || 0, n(segs[k + 3]) || 0, n(segs[k + 4]) || 0) }, consumed: k + 4 };
    return { c: null, consumed: Number.isNaN(mode) ? k : k + 1 };
}

function applySgr(st: Sgr, raw: string): void {
    if (/^[<=>?]/.test(raw)) return;          // private-prefixed — never SGR
    const params = /^[0-9:;]*/.exec(raw)![0]; // drop intermediate bytes
    const segs = params.split(";");
    if (segs.length === 1 && segs[0] === "") { resetSgr(st); return; }
    for (let k = 0; k < segs.length; k++) {
        const seg = segs[k]!;
        if (seg === "") { resetSgr(st); continue; }   // empty param = 0
        const sub = seg.split(":");
        const code = Number(sub[0]);
        if (Number.isNaN(code)) continue;
        switch (code) {
            case 0: resetSgr(st); break;
            case 1: st.bold = true; break;
            case 2: st.faint = true; break;
            case 3: st.italic = true; break;
            case 4: {
                const u = Number(sub[1]);
                st.underline = sub[1] === undefined || Number.isNaN(u)
                    ? 1 : Math.min(5, Math.max(0, u));
                break;
            }
            case 5: case 6: st.blink = true; break;
            case 7: st.inverse = true; break;
            case 8: st.conceal = true; break;
            case 9: st.strike = true; break;
            case 21: st.underline = 2; break;         // ECMA doubly-underlined
            case 22: st.bold = st.faint = false; break;
            case 23: st.italic = false; break;
            case 24: st.underline = 0; break;
            case 25: st.blink = false; break;
            case 27: st.inverse = false; break;
            case 28: st.conceal = false; break;
            case 29: st.strike = false; break;
            case 38: case 48: case 58: {
                const r = extColor(segs, k, sub);
                k = r.consumed;
                if (r.c) {
                    if (code === 38) st.fg = r.c;
                    else if (code === 48) st.bg = r.c;
                    else st.ul = r.c;
                }
                break;
            }
            case 39: st.fg = null; break;
            case 49: st.bg = null; break;
            case 51: case 52: st.framed = true; break;
            case 53: st.overline = true; break;
            case 54: st.framed = false; break;
            case 55: st.overline = false; break;
            case 59: st.ul = null; break;
            case 73: case 74: st.subSup = true; break;
            case 75: st.subSup = false; break;
            default:
                if (code >= 30 && code <= 37) st.fg = { n: code - 30 };
                else if (code >= 40 && code <= 47) st.bg = { n: code - 40 };
                else if (code >= 90 && code <= 97) st.fg = { n: code - 90 + 8 };
                else if (code >= 100 && code <= 107) st.bg = { n: code - 100 + 8 };
                break;
        }
    }
}

/** Scan a CSI body starting after "ESC[" — params+intermediates up to the
 *  final byte. final=-1 on a malformed sequence (next = reprocess point),
 *  null when the input ends mid-sequence. */
function scanCsi(s: string, i: number): { params: string; final: number; next: number } | null {
    let j = i;
    while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) return { params: s.slice(i, j), final: c, next: j + 1 };
        if ((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f)) { j++; continue; }
        return { params: s.slice(i, j), final: -1, next: j };
    }
    return null;
}

/** Scan a string-terminated sequence (OSC/DCS/SOS/PM/APC) — BEL or ST ends
 *  it; a stray ESC or control byte aborts without consuming. */
function scanTerminated(s: string, i: number): [string, number] {
    let j = i;
    while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c === 0x07) return [s.slice(i, j), j + 1];
        if (c === 0x1b) return s.charCodeAt(j + 1) === 0x5c ? [s.slice(i, j), j + 2] : [s.slice(i, j), j];
        if (c < 0x20 || c === 0x9c) return [s.slice(i, j), j];
        j++;
    }
    return [s.slice(i), j];
}

/** Charset designation body — intermediates then one final byte. */
function scanDesignate(s: string, i: number): [number, number] {
    let j = i;
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
    return j >= s.length ? [-1, j] : [s.charCodeAt(j), j + 1];
}

export function ansiToHtml(input: string): string {
    const st = freshSgr();
    const gset = ["B", "B", "B", "B"];  // G0–G3 charset ids ("0" = DEC graphics)
    let gl = 0, single = -1;            // GL table + pending SS2/SS3 shift
    let link: string | null = null;     // OSC-8 hyperlink target
    let buf = "", out = "";

    const flush = () => {
        if (!buf) return;
        let fg = resolveCol(st.fg, st.bold) ?? (st.bold ? BASE16[15]! : FG);
        let bg = resolveCol(st.bg, false) ?? BG;
        if (st.inverse) { const t = fg; fg = bg; bg = t; }
        if (st.conceal) fg = bg;
        if (st.faint) fg = mix(fg, bg, 0.55);
        if (link && fg === FG) fg = LINK;
        const css: string[] = [];
        if (fg !== FG) css.push(`color:${fg}`);
        if (bg !== BG) css.push(`background:${bg}`);
        if (st.bold) css.push("font-weight:bold");
        if (st.italic) css.push("font-style:italic");
        const deco = [
            st.underline ? "underline" : "", st.strike ? "line-through" : "",
            st.overline ? "overline" : "",
        ].filter(Boolean).join(" ");
        if (deco) {
            const ulc = resolveCol(st.ul, false);
            css.push(`text-decoration:${deco}${st.underline > 1 ? ` ${UL_STYLE[st.underline]}` : ""}${ulc ? ` ${ulc}` : ""}`);
        } else if (link) {
            css.push("text-decoration:underline");
        }
        if (st.framed) css.push("border:1px solid currentColor");
        if (st.subSup) css.push("font-size:82%");
        const linkAttrs = link ? ` data-action="log-url" data-url="${escHtml(link)}"` : "";
        out += css.length || linkAttrs
            ? `<span style="${css.join(";")}"${linkAttrs}>${escHtml(buf)}</span>`
            : escHtml(buf);
        buf = "";
    };

    /** Consume the escape at s[i]==ESC; returns the next index. */
    const escapeSeq = (i: number): number => {
        const e1 = input.charCodeAt(i + 1);
        if (Number.isNaN(e1)) return input.length;
        switch (e1) {
            case 0x5b: {                                    // CSI
                const r = scanCsi(input, i + 2);
                if (!r) return input.length;
                if (r.final === 0x6d) applySgr(st, r.params);
                return r.next;
            }
            case 0x5d: {                                    // OSC
                const [content, next] = scanTerminated(input, i + 2);
                if (content.startsWith("8;")) {             // hyperlink
                    const sep = content.indexOf(";", 2);
                    if (sep >= 0) {
                        const uri = content.slice(sep + 1);
                        link = uri || null;
                    }
                }
                return next;
            }
            case 0x50: case 0x58: case 0x5e: case 0x5f:     // DCS SOS PM APC
                return scanTerminated(input, i + 2)[1];
            case 0x28: case 0x29: case 0x2a: case 0x2b: {   // ( ) * + → G0–G3
                const [ch, next] = scanDesignate(input, i + 2);
                if (ch >= 0) gset[e1 - 0x28] = String.fromCharCode(ch);
                return next;
            }
            case 0x25: case 0x23:                          // %G utf8 / #8 decaln
                return scanDesignate(input, i + 2)[1];
            case 0x6e: gl = 2; return i + 2;               // LS2
            case 0x6f: gl = 3; return i + 2;               // LS3
            case 0x4e: single = 2; return i + 2;           // SS2
            case 0x4f: single = 3; return i + 2;           // SS3
            case 0x63:                                     // RIS — full reset
                resetSgr(st); link = null; gl = 0; single = -1;
                gset[0] = gset[1] = gset[2] = gset[3] = "B";
                return i + 2;
            default:
                return i + 2;                              // single-char ESC — consume
        }
    };

    let i = 0;
    while (i < input.length) {
        const cp = input.codePointAt(i)!;
        if (cp === 0x1b) { flush(); i = escapeSeq(i); continue; }
        if (cp === 0x9b) {                                 // C1 CSI
            flush();
            const r = scanCsi(input, i + 1);
            if (!r) break;
            if (r.final === 0x6d) applySgr(st, r.params);
            i = r.next;
            continue;
        }
        if (cp === 0x9d) {                                 // C1 OSC
            flush();
            i = scanTerminated(input, i + 1)[1];
            continue;
        }
        if (cp === 0x90) {                                 // C1 DCS
            flush();
            i = scanTerminated(input, i + 1)[1];
            continue;
        }
        if (cp === 0x85) { buf += "\n"; i++; continue; }   // NEL
        if (cp < 0x20 || cp === 0x7f) {
            if (cp === 0x0a) buf += "\n";
            else if (cp === 0x09) buf += "\t";
            else if (cp === 0x0d) {                        // \r\n? → \n
                buf += "\n";
                if (input.charCodeAt(i + 1) === 0x0a) i++;
            } else if (cp === 0x0e) gl = 1;                // SO → G1
            else if (cp === 0x0f) gl = 0;                  // SI → G0
            i++;
            continue;
        }
        if (cp >= 0x80 && cp <= 0x9f) { i++; continue; }   // other C1 — drop
        let ch = String.fromCodePoint(cp);
        const cs = single >= 0 ? gset[single]! : gset[gl]!;
        if (single >= 0) single = -1;
        if (cs === "0") {
            if (cp === 0x5f) ch = " ";
            else if (cp >= 0x60 && cp <= 0x7e) ch = DECG[cp - 0x60]!;
        }
        buf += ch;
        i += cp > 0xffff ? 2 : 1;
    }
    flush();
    return out;
}
