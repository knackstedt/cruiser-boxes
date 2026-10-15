import { describe, expect, test } from "bun:test";
import { defaultSpec, parseVmSpec } from "../libraries/vm-core/src/config/schema";
import {
    escapeActionLabel, escapesActive, watermarkLines, shortcutsDoc,
    regionLuminance, pickInk, watermarkRect, shellInsets, guestWallpaperScript, renderWallpaper, importJimp,
} from "../libraries/provision/src/wallpaper";

const spec = () => defaultSpec("testvm");

describe("wallpaper spec", () => {
    test("defaults: managed, bottom-right, generated source", () => {
        const w = spec().display.wallpaper;
        expect(w.managed).toBe(true);
        expect(w.position).toBe("bottom-right");
        expect(w.source).toBeUndefined();
    });
    test("parses position + source, rejects bad position", () => {
        const s = parseVmSpec({ name: "ok", display: { wallpaper: { position: "center", source: "/x.png" } } });
        expect(s.display.wallpaper.position).toBe("center");
        expect(s.display.wallpaper.source).toBe("/x.png");
        expect(() => parseVmSpec({ name: "ok", display: { wallpaper: { position: "middle" } } })).toThrow();
    });
});

describe("watermark text", () => {
    test("escapeActionLabel maps spec actions", () => {
        expect(escapeActionLabel("host-desktop:2")).toBe("jump to host desktop 2");
        expect(escapeActionLabel("desktop-cycle-left")).toBe("cycle host desktops left");
        expect(escapeActionLabel("ungrab")).toBe("release viewer grab");
        expect(escapeActionLabel("command:{cli} vm kill {vm}", "testvm")).toBe("run: cruiser vm kill testvm");
        expect(escapeActionLabel("weird")).toBe("weird");
    });
    test("escapesActive gates on head mode + grab", () => {
        const s = spec();
        s.display.headMode = "windowed";
        expect(escapesActive(s)).toBe(false);
        s.display.headMode = "virtual-desktop";
        expect(escapesActive(s)).toBe(true);
        s.display.grabKeyboard = true;
        expect(escapesActive(s)).toBe(false);
    });
    test("watermarkLines carry the vm name, escape hint, and kill hint", () => {
        const s = spec();
        const l = watermarkLines(s).map((x) => x.text);
        expect(l[0]).toContain("testvm");
        expect(l.join(" ")).toContain("ctrl+alt+delete");
        expect(l.join(" ")).toContain("cruiser vm kill testvm");
        expect(l.join(" ")).toMatch(/^[\x20-\x7e]+$/); // bitmap fonts are ASCII-only
    });
    test("windowed head mode swaps the escape hint for the fullscreen hint", () => {
        const s = spec();
        s.display.headMode = "windowed";
        expect(watermarkLines(s).map((x) => x.text).join(" ")).toContain("ctrl+alt+enter");
    });
    test("shortcutsDoc lists keys, kill command, and TTY fallback", () => {
        const d = shortcutsDoc(spec(), true);
        expect(d).toContain("ctrl+alt+delete");
        expect(d).toContain("cruiser vm kill testvm");
        expect(d).toContain("ctrl+alt+F3");
    });
    test("shortcutsDoc admits when the host WM can't bind shortcuts", () => {
        const d = shortcutsDoc(spec(), false);
        expect(d).toContain("no keybinding API");
        expect(d).not.toContain("ctrl+alt+delete");
        expect(d).toContain("cruiser vm kill testvm");
    });
});

