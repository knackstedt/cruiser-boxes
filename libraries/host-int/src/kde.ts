// ============================================================================
// kde.ts — qdbus/KWin helpers shared by kde-x11 and kde-wayland adapters.
// ============================================================================

import { run, which } from "../../sys/src/exec";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DesktopInfo, EscapeActionSpec, MonitorInfo, WindowRuleSpec } from "./types";

async function qdbus(args: string[]): Promise<string> {
    const bin = (await which("qdbus6")) ?? (await which("qdbus"));
    if (!bin) throw new Error("qdbus/qdbus6 not found");
    const r = await run(bin, args, { noThrow: true });
    if (r.code !== 0) throw new Error(`qdbus ${args[0]}: ${r.stderr.trim()}`);
    return r.stdout.trim();
}

const KWIN_RC = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kwinrc");

/** KWin VD UUID — the only value kwinrulesrc's `desktops` key accepts.
 *  Anything else (an EWMH index, an empty string) makes a placement rule
 *  silently never match. */
export const KWIN_VD_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Parse kwinrc's `[Desktops]` block (Number= / Id_N= / Name_N=). KWin
 * persists VD UUIDs there, so a session that can't reach the
 * VirtualDesktopManager over dbus can still resolve real ids — the fallback
 * that matters for window rules, where an EWMH index is NOT a valid id.
 * Exported for tests.
 */
export function kdeDesktopsRc(src: string): DesktopInfo[] {
    let inSec = false;
    const ids = new Map<number, string>(), names = new Map<number, string>();
    let count = 0;
    for (const line of src.split("\n")) {
        const t = line.trim();
        if (t.startsWith("[")) { inSec = t === "[Desktops]"; continue; }
        if (!inSec) continue;
        const kv = /^(Id|Name)_(\d+)=(.*)$/.exec(t);
        if (kv) {
            (kv[1] === "Id" ? ids : names).set(Number(kv[2]), kv[3]!.trim());
            continue;
        }
        const n = /^Number=(\d+)$/.exec(t);
        if (n) count = Number(n[1]);
    }
    const n = Math.max(count, ...ids.keys(), ...names.keys(), 0);
    const out: DesktopInfo[] = [];
    for (let i = 1; i <= n; i++) out.push({ index: i, id: ids.get(i), name: names.get(i) });
    return out;
}

/** KWin virtual desktops — UUIDs + names, works on X11 and Wayland. Falls
 *  back to kwinrc when the dbus probe fails (transient KWin/dbus hiccup at
 *  viewer launch) so callers still get real VD UUIDs. */
export async function kdeDesktops(): Promise<DesktopInfo[]> {
    const fromRc = async () => kdeDesktopsRc(await readFile(KWIN_RC(), "utf8").catch(() => ""));
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
            const rc = await fromRc();
            if (rc.length) {
                for (let i = 0; i < rc.length; i++) rc[i]!.current = !!cur && rc[i]!.id === cur;
                return rc;
            }
            const count = await qdbus(["org.kde.KWin", "/VirtualDesktopManager", "org.freedesktop.DBus.Properties.Get", "org.kde.KWin.VirtualDesktopManager", "count"]).catch(() => "0");
            for (let i = 0; i < Number(count); i++) out.push({ index: i + 1, current: i === 0 });
        }
        return out;
    } catch {
        return fromRc();
    }
}

/**
 * kscreen-doctor -o json → MonitorInfo[] — the wayland-path monitor probe
 * (xrandr sees nothing there). Carries real scale + refresh, unlike x11's
 * best-effort parse. Defensive on key names: kscreen has renamed
 * primary↔priority across Plasma releases.
 */
