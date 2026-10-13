// ============================================================================
// term-view.ts — one embedded terminal: a webui (WPE/CEF) view running the
// xterm.js page, composited into the cruiser surface with the same
// primitives createWebUi uses (WebUiTextureSource + PanelBlitPass), minus
// the RendererModuleContext cruiser doesn't have.
//
// Input: subscribes to the InputBus at priority −20 — below html-ui's −10 —
// so pointers/keys inside the view rect go to the page and never reach
// Blitz. Clicking outside the rect releases focus back to the doc.
// ============================================================================

import type { WebUiHostBridge, WebUiInputEvent } from "@downdraft/engine/libraries/webui/types";
import { WebUiTextureSource } from "@downdraft/engine/modules/webui";
import { PanelBlitPass, type CompositePanel } from "@downdraft/engine/modules/html-ui";
import type { InputBus, InputEventControl } from "../input-bus";
import { termBundleReady, termPageHtml } from "./page";

export interface TermViewOpts {
    device: GPUDevice;
    format: GPUTextureFormat;
    bus: InputBus;
    bridge: WebUiHostBridge;
    /** Buffer-px rect the view composites into (input space). */
    rect: { x: number; y: number; w: number; h: number };
    id?: string;
    /** Page → host message sink — TermManager wires session traffic here. */
    onMessage?: (payload: unknown) => void;
    onStatus?: (status: string) => void;
    onConsole?: (level: number, text: string) => void;
}

export class TermView {
    readonly id: string;
    private bridge: WebUiHostBridge;
    private src!: WebUiTextureSource;
    private comp!: CompositePanel;
    private blit: PanelBlitPass;
    private unsubs: Array<() => void> = [];
    private focused = false;
    private ready = false;
    /** Messages posted before the page's "ready" beats — flushed on ready. */
    private backlog: unknown[] = [];
    /** false while the term route is hidden — no composite, no input. */
    active = true;

    private constructor(private opts: TermViewOpts) {
        this.bridge = opts.bridge;
        this.id = opts.id ?? `term-${Math.random().toString(36).slice(2, 8)}`;
        this.blit = new PanelBlitPass(opts.device, opts.format);
    }

    static async create(opts: TermViewOpts): Promise<TermView | null> {
        if (!termBundleReady()) throw new Error("term bundle not built — run `bun run term:bundle`");
        const v = new TermView(opts);
        const ok = await opts.bridge.createView({
            id: v.id,
            width: Math.round(opts.rect.w),
            height: Math.round(opts.rect.h),
            scale: 1,
            html: termPageHtml(),
            transparent: false,
            interactive: true,
            frameRate: 60,
        });
        if (!ok) return null;
        // Physical dims are authoritative — CSS size × scale.
        const dims = opts.bridge.getDimensions(v.id)
            ?? { w: Math.max(1, Math.round(opts.rect.w)), h: Math.max(1, Math.round(opts.rect.h)) };
        v.src = new WebUiTextureSource(opts.device, v.id, dims.w, dims.h, opts.bridge.pixelFormat(v.id));
        const ubo = v.blit.createUbo();
        v.comp = {
            ubo,
            bindGroup: v.blit.createBindGroup(v.src.getTexture(), ubo, v.src.srgbFormat),
            rect: { ...opts.rect },
        };
        if (opts.onMessage) v.unsubs.push(opts.bridge.onMessage(v.id, (p) => v.pageMessage(p)));
        if (opts.onStatus) v.unsubs.push(opts.bridge.onStatus(v.id, (s) => opts.onStatus?.(s)));
        if (opts.onConsole) v.unsubs.push(opts.bridge.onConsole(v.id, opts.onConsole));
        v.bindInput();
        return v;
    }

    /** Page → host message handling: "ready" flushes the backlog. */
    private pageMessage(p: unknown): void {
        if (p && typeof p === "object" && (p as { t?: string }).t === "ready") {
            this.ready = true;
            const q = this.backlog; this.backlog = [];
            q.forEach((m) => this.post(m));
            return;
        }
        this.opts.onMessage?.(p);
    }

    post(payload: unknown): void {
        if (!this.ready) { this.backlog.push(payload); return; }
        this.bridge.postMessage(this.id, payload);
    }

