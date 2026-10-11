// ============================================================================
// session.ts — ViewerSession: launch freerdp, place its window per head mode,
// install escape shortcuts, clean up on exit.
// ============================================================================

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { VmSpec } from "../../vm-core/src/config/schema";
import type { EscapeActionSpec, WindowHandle, WmAdapter } from "./types";
import { detectAdapter } from "./detect";
import { launchFreerdp, waitRdpPort } from "./freerdp";
import { launchDdViewer, waitMonitorSock } from "./ddviewer";
import { run } from "../../sys/src/exec";

export interface ViewerSessionOpts {
    adapter?: WmAdapter;
    rdpWaitMs?: number;
    windowWaitMs?: number;
}

export class ViewerSession extends EventEmitter {
    readonly spec: VmSpec;
    readonly adapter: WmAdapter;
    private opts: ViewerSessionOpts;
    private child: ChildProcess | null = null;
    private window: WindowHandle | null = null;
    private uninstallers: (() => Promise<void>)[] = [];
    private cleanupDone: Promise<void> = Promise.resolve();

    constructor(spec: VmSpec, opts: ViewerSessionOpts = {}) {
        super();
        this.spec = spec;
        this.opts = opts;
        this.adapter = opts.adapter ?? detectAdapter();
    }

    /** Start the viewer: wait for the display endpoint, spawn the viewer
     *  (xfreerdp or viewer-dd), place the window, bind escape shortcuts. */
    async open(): Promise<void> {
        const dmabuf = this.spec.display.viewer === "dmabuf";
        const wmClass: string | undefined = dmabuf ? undefined : "xfreerdp";
        if (dmabuf) {
            // no guest-side daemon to wait on — QEMU's QMP socket is enough
            if (!await waitMonitorSock(this.spec))
                throw new Error(`no QEMU monitor socket for '${this.spec.name}' — is it running?`);
        } else {
            const rdpPort = this.spec.network.rdpPort;
            if (!rdpPort) throw new Error(`vm '${this.spec.name}' has no rdpPort`);
            if (!await waitRdpPort(rdpPort, this.opts.rdpWaitMs))
                throw new Error(`no RDP listener on 127.0.0.1:${rdpPort} — is '${this.spec.name}' running and logged in?`);
        }

        // Reap stale viewers for this VM — an orphaned viewer (dead UI
        // session, closed cli) would otherwise stay stacked on the target
        // desktop and race our findWindow's title fallback.
        const stale = await run("pgrep", ["-f", `(xfreerdp|viewer-dd).*cruiser:${this.spec.name}`], { noThrow: true });
        for (const p of stale.stdout.trim().split("\n").filter(Boolean))
            try { process.kill(Number(p), "SIGTERM"); } catch { /* already gone */ }

        const { child } = dmabuf
            ? await launchDdViewer(this.spec)
            : await launchFreerdp(this.spec, { rdpPort: this.spec.network.rdpPort! });
        this.child = child;
        child.on("exit", (c) => { this.child = null; this.emit("closed", c); this.cleanupDone = this.cleanup(); });

        const d = this.spec.display;

        // Find OUR window by pid — title matching races with other viewers.
        this.window = await this.adapter.findWindow(
            { pid: child.pid, ...(wmClass ? { wmClass } : {}) },
            this.opts.windowWaitMs ?? 15_000,
        ).catch(() => null);

        if (!this.window) {
            // Wayland findWindow is limited — retry on the viewer title
            // ("cruiser:<vm>"), then give up gracefully.
            this.window = await this.adapter.findWindow({ title: `cruiser:${this.spec.name}` }, 5_000).catch(() => null);
        }

        if (this.window && this.adapter.caps.placeWindows) {
            if (d.headMode === "windowed") {
                // A detached freerdp lands on whatever desktop the WM assigns —
                // pull it onto the user's current desktop and raise it so it
                // is actually visible.
                const cur = (await this.adapter.desktops().catch(() => [])).find((x) => x.current)?.index;
                if (cur !== undefined) await this.adapter.moveToDesktop(this.window, cur).catch(() => {});
                await this.adapter.focus(this.window).catch(() => {});
            } else {
                if (d.headMode === "virtual-desktop")
                    await this.adapter.moveToDesktop(this.window, d.virtualDesktop).catch(() => {});
                if (d.headMode === "fullscreen-monitor" && d.sticky)
                    await this.adapter.moveToDesktop(this.window, "all").catch(() => {});
                if (d.headMode === "fullscreen-monitor" && d.monitors !== "all" && d.monitors[0])
                    await this.adapter.moveToMonitor(this.window, d.monitors[0]).catch(() => {});
                await this.adapter.setFullscreen(this.window, true).catch(() => {});
            }
        }

        // Escape shortcuts need the host WM to see the keys (no keyboard grab).
        // Windowed sessions get none — stealing e.g. ctrl+alt+delete from a
        // normal app window is worse than losing the escape hatch.
        if (d.headMode !== "windowed" && this.adapter.caps.shortcuts && !d.grabKeyboard) {
            for (let i = 0; i < d.escapeShortcuts.length; i++) {
                const s = d.escapeShortcuts[i]!;
                const action = parseEscapeAction(
                    s.action.replaceAll("{vm}", this.spec.name).replaceAll("{cli}", cruiserCliPrefix()));
                if (action) {
                    const un = await this.adapter.installEscapeShortcut(s.keys, action).catch(() => null);
                    if (un) this.uninstallers.push(un);
                }
            }
        }
    }

