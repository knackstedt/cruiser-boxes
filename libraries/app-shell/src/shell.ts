// ============================================================================
// shell.ts — the cruiser UI shell: an HtmlUiHost panel filling the native
// window, fed by the zustand store and wired to CruiserService actions.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { HtmlUiHost, type UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import type { InputBus } from "./input-bus";
import type { CruiserService } from "./service";
import type { Store, CreateForm } from "./store";
import { renderRoute } from "./screens";

const log = createLogger("info");

const NUM_FIELDS: Set<string> = new Set(["cpus", "memMiB", "diskGiB"]);

export class CruiserShell {
    private host: HtmlUiHost;
    private panel: UiPanelHandle | null = null;
    private W: number;
    private H: number;
    private unsub: () => void;

    constructor(
        device: GPUDevice,
        format: GPUTextureFormat,
        width: number,
        height: number,
        private bus: InputBus,
        private store: Store,
        private svc: CruiserService,
    ) {
        this.W = width;
        this.H = height;
        this.host = new HtmlUiHost(device, format);
        this.host.bindInput(bus);
        this.panel = this.host.mount({
            rect: { x: 0, y: 0, w: width, h: height },
            html: renderRoute(store.getState()),
            scale: 1,
        });
        // Re-render on state change (cheap for now; targeted mutations later).
        let pending = false;
        this.unsub = store.subscribe(() => {
            if (pending) return;
            pending = true;
            queueMicrotask(() => {
                pending = false;
                this.panel?.setHtml(renderRoute(this.store.getState()));
            });
        });
        this.wireActions();
        this.wireInputs();
        log.info("shell", "mounted");
    }

    private wireActions(): void {
        const st = () => this.store.getState();
        const svc = this.svc;
        this.host.onAction("nav", (d) => {
            const route = d.route as "home" | "create" | "settings" | "vm" | undefined;
            if (route) st().setRoute(route, d.vm ?? null);
        });
        this.host.onAction("set-field", (d) => {
            const k = d.field as keyof CreateForm;
            if (!k) return;
            const v = NUM_FIELDS.has(k) ? Number(d.value ?? 0) : (d.value ?? "");
            st().setField(k, v as never);
        });
        this.host.onAction("vm-create", () => { svc.createVm(); });
        this.host.onAction("vm-start", (d) => { if (d.vm) svc.start(d.vm); });
        this.host.onAction("vm-stop", (d) => { if (d.vm) svc.stop(d.vm); });
        this.host.onAction("vm-kill", (d) => { if (d.vm) svc.kill(d.vm); });
        this.host.onAction("vm-rm", (d) => { if (d.vm) svc.remove(d.vm); });
        this.host.onAction("vm-view", (d) => { if (d.vm) svc.view(d.vm); });
        this.host.onAction("vm-snap", (d) => { if (d.vm) svc.snapshot(d.vm); });
        this.host.onAction("vm-restore", (d) => { if (d.vm && d.snap) svc.restoreSnapshot(d.vm, d.snap); });
        this.host.onAction("doctor", () => { svc.runDoctor(); });
    }

    /** <input data-field="x"> → store.create[x] on every input event. */
    private wireInputs(): void {
        this.panel?.onEvent((ev) => {
            if (ev.t !== "input" && ev.t !== "change") return;
            const field = ev.d?.field;
            if (!field || ev.v === undefined) return;
            const k = field as keyof CreateForm;
            const v = NUM_FIELDS.has(k) ? Number(ev.v) || 0 : ev.v;
            // setField would re-render and destroy the focused input — write
            // the value directly to keep DOM focus stable.
            const cur = this.store.getState().create;
            (cur as unknown as Record<string, unknown>)[k] = v;
        });
    }

    /** Render panels into an already-open render pass covering the surface. */
    composite(pass: GPURenderPassEncoder): void {
        this.host.compositor.render(pass, this.W, this.H);
    }

    resize(w: number, h: number): void {
        this.W = w; this.H = h;
        this.panel?.setRect({ x: 0, y: 0, w, h });
    }

    dispose(): void {
        this.unsub();
        this.host.dispose();
        this.panel = null;
    }
}