describe("luminance", () => {
    const bmp = (fill: number, w = 100, h = 100) => ({
        data: Buffer.alloc(w * h * 4, fill), width: w, height: h,
    });
    test("black/white regions read as expected", () => {
        expect(regionLuminance(bmp(0), { x: 0, y: 0, w: 100, h: 100 })).toBe(0);
        expect(regionLuminance(bmp(255), { x: 0, y: 0, w: 100, h: 100 })).toBe(255);
    });
    test("only samples inside the rect", () => {
        const b = bmp(0); // black canvas, white 10px square at 0,0
        for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++)
            for (let c = 0; c < 3; c++) b.data[(y * 100 + x) * 4 + c] = 255;
        expect(regionLuminance(b, { x: 0, y: 0, w: 10, h: 10 })).toBe(255);
        expect(regionLuminance(b, { x: 50, y: 50, w: 40, h: 40 })).toBe(0);
    });
    test("clamps out-of-bounds rects", () => {
        expect(regionLuminance(bmp(255), { x: 90, y: 90, w: 500, h: 500 })).toBe(255);
    });
    test("pickInk: bright bg -> dark ink, dark bg -> light ink", () => {
        expect(pickInk(250)).toBe("dark");
        expect(pickInk(10)).toBe("light");
        expect(pickInk(128)).toBe("light"); // mid-gray favors readable light text
    });
    test("watermarkRect honors each position", () => {
        const r = (p: Parameters<typeof watermarkRect>[4]) => watermarkRect(1000, 800, 200, 100, p, 20);
        expect(r("top-left")).toEqual({ x: 20, y: 20, w: 200, h: 100 });
        expect(r("top-right")).toEqual({ x: 780, y: 20, w: 200, h: 100 });
        expect(r("bottom-left")).toEqual({ x: 20, y: 680, w: 200, h: 100 });
        expect(r("bottom-right")).toEqual({ x: 780, y: 680, w: 200, h: 100 });
        expect(r("center")).toEqual({ x: 400, y: 350, w: 200, h: 100 });
    });
    test("watermarkRect adds edge insets on the matching side", () => {
        const inset = { top: 30, bottom: 60 };
        const r = (p: Parameters<typeof watermarkRect>[4]) => watermarkRect(1000, 800, 200, 100, p, 20, inset);
        expect(r("top-left")).toEqual({ x: 20, y: 50, w: 200, h: 100 });
        expect(r("top-right")).toEqual({ x: 780, y: 50, w: 200, h: 100 });
        expect(r("bottom-left")).toEqual({ x: 20, y: 620, w: 200, h: 100 });
        expect(r("bottom-right")).toEqual({ x: 780, y: 620, w: 200, h: 100 });
        expect(r("center")).toEqual({ x: 400, y: 350, w: 200, h: 100 });
    });
    test("shellInsets: kde reserves the bottom panel, gnome the top bar", () => {
        const s = spec();
        s.os.desktop = "kde";
        expect(shellInsets(s, 1080)).toEqual({ top: 0, bottom: 54 });
        s.os.desktop = "gnome";
        expect(shellInsets(s, 1080)).toEqual({ top: 32, bottom: 0 });
    });
});

describe("guestWallpaperScript", () => {
    test("installs file, shortcuts doc, and both DE apply paths", () => {
        const sh = guestWallpaperScript(spec());
        expect(sh).toContain(".local/share/cruiser");
        expect(sh).toContain("VM Shortcuts.md");
        expect(sh).toContain("xdg-user-dir DESKTOP");
        expect(sh).toContain("plasma-apply-wallpaperimage");
        expect(sh).toContain("org.kde.PlasmaShell.evaluateScript");
        expect(sh).toContain("gsettings set org.gnome.desktop.background picture-uri");
        expect(sh).toContain("CRUISER_WP_OK");
        expect(sh).toContain("CRUISER_WP_STAGED");
        expect(sh).toContain("cruiser vm kill testvm");
    });
    test("plasma is tried before gsettings when both exist", () => {
        const sh = guestWallpaperScript(spec());
        expect(sh.indexOf("plasma-apply-wallpaperimage")).toBeLessThan(sh.indexOf("picture-uri"));
    });
});

describe("renderWallpaper", () => {
    test("generated default renders a PNG", async () => {
        const buf = await renderWallpaper(spec());
        expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }, 30_000);
    test("mismatched target cover-crops (jimp v1 options object, not positional)", async () => {
        const { Jimp } = await importJimp();
        const out = await Jimp.read(await renderWallpaper(spec(), null, { w: 1280, h: 720 }));
        expect(out.bitmap.width).toBe(1280);
        expect(out.bitmap.height).toBe(720);
    }, 30_000);
    test("position off skips the watermark but still renders", async () => {
        const s = spec();
        s.display.wallpaper.position = "off";
        const buf = await renderWallpaper(s);
        expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }, 30_000);
    test("light source image gets dark watermark ink", async () => {
        const { Jimp, JimpMime } = await importJimp();
        const src = new Jimp({ width: 800, height: 600, color: 0xf0f0f0ff });
        const tmp = `/var/tmp/cruiser-test-wp-${process.pid}.png`;
        await (await import("node:fs/promises")).writeFile(tmp, await src.getBuffer(JimpMime.png));
        const s = spec();
        s.display.wallpaper.source = tmp;
        const out = await Jimp.read(await renderWallpaper(s));
        // the bottom-right watermark block must contain darkened pixels —
        // black ink at 0.62 alpha over the 240-gray bg lands ~85-95; a
        // wrongly-picked white ink would leave the region at ~240.
        const reg = { x: 600, y: 400, w: 190, h: 190 };
        let min = 255;
        for (let y = reg.y; y < reg.y + reg.h; y += 2)
            for (let x = reg.x; x < reg.x + reg.w; x += 2) {
                const i = (y * 800 + x) * 4;
                min = Math.min(min, out.bitmap.data[i]!);
            }
        expect(min).toBeLessThan(140);
    }, 30_000);
});
