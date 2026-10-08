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

import { createLogger } from "@downdraft/engine/util/logger";
import { createNativeHost } from "@downdraft/platform-native/native-host";
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

const host = await createNativeHost({
    window: { title: "Cruiser", width: WIDTH, height: HEIGHT },
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
// dev harness knob: CRUISER_ROUTE=create|vm|settings preselects a route for screenshots
if (process.env.CRUISER_ROUTE) {
    const r = process.env.CRUISER_ROUTE as "create" | "vm" | "settings";
    setTimeout(() => store.getState().setRoute(r, r === "vm" ? "test1" : null), 1500);
    if (r === "settings") setTimeout(() => svc.runDoctor(), 1600);
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

// dev harness knob: CRUISER_SMOKE_MS=N auto-exits after N ms (no window close needed)
const smokeMs = Number(process.env.CRUISER_SMOKE_MS ?? 0);
await new Promise<void>((resolve) => {
    win.addEventListener("close", () => resolve());
    if (smokeMs > 0) setTimeout(resolve, smokeMs);
});

shell.dispose();
await svc.dispose();
host.destroy();
log.info("cruiser", "exit");
