// ============================================================================
// session.ts — ViewerSession: launch freerdp, place its window per head mode,
// install escape shortcuts, clean up on exit.
// ============================================================================

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { vmPaths } from "../../vm-core/src/paths";
import type { EscapeActionSpec, WindowHandle, WindowMatcher, WmAdapter } from "./types";
import { detectAdapter } from "./detect";
import { KWIN_VD_UUID } from "./kde";
import { launchFreerdp, probeRdp, type RdpProbe } from "./freerdp";
import { launchDdViewer, waitMonitorSock } from "./ddviewer";
import { run } from "../../sys/src/exec";

export interface ViewerSessionOpts {
    adapter?: WmAdapter;
    rdpWaitMs?: number;
    windowWaitMs?: number;
    /** Progress/diag sink (provision/session forwards it from both surfaces). */
    log?: (msg: string) => void;
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
        let rdpProbe: RdpProbe | null = null;
        if (dmabuf) {
            // no guest-side daemon to wait on — QEMU's QMP socket is enough
            if (!await waitMonitorSock(this.spec))
                throw new Error(`no QEMU monitor socket for '${this.spec.name}' — is it running?`);
        } else {
            const rdpPort = this.spec.network.rdpPort;
            if (!rdpPort) throw new Error(`vm '${this.spec.name}' has no rdpPort`);
            rdpProbe = await probeRdp(rdpPort, this.opts.rdpWaitMs);
            if (!rdpProbe)
                throw new Error(`no RDP listener on 127.0.0.1:${rdpPort} — is '${this.spec.name}' running and logged in?`);
        }

        const d = this.spec.display;
        const logFile = join(vmPaths(this.spec.name).run, dmabuf ? "viewer-dd.log" : "freerdp.log");

        // Guest composite layout for the virtio tablet: the guest maps the
        // single absolute pointer over the whole composite and QEMU scales
        // per-console, so the viewer needs each console's composite offset
        // (host-mirror positions, normalized — same shape guestKdeMonitorsScript
        // pushes). `rects` are the picked monitors in absolute px — viewer-dd
        // spans ONE window over their union (freerdp /multimon semantics).
        // Console order = picked monitor order = virtio outputs[].
        const ddGeo: { offsets?: string; rects?: string } = {};
        if (dmabuf && this.adapter.caps.monitors) {
            const host = await this.adapter.monitors().catch(() => []);
            const picked = d.monitors === "all" ? host : host.filter((m) => d.monitors.includes(m.name));
            if (picked.length > 1) {
                const ox = Math.min(...picked.map((m) => m.x));
                const oy = Math.min(...picked.map((m) => m.y));
                ddGeo.offsets = picked.map((m) => `${m.x - ox},${m.y - oy}`).join(" ");
            }
            if (picked.length && d.headMode !== "windowed")
                ddGeo.rects = picked.map((m) => `${m.x},${m.y},${m.w},${m.h}`).join(" ");
        }

