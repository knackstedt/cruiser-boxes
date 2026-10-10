// ============================================================================
// appearance.ts — host dark/light hint via the xdg-desktop-portal Settings
// interface (org.freedesktop.appearance color-scheme: 0 = no preference,
// 1 = dark, 2 = light). DE-agnostic: GNOME and KDE hosts both feed the same
// key, so no per-adapter probing is needed.
// ============================================================================

import type { ChildProcess } from "node:child_process";
import { run, spawnChild, which } from "../../sys/src/exec";

export type ColorScheme = "dark" | "light";

/** Last uint in a variant dump — busctl prints `v v u 1`, gdbus `(<<uint32
 *  1>>,)`. 0 ("no preference") and anything unexpected map to null. */
function parseScheme(out: string): ColorScheme | null {
    const m = [...out.matchAll(/\b(?:uint32|u)\s+(\d+)/g)];
    const v = m.length ? Number(m[m.length - 1]![1]) : 0;
    return v === 1 ? "dark" : v === 2 ? "light" : null;
}

/** Current host preference; null for "no preference" or no reachable portal. */
export async function hostColorScheme(): Promise<ColorScheme | null> {
    const dest = "org.freedesktop.portal.Desktop";
    const path = "/org/freedesktop/portal/desktop";
    if (await which("busctl")) {
        const r = await run("busctl", ["--user", "call", dest, path,
            "org.freedesktop.portal.Settings", "Read", "ss",
            "org.freedesktop.appearance", "color-scheme"], { noThrow: true, timeoutMs: 5_000 });
        if (r.code === 0) return parseScheme(r.stdout);
    }
    if (await which("gdbus")) {
        const r = await run("gdbus", ["call", "--session", "--dest", dest,
            "--object-path", path, "--method", "org.freedesktop.portal.Settings.Read",
            "org.freedesktop.appearance", "color-scheme"], { noThrow: true, timeoutMs: 5_000 });
        if (r.code === 0) return parseScheme(r.stdout);
    }
    return null;
}

/**
 * Subscribe to portal SettingChanged; onChanged fires (debounced) each time
 * org.freedesktop.appearance/color-scheme is touched. Callers re-read the
 * value rather than trusting signal-body parsing. Returns an unsubscribe —
 * kills the dbus-monitor child.
 */
export function watchHostColorScheme(onChanged: () => void): () => void {
    const child: ChildProcess = spawnChild("dbus-monitor", [
        "--session", "type='signal',interface='org.freedesktop.portal.Settings'",
    ], { stdio: "pipe" });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
        if (timer) return;
        timer = setTimeout(() => { timer = null; onChanged(); }, 150);
    };
    // Signal body is (string namespace, string key, variant value) — scope
    // the match to SettingChanged signals, fire once both strings are seen.
    let buf = "", inSignal = false, sawNs = false, sawKey = false;
    child.stdout?.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (line.startsWith("signal")) {
                inSignal = line.includes("member=SettingChanged");
                sawNs = sawKey = false;
                continue;
            }
            if (!inSignal) continue;
            if (line.includes('"org.freedesktop.appearance"')) sawNs = true;
            if (line.includes('"color-scheme"')) sawKey = true;
            if (sawNs && sawKey) { fire(); sawNs = sawKey = false; }
        }
    });
    child.on("error", () => {}); // no dbus-monitor → read-only mode, no watch
    return () => { if (timer) clearTimeout(timer); child.kill("SIGTERM"); };
}
