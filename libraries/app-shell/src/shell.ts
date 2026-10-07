// ============================================================================
// shell.ts — the cruiser UI shell: an HtmlUiHost panel filling the native
// window, fed by the zustand store. No GameModule / sim worker — this is a
// desktop app riding the bare native host.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { HtmlUiHost, type UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import type { InputBus } from "./input-bus";
import type { Store } from "./store";
import { renderRoute } from "./screens";

const log = createLogger("info");

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
        this.host.onAction("nav", (d) => {
            const route = d.route as "home" | "create" | "settings" | undefined;
            if (route) this.store.getState().setRoute(route, d.vm ?? null);
        });
        log.info("shell", "mounted");
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