        // Adopt a live viewer for this VM when its window exists — killing a
        // healthy console because a different session owns it reads as a
        // "viewer crash" on every fresh session's view click. Zombies
        // (process up, window gone) still fall through to the reaper.
        if (!this.window)
            this.window = await this.adapter.findWindow({ title: this.titleRe() }, 1_500).catch(() => null);
        if (!this.window) {
            // Reap stale viewers for this VM — an orphaned viewer (dead UI
            // session, closed cli) would otherwise stay stacked on the target
            // desktop and race our findWindow's title fallback.
            const stale = await run("pgrep", ["-f", `(xfreerdp|viewer-dd).*cruiser:${this.spec.name}`], { noThrow: true });
            for (const p of stale.stdout.trim().split("\n").filter(Boolean))
                try { process.kill(Number(p), "SIGTERM"); } catch { /* already gone */ }

            // Pre-map VD placement: a KWin window rule lands the viewer
            // window on its target desktop at map time. Without it the
            // window flashes on the current desktop before the post-map
            // moveToDesktop drags it over (still kept below as the fallback
            // for adapters without a rules api — and for adopted windows).
            if (this.adapter.installWindowRule && d.headMode === "virtual-desktop") {
                const vd = (await this.adapter.desktops().catch(() => [])).find((x) => x.index === d.virtualDesktop);
                // kwinrulesrc's `desktops` only accepts a VD UUID — the x11
                // desktops() fallback reports a bare EWMH index as id, which
                // would write a rule KWin can never satisfy.
                if (vd?.id && KWIN_VD_UUID.test(vd.id)) {
                    const un = await this.adapter.installWindowRule({
                        titleRegex: `^cruiser:${escapeRegex(this.spec.name)}$`,
                        wmClass: dmabuf ? undefined : "xfreerdp",
                        desktopId: vd.id,
                        description: `cruiser: ${this.spec.name} → desktop ${vd.index}${vd.name ? ` (${vd.name})` : ""}`,
                    }).catch(() => null);
                    if (un) this.uninstallers.push(un);
                    else this.opts.log?.(`window rule for '${this.spec.name}' failed to install — window will be moved post-map`);
                } else {
                    this.opts.log?.(`no VD uuid for desktop ${d.virtualDesktop} — post-map placement only`);
                }
            }

            // viewer-dd gets the escape list ({vm}/{cli} expanded) PLUS the
            // host's own VD-switch bindings mirrored in — while its keyboard
            // grab is held the WM's global shortcuts are blind, so the
            // viewer dispatches the user's real keybinds itself
            // (kwin:<action> → kglobalaccel invokeShortcut). Spec entries
            // override mirrored ones on a key conflict. Windowed sessions
            // get none — same "don't steal global combos" rule as the WM
            // install path below.
            const ddEscapes = dmabuf && d.headMode !== "windowed"
                ? await this.ddEscapeList()
                : undefined;

            // Newer krdp (Plasma ≥6.5) negotiates NLA but has no CredSSP
            // credentials — the connection dies in negotiation. The port
            // probe above already learned the security layer (TLS-only →
            // /sec:tls immediately); retries below still force /sec:tls in
            // case the probe lied.
            const tlsOnly = rdpProbe?.tlsOnly === true;
            const maxAttempts = dmabuf ? 1 : 3;
            for (let attempt = 0; ; attempt++) {
                const { child } = dmabuf
                    ? await launchDdViewer(this.spec, ddGeo, ddEscapes)
                    : await launchFreerdp(this.spec, { rdpPort: this.spec.network.rdpPort!, logFile, tlsOnly: tlsOnly || attempt > 0 });
                this.child = child;
                child.on("exit", (c) => { this.child = null; this.emit("closed", c); this.cleanupDone = this.cleanup(); });
                const exited = new Promise<null>((r) => child.once("exit", () => r(null)));

                // Find OUR window. freerdp: by pid — title matching races
                // with other viewers. viewer-dd: minifb sets no _NET_WM_PID
                // at map time (the binary sets it itself post-create), so
                // match the per-VM title — the stale-viewer reaper above
                // guarantees it's ours.
                // Racing against child exit keeps a dead viewer from burning
                // the whole window-wait timeout.
                const matcher: WindowMatcher = dmabuf
                    ? { title: this.titleRe() }
                    : { pid: child.pid, ...(wmClass ? { wmClass } : {}) };
                this.window = await Promise.race([
                    this.adapter.findWindow(matcher, this.opts.windowWaitMs ?? 15_000).catch(() => null),
                    exited,
                ]);

                if (!this.window && this.child && !dmabuf) {
                    // Wayland findWindow is limited — retry on the viewer
                    // title, then give up gracefully.
                    this.window = await Promise.race([
                        this.adapter.findWindow({ title: this.titleRe() }, 5_000).catch(() => null),
                        exited,
                    ]);
                }

                if (this.child) break;   // viewer alive (window may be unplaced)
                if (this.window || attempt + 1 >= maxAttempts) {
                    await this.cleanup();
                    const why = child.exitCode !== null ? `code ${child.exitCode}` : (child.signalCode ?? "signal");
                    throw new Error(`viewer for '${this.spec.name}' exited (${why})${this.window ? " after the window mapped" : " before a window appeared"} — see ${logFile}`);
                }
                // Died before a window appeared: retry with /sec:tls (covers
                // the krdp CredSSP-fail case AND krdp's teardown race — a
                // probe/failed attempt's session teardown can kill the next
                // connection's portal session → LOGOFF_BY_USER exit 12).
                // Let the guest's teardown settle before reconnecting.
                this.opts.log?.(`viewer for '${this.spec.name}' exited before mapping (attempt ${attempt + 1}) — retrying`);
                await new Promise((r) => setTimeout(r, 1500));
            }
        }

