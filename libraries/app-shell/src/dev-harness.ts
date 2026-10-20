// ============================================================================
// dev-harness.ts — the env-gated dev/screenshot harness for native-entry.
//
// Everything here is inert without its env knob; production boot paths it
// nowhere. Knobs:
//   CRUISER_SCREENSHOT=/path.png CRUISER_SHOT_FRAMES=N  frame-N screenshot
//   CRUISER_FAKE_VM=1                                  append a fake running VM
//     (+CRUISER_FAKE_TICK_MS=N — jitter its metrics every N ms: mutation
//      storm for the region-patch/raster path)
//   CRUISER_ROUTE=create|vm|settings|logs (+CRUISER_VM, CRUISER_LOG_SOURCE,
//     CRUISER_LOG_FILE, CRUISER_FAKE_BUSY=sec)         preselect a route
//   CRUISER_INPUT_SCRIPT=/path.json (+CRUISER_UI_ZOOM, CRUISER_INPUT_DELAY)
//     scripted input through the real InputBus — wait/shot/route/down/move/
//     up/click/key/type/wheel/siv/scl/sve/probe/termrect steps
//   CRUISER_WIN_W/CRUISER_WIN_H, CRUISER_SMOKE_MS      (consumed by the entry)
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import type { InputBus } from "./input-bus";
import type { CruiserService } from "./service";
import type { CruiserShell } from "./shell";
import type { Store, VmSummary } from "./store";

const log = createLogger("info");

/** createNativeHost opts for the frame-N screenshot knob (spread it in). */
export function screenshotHostOpts(env: NodeJS.ProcessEnv = process.env): { screenshotPath: string; screenshotAfterFrames: number } | {} {
    return env.CRUISER_SCREENSHOT
        ? { screenshotPath: env.CRUISER_SCREENSHOT, screenshotAfterFrames: Number(env.CRUISER_SHOT_FRAMES ?? 20) }
        : {};
}

export interface DevHarnessCtx {
    store: Store;
    svc: CruiserService;
    bus: InputBus;
    shell: CruiserShell;
    /** Script "shot" steps enqueue here — the frame loop drains one per
     *  frame (the capture needs the just-rendered texture). */
    shotRequests: string[];
    env?: NodeJS.ProcessEnv;
}

/** Wire every env-gated dev hook. No-op when none are set. */
export function initDevHarness(ctx: DevHarnessCtx): void {
    const env = ctx.env ?? process.env;
    if (env.CRUISER_FAKE_VM) installFakeVm(ctx, env);
    if (env.CRUISER_ROUTE) forceRoute(ctx, env);
    if (env.CRUISER_INPUT_SCRIPT) runInputScript(ctx, env);
}

// ── CRUISER_FAKE_VM ──

/** Appends a fake running VM on every refresh — exercises the running
 *  vmrow layout (sparks + extra buttons). CRUISER_FAKE_TICK_MS jitters its
 *  metric samples on an interval — a cheap mutation storm driving the
 *  store→region-patch→raster path far faster than the real 3s cadence
 *  (smoke runs with screenshots verify textures survive partial updates). */
