// ============================================================================
// term-manager.ts — owns embedded terminals: one TermSession (term-dd → ssh
// → guest) + one TermView (webui xterm.js panel) per VM, kept alive across
// route switches so a guest `apt upgrade` survives a trip to the logs.
//
// Layout: the term route's markup is just a head strip + an empty
// #termbox div; the manager queries #termbox's doc-space rect via the Blitz
// panel (async, post-layout) and places the view rect over it in buffer px
// (doc px × the mount zoom). Re-queries on resize and after re-layouts.
// ============================================================================

import type { WebUiHostBridge } from "@downdraft/engine/libraries/webui/types";
import { createWebUiHost } from "@downdraft/platform-native/webui/webui-host";
import type { UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import { createLogger } from "@downdraft/engine/util/logger";
import type { InputBus } from "../input-bus";
import type { CruiserService } from "../service";
import type { Store } from "../store";
import { TermSession } from "./term-session";
import { TermView } from "./term-view";

const log = createLogger("info");

interface TermEntry {
    view: TermView;
    session: TermSession | null;
    /** unsubs for session/view wiring (view.dispose clears its own subs). */
    unwire: () => void;
    pending: boolean;      // a session (re)spawn is in flight
}

function b64enc(u8: Uint8Array): string {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000)
        s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
}
function b64dec(s: string): Uint8Array {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}

export class TermManager {
    private entries = new Map<string, TermEntry>();
    private zoom: number;

    constructor(
        private device: GPUDevice,
        private format: GPUTextureFormat,
        private bus: InputBus,
        private store: Store,
        private svc: CruiserService,
        private getPanel: () => UiPanelHandle | null,
    ) {
        this.zoom = Number(process.env.CRUISER_UI_ZOOM ?? 1.25);
    }

    // Cruiser runs a bespoke native host (no top-level appId) so the engine
    // never installs globalThis.downdraft — createWebUiHost() is the same
    // factory the bridge uses, cached per-backend, and returns null when the
    // cdylib or runtime is missing (fallback: host terminal emulator).
    private bridge(): WebUiHostBridge | null {
        return createWebUiHost()?.api ?? null;
    }

    /** Whether the embedded path can work at all (backend + helper staged).
     *  Probing runs webUiGlobalInit — call it only when a terminal is
     *  actually requested (it spawns the backend's aux processes). */
    static embeddedAvailable(): boolean {
        return !!createWebUiHost()?.available;
    }

    /**
     * Route watcher — called by the shell after every doc apply. Entering
     * the term route activates (creating if needed) that VM's terminal;
     * leaving it deactivates all views (sessions keep running).
     */
    async syncRoute(): Promise<void> {
        const st = this.store.getState();
        const onTerm = st.route === "term" && st.selectedVm !== null;
        this.entries.forEach((e, name) => { e.view.active = onTerm && name === st.selectedVm; });
        if (onTerm) await this.ensure(st.selectedVm!);
    }

    /** Create the VM's session+view if absent; reconnect if the view is
     *  alive but the session ended and a respawn was requested. */
    async ensure(name: string, opts: { reconnect?: boolean } = {}): Promise<void> {
        const st = this.store.getState();
        const existing = this.entries.get(name);
        if (existing && !opts.reconnect) return;
        if (existing?.pending) return;
        // CRUISER_TERM_LOCAL: dev-harness shell — term-dd spawns a local
        // shell instead of ssh (fake VMs, UI screenshots, layout work).
        // "1" → bash -l; a path/command → "<it> -l".
        const localEnv = process.env.CRUISER_TERM_LOCAL;
        const localCmd = localEnv ? [localEnv === "1" ? "bash" : localEnv, "-l"] : null;
        const spec = this.svc.specOf(name);
        if (!spec && !localCmd) { st.setTermLine("vm not found"); return; }

        // View first — the rect needs the mounted #termbox node.
        let entry = existing;
        if (!entry) {
            const rect = await this.termRect();
            if (!rect) { st.setTermLine("terminal area not laid out"); return; }
            const bridge = this.bridge();
            if (!bridge) { st.setTermLine("webui backend unavailable — use `cruiser vm ssh`"); return; }
            const view = await TermView.create({
                device: this.device, format: this.format, bus: this.bus, bridge,
                rect, fontSize: Math.round(13 * this.zoom),
                onMessage: (p) => this.pageMessage(name, p),
                onStatus: (s) => { if (s !== "running") this.setLine(name, `webui view ${s}`); },
                onConsole: (_l, t) => log.info("term", `${name} page: ${t}`),
            }).catch((e) => { this.setLine(name, `view failed: ${(e as Error).message}`); return null; });
            if (!view) return;
            entry = { view, session: null, unwire: () => {}, pending: false };
            this.entries.set(name, entry);
        }

        // (Re)connect the session.
        if (!entry.session || entry.session.ended || opts.reconnect) {
            entry.unwire();
            entry.pending = true;
            this.setLine(name, "connecting…");
            try {
                const session = await TermSession.open(spec, localCmd ?? undefined);
                entry.session = session;
                entry.unwire = session.onEvent((ev) => this.sessionEvent(name, ev));
                this.setLine(name, localCmd ? `local shell (${localCmd[0]})` : `ssh 127.0.0.1:${spec?.network.sshPort ?? "?"}`);
            } catch (e) {
                this.setLine(name, `spawn failed: ${(e as Error).message}`);
            } finally {
                entry.pending = false;
            }
        }
    }