    /** Pull a dirty frame into the texture; call each frame while visible. */
    private frame(): void {
        try {
            if (this.src.update(this.bridge) === 2) {
                this.comp.bindGroup = this.blit.createBindGroup(
                    this.src.getTexture(), this.comp.ubo, this.src.srgbFormat);
            }
        } catch { /* dead view — leave the last frame */ }
    }

    render(pass: GPURenderPassEncoder, surfaceW: number, surfaceH: number): void {
        if (!this.active) return;
        this.frame();
        this.blit.render(pass, [this.comp], surfaceW, surfaceH);
    }

    setRect(rect: { x: number; y: number; w: number; h: number }): void {
        if (!this.comp) return;
        this.comp.rect = { ...rect };
        this.bridge.resize(this.id, Math.round(rect.w), Math.round(rect.h), 1);
    }

    // ── input ──

    private local(e: { clientX: number; clientY: number }) {
        return { x: e.clientX - this.comp.rect.x, y: e.clientY - this.comp.rect.y };
    }

    private inside(x: number, y: number): boolean {
        const r = this.comp.rect;
        return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
    }

    private send(ev: WebUiInputEvent): void {
        this.bridge.sendInputEvent(this.id, ev);
    }

    private static mods(e: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): string[] {
        const m: string[] = [];
        if (e.shiftKey) m.push("shift");
        if (e.ctrlKey) m.push("ctrl");
        if (e.altKey) m.push("alt");
        if (e.metaKey) m.push("meta");
        return m;
    }

    private bindInput(): void {
        const bus = this.opts.bus;
        this.unsubs.push(
            bus.onPointerMove((e, _ctrl) => {
                if (!this.active) return;
                const c = this.local(e);
                this.send({ type: "mouseMove", x: c.x, y: c.y, modifiers: TermView.mods(e) });
            }, -20),
            bus.onPointerDown((e, ctrl: InputEventControl) => {
                if (!this.active) return;
                if (!this.inside(e.clientX, e.clientY)) {
                    if (this.focused) { this.focused = false; this.bridge.setFocus(this.id, false); }
                    return;
                }
                ctrl.stopPropagation();
                this.focused = true;
                this.bridge.setFocus(this.id, true);
                const c = this.local(e);
                this.send({ type: "mouseDown", x: c.x, y: c.y, button: TermView.btn(e.button), modifiers: TermView.mods(e) });
            }, -20),
            bus.onPointerUp((e, ctrl: InputEventControl) => {
                if (!this.active) return;
                if (!this.inside(e.clientX, e.clientY) && !this.focused) return;
                if (this.inside(e.clientX, e.clientY)) ctrl.stopPropagation();
                const c = this.local(e);
                this.send({ type: "mouseUp", x: c.x, y: c.y, button: TermView.btn(e.button), modifiers: TermView.mods(e) });
            }, -20),
            bus.onWheel((e, ctrl: InputEventControl) => {
                if (!this.active) return;
                if (!this.inside(e.clientX, e.clientY)) return;
                ctrl.stopPropagation();
                const c = this.local(e);
                this.send({ type: "mouseWheel", x: c.x, y: c.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: TermView.mods(e) });
            }, -20),
            bus.onKeyDown((e, ctrl: InputEventControl) => {
                if (!this.active || !this.focused) return;
                ctrl.stopPropagation();
                this.send({ type: "keyDown", x: 0, y: 0, key: e.key, code: e.code,
                    text: e.key.length === 1 ? e.key : undefined,
                    modifiers: TermView.mods(e) });
            }, -20),
            bus.onKeyUp((e, _ctrl: InputEventControl) => {
                if (!this.active || !this.focused) return;
                this.send({ type: "keyUp", x: 0, y: 0, key: e.key, code: e.code, modifiers: TermView.mods(e) });
            }, -20),
        );
    }

    private static btn(b: number): "left" | "middle" | "right" {
        return b === 2 ? "right" : b === 1 ? "middle" : "left";
    }

    dispose(): void {
        this.unsubs.forEach((u) => u());
        this.unsubs = [];
        this.src?.destroy();
        void this.bridge.destroyView(this.id).catch(() => {});
    }
}