function installFakeVm({ store }: DevHarnessCtx, env: NodeJS.ProcessEnv): void {
    const fake: VmSummary = {
        name: "fake-runner", state: "running", gpuMode: "venus", swVk: false, headMode: "windowed",
        viewer: "dmabuf", vmDir: "/var/tmp/cruiser-vms/fake-runner",
        forwards: [],
        cpus: 4, memMiB: 8192, diskGiB: 64, nestedVirt: false, sshPort: 4022, rdpPort: 43389,
        provisioned: "cloudimg", persist: "daemonize", autostart: false, netMode: "nat",
        snapshots: [], vd: 0, usbKeys: [],
        username: "cruiser", hasPassword: true,
        encrypt: "off", keyStorage: "store", diskLocked: false,
        snapAuto: "off", snapTrigger: "stop", snapKeep: 5,
        description: "fake VM for the screenshot harness",
        origin: "gist:0123456789abcdef0123456789abcdef",
        shares: [
            { idx: 0, tag: "src", hostPath: "/home/u/dev/project", mode: "mount", direction: "both", enabled: true, deletions: false },
            { idx: 1, tag: "assets", hostPath: "/home/u/assets", guestPath: "/opt/assets", mode: "mount", direction: "host-to-guest", enabled: true, deletions: false },
            { idx: 2, tag: "notes", hostPath: "/home/u/notes.md", mode: "copy", direction: "both", enabled: true, deletions: false },
            { idx: 3, tag: "secrets", hostPath: "/home/u/.ssh/config", mode: "copy", direction: "host-to-guest", enabled: false, deletions: false },
        ],
        cpu: [12, 30, 55, 22, 40, 68, 35], mem: [40, 44, 60, 38, 52, 55, 48],
        disk: [40, 120, 800, 210, 1300, 90, 420], net: [512e3, 1.4e6, 900e3, 3.2e6, 220e3, 780e3, 1.1e6],
        gpu: [5, 18, 42, 30, 55, 12, 24], gpuMemBytes: 412 * 1048576,
    };
    const orig = store.getState().setVms;
    store.setState({ setVms: (vms) => orig([fake, ...vms.filter((v) => v.name !== fake.name)]) });
    const tickMs = Number(env.CRUISER_FAKE_TICK_MS) || 0;
    if (tickMs > 0) {
        const jit = (a: number[], lo: number, hi: number) =>
            [...a.slice(-40), Math.round(lo + Math.random() * (hi - lo))];
        setInterval(() => {
            // Mutate the fixture in place — the setVms wrapper above
            // re-prepends `fake`, so a fresh object here would be dropped.
            fake.cpu = jit(fake.cpu, 5, 90);
            fake.mem = jit(fake.mem, 20, 80);
            fake.disk = jit(fake.disk, 0, 1500);
            fake.net = jit(fake.net, 0, 4e6);
            fake.gpu = jit(fake.gpu, 0, 70);
            store.getState().setVms([...store.getState().vms]);
        }, tickMs);
    }
}

// ── CRUISER_ROUTE ──

/** Preselect a route for screenshots (CRUISER_VM overrides the vm selected
 *  for vm/logs routes). */
function forceRoute({ store, svc, shell }: DevHarnessCtx, env: NodeJS.ProcessEnv): void {
    const r = env.CRUISER_ROUTE as "create" | "vm" | "settings" | "logs" | "term";
    const vmName = env.CRUISER_VM ?? "test1";
    setTimeout(() => {
        store.getState().setRoute(r, r === "vm" || r === "logs" || r === "term" ? vmName : null);
        if (r === "logs") {
            if (env.CRUISER_LOG_SOURCE === "journal") store.getState().setLogs({ source: "journal" });
            if (env.CRUISER_LOG_FILE) store.getState().setLogs({ file: env.CRUISER_LOG_FILE });
            void svc.refreshLogs();
            void svc.loadLogUnits();
            // first fetch races service init — retry once so the shot has text
            setTimeout(() => void svc.refreshLogs(), 2500);
        }
    }, 1500);
    if (r === "settings") setTimeout(() => svc.runDoctor(), 1600);
    if (r === "create" && env.CRUISER_FAKE_BUSY) {
        // Repro for the stale-scroll blank pane: pin .content's scrollport
        // to the bottom (the Create button lives there), then flip busy
        // like createVm does — the form→spinner swap must still paint.
        const panel = () => (shell as unknown as { panel?: { scrollTo(t: string, x: number, y: number): void } }).panel;
        setTimeout(() => panel()?.scrollTo(".content", 0, 1e9), 2200);
        setTimeout(() => {
            store.getState().setBusy(true);
            store.getState().setStatus("create test-1: downloading image…");
        }, Number(env.CRUISER_FAKE_BUSY) * 1000 || 3600);
    }
}

