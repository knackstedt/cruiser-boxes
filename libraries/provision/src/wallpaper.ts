// ============================================================================
// wallpaper.ts — cruiser-managed guest wallpaper.
//
// Host-side composite (jimp, pure JS — lazy-imported off the startup path):
// the user image or a generated gradient, watermarked with the VM name, the
// spec's live escape shortcuts, and a kill hint. Region luminance under the
// watermark decides light-vs-dark ink. Push: PNG via QGA guest-file-write
// (scp fallback for SELinux-confined agents), per-DE apply via a
// command -v-gated script in the guestThemeScript mold — plus a
// "~/Desktop/VM Shortcuts.md" cheat sheet written from the same script.
//
// ensureGuestWallpaper is the session-start sync (wired next to ThemeSync):
// it re-pushes only when inputs changed or a previous apply never reached a
// live desktop — an in-guest wallpaper change is never clobbered.
// ============================================================================

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { guestRun } from "../../vm-core/src/logs";

/** CRUISER_WALLPAPER=0 disables both the render and the push. */
export function wallpaperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.CRUISER_WALLPAPER !== "0";
}

export type WatermarkPos = VmSpec["display"]["wallpaper"]["position"];

const GUEST_STAGE = "/tmp/cruiser-wallpaper.png";
const sq = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;

/**
 * Host escape shortcuts are only bound while the viewer is up AND the head
 * mode isn't windowed AND the guest doesn't hold the keyboard grab — the
 * watermark/shortcuts doc mirrors that so it doesn't promise keys that
 * aren't installed. (Adapter shortcut caps are the one factor we can't see
 * from here — treated as capable.)
 */
export function escapesActive(spec: VmSpec): boolean {
    return spec.display.headMode !== "windowed" && !spec.display.grabKeyboard;
}

export function escapeActionLabel(action: string): string {
    const [kind, arg] = action.split(":", 2);
    switch (kind) {
        case "host-desktop": return `jump to host desktop ${arg ?? 1}`;
        case "desktop-cycle-left": return "cycle host desktops left";
        case "desktop-cycle-right": return "cycle host desktops right";
        case "ungrab": return "release viewer grab";
        case "none": return "no action";
        default: return action;
    }
}

/** Watermark text — ASCII only (jimp bitmap fonts carry no unicode). */
export function watermarkLines(spec: VmSpec): { text: string; kind: "title" | "detail" }[] {
    const lines: { text: string; kind: "title" | "detail" }[] = [
        { text: `cruiser :: ${spec.name}`, kind: "title" },
    ];
    if (escapesActive(spec)) {
        for (const s of spec.display.escapeShortcuts.slice(0, 2))
            lines.push({ text: `${s.keys} -> ${escapeActionLabel(s.action)}`, kind: "detail" });
    } else {
        lines.push({ text: "ctrl+alt+enter toggles viewer fullscreen", kind: "detail" });
    }
    lines.push({ text: `stuck? host shell: cruiser vm kill ${spec.name}`, kind: "detail" });
    return lines;
}

/** The "~/Desktop/VM Shortcuts.md" cheat sheet — UTF-8, full detail. */
export function shortcutsDoc(spec: VmSpec): string {
    const n = spec.name;
    const esc = escapesActive(spec)
        ? spec.display.escapeShortcuts.map((s) => `- \`${s.keys}\` — ${escapeActionLabel(s.action)}`).join("\n") ||
          "(none configured in `display.escapeShortcuts`)"
        : `None — this VM's head mode is \`${spec.display.headMode}\`${spec.display.grabKeyboard ? " with keyboard grab on" : ""}, so no host bindings are installed.`;
    return `# Cruiser VM shortcuts — ${n}

This desktop is streamed by the freerdp viewer (\`cruiser:${n}\`). Keep this
file — it's every way out if the guest looks stuck.

## Host escape shortcuts (while the viewer window is focused)

${esc}

These are bound on the host WM for the viewer session's lifetime, not inside
the guest — they only fire while the cruiser viewer is up.

## Viewer (xfreerdp) keys

- \`ctrl+alt+enter\` — toggle fullscreen
- closing the viewer window ends the session (the VM keeps running)

## From a host terminal

- \`cruiser vm view ${n}\` — reopen the viewer
- \`cruiser vm stop ${n}\` — graceful shutdown (ACPI)
- \`cruiser vm kill ${n}\` — force-kill the VM immediately
- \`cruiser vm logs ${n}\` — QEMU + provisioning log
- \`cruiser vm logs ${n} --journal\` — the guest's own system log

## If everything is hung

Switch to a host TTY (\`ctrl+alt+F3\`), log in, and run
\`cruiser vm kill ${n}\`. Switch back with \`ctrl+alt+F1\`/\`F2\`.
`;
}

