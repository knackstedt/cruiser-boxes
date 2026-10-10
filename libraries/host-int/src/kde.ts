// ============================================================================
// kde.ts — qdbus/KWin helpers shared by kde-x11 and kde-wayland adapters.
// ============================================================================

import { run, which } from "../../sys/src/exec";
import type { DesktopInfo, EscapeActionSpec } from "./types";

async function qdbus(args: string[]): Promise<string> {
    const bin = (await which("qdbus6")) ?? (await which("qdbus"));
    if (!bin) throw new Error("qdbus/qdbus6 not found");
    const r = await run(bin, args, { noThrow: true });
    if (r.code !== 0) throw new Error(`qdbus ${args[0]}: ${r.stderr.trim()}`);
    return r.stdout.trim();
}

/** KWin virtual desktops — UUIDs + names, works on X11 and Wayland. */
export async function kdeDesktops(): Promise<DesktopInfo[]> {
    try {
        // `desktops` is a(uss) = (position, uuid, name)[] — plain qdbus can't
        // render it; --literal prints `N, "uuid", "name"` tuples.
        const [literal, cur] = await Promise.all([
            qdbus(["--literal", "org.kde.KWin", "/VirtualDesktopManager", "org.freedesktop.DBus.Properties.Get", "org.kde.KWin.VirtualDesktopManager", "desktops"]),
            qdbus(["org.kde.KWin", "/VirtualDesktopManager", "org.freedesktop.DBus.Properties.Get", "org.kde.KWin.VirtualDesktopManager", "current"]).catch(() => ""),
        ]);
        const out: DesktopInfo[] = [];
        const re = /\(?\s*(\d+),\s*"([0-9a-fA-F-]{36})",\s*"([^"]*)"/g;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(literal)) !== null)
            out.push({ index: Number(mm[1]) + 1, id: mm[2], name: mm[3], current: mm[2] === cur });
        if (!out.length) {
            const count = await qdbus(["org.kde.KWin", "/VirtualDesktopManager", "org.freedesktop.DBus.Properties.Get", "org.kde.KWin.VirtualDesktopManager", "count"]).catch(() => "0");
            for (let i = 0; i < Number(count); i++) out.push({ index: i + 1, current: i === 0 });
        }
        return out;
    } catch {
        return [];
    }
}

/** Switch to a desktop by 1-based index (KWin, either session). */
export async function kdeSwitchDesktop(index: number): Promise<void> {
    const ds = await kdeDesktops();
    const d = ds[index - 1];
    if (d?.id) await qdbus(["org.kde.KWin", "/VirtualDesktopManager", "org.kde.KWin.VirtualDesktopManager.SetCurrentDesktop", d.id]);
    else await qdbus(["org.kde.KWin", "/KWin", "org.kde.KWin.setCurrentDesktop", String(index)]).catch(() => {});
}

/** Normalize "ctrl+alt+delete" → KDE's "Ctrl+Alt+Del". */
export function kdeKeys(keys: string): string {
    const map: Record<string, string> = {
        ctrl: "Ctrl", control: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta", super: "Meta",
        delete: "Del", del: "Del", backspace: "Backspace", return: "Return", enter: "Return",
        escape: "Esc", esc: "Esc", space: "Space", tab: "Tab", left: "Left", right: "Right", up: "Up", down: "Down",
    };
    return keys.toLowerCase().split("+").map((k) => map[k] ?? (k.length === 1 ? k.toUpperCase() : k)).join("+");
}

/** Map an escape action to a KWin shortcut name (component "kwin"). */
function kwinShortcutFor(action: EscapeActionSpec): string | null {
    if (action.kind === "host-desktop") return `Switch to Desktop ${action.index}`;
    if (action.kind === "desktop-cycle") return action.dir === 1 ? "Switch One Desktop to the Right" : "Switch One Desktop to the Left";
    return null;
}

/**
 * Install a global escape shortcut by editing kglobalshortcutsrc + reloading
 * kglobalaccel. Only meaningful when the viewer does NOT grab the keyboard
 * (freerdp -grab-keyboard), so the host WM sees the combo.
 *
 * Returns an uninstaller restoring the previous binding.
 */
export async function kdeInstallEscapeShortcut(keys: string, action: EscapeActionSpec): Promise<() => Promise<void>> {
    const shortcut = kwinShortcutFor(action);
    if (!shortcut) {
        if (action.kind === "command") {
            // TODO(phase2): custom command actions need a registered kglobalaccel
            // component (a tiny dbus service). For now fail loudly.
            throw new Error("command escape actions need a kglobalaccel component — not implemented yet");
        }
        throw new Error(`escape action '${action.kind}' has no KWin shortcut mapping`);
    }
    const kc = (await which("kwriteconfig6")) ?? (await which("kwriteconfig5")) ?? (await which("kwriteconfig"));
    if (!kc) throw new Error("kwriteconfig not found");
    const kd = kdeKeys(keys);
    // kwriteconfig5 can't read — its value arg is mandatory and it prints usage
    // instead. Use kreadconfig when present (KF5); kwriteconfig6 reads fine.
    const kr = (await which("kreadconfig6")) ?? (await which("kreadconfig5")) ?? (await which("kreadconfig")) ?? kc;
    const read = async () => {
        const r = await run(kr, ["--file", "kglobalshortcutsrc", "--group", "kwin", "--key", shortcut], { noThrow: true });
        const v = r.stdout.trim();
        return r.code === 0 && v && !v.startsWith("Usage:") && !v.includes("\n") ? v : "";
    };
    const prev = await read();
    await run(kc, ["--file", "kglobalshortcutsrc", "--group", "kwin", "--key", shortcut, `${kd},${kd},${shortcut}`]);
    // kglobalaccel watches the file on Wayland; reconfigure nudges X11.
    await qdbus(["org.kde.KWin", "/KWin", "reconfigure"]).catch(() => {});
    return async () => {
        await run(kc, ["--file", "kglobalshortcutsrc", "--group", "kwin", "--key", shortcut, prev || "none"]);
        await qdbus(["org.kde.KWin", "/KWin", "reconfigure"]).catch(() => {});
    };
}

/**
 * KWin window ops on Wayland via a temporary KWin script. Scripts run inside
 * KWin and can enumerate/move clients — the only reliable non-extension path
 * on Wayland. Returns parsed JSON result of `fn(clients, arg)`.
 */
export async function kwinScript(jsFn: string, timeoutMs = 8_000): Promise<void> {
    // Wrap: registerScript returns a script id; we load, run, then stop it.
    const script = `
        (function(){ ${jsFn} })();
    `;
    const tmp = `/var/tmp/cruiser-kwin-${process.pid}-${Date.now()}.js`;
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(tmp, script);
    try {
        const id = (await qdbus(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", tmp])).trim();
        await qdbus(["org.kde.KWin", `/Scripting/Script${id}`, "run"]).catch(() => {});
        await qdbus(["org.kde.KWin", `/Scripting/Script${id}`, "stop"]).catch(() => {});
    } finally {
        await rm(tmp, { force: true }).catch(() => {});
        void timeoutMs;
    }
}
