// ============================================================================
// adapters.ts — WmAdapter implementations per DE/session combo.
//
// Reality check (documented in docs/de-matrix.md):
//   kde-x11        — full support via xdotool/wmctrl + kglobalshortcutsrc
//   kde-wayland    — desktops + shortcuts via qdbus; window ops via KWin script
//   gnome-x11      — full support via xdotool/wmctrl; shortcuts via gsettings
//   gnome-wayland  — shortcuts via gsettings (gsd is session-level, not X11);
//                    window ops are read-only without a shell extension
//                    (docs/de-matrix.md)
//   generic-x11    — wmctrl/xdotool baseline for other EWMH WMs
// ============================================================================

import { run } from "../../sys/src/exec";
import { createHash } from "node:crypto";
import type {
    AdapterCaps, EscapeActionSpec,
    WindowHandle, WindowMatcher, WmAdapter,
} from "./types";
import {
    x11CurrentDesktop, x11Desktops, x11FindWindow, x11FindWindows, x11Focus, x11Monitors,
    x11MoveToDesktop, x11MoveToMonitor, x11SetFullscreen, x11SwitchDesktop,
} from "./x11";
import { kdeDesktops, kdeDesktopSwitchBindings, kdeInstallEscapeShortcut, kdeInstallWindowRule, kdeMonitors, kdeSwitchDesktop, kwinScript } from "./kde";

// ── shared X11 machinery ──

function x11Base(id: string, caps: AdapterCaps) {
    return {
        id, caps,
        monitors: x11Monitors,
        desktops: x11Desktops,
        findWindow: (m: WindowMatcher, t?: number) => x11FindWindow(m, t),
        findWindows: (m: WindowMatcher, t?: number, want?: number) => x11FindWindows(m, t, want),
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
    if (action.kind === "ungrab" || action.kind === "abort") return;   // viewer-side dispatches
    if (action.kind === "kwin") {
        // named kglobalaccel action — the same entry point the binding calls
        for (const bin of ["qdbus6", "qdbus"].values())
            if ((await run(bin, ["org.kde.kglobalaccel", "/component/kwin",
                "org.kde.kglobalaccel.Component.invokeShortcut", action.name], { noThrow: true })).code === 0) return;
        await run("gdbus", ["call", "--session", "--dest", "org.kde.kglobalaccel",
            "--object-path", "/component/kwin", "--method",
            "org.kde.kglobalaccel.Component.invokeShortcut", action.name], { noThrow: true });
        return;
    }
    if (action.kind === "command") { await run(action.argv[0]!, action.argv.slice(1), { noThrow: true }); return; }
}

// ── kde-x11 ──

export function kdeX11(): WmAdapter {
    const base = x11Base("kde-x11", { monitors: true, desktops: true, placeWindows: true, shortcuts: true });
    return {
        ...base,
        desktops: async () => {
            const ds = await kdeDesktops();
            return ds.length ? ds : x11Desktops();
        },
        installEscapeShortcut: (keys, action) => kdeInstallEscapeShortcut(keys, action),
        installWindowRule: kdeInstallWindowRule,
        desktopSwitchBindings: kdeDesktopSwitchBindings,
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
            monitors: true,           // kscreen-doctor json (scale + refresh)
            desktops: true,
            placeWindows: true,       // via KWin script
            shortcuts: true,
            notes: "window ops via temporary KWin scripts; monitors via kscreen-doctor",
        },
        monitors: kdeMonitors,
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
        // KWin rules reach Wayland clients too — the only placement path
        // this adapter has until the KWin-script window ops land.
        installWindowRule: kdeInstallWindowRule,
        desktopSwitchBindings: kdeDesktopSwitchBindings,
    };
}

// ── gnome-x11 ──
// gsettings for keybindings; window ops via EWMH.

export function gnomeX11(): WmAdapter {
    const base = x11Base("gnome-x11", { monitors: true, desktops: true, placeWindows: true, shortcuts: true });
    return { ...base, installEscapeShortcut: gnomeInstallEscapeShortcut, desktopSwitchBindings: gnomeDesktopSwitchBindings };
}

/**
 * gsettings keybindings — identical on X11 and Wayland: mutter owns the
 * wm.keybindings schema and gsd handles media-keys custom-keybindings at
 * the session level, so none of this touches X11.
 */
async function gnomeInstallEscapeShortcut(keys: string, action: EscapeActionSpec) {
    const binding = gnomeKeys(keys);
    if (action.kind === "command") return gnomeInstallCommandShortcut(binding, action.argv);
    const path = gnomeKeybindFor(action);
    if (!path) throw new Error(`escape action '${action.kind}' has no GNOME binding`);
    const [schema, key] = path;
    const prev = (await run("gsettings", ["get", schema, key], { noThrow: true })).stdout.trim();
    await run("gsettings", ["set", schema, key, `['${binding}']`]);
    return async () => { await run("gsettings", ["set", schema, key, prev || "@as []"], { noThrow: true }); };
}

function gnomeKeys(keys: string): string {
    // "ctrl+alt+delete" → "<Ctrl><Alt>Delete"
    const map: Record<string, string> = {
        delete: "Delete", escape: "Escape", return: "Return", enter: "Return", space: "space", tab: "Tab",
        end: "End", insert: "Insert", ins: "Insert", home: "Home",
        pageup: "Page_Up", pgup: "Page_Up", pagedown: "Page_Down", pgdn: "Page_Down",
    };
    const parts = keys.toLowerCase().split("+");
    const mods = parts.slice(0, -1).map((m) => `<${m === "meta" || m === "super" ? "Super" : m[0]!.toUpperCase() + m.slice(1)}>`).join("");
    const k = parts[parts.length - 1]!;
    return mods + (map[k] ?? (/^f\d{1,2}$/.test(k) ? k.toUpperCase() : k.length === 1 ? k.toUpperCase() : k));
}