    /** Bring the existing viewer window forward (no-op if it couldn't be
     *  located or the adapter can't focus windows). */
    async focus(): Promise<void> {
        if (this.window) await this.adapter.focus(this.window).catch(() => {});
    }

    async close(): Promise<void> {
        this.child?.kill("SIGTERM");
        await (this.cleanupDone = this.cleanup());
    }

    /** Resolves once the viewer process has exited AND escape shortcuts were
     *  uninstalled. A caller that exits early (e.g. a one-shot CLI) leaves the
     *  kglobalshortcutsrc/gsettings edits orphaned — hold the process open on
     *  this instead of returning after open(). */
    async exited(): Promise<void> {
        if (this.child) await new Promise<void>((r) => this.once("closed", () => r()));
        await this.cleanupDone;
    }

    private async cleanup(): Promise<void> {
        const us = this.uninstallers; this.uninstallers = [];
        for (let i = 0; i < us.length; i++) await us[i]!().catch(() => {});
    }
}

/** "host-desktop:1" | "desktop-cycle-left" | "desktop-cycle-right" |
 *  "ungrab" | "command:<cmdline>" (run via sh -c; {vm}/{cli} placeholders
 *  are already substituted by the caller). */
export function parseEscapeAction(s: string): EscapeActionSpec | null {
    // arg is everything after the first colon — command cmdlines may
    // themselves contain colons, so split(":",2) is out.
    const i = s.indexOf(":");
    const kind = i < 0 ? s : s.slice(0, i);
    const arg = i < 0 ? undefined : s.slice(i + 1);
    switch (kind) {
        case "host-desktop": return { kind: "host-desktop", index: Number(arg ?? 1) };
        case "desktop-cycle-left": return { kind: "desktop-cycle", dir: -1 };
        case "desktop-cycle-right": return { kind: "desktop-cycle", dir: 1 };
        case "ungrab": return { kind: "ungrab" };
        case "command": return arg ? { kind: "command", argv: ["sh", "-c", arg] } : null;
        default: return null;
    }
}

/** What `{cli}` expands to in escape-shortcut commands — dev trees resolve
 *  to the repo's cli.ts via bun; packaged builds don't ship it, so the
 *  installed `cruiser` binary is assumed on PATH. */
export function cruiserCliPrefix(): string {
    const cli = new URL("../../../src/cli.ts", import.meta.url).pathname;
    return existsSync(cli) ? `bun run ${cli}` : "cruiser";
}
