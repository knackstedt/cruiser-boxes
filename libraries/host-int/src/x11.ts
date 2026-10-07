// ============================================================================
// x11.ts — xdotool/wmctrl/xrandr primitives shared by all X11 adapters.
// ============================================================================

import { run } from "../../sys/src/exec";
import type { DesktopInfo, MonitorInfo, WindowHandle, WindowMatcher } from "./types";

export async function x11Monitors(): Promise<MonitorInfo[]> {
    const r = await run("xrandr", ["--listmonitors"], { noThrow: true });
    if (r.code !== 0) return [];
    const out: MonitorInfo[] = [];
    // " 0: +*DP-1 3440/800x1440/330+0+0  DP-1"
    for (const line of r.stdout.split("\n")) {
        const m = line.match(/^\s*\d+:\s+[+*]*\s*(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(\d+)\+(\d+)/);
        if (m) out.push({ name: m[1]!, w: Number(m[2]), h: Number(m[3]), x: Number(m[4]), y: Number(m[5]), primary: line.includes("*") });
    }
    return out;
}

export async function x11Desktops(): Promise<DesktopInfo[]> {
    const r = await run("wmctrl", ["-d"], { noThrow: true });
    if (r.code !== 0) return [];
    // "0  * DG: 3440x1440  VP: 0,0  WA: ...  Desktop 1"
    return r.stdout.split("\n").filter(Boolean).map((line) => {
        const m = line.match(/^(\d+)\s+(.)\s.*?\s(\S+)\s*$/);
        const idx = Number(m?.[1] ?? 0);
        return { index: idx + 1, id: String(idx), name: m?.[3], current: m?.[2] === "*" };
    });
}

export async function x11Windows(): Promise<WindowHandle[]> {
    const r = await run("wmctrl", ["-l", "-p", "-x"], { noThrow: true });
    if (r.code !== 0) return [];
    // "0x03600008  2 4176 xfreerdp.Xfreerdp  host  FreeRDP: ..."
    const out: WindowHandle[] = [];
    for (const line of r.stdout.split("\n")) {
        const m = line.match(/^(0x[0-9a-fA-F]+)\s+-?\d+\s+(-?\d+)\s+(\S+)\s+\S+\s+(.*)$/);
        if (m) out.push({ id: m[1]!, pid: Number(m[2]), wmClass: m[3], title: m[4]! });
    }
    return out;
}

export async function x11FindWindow(m: WindowMatcher, timeoutMs = 15_000): Promise<WindowHandle | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        for (const w of await x11Windows()) {
            if (m.pid !== undefined && w.pid !== m.pid) continue;
            if (m.wmClass && w.wmClass !== m.wmClass) continue;
            if (m.title !== undefined) {
                const t = typeof m.title === "string" ? w.title.includes(m.title) : m.title.test(w.title);
                if (!t) continue;
            }
            return w;
        }
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 250));
    }
}

export async function x11MoveToDesktop(w: WindowHandle, desktop: number | "all"): Promise<void> {
    const target = desktop === "all" ? "-1" : String(desktop - 1);
    await run("wmctrl", ["-i", "-r", w.id, "-t", target], { noThrow: true });
}

export async function x11SetFullscreen(w: WindowHandle, on: boolean): Promise<void> {
    await run("wmctrl", ["-i", "-r", w.id, "-b", `${on ? "add" : "remove"},fullscreen`], { noThrow: true });
}

export async function x11MoveToMonitor(w: WindowHandle, mon: MonitorInfo): Promise<void> {
    // unmaximize, drop onto the monitor, re-center; fullscreen afterwards if wanted
    await run("wmctrl", ["-i", "-r", w.id, "-b", "remove,maximized_vert,maximized_horz"], { noThrow: true });
    await run("xdotool", ["windowmove", w.id, String(mon.x + Math.max(0, (mon.w - 800) / 2)), String(mon.y + Math.max(0, (mon.h - 600) / 2))], { noThrow: true });
}

export async function x11Focus(w: WindowHandle): Promise<void> {
    await run("wmctrl", ["-i", "-a", w.id], { noThrow: true });
}

/** Switch the host to desktop N (1-based). */
export async function x11SwitchDesktop(index: number): Promise<void> {
    await run("wmctrl", ["-s", String(index - 1)], { noThrow: true });
}

export async function x11CurrentDesktop(): Promise<number> {
    const d = await x11Desktops();
    return d.find((x) => x.current)?.index ?? 1;
}
