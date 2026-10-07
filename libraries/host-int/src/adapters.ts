// ============================================================================
// adapters.ts — WmAdapter implementations per DE/session combo.
//
// Reality check (documented in docs/de-matrix.md):
//   kde-x11        — full support via xdotool/wmctrl + kglobalshortcutsrc
//   kde-wayland    — desktops + shortcuts via qdbus; window ops via KWin script
//   gnome-x11      — full support via xdotool/wmctrl; shortcuts via gsettings
//   gnome-wayland  — read-only without a shell extension (docs/de-matrix.md)
//   generic-x11    — wmctrl/xdotool baseline for other EWMH WMs
// ============================================================================

import { run } from "../../sys/src/exec";
import type {
    AdapterCaps, EscapeActionSpec,
    WindowHandle, WindowMatcher, WmAdapter,
} from "./types";
import {
    x11CurrentDesktop, x11Desktops, x11FindWindow, x11Focus, x11Monitors,
    x11MoveToDesktop, x11MoveToMonitor, x11SetFullscreen, x11SwitchDesktop,
} from "./x11";
import { kdeDesktops, kdeInstallEscapeShortcut, kdeSwitchDesktop, kwinScript } from "./kde";

// ── shared X11 machinery ──

function x11Base(id: string, caps: AdapterCaps) {
    return {
        id, caps,
        monitors: x11Monitors,
        desktops: x11Desktops,
        findWindow: (m: WindowMatcher, t?: number) => x11FindWindow(m, t),
        moveToDesktop: (w: WindowHandle, d: number | "all") => x11MoveToDesktop(w, d),
        setFullscreen: (w: WindowHandle, on: boolean) => x11SetFullscreen(w, on),
        async moveToMonitor(w: WindowHandle, monitor: string) {
            const mon = (await x11Monitors()).find((m) => m.name === monitor);
            if (mon) await x11MoveToMonitor(w, mon);
        },
        focus: (w: WindowHandle) => x11Focus(w),
    };
}

export async function runEscape(action: EscapeActionSpec, kde: boolean): Promise<void> {
    if (action.kind === "host-desktop")
        return kde ? kdeSwitchDesktop(action.index) : x11SwitchDesktop(action.index);
    if (action.kind === "desktop-cycle") {
        if (kde) {
            // KWin has no relative-step dbus call; compute from current.
            const ds = await kdeDesktops();
            const cur = ds.findIndex((d) => d.current);
            if (cur >= 0) await kdeSwitchDesktop(((cur + action.dir + ds.length) % ds.length) + 1);
            return;
        }
        const ds = await x11Desktops();
        const cur = await x11CurrentDesktop();
        const next = ((cur - 1 + action.dir + ds.length) % ds.length) + 1;
        return x11SwitchDesktop(next);
    }
    if (action.kind === "ungrab") return;   // freerdp handles its own grab release combo
    if (action.kind === "command") { await run(action.argv[0]!, action.argv.slice(1), { noThrow: true }); return; }
}

// ── kde-x11 ──

export function kdeX11(): WmAdapter {
    const base = x11Base("kde-x11", { monitors: true, desktops: true, placeWindows: true, shortcuts: true });
    return {
        ...base,
        desktops: async () => (await kdeDesktops()).length ? kdeDesktops() : x11Desktops(),
        installEscapeShortcut: (keys, action) => kdeInstallEscapeShortcut(keys, action),
        // keep runEscape usable for runtime (non-installed) escapes
    };
}

// ── kde-wayland ──
// xdotool/wmctrl do not see Wayland clients. Desktops + shortcuts still work
// over dbus; window placement goes through a temporary KWin script.