    private setLine(name: string, line: string): void {
        const st = this.store.getState();
        if (st.route === "term" && st.selectedVm === name) st.setTermLine(line);
    }

    // ── session ↔ view traffic ──

    private sessionEvent(name: string, ev: { t: string; bytes?: Uint8Array; code?: number; message?: string }): void {
        const e = this.entries.get(name);
        if (!e) return;
        if (ev.t === "data") {
            e.view.post({ t: "out", d: b64enc(ev.bytes!) });
        } else if (ev.t === "exit") {
            e.view.post({ t: "status", s: `session ended (exit ${ev.code}) — click to reconnect` });
            this.setLine(name, `exited ${ev.code} — Reconnect to start a new session`);
        } else if (ev.t === "err") {
            e.view.post({ t: "status", s: `error: ${ev.message}` });
            this.setLine(name, ev.message!);
        }
    }

    private pageMessage(name: string, p: unknown): void {
        const e = this.entries.get(name);
        const m = p as { t?: string; d?: string; c?: number; r?: number };
        if (!e || !m || typeof m !== "object") return;
        if (m.t === "in" && typeof m.d === "string") e.session?.write(b64dec(m.d));
        else if (m.t === "size" && m.c && m.r) e.session?.resize(m.c, m.r);
    }

    /** User clicked Reconnect — kill the session, reset xterm, respawn. */
    reconnect(name: string): void {
        const e = this.entries.get(name);
        if (e) {
            e.view.post({ t: "reset" });
            e.session?.close();
        }
        void this.ensure(name, { reconnect: true });
    }

    // ── layout ──

    /** #termbox doc-rect → buffer px, or null while the route isn't mounted. */
    private async termRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
        const panel = this.getPanel();
        if (!panel) return null;
        for (let i = 0; i < 40; i++) {
            const r = await panel.getRect("#termbox").catch(() => null);
            if (r && r.w > 10 && r.h > 10) {
                // Snap to integer buffer px — the blit samples linearly and a
                // fractional composite rect smears every glyph (TermView
                // snaps too; doing it here keeps the doc-edge intent).
                const x = Math.round(r.x * this.zoom);
                const y = Math.round(r.y * this.zoom);
                return {
                    x, y,
                    w: Math.round((r.x + r.w) * this.zoom) - x,
                    h: Math.round((r.y + r.h) * this.zoom) - y,
                };
            }
            await new Promise((res) => setTimeout(res, 50));
        }
        return null;
    }

    /** Re-query after window resize / doc relayout — the view tracks it. */
    async syncRect(): Promise<void> {
        const st = this.store.getState();
        if (st.route !== "term" || !st.selectedVm) return;
        const e = this.entries.get(st.selectedVm);
        if (!e) return;
        const r = await this.termRect();
        if (r) e.view.setRect(r);
    }

    /** View pixels → surface. Active views only (one at a time in practice). */
    render(pass: GPURenderPassEncoder, w: number, h: number): void {
        this.entries.forEach((e) => e.view.render(pass, w, h));
    }

    /** Kill a VM's terminal entirely (vm delete, app teardown). */
    drop(name: string): void {
        const e = this.entries.get(name);
        if (!e) return;
        this.entries.delete(name);
        e.unwire();
        e.session?.close();
        e.view.dispose();
    }

    dispose(): void {
        [...this.entries.keys()].forEach((n) => this.drop(n));
    }
}