export async function kdeMonitors(): Promise<MonitorInfo[]> {
    if (!await which("kscreen-doctor")) return [];
    const r = await run("kscreen-doctor", ["-o", "json"], { noThrow: true, timeoutMs: 10_000 });
    if (r.code !== 0 || !r.stdout.trim()) return [];
    try {
        const doc = JSON.parse(r.stdout) as {
            outputs?: {
                name?: string; enabled?: boolean; primary?: boolean; priority?: number;
                scale?: number; pos?: { x?: number; y?: number };
                size?: { width?: number; height?: number };
                currentModeId?: string;
                modes?: { id?: string | number; size?: { width?: number; height?: number }; refreshRate?: number }[];
            }[];
        };
        const out: MonitorInfo[] = [];
        const outputs = doc.outputs ?? [];
        for (let i = 0; i < outputs.length; i++) {
            const o = outputs[i]!;
            if (o.enabled === false || !o.name) continue;
            const mode = (o.modes ?? []).find((m) => String(m.id) === String(o.currentModeId));
            const w = o.size?.width ?? mode?.size?.width ?? 0;
            const h = o.size?.height ?? mode?.size?.height ?? 0;
            if (!w || !h) continue;
            out.push({
                name: o.name,
                x: o.pos?.x ?? 0, y: o.pos?.y ?? 0,
                w, h,
                primary: o.primary ?? (o.priority !== undefined ? o.priority === 1 : false),
                scale: o.scale,
                refresh: mode?.refreshRate,
            });
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
        end: "End", insert: "Ins", ins: "Ins", home: "Home",
        pageup: "PgUp", pgup: "PgUp", pagedown: "PgDn", pgdn: "PgDn",
    };
    return keys.toLowerCase().split("+").map((k) =>
        map[k] ?? (/^f\d{1,2}$/.test(k) ? k.toUpperCase() : k.length === 1 ? k.toUpperCase() : k)).join("+");
}

/** Map an escape action to a KWin shortcut name (component "kwin"). */
function kwinShortcutFor(action: EscapeActionSpec): string | null {
    if (action.kind === "host-desktop") return `Switch to Desktop ${action.index}`;
    if (action.kind === "desktop-cycle") return action.dir === 1 ? "Switch One Desktop to the Right" : "Switch One Desktop to the Left";
    return null;
}

const KGLOBAL_RC = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kglobalshortcutsrc");

export interface KglobalBoundEntry { group: string; key: string; value: string }

/**
 * Every kglobalshortcutsrc entry holding `kd`. The value shape is
 * `<current>,<default>,<friendly>` with multi-binding slots joined by an
 * ESCAPED tab (`display=Display\tMeta+P,...` — literally backslash-t in
 * the ini). [khotkeys] uuid rows look like `{uuid}=Ctrl+Alt+End,none,
 * <desc>`, so either of the first two fields may carry the live grab.
 * Exported for tests.
 */
export function kglobalConflicts(src: string, kd: string): KglobalBoundEntry[] {
    const out: KglobalBoundEntry[] = [];
    let group = "";
    src.split("\n").forEach((raw) => {
        const line = raw.trimEnd();
        const g = /^\[(.+)\]$/.exec(line);
        if (g) { group = g[1]!; return; }
        const eq = line.indexOf("=");
        if (eq <= 0 || !group) return;
        const value = line.slice(eq + 1);
        const bound = value.split(",").slice(0, 2)
            .some((f) => f.split(/\\t|\t/).some((b) => b.trim().toLowerCase() === kd.toLowerCase()));
        if (bound) out.push({ group, key: line.slice(0, eq), value });
    });
    return out;
}

/** "a][b" nested group headers → repeated kwriteconfig --group args. */
const groupArgs = (g: string) => g.split("][").flatMap((p) => ["--group", p]);

/**
 * Steal `kd` from whatever already holds it — kglobalaccel keeps the first
 * grab registered, so our rebind never fires while another component owns
 * the key (ksmserver's "Log Out" takes Ctrl+Alt+Del out of the box). Each
 * conflicting entry is rewritten `none,none,<desc>` and returned for the
 * uninstaller to restore. [khotkeys] grabs are unregistered over dbus
 * instead — a file edit doesn't release the daemon-side grab, and their
 * khotkeysrc entries re-arm themselves on the next reread.
 */
async function kdeStealKey(kd: string, kc: string, skip?: { group: string; key: string }): Promise<KglobalBoundEntry[]> {
    const src = await readFile(KGLOBAL_RC(), "utf8").catch(() => "");
    const hits = kglobalConflicts(src, kd).filter((h) => !(skip && h.group === skip.group && h.key === skip.key));
    const stolen: KglobalBoundEntry[] = [];
    for (let i = 0; i < hits.length; i++) {
        const h = hits[i]!;
        if (h.group === "khotkeys") {
            const svcs = ["org.kde.kglobalaccel", "org.kde.KGlobalAccel"];
            for (let j = 0; j < svcs.length; j++)
                if (await qdbus([svcs[j]!, "/kglobalaccel", "org.kde.KGlobalAccel.unregister", "khotkeys", h.key]).then(() => true).catch(() => false)) break;
            continue;
        }
        const desc = h.value.split(",").slice(2).join(",");
        const r = await run(kc, ["--file", "kglobalshortcutsrc", ...groupArgs(h.group), "--key", h.key, `none,none,${desc || h.key}`], { noThrow: true });
        if (r.code === 0) stolen.push(h);
    }
    return stolen;
}

async function kdeRestoreKeys(kc: string, entries: KglobalBoundEntry[]): Promise<void> {
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        await run(kc, ["--file", "kglobalshortcutsrc", ...groupArgs(e.group), "--key", e.key, e.value], { noThrow: true });
    }
}

