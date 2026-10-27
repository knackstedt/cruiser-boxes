import { describe, expect, test } from "bun:test";
import { ansiToHtml } from "../libraries/app-shell/src/ansi";
import { renderRouteParts } from "../libraries/app-shell/src/screens";
import { createCruiserStore } from "../libraries/app-shell/src/store";

const E = "\x1b";

describe("ansiToHtml", () => {
    test("plain text passes through, HTML-escaped", () => {
        expect(ansiToHtml("a<b & \"c\">")).toBe("a&lt;b &amp; &quot;c&quot;&gt;");
        expect(ansiToHtml("line1\nline2")).toBe("line1\nline2");
        expect(ansiToHtml("")).toBe("");
    });

    test("basic SGR color + reset", () => {
        expect(ansiToHtml(`${E}[31merr${E}[0m ok`))
            .toBe('<span style="color:#f08aa8">err</span> ok');
        // unstyled runs emit no span at all
        expect(ansiToHtml(`${E}[32mgreen`)).toBe('<span style="color:#9fd89f">green</span>');
    });

    test("bold brightens base fg colors (both orders)", () => {
        expect(ansiToHtml(`${E}[31;1mx`)).toBe('<span style="color:#ff9ec0;font-weight:bold">x</span>');
        expect(ansiToHtml(`${E}[1;31mx`)).toBe('<span style="color:#ff9ec0;font-weight:bold">x</span>');
        // bright indices (90-97) don't double-brighten
        expect(ansiToHtml(`${E}[1;91mx`)).toBe('<span style="color:#ff9ec0;font-weight:bold">x</span>');
    });

    test("256-palette and truecolor, semicolon + colon forms", () => {
        expect(ansiToHtml(`${E}[38;5;196mx`)).toBe('<span style="color:#ff0000">x</span>');
        expect(ansiToHtml(`${E}[38;2;1;2;3mx`)).toBe('<span style="color:#010203">x</span>');
        expect(ansiToHtml(`${E}[38:2:4:5:6mx`)).toBe('<span style="color:#040506">x</span>');
        expect(ansiToHtml(`${E}[48;5;21mx`)).toBe('<span style="background:#0000ff">x</span>');
        expect(ansiToHtml(`${E}[39;49mplain`)).toBe("plain");
    });

    test("text styles: italic, underline variants, strike, overline", () => {
        expect(ansiToHtml(`${E}[3mx`)).toBe('<span style="font-style:italic">x</span>');
        expect(ansiToHtml(`${E}[4mx`)).toBe('<span style="text-decoration:underline">x</span>');
        expect(ansiToHtml(`${E}[4:2mx`)).toBe('<span style="text-decoration:underline double">x</span>');
        expect(ansiToHtml(`${E}[4:3mx`)).toBe('<span style="text-decoration:underline wavy">x</span>');
        expect(ansiToHtml(`${E}[4:5mx`)).toBe('<span style="text-decoration:underline dashed">x</span>');
        expect(ansiToHtml(`${E}[21mx`)).toBe('<span style="text-decoration:underline double">x</span>');
        expect(ansiToHtml(`${E}[9mx`)).toBe('<span style="text-decoration:line-through">x</span>');
        expect(ansiToHtml(`${E}[53mx`)).toBe('<span style="text-decoration:overline">x</span>');
        expect(ansiToHtml(`${E}[4;9;53mx`))
            .toBe('<span style="text-decoration:underline line-through overline">x</span>');
        // underline color (58)
        expect(ansiToHtml(`${E}[58;2;255;0;0m${E}[4mx`))
            .toBe('<span style="text-decoration:underline #ff0000">x</span>');
    });

    test("inverse swaps fg/bg including defaults", () => {
        expect(ansiToHtml(`${E}[7mx`)).toBe('<span style="color:#0e0e0e;background:#d1d1d1">x</span>');
        expect(ansiToHtml(`${E}[7;31mx`)).toBe('<span style="color:#0e0e0e;background:#f08aa8">x</span>');
        expect(ansiToHtml(`${E}[7mx${E}[27my`))
            .toBe('<span style="color:#0e0e0e;background:#d1d1d1">x</span>y');
    });

    test("conceal paints fg = bg", () => {
        expect(ansiToHtml(`${E}[41;8mx`)).toBe('<span style="color:#f08aa8;background:#f08aa8">x</span>');
    });

    test("non-SGR CSI and stray sequences are dropped", () => {
        expect(ansiToHtml(`${E}[2Afoo${E}[K${E}[?25lbar`)).toBe("foobar");
        expect(ansiToHtml(`${E}]0;window title\x07hi`)).toBe("hi");
        expect(ansiToHtml(`${E}]0;title${E}\\hi`)).toBe("hi");    // ST-terminated OSC
        expect(ansiToHtml(`${E}P1;2|data${E}\\hi`)).toBe("hi");   // DCS
        expect(ansiToHtml(`${E}=${E}>${E}Mhi`)).toBe("hi");       // single-char ESCs
        // private-prefixed params are never SGR
        expect(ansiToHtml(`${E}[>4;1mfoo`)).toBe("foo");
    });

    test("OSC 8 hyperlinks become clickable spans, clear on empty uri", () => {
        const out = ansiToHtml(`${E}]8;;https://example.com${E}\\a page${E}]8;;${E}\\tail`);
        expect(out).toContain('data-action="log-url"');
        expect(out).toContain('data-url="https://example.com"');
        expect(out).toContain("text-decoration:underline");
        expect(out).toContain(">a page</span>");
        expect(out.endsWith("tail")).toBe(true);
        expect(out.lastIndexOf("data-url")).toBeLessThan(out.indexOf("tail"));
        // BEL-terminated too
        expect(ansiToHtml(`${E}]8;;https://x\x07y`)).toContain('data-url="https://x"');
    });

    test("DEC special-graphics charset maps box drawing", () => {
        expect(ansiToHtml(`${E}(0lqk${E}(B`)).toBe("┌─┐");
        // SO shifts into G1 designated as graphics
        expect(ansiToHtml(`${E})0\x0elqk`)).toBe("┌─┐");
    });

    test("\\r\\n? normalize to \\n; C0 controls strip", () => {
        expect(ansiToHtml("a\r\nb\rc")).toBe("a\nb\nc");
        expect(ansiToHtml("a\x07b\x00c\x7fd")).toBe("abcd");
        expect(ansiToHtml("a\tb")).toBe("a\tb");
    });

    test("unterminated trailing sequence is dropped", () => {
        expect(ansiToHtml(`abc${E}[31`)).toBe("abc");
        expect(ansiToHtml(`abc${E}]8;;https://x`)).toBe("abc");
    });

    test("mixed real-world line", () => {
        const s = ansiToHtml(`${E}[32m[  OK  ]${E}[0m Started ${E}[1mnginx${E}[0m.`);
        expect(s).toBe('<span style="color:#9fd89f">[  OK  ]</span> Started '
            + '<span style="color:#f5f5f5;font-weight:bold">nginx</span>.');
    });
});

describe("logs pane integration", () => {
    test("log route renders ANSI into .logpre", () => {
        const store = createCruiserStore();
        store.setState({ route: "logs", selectedVm: "vm-1" });
        store.getState().setLogs({ text: `${E}[31mbad${E}[0m` });
        const parts = renderRouteParts(store.getState());
        expect(parts.log).toContain('<span style="color:#f08aa8">bad</span>');
    });
});