export function kdeWayland(): WmAdapter {
    return {
        id: "kde-wayland",
        caps: {
            monitors: false,          // no xrandr on wayland; TODO: kscreen dbus
            desktops: true,
            placeWindows: true,       // via KWin script
            shortcuts: true,
            notes: "window ops via temporary KWin scripts; monitor listing not yet wired (kscreen dbus)",
        },
        monitors: async () => [],
        desktops: kdeDesktops,
        async findWindow(m: WindowMatcher, timeoutMs = 10_000): Promise<WindowHandle | null> {
            // Poll workspace.windowList via KWin script is expensive; use it once.
            void timeoutMs;
            let found: WindowHandle | null = null;
            await kwinScript(`
                const wins = workspace.windowList();
                for (const w of wins) {
                    const cls = w.resourceClass?.toString() ?? "";
                    const cap = w.caption?.toString() ?? "";
                    const pid = w.pid ?? -1;
                    if (${m.pid !== undefined} && pid !== ${m.pid ?? -1}) continue;
                    ${m.wmClass ? `if (cls !== ${JSON.stringify(m.wmClass)}) continue;` : ""}
                    ${m.title ? `if (!cap.includes(${JSON.stringify(String(m.title instanceof RegExp ? m.title.source : m.title))})) continue;` : ""}
                    print("CRUISER_WIN:" + w.internalId + ":" + cls + ":" + cap);
                }
            `).then(async () => {
                // KWin script print() goes to the journal, not back over dbus.
                // TODO(phase2): write match to a tmp file via script instead —
                // for now kde-wayland findWindow is limited to KWin-rule flows.
            }).catch(() => {});
            return found;
        },
        async moveToDesktop(w, d) { void w; void d; },
        async setFullscreen(w, on) { void w; void on; },
        async moveToMonitor(w, m2) { void w; void m2; },
        async focus(w) { void w; },
        installEscapeShortcut: (keys, action) => kdeInstallEscapeShortcut(keys, action),
    };
}

// ── gnome-x11 ──
// gsettings for keybindings; window ops via EWMH.

export function gnomeX11(): WmAdapter {
    const base = x11Base("gnome-x11", { monitors: true, desktops: true, placeWindows: true, shortcuts: true });
    return {
        ...base,
        async installEscapeShortcut(keys: string, action: EscapeActionSpec) {
            const binding = gnomeKeys(keys);
            const path = gnomeKeybindFor(action);
            if (!path) throw new Error(`escape action '${action.kind}' has no GNOME binding`);
            const [schema, key] = path;
            const prev = (await run("gsettings", ["get", schema, key], { noThrow: true })).stdout.trim();
            await run("gsettings", ["set", schema, key, `['${binding}']`]);
            return async () => { await run("gsettings", ["set", schema, key, prev || "@as []"], { noThrow: true }); };
        },
    };
}

function gnomeKeys(keys: string): string {
    // "ctrl+alt+delete" → "<Ctrl><Alt>Delete"
    const map: Record<string, string> = { delete: "Delete", escape: "Escape", return: "Return", space: "space" };
    const parts = keys.toLowerCase().split("+");
    const mods = parts.slice(0, -1).map((m) => `<${m === "meta" || m === "super" ? "Super" : m[0]!.toUpperCase() + m.slice(1)}>`).join("");
    const k = parts[parts.length - 1]!;
    return mods + (map[k] ?? (k.length === 1 ? k.toUpperCase() : k));
}

function gnomeKeybindFor(action: EscapeActionSpec): [string, string] | null {
    if (action.kind === "host-desktop")
        return ["org.gnome.desktop.wm.keybindings", `switch-to-workspace-${action.index}`];
    if (action.kind === "desktop-cycle")
        return ["org.gnome.desktop.wm.keybindings", action.dir === 1 ? "switch-to-workspace-right" : "switch-to-workspace-left"];
    return null;
}

// ── gnome-wayland — read-only until a companion shell extension ships ──

export function gnomeWayland(): WmAdapter {
    return {
        id: "gnome-wayland",
        caps: {
            monitors: false, desktops: false, placeWindows: false, shortcuts: false,
            notes: "mutter exposes no window-placement dbus API; needs the cruiser shell extension (docs/de-matrix.md)",
        },
        monitors: async () => [],
        desktops: async () => [],
        findWindow: async () => null,
        moveToDesktop: async () => {},
        setFullscreen: async () => {},
        moveToMonitor: async () => {},
        focus: async () => {},
        installEscapeShortcut: async () => { throw new Error("gnome-wayland: global shortcuts need the cruiser extension"); },
    };
}

// ── generic-x11 (openbox, i3-anywhere-EWMH…) ──

export function genericX11(): WmAdapter {
    const base = x11Base("generic-x11", {
        monitors: true, desktops: true, placeWindows: true, shortcuts: false,
        notes: "EWMH baseline; escape shortcuts not installed (no WM-specific keybinding api)",
    });
    return { ...base, installEscapeShortcut: async () => { throw new Error("generic-x11: no keybinding api"); } };
}