// ── luminance ──

export interface BitmapLike {
    data: Uint8Array | Buffer;
    width: number;
    height: number;
}
export interface Rect { x: number; y: number; w: number; h: number }

/** Strided mean luminance (0–255, Rec. 601) over a rect — samples a few
 *  thousand pixels at most, so it's microseconds even on 4K bitmaps. */
export function regionLuminance(bmp: BitmapLike, rect: Rect, maxSamples = 4096): number {
    const x0 = Math.max(0, Math.min(bmp.width - 1, rect.x | 0));
    const y0 = Math.max(0, Math.min(bmp.height - 1, rect.y | 0));
    const x1 = Math.max(x0 + 1, Math.min(bmp.width, Math.ceil(rect.x + rect.w)));
    const y1 = Math.max(y0 + 1, Math.min(bmp.height, Math.ceil(rect.y + rect.h)));
    const stride = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / maxSamples)));
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y += stride) {
        for (let x = x0; x < x1; x += stride) {
            const i = (y * bmp.width + x) * 4;
            sum += 0.299 * bmp.data[i]! + 0.587 * bmp.data[i + 1]! + 0.114 * bmp.data[i + 2]!;
            n++;
        }
    }
    return n ? sum / n : 128;
}

/** Bright region → dark ink; dark region → light ink. Threshold sits above
 *  mid-gray so middling wallpapers favor the more readable light text. */
export function pickInk(luma: number): "light" | "dark" {
    return luma >= 140 ? "dark" : "light";
}

export function watermarkRect(imgW: number, imgH: number, w: number, h: number, position: WatermarkPos, margin: number): Rect {
    switch (position) {
        case "top-left": return { x: margin, y: margin, w, h };
        case "top-right": return { x: imgW - w - margin, y: margin, w, h };
        case "bottom-left": return { x: margin, y: imgH - h - margin, w, h };
        case "center": return { x: (imgW - w) >> 1, y: (imgH - h) >> 1, w, h };
        case "off":
        case "bottom-right":
        default: return { x: imgW - w - margin, y: imgH - h - margin, w, h };
    }
}

// ── host-side render ──

/** Composite the wallpaper: user source (or a generated gradient) plus the
 *  watermark. jimp is lazy-imported — it's pure JS but ~1MB of module graph
 *  we don't want on the startup path. Decode+print is a few hundred ms
 *  worst-case; callers run this fire-and-forget, never on a blocking path. */
/**
 * jimp's `isWebWorker` (`self` defined && !self.document, captured at module
 * eval) misfires under Bun — `self` exists on the main thread — so loadFont
 * takes a fetch() path with a filesystem path. Shadow `self` for the import
 * only; Node never defines it, so this is a bun-only shim. Exported so tests
 * take the same import path (an earlier unshimmed import would poison the
 * module cache).
 */
export async function importJimp() {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "self");
    delete (globalThis as Record<string, unknown>).self;
    try {
        const [j, f] = await Promise.all([import("jimp"), import("jimp/fonts")]);
        return { ...j, F: f };
    } finally {
        if (desc) Object.defineProperty(globalThis, "self", desc);
    }
}

