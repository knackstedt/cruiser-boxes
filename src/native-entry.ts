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
import type { NativeWindowConfig } from "@downdraft/platform-native/window/native-window";
import { InputBus } from "../libraries/app-shell/src/input-bus";
import { CruiserShell } from "../libraries/app-shell/src/shell";
import { CruiserService } from "../libraries/app-shell/src/service";
import { createCruiserStore } from "../libraries/app-shell/src/store";
import { mark } from "../libraries/app-shell/src/startup-profile";

const log = createLogger("info");

// Runtime boot + module-graph eval happened before this line ran.
mark("entry-module");

const WIDTH = 1100;
const HEIGHT = 720;

// Desktop-entry identity — env covers launcher-exported vars (packaged
// node runtime); the window config fields below cover runtimes whose
// process.env writes never reach the dlopen'd lib (Bun dev).
process.env.DD_APP_ID ??= "dev.cruiser.app";
process.env.DD_APP_ICON ??= fileURLToPath(new URL("../assets/icon.png", import.meta.url));

const host = await createNativeHost({
    // appId/iconPath are post-0.3.0 NativeWindowConfig fields — the cast
    // keeps CI (npm @downdraft/*) typechecking until the next engine release;
    // older builds ignore the extra fields at runtime. Drop it once the
    // fields land on npm.
    window: {
        title: "Cruiser", width: WIDTH, height: HEIGHT,
        appId: "dev.cruiser.app",
        iconPath: fileURLToPath(new URL("../assets/icon.png", import.meta.url)),
    } as NativeWindowConfig,
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
