// ============================================================================
// native-entry.ts — cruiser app entry.
//
// A DownDraft native desktop app: createNativeHost owns the winit window +
// wgpu device; the UI is an HtmlUiHost panel (Blitz rasterizer) composited
// into the surface each frame. No GameModule/sim worker — this is a desktop
// tool, not a game.
//
// Run: draft dev   (or: bun run src/native-entry.ts)
// ============================================================================

import { fileURLToPath } from "node:url";
import { createLogger } from "@downdraft/engine/util/logger";
import { createNativeHost } from "@downdraft/platform-native/native-host";
import { InputBus } from "../libraries/app-shell/src/input-bus";
import { CruiserShell } from "../libraries/app-shell/src/shell";
import { CruiserService } from "../libraries/app-shell/src/service";
import { createCruiserStore, type VmSummary } from "../libraries/app-shell/src/store";
import { mark } from "../libraries/app-shell/src/startup-profile";

const log = createLogger("info");

// Runtime boot + module-graph eval happened before this line ran.
mark("entry-module");

// dev harness knob: CRUISER_WIN_W/CRUISER_WIN_H override the initial size
const WIDTH = Number(process.env.CRUISER_WIN_W ?? 1100);
const HEIGHT = Number(process.env.CRUISER_WIN_H ?? 720);

// Desktop-entry identity — env covers launcher-exported vars (packaged
// node runtime); the window config fields below cover runtimes whose
// process.env writes never reach the dlopen'd lib (Bun dev).
process.env.DD_APP_ID ??= "dev.cruiser.app";
process.env.DD_APP_ICON ??= fileURLToPath(new URL("../assets/icon.png", import.meta.url));

const host = await createNativeHost({
    window: {
        title: "Cruiser", width: WIDTH, height: HEIGHT,
        appId: "dev.cruiser.app",
        iconPath: fileURLToPath(new URL("../assets/icon.png", import.meta.url)),
    },
    services: "inline",
    // dev harness knobs: CRUISER_SCREENSHOT=/path.png CRUISER_SHOT_FRAMES=20
    ...(process.env.CRUISER_SCREENSHOT
        ? { screenshotPath: process.env.CRUISER_SCREENSHOT, screenshotAfterFrames: Number(process.env.CRUISER_SHOT_FRAMES ?? 20) }
        : {}),
});

mark("host");
const { surface, device, window: win } = host;
const gpuCtx = surface.getContext("webgpu")!;
const format = host.gpu.getPreferredCanvasFormat() as GPUTextureFormat;
const CLEAR = { r: 0.063, g: 0.078, b: 0.102, a: 1 };

const bus = new InputBus();
const store = createCruiserStore();
const svc = new CruiserService(store);
const shell = new CruiserShell(device as unknown as GPUDevice, format, surface.width, surface.height, bus, store, svc);
mark("shell");
svc.init().then(() => mark("service-init")).catch((e) => store.getState().setStatus(`init failed: ${e}`));
// dev harness knob: CRUISER_FAKE_VM=1 appends a fake running VM on every
// refresh — exercises the running vmrow layout (sparks + extra buttons).
if (process.env.CRUISER_FAKE_VM) {
    const fake: VmSummary = {
        name: "fake-runner", state: "running", gpuMode: "venus", headMode: "windowed",
        cpus: 4, memMiB: 8192, diskGiB: 64, sshPort: 4022, rdpPort: 43389,
        provisioned: "cloudimg", persist: "daemonize", snapshots: [], vd: 0, usbKeys: [],
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
}
// dev harness knob: CRUISER_ROUTE=create|vm|settings|logs preselects a route for screenshots
// (CRUISER_VM overrides the vm selected for vm/logs routes)
if (process.env.CRUISER_ROUTE) {
    const r = process.env.CRUISER_ROUTE as "create" | "vm" | "settings" | "logs";
    const vmName = process.env.CRUISER_VM ?? "test1";
    setTimeout(() => {
        store.getState().setRoute(r, r === "vm" || r === "logs" ? vmName : null);
        if (r === "logs") {
            if (process.env.CRUISER_LOG_SOURCE === "journal") store.getState().setLogs({ source: "journal" });
            if (process.env.CRUISER_LOG_FILE) store.getState().setLogs({ file: process.env.CRUISER_LOG_FILE });
            void svc.refreshLogs();
            void svc.loadLogUnits();
            // first fetch races service init — retry once so the shot has text
            setTimeout(() => void svc.refreshLogs(), 2500);
        }
    }, 1500);
    if (r === "settings") setTimeout(() => svc.runDoctor(), 1600);
    if (r === "create" && process.env.CRUISER_FAKE_BUSY) {
        // Repro for the stale-scroll blank pane: pin .content's scrollport
        // to the bottom (the Create button lives there), then flip busy
        // like createVm does — the form→spinner swap must still paint.
        const panel = () => (shell as unknown as { panel?: { scrollTo(t: string, x: number, y: number): void } }).panel;
        setTimeout(() => panel()?.scrollTo(".content", 0, 1e9), 2200);
        setTimeout(() => {
            store.getState().setBusy(true);
            store.getState().setStatus("create test-1: downloading image…");
        }, Number(process.env.CRUISER_FAKE_BUSY) * 1000 || 3600);
    }
}

// ── Input routing (surface = pointer/wheel, window = keys) ──

surface.addEventListener("mousedown", (e: any) => { bus.pointerDown(e.clientX, e.clientY, e.button ?? 0); });
surface.addEventListener("mouseup", (e: any) => { bus.pointerUp(e.clientX, e.clientY, e.button ?? 0); });
surface.addEventListener("mousemove", (e: any) => { bus.pointerMove(e.clientX, e.clientY); });
surface.addEventListener("wheel", (e: any) => { bus.wheel(e.clientX, e.clientY, e.deltaX ?? 0, e.deltaY ?? 0); });
win.addEventListener("keydown", (e: any) => { bus.key(true, e.key ?? "", e.code ?? "", e); });
win.addEventListener("keyup", (e: any) => { bus.key(false, e.key ?? "", e.code ?? "", e); });
win.addEventListener("resize", (e: any) => { shell.resize(e.width, e.height); });

// ── Frame loop ──

const shotPath = process.env.CRUISER_SCREENSHOT;
const shotAt = Number(process.env.CRUISER_SHOT_FRAMES ?? 30);
/** Script-driven screenshot requests — drained one per frame (the capture
 *  needs the just-rendered texture, which only exists inside frame()). */
const shotRequests: string[] = [];

// dev harness knob: CRUISER_INPUT_SCRIPT=/path.json — a JSON array of input
// steps dispatched through the real InputBus (so HtmlUiHost's production
// routing runs). Steps: wait/shot/route/down/move/up/click/key/type/wheel/
// probe. Pointer steps take {sel} (resolved via getRect → center) or x/y in
// display px; click takes {jitter} (px offset between down and up); probe
// logs focusedNode + per-panel editing state.
if (process.env.CRUISER_INPUT_SCRIPT) {
    const zoom = Number(process.env.CRUISER_UI_ZOOM ?? 1.25);
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
    const file = process.env.CRUISER_INPUT_SCRIPT;
    void (async () => {
        const steps = JSON.parse((await import("node:fs")).readFileSync(file, "utf8")) as Step[];
        await new Promise<void>((r) => setTimeout(r, Number(process.env.CRUISER_INPUT_DELAY ?? 2200)));
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
                }
            } catch (e) { log.warn("cruiser", `[script:${i}] ${s.t} failed: ${e}`); }
            await new Promise<void>((r) => setTimeout(r, s.gap ?? 160));
        }
        log.info("cruiser", "[script] done");
    })();
}