export async function renderWallpaper(spec: VmSpec): Promise<Buffer> {
    const { Jimp, loadFont, measureText, measureTextHeight, JimpMime, F } = await importJimp();

    const w = spec.display.wallpaper;
    // jimp's read() and constructor return nominally-different generic
    // instantiations of the same class — `any` sidesteps the mismatch.
    let img: any = w.source ? await Jimp.read(w.source).catch(() => null) : null;
    if (!img) img = defaultBackdrop(Jimp);

    if (w.position !== "off") {
        const W = img.bitmap.width, H = img.bitmap.height;
        const big = W >= 3000;
        const lines = watermarkLines(spec);
        const margin = Math.max(16, Math.round(Math.min(W, H) * 0.035));
        const pad = big ? 20 : 12;
        const gap = big ? 12 : 6;

        // Metrics are identical across ink colors — measure with one set,
        // then sample the real block region and pick the ink from it.
        const [mTitle, mDetail] = await Promise.all([
            loadFont(big ? F.SANS_64_WHITE : F.SANS_32_WHITE),
            loadFont(big ? F.SANS_32_WHITE : F.SANS_16_WHITE),
        ]);
        let blockW = 0, blockH = 0;
        for (let i = 0; i < lines.length; i++) {
            const f = lines[i]!.kind === "title" ? mTitle : mDetail;
            blockW = Math.max(blockW, measureText(f, lines[i]!.text));
            blockH += measureTextHeight(f, lines[i]!.text, W);
        }
        blockH += gap * (lines.length - 1);
        const rect = watermarkRect(W, H, blockW + pad * 2, blockH + pad * 2, w.position, margin);
        const ink = pickInk(regionLuminance(img.bitmap, rect));
        const fname = (sz: 16 | 32 | 64, white: boolean) =>
            F[`SANS_${sz}_${white ? "WHITE" : "BLACK"}` as keyof typeof F];
        const [titleFont, detailFont, shadowTitle, shadowDetail] = await Promise.all([
            loadFont(fname(big ? 64 : 32, ink === "light")),
            loadFont(fname(big ? 32 : 16, ink === "light")),
            loadFont(fname(big ? 64 : 32, ink !== "light")),
            loadFont(fname(big ? 32 : 16, ink !== "light")),
        ]);

        const lw = rect.w, lh = rect.h;
        const layer = new Jimp({ width: lw, height: lh, color: 0x00000000 });
        const shadow = new Jimp({ width: lw + 2, height: lh + 2, color: 0x00000000 });
        let y = pad;
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i]!;
            const font = l.kind === "title" ? titleFont : detailFont;
            const sh = l.kind === "title" ? shadowTitle : shadowDetail;
            layer.print({ font, x: pad, y, text: l.text });
            shadow.print({ font: sh, x: pad, y, text: l.text });
            y += measureTextHeight(font, l.text, W) + gap;
        }
        shadow.opacity(0.35);
        layer.opacity(0.62);
        img.composite(shadow, rect.x + 1, rect.y + 1);
        img.composite(layer, rect.x, rect.y);
    }
    return img.getBuffer(JimpMime.png);
}

/** Generated default: diagonal navy→charcoal gradient with a soft vignette. */
function defaultBackdrop(Jimp: any) {
    const W = 2560, H = 1440;
    const img = new Jimp({ width: W, height: H, color: 0x000000ff });
    const c0 = [0x27, 0x38, 0x55], c1 = [0x0a, 0x0d, 0x14];
    img.scan((x: number, y: number, idx: number) => {
        const t = (x / W) * 0.35 + (y / H) * 0.65;
        const dx = x / W - 0.5, dy = y / H - 0.5;
        const vig = 1 - Math.min(0.35, (dx * dx + dy * dy) * 0.9);
        img.bitmap.data[idx] = Math.round((c0[0]! + (c1[0]! - c0[0]!) * t) * vig);
        img.bitmap.data[idx + 1] = Math.round((c0[1]! + (c1[1]! - c0[1]!) * t) * vig);
        img.bitmap.data[idx + 2] = Math.round((c0[2]! + (c1[2]! - c0[2]!) * t) * vig);
    });
    return img;
}