// ── CRUISER_INPUT_SCRIPT ──

/** A JSON array of input steps dispatched through the real InputBus (so
 *  HtmlUiHost's production routing runs). Pointer steps take {sel} (resolved
 *  via getRect → center) or x/y in display px; click takes {jitter} (px
 *  offset between down and up); probe logs focusedNode + per-panel editing
 *  state. */
function runInputScript({ store, bus, shell, shotRequests }: DevHarnessCtx, env: NodeJS.ProcessEnv): void {
    const zoom = Number(env.CRUISER_UI_ZOOM ?? 1.25);
    const panel = () => (shell as unknown as { panel: { getRect(s: string): Promise<{ x: number; y: number; w: number; h: number } | null>; focusedNode(): Promise<number> } | null }).panel;
    type Step = Record<string, any>;
    const center = async (s: Step): Promise<{ x: number; y: number }> => {
        if (s.sel) {
            const r = await panel()?.getRect(s.sel);
            if (!r) throw new Error(`no rect for ${s.sel}`);
            return { x: (r.x + r.w / 2) * zoom, y: (r.y + r.h / 2) * zoom };
        }
        return { x: s.x ?? 0, y: s.y ?? 0 };
    };
    const file = env.CRUISER_INPUT_SCRIPT!;
    void (async () => {
        const steps = JSON.parse((await import("node:fs")).readFileSync(file, "utf8")) as Step[];
        await new Promise<void>((r) => setTimeout(r, Number(env.CRUISER_INPUT_DELAY ?? 2200)));
        for (const [i, s] of steps.entries()) {
            try {
                switch (s.t) {
                    case "wait": await new Promise<void>((r) => setTimeout(r, s.ms ?? 100)); continue;
                    case "shot": shotRequests.push(s.path ?? `/var/tmp/cruiser-shot-${i}.png`); continue;
                    case "route": store.getState().setRoute(s.route, s.vm ?? null); break;
                    case "down": { const c = await center(s); bus.pointerDown(c.x, c.y, s.button ?? 0); break; }
                    case "move": { const c = await center(s); bus.pointerMove(c.x, c.y); break; }
                    case "up": { const c = await center(s); bus.pointerUp(c.x, c.y, s.button ?? 0); break; }
                    case "click": {
                        const c = await center(s);
                        const j = s.jitter ?? 0;
                        bus.pointerDown(c.x, c.y, s.button ?? 0);
                        if (j) bus.pointerMove(c.x + j, c.y + j * 0.5);
                        bus.pointerUp(c.x + j, c.y + j * 0.5, s.button ?? 0);
                        break;
                    }
                    case "key": { bus.key(true, s.key, s.code ?? "", s.mods); bus.key(false, s.key, s.code ?? "", s.mods); break; }
                    case "type": {
                        for (const ch of String(s.text)) {
                            const code = ch === " " ? "Space" : `Key${ch.toUpperCase()}`;
                            bus.key(true, ch, code); bus.key(false, ch, code);
                        }
                        break;
                    }
                    case "wheel": { const c = await center(s); bus.wheel(c.x, c.y, s.dx ?? 0, s.dy ?? 0); break; }
                    case "siv": (shell as unknown as { panel: { scrollIntoView(sel: string, o?: object): void } | null }).panel?.scrollIntoView(s.sel, s.opts); break;
                    case "scl": (shell as unknown as { panel: { scrollTo(sel: string, x: number, y: number, sm?: boolean): void } | null }).panel?.scrollTo(s.sel, s.x ?? 0, s.y ?? 0, s.smooth); break;
                    case "sve": {
                        // scrollIntoView only moves the root viewport — .content
                        // is a nested scrollport. Reset to top so getRect yields
                        // doc-space y, then scrollTo the element into view.
                        const p = panel() as { scrollTo(sel: string, x: number, y: number): void } | null;
                        if (!p) break;
                        p.scrollTo(".content", 0, 0);
                        await new Promise<void>((r) => setTimeout(r, 350));
                        const r = await panel()?.getRect(s.sel);
                        if (!r) throw new Error(`no rect for ${s.sel}`);
                        p.scrollTo(".content", 0, Math.max(0, r.y + r.h / 2 - (s.at ?? 200)));
                        break;
                    }
                    case "probe": {
                        const fn = await panel()?.focusedNode();
                        const uiHost = (shell as unknown as { host: { panels: Map<string, { editing: boolean }> } }).host;
                        const editing = [...uiHost.panels.values()].map((p) => p.editing);
                        log.info("cruiser", `[probe:${i}] ${s.label ?? ""} focused=${fn} editing=${JSON.stringify(editing)}`);
                        break;
                    }
                    case "termrect": {
                        // Resize the live TermView without a window resize —
                        // exercises bridge.resize → page refit → size msg →
                        // PTY resize (guest `stty size`). w/h are fractions
                        // of the current rect; no args → syncRect() restores.
                        const mgr = (shell as unknown as { termMgr: unknown }).termMgr as {
                            entries: Map<string, { view: { setRect(r: { x: number; y: number; w: number; h: number }): void; comp: { rect: { x: number; y: number; w: number; h: number } } } }>;
                            syncRect(): Promise<void>;
                        };
                        const name = s.vm ?? store.getState().selectedVm;
                        const e = name ? mgr.entries.get(name) : undefined;
                        if (!e) throw new Error(`no term view for ${name}`);
                        if (s.w === undefined && s.h === undefined) { await mgr.syncRect(); break; }
                        const r = { ...e.view.comp.rect };
                        r.w = Math.max(40, Math.round(r.w * (s.w ?? 1)));
                        r.h = Math.max(40, Math.round(r.h * (s.h ?? 1)));
                        e.view.setRect(r);
                        break;
                    }
                    case "termeval": {
                        // Eval JS inside the live term view's page (xterm's
                        // `term`/`fit` bindings are global) and log the result.
                        const mgr = (shell as unknown as { termMgr: unknown }).termMgr as {
                            entries: Map<string, { view: { id: string; bridge: { eval(id: string, js: string): Promise<unknown> } } }>;
                        };
                        const name = s.vm ?? store.getState().selectedVm;
                        const e = name ? mgr.entries.get(name) : undefined;
                        if (!e) throw new Error(`no term view for ${name}`);
                        const r = await e.view.bridge.eval(e.view.id, String(s.js ?? "null")).catch((err) => `eval failed: ${err}`);
                        log.info("cruiser", `[termeval:${i}] ${JSON.stringify(r)}`);
                        break;
                    }
                    case "termstat": {
                        // Native-side frame state: texture-source dims vs the
                        // bridge's reported view dims + comp rect.
                        const mgr = (shell as unknown as { termMgr: unknown }).termMgr as {
                            entries: Map<string, { view: { id: string; src: { width: number; height: number; hasFrame: boolean }; comp: { rect: { x: number; y: number; w: number; h: number } }; bridge: { getDimensions(id: string): { w: number; h: number } | null; pending?(id: string): boolean } } }>;
                        };
                        const name = s.vm ?? store.getState().selectedVm;
                        const e = name ? mgr.entries.get(name) : undefined;
                        if (!e) throw new Error(`no term view for ${name}`);
                        log.info("cruiser", `[termstat:${i}] src=${e.view.src.width}x${e.view.src.height} hasFrame=${e.view.src.hasFrame} rect=${JSON.stringify(e.view.comp.rect)} dims=${JSON.stringify(e.view.bridge.getDimensions(e.view.id))}`);
                        break;
                    }
                }
            } catch (e) { log.warn("cruiser", `[script:${i}] ${s.t} failed: ${e}`); }
            await new Promise<void>((r) => setTimeout(r, s.gap ?? 160));
        }
        log.info("cruiser", "[script] done");
    })();
}