function gnomeKeybindFor(action: EscapeActionSpec): [string, string] | null {
    if (action.kind === "host-desktop")
        return ["org.gnome.desktop.wm.keybindings", `switch-to-workspace-${action.index}`];
    if (action.kind === "desktop-cycle")
        return ["org.gnome.desktop.wm.keybindings", action.dir === 1 ? "switch-to-workspace-right" : "switch-to-workspace-left"];
    return null;
}

/** "<Super><Primary>Page_Up" → "super+ctrl+pageup" — the GNOME wm
 *  keybindings notation → our lowercase grammar. Exported for tests. */
export function gnomeUnkeys(b: string): string | null {
    const mods: Record<string, string> = {
        super: "super", primary: "ctrl", control: "ctrl", ctrl: "ctrl",
        alt: "alt", shift: "shift", meta: "super", mod1: "alt", mod4: "super",
    };
    const keys: Record<string, string> = {
        page_up: "pageup", page_down: "pagedown", return_: "enter", return: "enter",
        escape: "escape", delete: "delete", backspace: "backspace", space: "space",
        tab: "tab", home: "home", end: "end", insert: "insert",
    };
    const m = /^((?:<\w+>)*)(.*)$/.exec(b.trim());
    if (!m || (!m[1] && !m[2])) return null;
    const parts = [...m[1]!.matchAll(/<(\w+)>/g)]
        .map((x) => mods[x[1]!.toLowerCase()]).filter((x): x is string => !!x);
    const k = keys[m[2]!.toLowerCase()] ?? m[2]!.toLowerCase();
    if (!k) return null;
    return [...parts, k].join("+");
}

/** The user's own GNOME workspace-switch bindings (wm.keybindings), mirrored
 *  so the viewer can dispatch the same switch while its grab is held —
 *  desktop-cycle/host-desktop actions take the EWMH fallback at dispatch. */
async function gnomeDesktopSwitchBindings(): Promise<{ keys: string; action: string }[]> {
    const SCHEMA = "org.gnome.desktop.wm.keybindings";
    const out: { keys: string; action: string }[] = [];
    const get = async (key: string) =>
        (await run("gsettings", ["get", SCHEMA, key], { noThrow: true })).stdout.trim();
    const list = (s: string) => [...s.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
    for (const [key, action] of [["switch-to-workspace-left", "desktop-cycle-left"],
        ["switch-to-workspace-right", "desktop-cycle-right"]].values())
        for (const b of list(await get(key))) {
            const keys = gnomeUnkeys(b);
            if (keys) out.push({ keys, action });
        }
    for (let i = 1; i <= 9; i++)
        for (const b of list(await get(`switch-to-workspace-${i}`))) {
            const keys = gnomeUnkeys(b);
            if (keys) out.push({ keys, action: `host-desktop:${i}` });
        }
    return out;
}

/** GVariant string literal — single-quoted, backslash escapes. */
const gv = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * Command actions ride a relocatable media-keys custom-keybinding slot —
 * the same thing Settings → Keyboard → Custom Shortcuts writes. The slot id
 * is keyed by argv so repeat installs share it; uninstall restores the
 * bindings list and resets the slot.
 */
async function gnomeInstallCommandShortcut(binding: string, argv: string[]): Promise<() => Promise<void>> {
    const BASE = "org.gnome.settings-daemon.plugins.media-keys";
    const SUB = `${BASE}.custom-keybinding`;
    const id = `cruiser-${createHash("sha256").update(argv.join("\0")).digest("hex").slice(0, 8)}`;
    const path = `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/${id}/`;
    const prev = (await run("gsettings", ["get", BASE, "custom-keybindings"], { noThrow: true })).stdout.trim();
    const cur = [...prev.matchAll(/'[^']*'/g)].map((m) => m[0]);
    const next = cur.includes(gv(path)) ? prev
        : cur.length ? `[${cur.concat(gv(path)).join(", ")}]`
        : `[${gv(path)}]`;
    if (next !== prev) await run("gsettings", ["set", BASE, "custom-keybindings", next]);
    const at = `${SUB}:${path}`;
    await run("gsettings", ["set", at, "name", gv(`cruiser escape: ${argv.join(" ").slice(0, 60)}`)]);
    await run("gsettings", ["set", at, "binding", gv(binding)]);
    // the command runs through a shell — single-quote argv like logs.ts
    const cmdline = argv.map((a) => `'${a.replaceAll("'", `'"'"'`)}'`).join(" ");
    await run("gsettings", ["set", at, "command", gv(cmdline)]);
    return async () => {
        await run("gsettings", ["set", BASE, "custom-keybindings", prev || "@as []"], { noThrow: true });
        await run("gsettings", ["reset-recursively", at], { noThrow: true });
    };
}

// ── gnome-wayland — shortcuts via gsettings; window ops stay stubbed until
// a companion shell extension ships ──

export function gnomeWayland(): WmAdapter {
    return {
        id: "gnome-wayland",
        caps: {
            monitors: false, desktops: false, placeWindows: false, shortcuts: true,
            notes: "mutter exposes no window-placement dbus API; needs the cruiser shell extension (docs/de-matrix.md). Escape shortcuts DO work — media-keys/wm keybindings are session-level, not X11.",
        },
        monitors: async () => [],
        desktops: async () => [],
        findWindow: async () => null,
        moveToDesktop: async () => {},
        setFullscreen: async () => {},
        moveToMonitor: async () => {},
        focus: async () => {},
        installEscapeShortcut: gnomeInstallEscapeShortcut,
        desktopSwitchBindings: gnomeDesktopSwitchBindings,
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
