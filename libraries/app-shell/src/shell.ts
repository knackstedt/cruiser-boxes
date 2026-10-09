// ============================================================================
// shell.ts — the cruiser UI shell: an HtmlUiHost panel filling the native
// window, fed by the zustand store and wired to CruiserService actions.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { HtmlUiHost, createLocalBackend, type UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import type { InputBus } from "./input-bus";
import type { CruiserService } from "./service";
import type { Store, CreateForm } from "./store";
import { renderRoute } from "./screens";
import { DISTROS } from "../../provision/src/distros";
import { DEVTOOLS } from "../../provision/src/packages";
import { registerUiFonts } from "./fonts";
import { RenderGate } from "./render-gate";
import { mark } from "./startup-profile";

const log = createLogger("info");

const NUM_FIELDS: Set<string> = new Set(["cpus", "memMiB", "diskGiB"]);
const BOOL_FIELDS: Set<string> = new Set(["snap", "extraFonts"]);

const SPIN = ["◐", "◓", "◑", "◒"];

export class CruiserShell {
    private host: HtmlUiHost;
    private panel: UiPanelHandle | null = null;
    private gate: RenderGate;
    private W: number;
    private H: number;
    private unsub: () => void;
    private spinIdx = 0;
    private spinTimer: ReturnType<typeof setInterval>;
    private scrollX = 0;
    private scrollY = 0;
    private lastRoute = "";

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
        // Doc backend: default resolution prefers a worker (raster off the
        // main thread — a full VMs-page repaint is ~20ms of CPU, so in-process
        // raster starves input during scroll/fade animations). Local remains
        // as the automatic fallback and via CRUISER_UI_BACKEND=local.
        this.host = new HtmlUiHost(device, format,
            process.env.CRUISER_UI_BACKEND === "local" ? createLocalBackend() : undefined);
        svc.uiBackend = this.host.backendKind === "worker" ? "worker" : "local (in-process)";
        mark("html-ui-host");
        this.host.bindInput(bus);
        // Before mount: the local backend applies resources in order, so the
        // first doc resolve sees the system fonts instead of the embedded
        // DejaVu fallback.
        registerUiFonts(this.host);
        mark("fonts");
        const html = renderRoute(store.getState());
        this.panel = this.host.mount({
            rect: { x: 0, y: 0, w: width, h: height },
            html,
            // zoom: layout runs at rect/zoom CSS px → UI renders zoom× bigger.
            // scale=1 keeps the raster at display res so text lands on hard
            // pixels instead of a downsampled (soft) supersample.
            zoom: Number(process.env.CRUISER_UI_ZOOM ?? 1.25),
            scale: Number(process.env.CRUISER_UI_SCALE ?? 1),
            // Wheel deltas ease out at frame cadence instead of instant
            // ~80px jumps per detent. CRUISER_SMOOTH_WHEEL=0 disables.
            smoothWheel: process.env.CRUISER_SMOOTH_WHEEL !== "0",
        });
        mark("panel-mount");
        this.lastRoute = `${store.getState().route}:${store.getState().selectedVm ?? ""}`;
        this.gate = new RenderGate(html, (h) => this.applyHtml(h));
        // Re-render on state change (cheap for now; targeted mutations later).
        let pending = false;
        this.unsub = store.subscribe(() => {
            if (pending) return;
            pending = true;
            queueMicrotask(() => {
                pending = false;
                this.gate.render(renderRoute(this.store.getState()));
            });
        });
        this.wireActions();
        this.wireInputs();
        // Spinner ticks only while busy (status text itself re-renders the
        // overlay) — direct setText so it doesn't trip the RenderGate.
        this.spinTimer = setInterval(() => {
            if (!this.store.getState().busy) return;
            this.panel?.setText("[data-spin]", SPIN[this.spinIdx++ % SPIN.length]!);
        }, 140);
        log.info("shell", "mounted");
    }

    /** Two-click guard for destructive actions: first click arms `token`
     *  (button re-renders as "Confirm…"), a second within 5s executes. */
    private confirmTimer: ReturnType<typeof setTimeout> | null = null;
    private armed(token: string): boolean {
        const st = this.store.getState();
        if (st.confirm === token) { st.setConfirm(null); return true; }
        st.setConfirm(token);
        if (this.confirmTimer) clearTimeout(this.confirmTimer);
        this.confirmTimer = setTimeout(() => {
            if (this.store.getState().confirm === token) this.store.getState().setConfirm(null);
        }, 5_000);
        return false;
    }

    private wireActions(): void {
        const st = () => this.store.getState();
        const svc = this.svc;
        this.host.onAction("nav", (d) => {
            const route = d.route as "home" | "create" | "settings" | "vm" | undefined;
            if (!route) return;
            st().setRoute(route, d.vm ?? null);
            if (route === "create") {
                void svc.refreshCreateExtras();
                // Fresh wizard on each entry — also clears values an Edit
                // loaded into the shared form. Then prefill a unique name.
                st().resetCreate();
                let n = 1;
                while (st().vms.some((v) => v.name === `vm-${n}`)) n++;
                st().setField("name", `vm-${n}`);
            }
            if (route === "settings") void svc.refreshSettings();
        });
        this.host.onAction("set-field", (d) => {
            const k = d.field as keyof CreateForm;
            if (!k) return;
            const v = NUM_FIELDS.has(k) ? Number(d.value ?? 0)
                : BOOL_FIELDS.has(k) ? d.value === "true"
                : (d.value ?? "");
            st().setField(k, v as never);
        });
        this.host.onAction("set-distro", (d) => {
            const fam = d.value as keyof typeof DISTROS;
            if (!DISTROS[fam]) return;
            st().setField("distro", fam);
            // each family has its own release namespace — jump to its default
            st().setField("release", DISTROS[fam].releases[0]!.id);
        });
        this.host.onAction("set-vd", (d) => st().setField("vd", Number(d.vd) || 0));
        this.host.onAction("set-preset", (d) => {
            const preset = d.value === "developer" ? "developer" : "standard";
            st().setField("preset", preset);
            // developer pre-checks the whole tooling menu; user can untoggle
            st().setField("devtools", preset === "developer" ? DEVTOOLS.map((t) => t.id) : []);
        });
        this.host.onAction("devtools-toggle", (d) => { if (d.key) st().toggleDevtool(d.key); });
        this.host.onAction("usb-toggle", (d) => {
            if (!d.key) return;
            const dev = st().usbDevices.find((u) => u.key === d.key);
            if (dev && !dev.writable) {
                st().setStatus(`${dev.label}: no host access — run doctor for the udev fix`);
                return;
            }
            st().toggleUsb(d.key);
        });
        this.host.onAction("pick-disk-dir", () => { void svc.pickDiskDir(); });
        this.host.onAction("pick-import", () => { void svc.pickImportFile(); });
        this.host.onAction("vm-create", () => { svc.createVm(); });
        this.host.onAction("vm-edit", (d) => {
            const vm = d.vm ? st().vms.find((v) => v.name === d.vm) : null;
            if (!vm) return;
            // Load the summary into the shared form — provisioning-only fields
            // (method/distro/credentials) stay at their defaults, unused.
            Object.assign(st().create, {
                name: vm.name, cpus: vm.cpus, memMiB: vm.memMiB, diskGiB: vm.diskGiB,
                gpu: vm.gpuMode, headMode: vm.headMode, persist: vm.persist,
                vd: vm.vd, usb: [...vm.usbKeys],
            });
            st().setRoute("create");
            st().setEditVm(vm.name);
            void svc.refreshCreateExtras();
        });
        this.host.onAction("vm-save", () => { svc.saveVm(); });
        this.host.onAction("vm-start", (d) => { if (d.vm) svc.start(d.vm); });
        this.host.onAction("vm-stop", (d) => { if (d.vm) svc.stop(d.vm); });
        this.host.onAction("vm-resume", (d) => { if (d.vm) svc.resume(d.vm); });
        this.host.onAction("vm-kill", (d) => { if (d.vm && this.armed(`vm-kill:${d.vm}`)) svc.kill(d.vm); });
        this.host.onAction("vm-rm", (d) => { if (d.vm && this.armed(`vm-rm:${d.vm}`)) svc.remove(d.vm); });
        this.host.onAction("vm-view", (d) => { if (d.vm) svc.view(d.vm); });
        this.host.onAction("vm-snap", (d) => { if (d.vm) svc.snapshot(d.vm); });
        this.host.onAction("vm-restore", (d) => {
            if (d.vm && d.snap && this.armed(`vm-restore:${d.vm}:${d.snap}`)) svc.restoreSnapshot(d.vm, d.snap);
        });
        this.host.onAction("doctor", () => { svc.runDoctor(); });
    }

    /** <input data-field="x"> → store.create[x] on every input event. */
    private wireInputs(): void {
        this.panel?.onEvent((ev) => {
            if (ev.t === "focus") { this.gate.focus(ev.g); return; }
            if (ev.t === "blur") {
                // Queued so a focus event for the next input in the same
                // batch lands first and keeps the render deferred.
                if (this.gate.blur()) queueMicrotask(() => this.gate.render(renderRoute(this.store.getState())));
                return;
            }
            if (ev.t === "scroll") {
                this.scrollY = ev.st ?? 0;
                this.scrollX = ev.sl ?? 0;
                return;
            }
            if (ev.t !== "input" && ev.t !== "change") return;
            const field = ev.d?.field;
            if (!field || ev.v === undefined) return;
            const cur = this.store.getState().create;
            // memInput is display-only: convert the typed value to memMiB in
            // the active unit. Writing memMiB directly keeps focus stable.
            if (field === "memInput") {
                const n = Number(ev.v);
                if (Number.isFinite(n)) cur.memMiB = Math.round(n * (cur.memUnit === "GiB" ? 1024 : 1));
                return;
            }
            const k = field as keyof CreateForm;
            const v = NUM_FIELDS.has(k) ? Number(ev.v) || 0 : ev.v;
            // setField would re-render and destroy the focused input — write
            // the value directly to keep DOM focus stable.
            (cur as unknown as Record<string, unknown>)[k] = v;
        });
    }

    /**
     * Swap the doc HTML while preserving `.content`'s scroll position.
     * `setHtml` rebuilds the whole DOM so the scrollport resets to 0 — every
     * mid-page action (USB toggle, vd picker, unit switch) used to throw the
     * user back to the top. Route changes intentionally start at the top.
     */
    private applyHtml(html: string): void {
        const p = this.panel;
        if (!p) return;
        const st = this.store.getState();
        const route = `${st.route}:${st.selectedVm ?? ""}`;
        const sameRoute = route === this.lastRoute;
        this.lastRoute = route;
        const x = this.scrollX;
        const y = this.scrollY;
        p.setHtml(html);
        if (!sameRoute || (x === 0 && y === 0)) {
            this.scrollX = 0;
            this.scrollY = 0;
            // Flash the overlay scrollbar on route change so a scrollable
            // page reads as scrollable — thumbs only paint during/after
            // scroll activity (opacity fades out ~700ms after the last one).
            // The 1px nudge is imperceptible; scrollTo clamps, so a page
            // that fits emits no flash and no motion.
            if (!sameRoute) {
                const flash = () => { p.scrollTo(".content", 0, 1); p.scrollTo(".content", 0, 0); };
                queueMicrotask(flash);
                setTimeout(flash, 30);
            }
            return;
        }
        // scrollTo clamps against the node's scroll range, which isn't laid
        // out until the next frame — retry once after layout settles.
        const restore = () => p.scrollTo(".content", x, y);
        queueMicrotask(restore);
        setTimeout(restore, 30);
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
        clearInterval(this.spinTimer);
        if (this.confirmTimer) clearTimeout(this.confirmTimer);
        this.unsub();
        this.host.dispose();
        this.panel = null;
    }
}
