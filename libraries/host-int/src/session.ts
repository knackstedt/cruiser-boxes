// ============================================================================
// session.ts — ViewerSession: launch freerdp, place its window per head mode,
// install escape shortcuts, clean up on exit.
// ============================================================================

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { VmSpec } from "../../vm-core/src/config/schema";
import type { EscapeActionSpec, WindowHandle, WmAdapter } from "./types";
import { detectAdapter } from "./detect";
import { launchFreerdp, waitRdpPort } from "./freerdp";

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

    constructor(spec: VmSpec, opts: ViewerSessionOpts = {}) {
        super();
        this.spec = spec;
        this.opts = opts;
        this.adapter = opts.adapter ?? detectAdapter();
    }

    /** Start the viewer: wait for RDP, spawn freerdp, place window, bind escapes. */
    async open(): Promise<void> {
        const rdpPort = this.spec.network.rdpPort;
        if (!rdpPort) throw new Error(`vm '${this.spec.name}' has no rdpPort`);
        if (!await waitRdpPort(rdpPort, this.opts.rdpWaitMs))
            throw new Error(`no RDP listener on 127.0.0.1:${rdpPort} — is '${this.spec.name}' running and logged in?`);

        const { child } = await launchFreerdp(this.spec, { rdpPort });
        this.child = child;
        child.on("exit", (c) => { this.child = null; this.emit("closed", c); this.cleanup(); });

        const d = this.spec.display;
        if (d.headMode === "windowed") return; // no placement needed

        // Find OUR window by pid — title matching races with other viewers.
        this.window = await this.adapter.findWindow(
            { pid: child.pid, wmClass: "xfreerdp" },
            this.opts.windowWaitMs ?? 15_000,
        ).catch(() => null);

        if (!this.window) {
            // Wayland findWindow is limited — try wmclass-only once more, then give up gracefully.
            this.window = await this.adapter.findWindow({ title: /FreeRDP/i }, 5_000).catch(() => null);
        }

        if (this.window && this.adapter.caps.placeWindows) {
            if (d.headMode === "virtual-desktop")
                await this.adapter.moveToDesktop(this.window, d.virtualDesktop).catch(() => {});
            if (d.headMode === "fullscreen-monitor" && d.sticky)
                await this.adapter.moveToDesktop(this.window, "all").catch(() => {});
            if (d.headMode === "fullscreen-monitor" && d.monitors !== "all" && d.monitors[0])
                await this.adapter.moveToMonitor(this.window, d.monitors[0]).catch(() => {});
            await this.adapter.setFullscreen(this.window, true).catch(() => {});
        }

        // Escape shortcuts need the host WM to see the keys (no keyboard grab).
        if (this.adapter.caps.shortcuts && !d.grabKeyboard) {
            for (const s of d.escapeShortcuts) {
                const action = parseEscapeAction(s.action);
                if (action) {
                    const un = await this.adapter.installEscapeShortcut(s.keys, action).catch(() => null);
                    if (un) this.uninstallers.push(un);
                }
            }
        }
    }

    async close(): Promise<void> {
        this.child?.kill("SIGTERM");
        await this.cleanup();
    }

    private async cleanup(): Promise<void> {
        const us = this.uninstallers; this.uninstallers = [];
        for (const u of us) await u().catch(() => {});
    }
}

/** "host-desktop:1" | "desktop-cycle-left" | "desktop-cycle-right" | "ungrab" */
export function parseEscapeAction(s: string): EscapeActionSpec | null {
    const [kind, arg] = s.split(":", 2);
    switch (kind) {
        case "host-desktop": return { kind: "host-desktop", index: Number(arg ?? 1) };
        case "desktop-cycle-left": return { kind: "desktop-cycle", dir: -1 };
        case "desktop-cycle-right": return { kind: "desktop-cycle", dir: 1 };
        case "ungrab": return { kind: "ungrab" };
        default: return null;
    }
}