/**
 * Install a global escape shortcut by editing kglobalshortcutsrc + reloading
 * kglobalaccel. Only meaningful when the viewer does NOT grab the keyboard
 * (freerdp -grab-keyboard), so the host WM sees the combo.
 *
 * Returns an uninstaller restoring the previous binding.
 */
export async function kdeInstallEscapeShortcut(keys: string, action: EscapeActionSpec): Promise<() => Promise<void>> {
    if (action.kind === "command") return kdeInstallCommandShortcut(keys, action.argv);
    const shortcut = kwinShortcutFor(action);
    if (!shortcut) throw new Error(`escape action '${action.kind}' has no KWin shortcut mapping`);
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
    const stolen = await kdeStealKey(kd, kc, { group: "kwin", key: shortcut });
    await run(kc, ["--file", "kglobalshortcutsrc", "--group", "kwin", "--key", shortcut, `${kd},${kd},${shortcut}`]);
    // kglobalaccel watches the file on Wayland; reconfigure nudges X11.
    await qdbus(["org.kde.KWin", "/KWin", "reconfigure"]).catch(() => {});
    await reloadKglobalaccel();
    return async () => {
        await run(kc, ["--file", "kglobalshortcutsrc", "--group", "kwin", "--key", shortcut, prev || "none"]);
        await kdeRestoreKeys(kc, stolen);
        await qdbus(["org.kde.KWin", "/KWin", "reconfigure"]).catch(() => {});
        await reloadKglobalaccel();
    };
}

/** Re-read path for kglobalacceld's own groups ([services]) — unlike the
 *  kwin component, nothing else pokes it. The daemon watches the file on
 *  Plasma 6; the dbus call nudges versions with a reload method. A daemon
 *  RESTART is deliberately avoided: kglobalaccel flushes in-memory state
 *  over pending file edits on shutdown (verified on Plasma 5.27). */
async function reloadKglobalaccel(): Promise<void> {
    await qdbus(["org.kde.kglobalaccel", "/kglobalaccel", "org.kde.KGlobalAccel.reconfigure"]).catch(() => {});
    await qdbus(["org.kde.KGlobalAccel", "/kglobalaccel", "org.kde.KGlobalAccel.reconfigure"]).catch(() => {});
}