        // Both viewers are single-window now — freerdp spans monitors via
        // /multimon, viewer-dd via --rects + _NET_WM_FULLSCREEN_MONITORS.
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
                // dmabuf + --rects self-places over the monitor union — the
                // moveToMonitor hint only remains for freerdp and for a
                // dmabuf session that lacked monitor info to span with.
                if (d.headMode === "fullscreen-monitor" && d.monitors !== "all" && d.monitors[0] && !(dmabuf && ddGeo.rects))
                    await this.adapter.moveToMonitor(this.window, d.monitors[0]).catch(() => {});
                await this.adapter.setFullscreen(this.window, true).catch(() => {});
            }
        }

        // Escape shortcuts via the WM's binding API. Freerdp installs the
        // whole list (its +grab-keyboard only shadows the bindings while it
        // actually holds the grab). dmabuf installs only `command:` actions
        // — the daemon's [services]/gsettings entries make them fire while
        // unfocused AND puts them in the host's shortcut UI; VD nav is the
        // user's own WM bindings (mirrored into viewer-dd, never rewritten
        // — installing kwin-group rows would clobber them) and ungrab/
        // abort/kwin: are viewer-internal dispatches. Windowed sessions
        // get none — stealing keys from a normal app window is worse than
        // losing the escape hatch.
        if (d.headMode !== "windowed" && this.adapter.caps.shortcuts) {
            for (let i = 0; i < d.escapeShortcuts.length; i++) {
                const s = d.escapeShortcuts[i]!;
                const action = parseEscapeAction(
                    s.action.replaceAll("{vm}", this.spec.name).replaceAll("{cli}", cruiserCliPrefix()));
                if (!action || (dmabuf && action.kind !== "command")) continue;
                const un = await this.adapter.installEscapeShortcut(s.keys, action).catch(() => null);
                if (un) this.uninstallers.push(un);
            }
        }
    }

    /** Merge spec escapeShortcuts with the host's own VD-switch bindings
     *  (mirrored so they keep working under the viewer's grab). Spec wins
     *  on a key conflict; keys are normalized for dedupe. */
    private async ddEscapeList(): Promise<string[]> {
        const merged = new Map<string, string>();
        const mirrored = await this.adapter.desktopSwitchBindings?.().catch(() => []) ?? [];
        mirrored.forEach((m) => merged.set(normKeys(m.keys), m.action));
        this.spec.display.escapeShortcuts.forEach((s) =>
            merged.set(normKeys(s.keys),
                s.action.replaceAll("{vm}", this.spec.name).replaceAll("{cli}", cruiserCliPrefix())));
        return [...merged].map(([k, a]) => `${k}=${a}`);
    }

    /** Bring the existing viewer window forward (no-op if it couldn't be
     *  located or the adapter can't focus windows). */
    async focus(): Promise<void> {
        if (this.window) await this.adapter.focus(this.window).catch(() => {});
    }

    /** Adopted sessions hold no child handle — recheck the window instead.
     *  True when an adopted viewer's window is gone (caller should drop the
     *  entry and relaunch). */
    async windowGone(): Promise<boolean> {
        if (this.child || !this.window) return false;
        return !await this.adapter.findWindow({ title: this.titleRe() }, 1_000).catch(() => null);
    }

    async close(): Promise<void> {
        this.child?.kill("SIGTERM");
        await (this.cleanupDone = this.cleanup());
    }

    /** Release ownership without killing — the viewer child is spawned
     *  detached+unref'd and outlives the owning session/process. Shortcut
     *  uninstallers still run (the orphan window survives without escape
     *  bindings; open()'s stale-viewer reaper cleans it on next launch). */
    async detach(): Promise<void> {
        this.child = null;
        this.window = null;
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

    /** Anchored viewer-title matcher — "cruiser:<vm>" exactly. A bare
     *  substring would also catch a different VM whose NAME has this one
     *  as a prefix ("devinbox" matching "cruiser:devinbox2"), and matching
     *  a per-head "cruiser:<vm>:<i>" left over from a pre-single-window
     *  viewer-dd would adopt a stale window — those are reaped by cmdline
     *  instead. */
    private titleRe(): RegExp {
        return new RegExp(`^cruiser:${escapeRegex(this.spec.name)}$`);
    }

    private async cleanup(): Promise<void> {
        const us = this.uninstallers; this.uninstallers = [];
        for (let i = 0; i < us.length; i++) await us[i]!().catch(() => {});
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "host-desktop:1" | "desktop-cycle-left" | "desktop-cycle-right" |
 *  "ungrab" | "abort" | "kwin:<action>" | "command:<cmdline>" (run via
 *  sh -c; {vm}/{cli} placeholders are already substituted by the caller). */
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
        case "abort": return { kind: "abort" };
        case "kwin": return arg ? { kind: "kwin", name: arg } : null;
        case "command": return arg ? { kind: "command", argv: ["sh", "-c", arg] } : null;
        default: return null;
    }
}

/** " Ctrl+Super + Left " → "ctrl+super+left" — dedupe key for escape merge. */
function normKeys(keys: string): string {
    return keys.toLowerCase().split("+").map((k) => k.trim()).filter(Boolean).join("+");
}

/** What `{cli}` expands to in escape-shortcut commands — dev trees resolve
 *  to the repo's cli.ts via bun; packaged builds dispatch cli areas off the
 *  appdir launcher (`$DIR/cruiser vm …`, sibling of the runtime binary).
 *  Shortcut daemons (gsd, kglobalaccel) exec through `sh -c` with the
 *  SESSION's PATH — which may lack ~/.bun/bin — so binaries are referenced
 *  by absolute path and single-quoted for the shell. */
export function cruiserCliPrefix(): string {
    const q = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
    const cli = new URL("../../../src/cli.ts", import.meta.url).pathname;
    if (!existsSync(cli)) {
        const launcher = join(dirname(process.execPath), "cruiser");
        return existsSync(launcher) ? q(launcher) : "cruiser";
    }
    const bun = /bun/.test(process.execPath.split("/").pop() ?? "") ? q(process.execPath) : "bun";
    return `${bun} run ${q(cli)}`;
}