// ── guest side ──

/**
 * Install script — runs via guestRun as root; user-context steps are
 * `runuser`'d. Plasma tools present → plasma only (gsettings would happily
 * "succeed" writing dconf on a KDE system while never touching the real
 * wallpaper); no plasma → gsettings with the dbus-run-session pre-login
 * fallback, same as guestThemeScript. Exits 0 even when no DE applied —
 * CRUISER_WP_STAGED means "file installed, retry when a session exists".
 */
export function guestWallpaperScript(spec: VmSpec): string {
    const doc = shortcutsDoc(spec);
    return `set -u
U=${sq(spec.credentials.username)}
UHOME=$(getent passwd "$U" | cut -d: -f6)
UUID=$(id -u "$U")
WPDIR="$UHOME/.local/share/cruiser"
mkdir -p "$WPDIR" || exit 1
if [ -f ${GUEST_STAGE} ]; then
    cp ${GUEST_STAGE} "$WPDIR/wallpaper.png" && rm -f ${GUEST_STAGE}
fi
[ -f "$WPDIR/wallpaper.png" ] || { echo "no wallpaper staged"; exit 1; }
chown -R "$U":"$U" "$WPDIR" 2>/dev/null || true
WPURI="file://$WPDIR/wallpaper.png"

# shortcuts cheat sheet on the user's XDG desktop
DESKTOP=$(runuser -u "$U" -- xdg-user-dir DESKTOP 2>/dev/null) || DESKTOP=
[ -n "$DESKTOP" ] || DESKTOP="$UHOME/Desktop"
mkdir -p "$DESKTOP" 2>/dev/null || true
cat > "$DESKTOP/VM Shortcuts.md" <<'CRUISER_DOC'
${doc}
CRUISER_DOC
chown "$U":"$U" "$DESKTOP/VM Shortcuts.md" 2>/dev/null || true

RUNU() { runuser -u "$U" -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus XDG_RUNTIME_DIR=/run/user/"$UUID" "$@"; }
applied=
if command -v plasma-apply-wallpaperimage >/dev/null 2>&1 || command -v plasmashell >/dev/null 2>&1; then
    if RUNU plasma-apply-wallpaperimage "$WPDIR/wallpaper.png" 2>/dev/null; then
        applied=1
    else
        QDBUS=
        for q in qdbus6 qdbus-qt6 qdbus qdbus-qt5; do
            if command -v "$q" >/dev/null 2>&1; then QDBUS=$q; break; fi
        done
        if [ -n "$QDBUS" ] && RUNU "$QDBUS" org.kde.plasmashell /PlasmaShell org.kde.PlasmaShell.evaluateScript '
var ds = desktops();
for (var i = 0; i < ds.length; i++) {
    ds[i].wallpaperPlugin = "org.kde.image";
    ds[i].currentConfigGroup = ["Wallpaper", "org.kde.image", "General"];
    ds[i].writeConfig("Image", "file://'$WPDIR'/wallpaper.png");
}' 2>/dev/null; then
            applied=1
        fi
    fi
elif command -v gsettings >/dev/null 2>&1; then
    if RUNU gsettings set org.gnome.desktop.background picture-uri "$WPURI" 2>/dev/null; then
        RUNU gsettings set org.gnome.desktop.background picture-uri-dark "$WPURI" 2>/dev/null || true
        RUNU gsettings set org.gnome.desktop.background picture-options zoom 2>/dev/null || true
        applied=1
    elif runuser -u "$U" -- dbus-run-session -- sh -c "gsettings set org.gnome.desktop.background picture-uri '$WPURI'; gsettings set org.gnome.desktop.background picture-uri-dark '$WPURI'; gsettings set org.gnome.desktop.background picture-options zoom" 2>/dev/null; then
        applied=1
    fi
fi
if [ -n "$applied" ]; then echo CRUISER_WP_OK; else echo CRUISER_WP_STAGED; fi
`;
}