/** Desktop-entry Exec escaping: % must double; quote args with specials. */
function desktopExec(argv: string[]): string {
    const esc = (a: string) => (/[\s"\\`$']/.test(a) ? `"${a.replace(/["\\`$]/g, "\\$&")}"` : a);
    return argv.map(esc).join(" ").replaceAll("%", "%%");
}

/** khotkeys' CommandURL is executed as a command line by the launcher
 *  itself — a literal "sh -c" prefix makes the outer shell consume only
 *  the first word ("bun"), never the real cmdline. Unwrap the sh -c
 *  packaging parseEscapeAction adds; other argv shapes join verbatim. */
export function unwrapShC(argv: string[]): string {
    return argv[0] === "sh" && argv[1] === "-c" && argv.length === 3 ? argv[2]! : argv.join(" ");
}

/**
 * Command actions dispatch through whichever backend the session actually
 * runs — verified live on Plasma 5.27 (X11): a `[services]` launcher entry
 * binds in kglobalaccel5 but never fires, while a khotkeys
 * `SIMPLE_ACTION_DATA` entry works. khotkeys was removed in Plasma 6, where
 * the `[services][<id>.desktop] _launch` path is the supported mechanism.
 */
async function kdeInstallCommandShortcut(keys: string, argv: string[]): Promise<() => Promise<void>> {
    const idhash = createHash("sha256").update(argv.join("\0")).digest("hex").slice(0, 8);
    const kd = kdeKeys(keys);
    const kc = (await which("kwriteconfig6")) ?? (await which("kwriteconfig5")) ?? (await which("kwriteconfig"));
    // Same first-grab-wins conflict — a stray binding (including one of ours
    // orphaned in [khotkeys] by a dead session) refuses the new grab.
    const stolen = kc ? await kdeStealKey(kd, kc) : [];
    const uninstall = await (await khotkeysAvailable()
        ? khotkeysInstall(idhash, kd, unwrapShC(argv))
        : kglobalaccelInstallCommand(idhash, kd, argv));
    return async () => {
        await uninstall();
        if (kc) await kdeRestoreKeys(kc, stolen);
        await reloadKglobalaccel();
    };
}

/** Plasma 6 path: NoDisplay .desktop + [services][<id>.desktop] _launch. */
async function kglobalaccelInstallCommand(idhash: string, kd: string, argv: string[]): Promise<() => Promise<void>> {
    const kc = (await which("kwriteconfig6")) ?? (await which("kwriteconfig5")) ?? (await which("kwriteconfig"));
    if (!kc) throw new Error("kwriteconfig not found");
    const kr = (await which("kreadconfig6")) ?? (await which("kreadconfig5")) ?? (await which("kreadconfig")) ?? kc;
    const id = `cruiser-escape-${idhash}`;
    const apps = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "applications");
    await mkdir(apps, { recursive: true });
    const desktop = join(apps, `${id}.desktop`);
    const label = argv.join(" ");
    await writeFile(desktop,
        `[Desktop Entry]\nType=Application\nName=cruiser escape: ${label.slice(0, 80)}\nExec=${desktopExec(argv)}\nNoDisplay=true\n`,
        { mode: 0o644 });
    const grp = ["--file", "kglobalshortcutsrc", "--group", "services", "--group", `${id}.desktop`];
    const read = async () => {
        const r = await run(kr, [...grp, "--key", "_launch"], { noThrow: true });
        const v = r.stdout.trim();
        return r.code === 0 && v && !v.startsWith("Usage:") && !v.includes("\n") ? v : "";
    };
    const prev = await read();
    await run(kc, [...grp, "--key", "_launch", `${kd},${kd},${label.slice(0, 40)}`]);
    await reloadKglobalaccel();
    return async () => {
        await run(kc, [...grp, "--key", "_launch", prev || "none"]);
        await rm(desktop, { force: true }).catch(() => {});
        await reloadKglobalaccel();
    };
}

/** True when kded has the khotkeys module loaded (Plasma 5; gone on 6). */
async function khotkeysAvailable(): Promise<boolean> {
    const svcs = ["org.kde.kded5", "org.kde.kded6", "org.kde.kded"];
    for (let i = 0; i < svcs.length; i++) {
        try {
            if ((await qdbus([svcs[i], "/kded", "loadedModules"])).includes("khotkeys")) return true;
        } catch { /* kded not running under this service name */ }
    }
    return false;
}

const KHOTKEYS_RC = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "khotkeysrc");
const KHOTKEYS_MARKER = "cruiser-escape:";

/** Top-level `[Data_N]` groups in khotkeysrc → their Comment marker. */
export function khotkeysDataGroups(src: string): Map<number, string | null> {
    const out = new Map<number, string | null>();
    let cur: number | null = null;
    src.split("\n").forEach((line) => {
        const g = /^\[Data_(\d+)\]\s*$/.exec(line);
        if (g) { cur = Number(g[1]); out.set(cur, null); return; }
        if (line.startsWith("[")) { cur = null; return; }
        const c = /^Comment=(.*)$/.exec(line);
        if (cur !== null && c && out.get(cur) === null) out.set(cur, c[1]);
    });
    return out;
}

/**
 * khotkeys registers each trigger with kglobalaccel keyed by its `Uuid`, and
 * the grab is NOT released when the action is removed on reread — it persists
 * in `[khotkeys]` of kglobalshortcutsrc until an explicit `unregister`. So the
 * uuid must be deterministic per command: a fresh uuid each install orphans
 * the previous grab, and the new registration is refused while the key is
 * still held (verified live on Plasma 5.27).
 */
export function khotkeysUuid(idhash: string): string {
    const h = createHash("sha256").update(`cruiser-khotkeys:${idhash}`).digest();
    h[6] = (h[6] & 0x0f) | 0x50; // version 5
    h[8] = (h[8] & 0x3f) | 0x80; // variant 1
    const hex = h.subarray(0, 16).toString("hex");
    return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
}

/**
 * Plasma 5 path: a `SIMPLE_ACTION_DATA` entry in khotkeysrc. The marker in
 * Comment keys the entry by argv so repeat installs update in place instead
 * of accumulating duplicates.
 */
async function khotkeysInstall(idhash: string, kd: string, cmd: string): Promise<() => Promise<void>> {
    const kc = (await which("kwriteconfig6")) ?? (await which("kwriteconfig5")) ?? (await which("kwriteconfig"));
    if (!kc) throw new Error("kwriteconfig not found");
    const marker = `${KHOTKEYS_MARKER}${idhash}`;
    let src = "";
    try { src = await readFile(KHOTKEYS_RC(), "utf8"); } catch { /* fresh file */ }
    const groups = khotkeysDataGroups(src);
    let idx: number | null = null;
    let max = 0;
    groups.forEach((comment, i) => {
        if (i > max) max = i;
        if (comment === marker) idx = i;
    });
    idx ??= max + 1;
    const base = `Data_${idx}`;
    const w = (group: string, key: string, value: string) =>
        run(kc, ["--file", "khotkeysrc", "--group", group, "--key", key, value]);
    await w(base, "Comment", marker);
    await w(base, "Enabled", "true");
    await w(base, "Name", `cruiser: ${cmd.slice(0, 60)}`);
    await w(base, "Type", "SIMPLE_ACTION_DATA");
    await w(`${base}Actions`, "ActionsCount", "1");
    await w(`${base}Actions0`, "CommandURL", cmd);
    await w(`${base}Actions0`, "Type", "COMMAND_URL");
    await w(`${base}Conditions`, "Comment", "");
    await w(`${base}Conditions`, "ConditionsCount", "0");
    await w(`${base}Triggers`, "Comment", "Simple_action");
    await w(`${base}Triggers`, "TriggersCount", "1");
    await w(`${base}Triggers0`, "Key", kd);
    await w(`${base}Triggers0`, "Type", "SHORTCUT");
    await w(`${base}Triggers0`, "Uuid", khotkeysUuid(idhash));
    await w("Data", "DataCount", String(Math.max(idx, max)));
    await khotkeysReread();
    return () => khotkeysUninstall(idhash);
}

/** Rewrite khotkeysrc without the given top-level `[Data_N…]` sections,
 *  re-pointing DataCount at the highest surviving index (a hole in the
 *  middle is harmless — khotkeys sees an empty slot). */
export function khotkeysDropGroups(src: string, victims: number[]): string {
    const drop = new RegExp(`^\\[Data_(${victims.join("|")})([^0-9]|$)`);
    const kept: string[] = [];
    let skipping = false;
    src.split("\n").forEach((line) => {
        if (line.startsWith("[")) skipping = drop.test(line);
        if (!skipping) kept.push(line);
    });
    let max = 0;
    khotkeysDataGroups(kept.join("\n")).forEach((_, i) => { if (i > max) max = i; });
    const joined = kept.join("\n");
    return /^DataCount=/m.test(joined) ? joined.replace(/^DataCount=.*$/m, `DataCount=${max}`) : joined;
}

/**
 * Remove our khotkeys entries. kwriteconfig5 can't delete groups, so the ini
 * is rewritten directly.
 */
async function khotkeysUninstall(idhash: string): Promise<void> {
    let src = "";
    try { src = await readFile(KHOTKEYS_RC(), "utf8"); } catch { return; }
    const marker = `${KHOTKEYS_MARKER}${idhash}`;
    const victims: number[] = [];
    khotkeysDataGroups(src).forEach((comment, i) => { if (comment === marker) victims.push(i); });
    if (!victims.length) return;
    await writeFile(KHOTKEYS_RC(), khotkeysDropGroups(src, victims));
    await khotkeysReread();
    // The reread drops the action but NOT its kglobalaccel grab — unregister
    // it explicitly or the key stays stolen until the daemon restarts.
    const uuid = khotkeysUuid(idhash);
    const svcs = ["org.kde.kglobalaccel", "org.kde.KGlobalAccel"];
    for (let i = 0; i < svcs.length; i++) {
        const ok = await qdbus([svcs[i], "/kglobalaccel", "org.kde.KGlobalAccel.unregister",
            "khotkeys", uuid]).then(() => true).catch(() => false);
        if (ok) break;
    }
}

async function khotkeysReread(): Promise<void> {
    const svcs = ["org.kde.kded5", "org.kde.kded6", "org.kde.kded"];
    for (let i = 0; i < svcs.length; i++) {
        try {
            await qdbus([svcs[i], "/modules/khotkeys", "org.kde.khotkeys.reread_configuration"]);
            return;
        } catch { /* not this kded */ }
    }
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

// ── kwinrulesrc window rules ──
// A rule lands a matching window on its target VD at map time — the window
// never renders on the wrong desktop, unlike post-map wmctrl -t moves.
// Enum values from KWin 5.27 rules.h:
//   match:    titlematch/wmclassmatch  1=exact 2=substring 3=regex
//   policy:   desktopsrule             2=force 3=apply-initially 4=remember
//             (5=apply-now, 6=force-temporarily)
// `desktops` takes VD UUIDs (update_info use-virtual-desktop-ids); the "\\0"
// string means "all desktops" (sticky).

const KWIN_RULES = "kwinrulesrc";
const KWINRULES_RC = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), KWIN_RULES);

async function kwinRulesList(kr: string): Promise<string[]> {
    const r = await run(kr, ["--file", KWIN_RULES, "--group", "General", "--key", "rules"], { noThrow: true });
    const v = r.stdout.trim();
    return r.code === 0 && v && !v.startsWith("Usage:") && !v.includes("\n")
        ? v.split(",").filter(Boolean) : [];
}

/** Drop groups from [General] rules=/count= and rewrite the ini without
 *  their sections (kwriteconfig5 has no --delete-group — same approach as
 *  khotkeysUninstall). No-op when none are registered. */
async function kwinRulesDrop(kc: string, kr: string, groups: string[]): Promise<void> {
    const cur = await kwinRulesList(kr);
    const next = cur.filter((g) => !groups.includes(g));
    if (next.length !== cur.length) {
        await run(kc, ["--file", KWIN_RULES, "--group", "General", "--key", "rules", next.join(",")], { noThrow: true });
        await run(kc, ["--file", KWIN_RULES, "--group", "General", "--key", "count", String(next.length)], { noThrow: true });
    }
    const drop = new Set(groups);
    let src = "";
    try { src = await readFile(KWINRULES_RC(), "utf8"); } catch { /* gone */ }
    if (src) {
        const kept: string[] = [];
        let skipping = false;
        for (const line of src.split("\n")) {
            if (line.startsWith("[")) skipping = drop.has(line.trim().slice(1, -1));
            if (!skipping) kept.push(line);
        }
        await writeFile(KWINRULES_RC(), kept.join("\n")).catch(() => {});
    }
}

/**
 * Install a KWin window rule (kwinrulesrc) matched on title regex and/or
 * exact wmclass, applied at initial mapping. Works identically for X11 and
 * Wayland clients — KWin evaluates rules before showing the window, so this
 * is also the only placement path kde-wayland has.
 *
 * Group id is a deterministic `cruiser-<hash>` so concurrent installs of the
 * same match share one group; uninstall drops the group and re-tracks
 * [General] rules=/count=. `reconfigure` reloads the rulebook.
 */
export async function kdeInstallWindowRule(spec: WindowRuleSpec): Promise<() => Promise<void>> {
    const kc = (await which("kwriteconfig6")) ?? (await which("kwriteconfig5")) ?? (await which("kwriteconfig"));
    if (!kc) throw new Error("kwriteconfig not found");
    // A non-UUID desktopId (e.g. an EWMH index from a degraded desktops()
    // probe) would write a rule KWin can never satisfy — fail loudly so the
    // caller falls back to post-map placement instead of trusting a dead rule.
    if (!KWIN_VD_UUID.test(spec.desktopId)) throw new Error(`desktopId '${spec.desktopId}' is not a KWin VD uuid`);
    const kr = (await which("kreadconfig6")) ?? (await which("kreadconfig5")) ?? (await which("kreadconfig")) ?? kc;
    const group = `cruiser-${createHash("sha256")
        .update(`${spec.titleRegex ?? ""}${spec.wmClass ?? ""}${spec.desktopId}`).digest("hex").slice(0, 8)}`;
    const w = (key: string, value: string) =>
        run(kc, ["--file", KWIN_RULES, "--group", group, "--key", key, value], { noThrow: true });
    await w("Description", spec.description ?? "cruiser viewer placement");
    if (spec.titleRegex) {
        await w("title", spec.titleRegex);
        await w("titlematch", "3");
    }
    if (spec.wmClass) {
        await w("wmclass", spec.wmClass);
        await w("wmclassmatch", "1");
    }
    await w("desktops", spec.desktopId);
    await w("desktopsrule", "3");
    const rules = await kwinRulesList(kr);
    if (!rules.includes(group)) {
        rules.push(group);
        await run(kc, ["--file", KWIN_RULES, "--group", "General", "--key", "rules", rules.join(",")], { noThrow: true });
        await run(kc, ["--file", KWIN_RULES, "--group", "General", "--key", "count", String(rules.length)], { noThrow: true });
    }
    // Sweep superseded cruiser rules for the same window — the group id is
    // keyed on (title, class, desktop), so a changed target desktop leaves an
    // orphaned rule that keeps forcing windows to the OLD desktop forever.
    const stale = (await kwinRulesList(kr)).filter((g) => g.startsWith("cruiser-") && g !== group);
    const dead: string[] = [];
    for (let i = 0; i < stale.length; i++) {
        const g = stale[i]!;
        const t = await run(kr, ["--file", KWIN_RULES, "--group", g, "--key", "title"], { noThrow: true });
        const wc = await run(kr, ["--file", KWIN_RULES, "--group", g, "--key", "wmclass"], { noThrow: true });
        if (t.stdout.trim() === (spec.titleRegex ?? "") && wc.stdout.trim() === (spec.wmClass ?? "")) dead.push(g);
    }
    if (dead.length) await kwinRulesDrop(kc, kr, dead);
    await qdbus(["org.kde.KWin", "/KWin", "reconfigure"]).catch(() => {});
    return async () => {
        await kwinRulesDrop(kc, kr, [group]);
        await qdbus(["org.kde.KWin", "/KWin", "reconfigure"]).catch(() => {});
    };
}
