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
import { createNativeHost } from "@downdraft/platform-native";
import { InputBus } from "../libraries/app-shell/src/input-bus";
import { CruiserShell } from "../libraries/app-shell/src/shell";
import { createCruiserStore } from "../libraries/app-shell/src/store";

const log = createLogger("info");

const WIDTH = 1100;
const HEIGHT = 720;

const host = await createNativeHost({
    window: { title: "Cruiser", width: WIDTH, height: HEIGHT },
    services: "inline",
});

const { surface, device, window: win } = host;
const gpuCtx = surface.getContext("webgpu")!;
const format = host.gpu.getPreferredCanvasFormat() as GPUTextureFormat;
const CLEAR = { r: 0.063, g: 0.078, b: 0.102, a: 1 };

const bus = new InputBus();
const store = createCruiserStore();
const shell = new CruiserShell(device as unknown as GPUDevice, format, surface.width, surface.height, bus, store);

// ── Input routing (surface = pointer/wheel, window = keys) ──

surface.addEventListener("mousedown", (e: any) => { bus.pointerDown(e.clientX, e.clientY, e.button ?? 0); });
surface.addEventListener("mouseup", (e: any) => { bus.pointerUp(e.clientX, e.clientY, e.button ?? 0); });
surface.addEventListener("mousemove", (e: any) => { bus.pointerMove(e.clientX, e.clientY); });
surface.addEventListener("wheel", (e: any) => { bus.wheel(e.clientX, e.clientY, e.deltaX ?? 0, e.deltaY ?? 0); });
win.addEventListener("keydown", (e: any) => { if (!e.repeat) bus.key(true, e.key ?? "", e.code ?? ""); });
win.addEventListener("keyup", (e: any) => { bus.key(false, e.key ?? "", e.code ?? ""); });
win.addEventListener("resize", (e: any) => { shell.resize(e.width, e.height); });

// ── Frame loop ──

function frame(): void {
    const tex = gpuCtx.getCurrentTexture();
    if (!tex) { requestAnimationFrame(frame); return; }
    const encoder = (device as unknown as GPUDevice).createCommandEncoder();
    const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: tex.createView() as unknown as GPUTextureView, loadOp: "clear" as GPULoadOp, clearValue: CLEAR, storeOp: "store" as GPUStoreOp }],
    });
    shell.composite(pass);
    pass.end();
    (device as unknown as GPUDevice).queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

await new Promise<void>((resolve) => {
    win.addEventListener("close", () => resolve());
});

shell.dispose();
host.destroy();
log.info("cruiser", "exit");