/** Push the PNG into the guest: QGA guest-file-write first (writes to /tmp —
 *  allowed even under most policy), scp via the seeded key as the confined-
 *  agent fallback. */
async function stageToGuest(h: VmHandle, png: Buffer): Promise<void> {
    try {
        await h.withQga((g) => g.writeFile(GUEST_STAGE, png), 30_000);
        return;
    } catch { /* agent down or confined — try ssh */ }
    const port = h.spec.network.sshPort;
    if (!port) throw new Error("can't stage wallpaper: guest-file-write failed and no SSH hostfwd is mapped");
    const { ensureKeypair } = await import("../../vm-core/src/sshkey");
    const { priv } = await ensureKeypair();
    const { run } = await import("../../sys/src/exec");
    const tmp = join(h.paths.run, "wallpaper.push.png");
    await writeFile(tmp, png);
    const r = await run("scp", [
        "-i", priv, "-P", String(port),
        "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=15",
        tmp, `${h.spec.credentials.username}@127.0.0.1:${GUEST_STAGE}`,
    ], { noThrow: true, timeoutMs: 60_000 });
    if (r.code !== 0)
        throw new Error(`wallpaper staging failed via qga and scp: ${r.stderr.slice(-300)}`);
}

/** Inputs that make the pushed wallpaper stale — hashed into run/wallpaper.state. */
async function wallpaperHash(h: VmHandle): Promise<string> {
    const w = h.spec.display.wallpaper;
    let srcMeta = "";
    if (w.source) {
        const st = await stat(w.source).catch(() => null);
        srcMeta = st ? `${st.mtimeMs}:${st.size}` : "missing";
    }
    const payload = JSON.stringify({
        v: 1, name: h.spec.name, position: w.position,
        source: w.source ?? "", srcMeta, doc: shortcutsDoc(h.spec),
    });
    return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export type WallpaperSyncResult = "off" | "skipped" | "applied" | "staged";

/**
 * Render + push + apply, idempotently. Skips when the last apply was
 * `applied` and no inputs changed — an in-guest wallpaper change is then
 * never clobbered. A `staged` previous run (no live desktop session yet,
 * e.g. pre-login provision on KDE) retries on the next call. force bypasses
 * the skip. Never throws for a disabled config — only for real failures.
 */
export async function ensureGuestWallpaper(
    h: VmHandle, log?: (msg: string) => void, opts: { force?: boolean } = {},
): Promise<WallpaperSyncResult> {
    const w = h.spec.display.wallpaper;
    if (!w.managed || !wallpaperEnabled()) return "off";
    const hash = await wallpaperHash(h);
    const statePath = join(h.paths.run, "wallpaper.state");
    const [prevHash, prevStatus] = (await readFile(statePath, "utf-8").catch(() => "")).trim().split(" ");
    if (!opts.force && prevHash === hash && prevStatus === "applied") return "skipped";

    const png = await renderWallpaper(h.spec);
    await mkdir(h.paths.run, { recursive: true });
    await writeFile(join(h.paths.run, "wallpaper.png"), png); // host copy — preview/debug
    await stageToGuest(h, png);
    const r = await guestRun(h, ["/bin/sh", "-c", guestWallpaperScript(h.spec)], 30_000);
    if (r.code !== 0)
        throw new Error(`wallpaper script exited ${r.code} via ${r.transport}: ${(r.stderr || r.stdout).slice(-400)}`);
    const applied = r.stdout.includes("CRUISER_WP_OK");
    await writeFile(statePath, `${hash} ${applied ? "applied" : "staged"}\n`);
    log?.(applied ? `wallpaper applied via ${r.transport}` : "wallpaper staged (no live guest desktop yet — retrying at next session)");
    return applied ? "applied" : "staged";
}
