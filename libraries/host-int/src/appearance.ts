// ============================================================================
// appearance.ts — host appearance hints via the xdg-desktop-portal Settings
// interface (org.freedesktop.appearance):
//   color-scheme  uint  0 = no preference, 1 = dark, 2 = light
//   accent-color  (d,d,d) srgb triple   (portal ≥ ~1.20; absent elsewhere)
//   contrast      uint  0 = normal, 1 = high (newer portals only)
// DE-agnostic: GNOME and KDE hosts both feed the same namespace, so no
// per-adapter probing is needed. Missing keys portably read as errors —
// each probe returns null and the caller's channel just no-ops.
// ============================================================================

import type { ChildProcess } from "node:child_process";
import { run, spawnChild, which } from "../../sys/src/exec";

export type ColorScheme = "dark" | "light";

/** Raw portal Settings.Read for one key; null on error or no portal. */
async function readPortal(ns: string, key: string): Promise<string | null> {
    const dest = "org.freedesktop.portal.Desktop";
    const path = "/org/freedesktop/portal/desktop";
    if (await which("busctl")) {
        const r = await run("busctl", ["--user", "call", dest, path,
            "org.freedesktop.portal.Settings", "Read", "ss", ns, key],
            { noThrow: true, timeoutMs: 5_000 });
        if (r.code === 0) return r.stdout;
    }
    if (await which("gdbus")) {
        const r = await run("gdbus", ["call", "--session", "--dest", dest,
            "--object-path", path, "--method", "org.freedesktop.portal.Settings.Read",
            ns, key], { noThrow: true, timeoutMs: 5_000 });
        if (r.code === 0) return r.stdout;
    }
    return null;
}

/** Last uint in a variant dump — busctl prints `v v u 1`, gdbus `(<<uint32
 *  1>>,)`. 0 ("no preference") and anything unexpected map to null. */
function parseScheme(out: string): ColorScheme | null {
    const m = [...out.matchAll(/\b(?:uint32|u)\s+(\d+)/g)];
    const v = m.length ? Number(m[m.length - 1]![1]) : 0;
    return v === 1 ? "dark" : v === 2 ? "light" : null;
}

/** Current host preference; null for "no preference" or no reachable portal. */
export async function hostColorScheme(): Promise<ColorScheme | null> {
    const out = await readPortal("org.freedesktop.appearance", "color-scheme");
    return out ? parseScheme(out) : null;
}

/**
 * Host accent color as an sRGB triple (0..1 channels). The portal key is a
 * (ddd) struct — busctl prints `v v ddd 0.2 0.4 0.6`; gdbus a nested tuple.
 * Older portals lack the key entirely → null.
 */
export async function hostAccentColor(): Promise<{ r: number; g: number; b: number } | null> {
    const out = await readPortal("org.freedesktop.appearance", "accent-color");
    if (!out) return null;
    const nums = [...out.matchAll(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi)].map((m) => Number(m[0]));
    // The variant wraps the struct — channel values are the LAST three reals.
    const [r, g, b] = nums.slice(-3);
    if (r === undefined || g === undefined || b === undefined) return null;
    if (r < 0 || r > 1 || g < 0 || g > 1 || b < 0 || b > 1) return null;
    return { r, g, b };
}

/** Host high-contrast preference; null when the portal lacks the key. */
export async function hostContrast(): Promise<boolean | null> {
    const out = await readPortal("org.freedesktop.appearance", "contrast");
    if (!out) return null;
    const m = [...out.matchAll(/\b(?:uint32|u)\s+(\d+)/g)];
    const v = m.length ? Number(m[m.length - 1]![1]) : 0;
    return v === 1 ? true : v === 0 ? false : null;
}

/**
 * Subscribe to portal SettingChanged; onChanged fires (debounced) each time
 * a key under org.freedesktop.appearance is touched. Callers re-read values
 * rather than trusting signal-body parsing. Returns an unsubscribe — kills
 * the dbus-monitor child.
 */
export function watchPortalSettings(onChanged: () => void): () => void {
    const child: ChildProcess = spawnChild("dbus-monitor", [
        "--session", "type='signal',interface='org.freedesktop.portal.Settings'",
    ], { stdio: "pipe" });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
        if (timer) return;
        timer = setTimeout(() => { timer = null; onChanged(); }, 150);
    };
    // Signal body is (string namespace, string key, variant value) — scope
    // the match to SettingChanged signals, fire once the namespace is seen.
    let buf = "", inSignal = false;
    child.stdout?.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (line.startsWith("signal")) {
                inSignal = line.includes("member=SettingChanged");
                continue;
            }
            if (inSignal && line.includes('"org.freedesktop.appearance"')) { fire(); inSignal = false; }
        }
    });
    child.on("error", () => {}); // no dbus-monitor → read-only mode, no watch
    return () => { if (timer) clearTimeout(timer); child.kill("SIGTERM"); };
}