let frames = 0;
let lastW = surface.width, lastH = surface.height;

let firstFrameMarked = false;
function frame(): void {
    if (!firstFrameMarked) { firstFrameMarked = true; mark("first-frame"); }
    // The WM can resize the window before/without a "resize" event (initial
    // layout, tiling). Track the real swapchain size — the panel and the
    // render pass must match it or wgpu drops the copy.
    if (surface.width !== lastW || surface.height !== lastH) {
        lastW = surface.width; lastH = surface.height;
        shell.resize(lastW, lastH);
    }
    const tex = gpuCtx.getCurrentTexture();
    if (!tex) { requestAnimationFrame(frame); return; }
    const encoder = (device as unknown as GPUDevice).createCommandEncoder();
    const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: tex.createView() as unknown as GPUTextureView, loadOp: "clear" as GPULoadOp, clearValue: CLEAR, storeOp: "store" as GPUStoreOp }],
    });
    shell.composite(pass);
    pass.end();
    (device as unknown as GPUDevice).queue.submit([encoder.finish()]);
    if (shotPath && ++frames === shotAt)
        (host as { captureScreenshot?: (p: string, t: unknown) => void }).captureScreenshot?.(shotPath, tex);
    if (shotRequests.length)
        (host as { captureScreenshot?: (p: string, t: unknown) => void })
            .captureScreenshot?.(shotRequests.shift()!, tex);
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Boot is complete — under the dev shell this is the real "boot done":
// the supervisor's finishSessionBoot waits on the entry import settling,
// which for this blocking entry only resolves at session end.
try { (globalThis as any).__ddSession?.finishSessionBoot?.(); } catch { /* no dev shell */ }

// dev harness knob: CRUISER_SMOKE_MS=N auto-exits after N ms (no window close needed)
const smokeMs = Number(process.env.CRUISER_SMOKE_MS ?? 0);
const tracker = (globalThis as any).__ddSession;
const bootSession = tracker?.session;
let windowClosed = false;
await new Promise<void>((resolve) => {
    const s = tracker?.session;
    // Our session dead/absent/superseded (a restart landed during boot):
    // resolve now — the close listener and onDispose registration would
    // both be dropped by the tracker, leaving this frame parked forever.
    if (tracker && (!s || s.dead || (bootSession && s !== bootSession))) return resolve();
    // The close may already have fired during boot — a listener registered
    // now would never see it.
    if ((win as any).closed) { windowClosed = true; return resolve(); }
    win.addEventListener("close", () => { windowClosed = true; resolve(); });
    // Dev-shell session restart (Tier 3): teardown releases this wait via
    // onDispose so the suspended frame completes instead of pinning the
    // dead module env and jamming the supervisor's reimport queue.
    tracker?.onDispose?.(() => resolve());
    if (smokeMs > 0) setTimeout(resolve, smokeMs);
});

shell.dispose();
await svc.dispose();
if (windowClosed || !tracker) {
    host.destroy();
} else {
    // Session restart — the host is persistent-layer (the supervisor owns
    // its lifecycle); join the in-flight teardown and finish.
    try { await tracker.teardown?.({ destroyDevices: false }); } catch { /* already down */ }
}
log.info("cruiser", "exit");
