// ============================================================================
// shell.ts — the cruiser UI shell: an HtmlUiHost panel filling the native
// window, fed by the zustand store and wired to CruiserService actions.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { HtmlUiHost, createLocalBackend, type UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import type { InputBus } from "./input-bus";
import type { CruiserService } from "./service";
import type { Store, CreateForm } from "./store";
import { renderRouteParts, vmListInner, createHints, type RouteParts } from "./screens";
import { applySameRoute } from "./content-patch";
import { DISTROS } from "../../provision/src/distros";
import { DEVTOOLS, DEVTOOLS_PRESET } from "../../provision/src/packages";
import { registerUiFonts } from "./fonts";
import { RenderGate } from "./render-gate";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TermManager } from "./term/term-manager";
import { mark } from "./startup-profile";

const log = createLogger("info");

const NUM_FIELDS: Set<string> = new Set(["cpus", "memMiB", "diskGiB", "snapKeep", "homeGiB"]);

/** data-field values whose inputs mask as "*" bullets — see wireInputs. */
const MASKED_FIELDS = new Set(["password", "diskPassword", "diskPassword2", "unlock-pw"]);
const BOOL_FIELDS: Set<string> = new Set([
    "snap", "extraFonts", "autologin", "nestedVirt", "swVk",
    "syncTheme", "syncAccent", "syncContrast", "syncTimezone", "syncLocale",
    "syncKeyboard", "syncMonitors", "syncHostWallpaper", "syncScale", "syncShares",
    "syncGit", "syncProxy", "syncCa", "syncAgent", "syncGitKey",
]);

const SPIN = ["◐", "◓", "◑", "◒"];

/** The busy overlay that replaces the create form — identified by its root
 *  element since RouteParts carries markup, not flags. */

export class CruiserShell {
    private host: HtmlUiHost;
    private panel: UiPanelHandle | null = null;
    private termMgr: TermManager;
    private gate: RenderGate;
    private W: number;
    private H: number;
    private unsub: () => void;
    private spinIdx = 0;
    private spinTimer: ReturnType<typeof setInterval>;
    private lastRoute = "";
    private pendingParts: RouteParts | null = null;
    private lastParts: RouteParts | null = null;
    private logInputTimer: ReturnType<typeof setTimeout> | null = null;
    /** True while the log pane sits at (or the user wants) the bottom —
     *  scroll events on #logpane recompute it via the #logend sentinel. */
    private logPinned = true;

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
        // Topbar icon — decorative; a missing/unloadable asset just leaves
        // the empty .brand box.
        try {
            this.host.registerResource("ui://cruiser/icon.png",
                readFileSync(fileURLToPath(new URL("../../../assets/icon.png", import.meta.url))));
        } catch { /* icon is decorative */ }
        mark("fonts");
        const mountParts = renderRouteParts(store.getState());
        this.panel = this.host.mount({
            rect: { x: 0, y: 0, w: width, h: height },
            html: mountParts.html,
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
        this.lastParts = mountParts;
        // Embedded terminals — the webui view is created lazily per VM on
        // the term route; sessions outlive navigation. svc gets the drop
        // hook so `vm rm` can kill the session+view too.
        this.termMgr = new TermManager(device, format, bus, store, svc, () => this.panel);
        svc.termDropped = (name) => this.termMgr.drop(name);
        this.gate = new RenderGate(mountParts.html, () => this.applyHtml());
        // Hold DOM rebuilds stable across a press: a store update that lands
        // between pointerdown and the click (or the focus event it queues)
        // would otherwise rebuild the DOM under the pressed element — killing
        // a just-focused input or the click target itself.
        this.host.onPressChange = (id) => {
            if (id !== null) { this.gate.pressDown(); return; }
            if (this.gate.pressUp()) queueMicrotask(() => this.pushRender());
        };
        // Re-render on state change — applyHtml diffs the parts and only
        // mutates the regions/rows that actually moved (see contentPatch).
        let pending = false;
        this.unsub = store.subscribe(() => {
            if (pending) return;
            pending = true;
            queueMicrotask(() => {
                pending = false;
                this.pushRender();
            });
        });
        this.wireActions();
        this.wireInputs();
        // Spinner ticks only while busy (status text itself re-renders the
        // overlay) — direct setText so it doesn't trip the RenderGate.
        this.spinTimer = setInterval(() => {
            if (!this.store.getState().busy) return;
            // same teardown-race guard as pushRender — a dead panel's
            // setText must not kill the interval's process either
            try { this.panel?.setText("[data-spin]", SPIN[this.spinIdx++ % SPIN.length]!); } catch { /* panel gone */ }
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
        // The arm silently expires after 5s — say so up front so a reverted
        // button doesn't read as the action having run.
        st.setStatus("click again within 5s to confirm", "warn");
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
            const route = d.route as "home" | "create" | "settings" | "vm" | "logs" | "term" | undefined;
            if (!route) return;
            st().setRoute(route, d.vm ?? null);
            if (route === "logs") void svc.loadLogUnits();
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
            // software gpu exports no GL scanouts — drop the viewer to rdp
            // instead of leaving an unbootable combo selected (create/save
            // guard against it too). A real gpu change back to a GL mode
            // restores dmabuf — the fast default; rdp stays a re-pick.
            const gpuChanged = k === "gpu" && v !== st().create.gpu;
            st().setField(k, v as never);
            if (k === "gpu") {
                if (v === "software" && st().create.viewer === "dmabuf")
                    st().setField("viewer", "rdp");
                else if (gpuChanged && st().create.viewer === "rdp")
                    st().setField("viewer", "dmabuf");
            }
        });
        // Input ✕ chips — routes by data-field exactly like wireInputs:
        // "" to the same store slot the input binds to (numeric fields get
        // 0, matching what keyboard-clearing writes), then a direct attr
        // mutate so the box empties even while the press gate holds the
        // store-notify re-render.
        this.host.onAction("clear-field", (d) => {
            const field = d.field;
            if (!field) return;
            const st = this.store.getState();
            if (field.startsWith("log-")) {
                (st.logs as unknown as Record<string, unknown>)[field.slice(4)] = "";
                void svc.refreshLogs();
            } else if (field === "vm-desc") st.setVmDesc("");
            else if (field.startsWith("share-")) st.setShareForm({ [field.slice(6)]: "" } as never);
            else if (field.startsWith("fwd-")) st.setFwdForm({ [field.slice(4)]: "" } as never);
            else if (field === "vm-filter") {
                st.setVmFilter("");
                this.panel?.setInnerHtml("#vmlist", vmListInner(st));
            } else if (field === "unlock-pw") this.store.setState({ unlockPw: "" });
            else if (field === "memInput") st.create.memMiB = 0;
            else {
                const k = field as keyof CreateForm;
                (st.create as unknown as Record<string, unknown>)[k] = NUM_FIELDS.has(k) ? 0 : "";
            }
            this.panel?.mutate([{ op: "attr", sel: `input[data-field=${field}]`, name: "value", value: "" }] as never);
            this.patchHints();
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
            // developer pre-checks a dev-box subset of the checklist — the
            // heavy/optional entries (db servers, k3s, editors, cloud sdks)
            // stay opt-in; user can toggle individually or per category.
            st().setField("devtools", preset === "developer" ? [...DEVTOOLS_PRESET] : []);
        });
        this.host.onAction("devtools-toggle", (d) => { if (d.key) st().toggleDevtool(d.key); });
        this.host.onAction("devtools-cat", (d) => {
            if (!d.key) return;
            const ids: string[] = DEVTOOLS.filter((t) => t.cat === d.key).map((t) => t.id);
            const cur = new Set(st().create.devtools);
            // all on → clear the category; otherwise fill in the gaps
            st().setField("devtools", ids.every((id) => cur.has(id))
                ? st().create.devtools.filter((k) => !ids.includes(k))
                : [...st().create.devtools, ...ids.filter((id) => !cur.has(id))]);
        });
        this.host.onAction("usb-toggle", (d) => {
            if (!d.key) return;
            // Chips dedup identical devices by key — warn only when NO
            // physical device behind the key is writable.
            const devs = st().usbDevices.filter((u) => u.key === d.key);
            if (devs.length && !devs.some((u) => u.writable)) {
                st().setStatus(`${devs[0]!.label}: no host access — run doctor for the udev fix`, "warn");
                return;
            }
            st().toggleUsb(d.key);
        });
        this.host.onAction("agentkey-toggle", (d) => { if (d.key) st().toggleAgentKey(d.key); });
        this.host.onAction("pick-disk-dir", () => { void svc.pickDiskDir(); });
        this.host.onAction("pick-vm-dir", () => { void svc.pickVmDir(); });
        this.host.onAction("pick-import", () => { void svc.pickImportFile(); });
        this.host.onAction("vm-create", () => { svc.createVm(); });
        this.host.onAction("vm-edit", (d) => {
            const vm = d.vm ? st().vms.find((v) => v.name === d.vm) : null;
            if (!vm) return;
            // Load the summary into the shared form — provisioning-only fields
            // (method/distro/credentials) stay at their defaults, unused.
            Object.assign(st().create, {
                name: vm.name, cpus: vm.cpus, memMiB: vm.memMiB, diskGiB: vm.diskGiB,
                nestedVirt: vm.nestedVirt,
                nice: String(vm.nice ?? 0),
                ioClass: vm.ioClass ?? "default",
                ioPrio: String(vm.ioPrio ?? 4),
                gpu: vm.gpuMode, swVk: vm.swVk, headMode: vm.headMode,
                // dmabuf is preselected whenever the gpu can export scanouts
                // — a saved rdp only survives an explicit re-pick.
                viewer: vm.gpuMode === "software" ? "rdp" : "dmabuf",
                persist: vm.persist,
                vmDir: dirname(vm.vmDir),
                autostart: vm.autostart, netMode: vm.netMode,
                vd: vm.vd, usb: [...vm.usbKeys], agentKeys: [...(vm.agentKeys ?? [])],
                snapAuto: vm.snapAuto, snapTrigger: vm.snapTrigger, snapKeep: vm.snapKeep,
            });
            const sy = vm.sync;
            if (sy) Object.assign(st().create, {
                syncTheme: sy.theme ?? true, syncAccent: sy.accentColor ?? true,
                syncContrast: sy.contrast ?? true, syncTimezone: sy.timezone ?? true,
                syncLocale: sy.locale ?? true, syncKeyboard: sy.keyboard ?? true,
                syncMonitors: sy.monitors ?? true, syncHostWallpaper: sy.hostWallpaper ?? true,
                syncScale: sy.scale ?? true,
                syncGit: sy.gitIdentity ?? false, syncProxy: sy.proxy ?? false,
                syncCa: sy.caCerts ?? false, syncAgent: sy.sshAgent ?? false,
                syncGitKey: sy.gitKey ?? false,
                syncShares: sy.shares ?? true,
            });
            st().setVmDesc(vm.description);
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
        this.host.onAction("vm-pw", (d) => { if (d.vm) void svc.togglePassword(d.vm); });
        this.host.onAction("vm-term", (d) => { if (d.vm) void svc.term(d.vm); });
        this.host.onAction("vm-term-reconnect", (d) => { if (d.vm) this.termMgr.reconnect(d.vm); });
        this.host.onAction("vm-term-host", (d) => { if (d.vm) void svc.termHost(d.vm); });
        this.host.onAction("vm-snap", (d) => { if (d.vm) svc.snapshot(d.vm); });
        this.host.onAction("vm-shot", (d) => { if (d.vm) void svc.screenshot(d.vm); });
        this.host.onAction("vm-restore", (d) => {
            if (d.vm && d.snap && this.armed(`vm-restore:${d.vm}:${d.snap}`)) svc.restoreSnapshot(d.vm, d.snap);
        });
        this.host.onAction("vm-snap-del", (d) => {
            if (d.vm && d.snap && this.armed(`vm-snap-del:${d.vm}:${d.snap}`)) void svc.deleteSnapshot(d.vm, d.snap);
        });
        this.host.onAction("vm-clone", (d) => { if (d.vm) void svc.cloneVm(d.vm); });
        this.host.onAction("autosnap-skip", (d) => { if (d.vm) void svc.autoSnapSkip(d.vm); });
        this.host.onAction("autosnap-purge", (d) => { if (d.vm) void svc.autoSnapPurge(d.vm); });
        this.host.onAction("unlock-go", (d) => { if (d.vm) void svc.unlockGo(d.vm); });
        this.host.onAction("unlock-cancel", () => { void svc.unlockCancel(); });
        this.host.onAction("doctor", () => { svc.runDoctor(); });
        this.host.onAction("import-config", () => { void svc.importConfig(); });
        this.host.onAction("vm-export", (d) => { if (d.vm) void svc.exportConfig(d.vm); });
        this.host.onAction("vm-gist-push", (d) => { if (d.vm) void svc.gistPush(d.vm); });
        this.host.onAction("vm-gist-pull", (d) => { if (d.vm) void svc.gistPull(d.vm); });
        this.host.onAction("share-pick", () => { void svc.pickShareDir(); });
        this.host.onAction("share-add", (d) => { if (d.vm) void svc.shareAdd(d.vm); });
        this.host.onAction("share-rm", (d) => {
            if (d.vm && this.armed(`share-rm:${d.vm}:${d.idx}`)) void svc.shareRemove(d.vm, Number(d.idx));
        });
        this.host.onAction("share-attr", (d) => {
            if (!d.vm || !d.field) return;
            void svc.shareAttr(d.vm, Number(d.idx), String(d.field), String(d.value ?? ""));
        });
        this.host.onAction("share-form", (d) => {
            if (!d.field) return;
            st().setShareForm({ [d.field]: d.field === "open" ? d.value === "true" : d.value } as never);
        });
        this.host.onAction("filesync-now", (d) => { if (d.vm) void svc.filesyncNow(d.vm); });
        this.host.onAction("fwd-form", (d) => {
            if (!d.field) return;
            st().setFwdForm({ [d.field]: d.field === "open" ? d.value === "true" : d.value } as never);
        });
        this.host.onAction("fwd-add", (d) => { if (d.vm) void svc.fwdAdd(d.vm); });
        this.host.onAction("fwd-rm", (d) => {
            if (d.vm && this.armed(`fwd-rm:${d.vm}:${d.proto}:${d.port}`))
                void svc.fwdRm(d.vm, Number(d.port), String(d.proto ?? "tcp") as "tcp" | "udp");
        });
        this.host.onAction("vm-mount", (d) => { if (d.vm) void svc.mountVm(d.vm); });
        this.host.onAction("vm-umount", (d) => { if (d.vm) void svc.umountVm(d.vm); });
        this.host.onAction("vm-open-mount", (d) => { if (d.vm) void svc.openMount(d.vm); });
        this.host.onAction("log-set", (d) => {
            const f = d.field;
            if (!f) return;
            const patch: Record<string, unknown> = {};
            if (f === "lines") patch.lines = Number(d.value) || 300;
            else if (f === "follow") patch.follow = d.value === "true";
            else patch[f] = d.value ?? "";
            st().setLogs(patch);
            if (f === "source" && d.value === "journal") void svc.loadLogUnits();
            void svc.refreshLogs();
        });
        this.host.onAction("log-refresh", () => { void svc.refreshLogs(); });
        this.host.onAction("log-url", (d) => { if (d.url) void svc.openUrl(String(d.url)); });
        this.host.onAction("status-open", (d) => { if (d.path) void svc.openPath(String(d.path)); });
        this.host.onAction("status-copy", (d) => { if (d.path) void svc.copyText(String(d.path)); });
        this.host.onAction("kv-open", (d) => { if (d.path) void svc.openPath(String(d.path)); });
        this.host.onAction("kv-copy", (d) => { if (d.copy) void svc.copyText(String(d.copy)); });
        this.host.onAction("usb-blocked-toggle", () => { st().toggleUsbBlocked(); });
    }

    /** <input data-field="x"> → store.create[x] on every input event. */
    private wireInputs(): void {
        this.panel?.onEvent((ev) => {
            if (ev.t === "focus") { this.gate.focus(ev.g); return; }
            if (ev.t === "blur") {
                // Queued so a focus event for the next input in the same
                // batch lands first and keeps the render deferred.
                if (this.gate.blur()) queueMicrotask(() => this.pushRender());
                return;
            }
            if (ev.t === "scroll") {
                if (ev.id === "logpane") void this.updateLogPin();
                return;
            }
            if (ev.t === "keydown") {
                // Enter in the unlock banner's passphrase submits it — same
                // as the Unlock button. The input still holds focus, so
                // release the gate like a blur or the banner's removal is
                // deferred past a blur the destroyed node never emits.
                if (ev.k === "Enter" && ev.d?.field === "unlock-pw") {
                    if (this.gate.blur()) queueMicrotask(() => this.pushRender());
                    const vm = this.store.getState().unlockPrompt?.vm;
                    if (vm) void this.svc.unlockGo(vm);
                }
                return;
            }
            if (ev.t !== "input" && ev.t !== "change") return;
            const field = ev.d?.field;
            if (!field || ev.v === undefined) return;
            // log-* fields bind to store.logs — write directly (a setLogs
            // re-render is gated while the input holds focus anyway) and
            // debounce a fetch so typing filters live.
            if (field.startsWith("log-")) {
                const st = this.store.getState();
                (st.logs as unknown as Record<string, unknown>)[field.slice(4)] = ev.v;
                if (this.logInputTimer) clearTimeout(this.logInputTimer);
                this.logInputTimer = setTimeout(() => { void this.svc.refreshLogs(); }, 700);
                return;
            }
            // vm-desc / share-* bind outside the create form — write directly
            // (a re-render would destroy the focused input).
            if (field === "vm-desc") { this.store.getState().setVmDesc(String(ev.v)); return; }
            // unlock-pw binds to the banner state, not the create form — it's
            // masked, so it falls through to the MASKED_FIELDS branch below.
            if (field.startsWith("share-")) {
                this.store.getState().setShareForm({ [field.slice(6)]: ev.v } as never);
                return;
            }
            if (field.startsWith("fwd-")) {
                this.store.getState().setFwdForm({ [field.slice(4)]: ev.v } as never);
                return;
            }
            // vm-filter binds outside the create form — store the value,
            // then patch the list directly. The render gate defers full
            // pushes while the input holds focus, so without the direct
            // setInnerHtml the rows would only refilter on blur.
            if (field === "vm-filter") {
                const st = this.store.getState();
                st.setVmFilter(String(ev.v));
                this.panel?.setInnerHtml("#vmlist", vmListInner(st));
                return;
            }
            // Masked fields (passwords) — Blitz ignores type=password, so the
            // doc shows one "*" bullet per stored char. Diff the incoming DOM
            // string against the previous bullets to recover the real edit,
            // then write the bullets back. Single-byte bullets keep the
            // engine's byte-offset caret aligned with the glyph index.
            if (MASKED_FIELDS.has(field)) {
                const real = field === "unlock-pw"
                    ? this.store.getState().unlockPw
                    : String((this.store.getState().create as unknown as Record<string, unknown>)[field] ?? "");
                const dom = String(ev.v);
                const dots = "*".repeat(real.length);
                let pre = 0;
                while (pre < dom.length && pre < dots.length && dom[pre] === dots[pre]) pre++;
                let suf = 0;
                while (suf < dom.length - pre && suf < dots.length - pre && dom[dom.length - 1 - suf] === "*") suf++;
                const next = real.slice(0, pre) + dom.slice(pre, dom.length - suf)
                    + real.slice(pre + (dots.length - pre - suf));
                if (field === "unlock-pw") this.store.setState({ unlockPw: next });
                else (this.store.getState().create as unknown as Record<string, unknown>)[field] = next;
                const mask = "*".repeat(next.length);
                if (dom !== mask) this.panel?.mutate(
                    [{ op: "attr", sel: `input[data-field=${field}]`, name: "value", value: mask }] as never);
                this.patchHints();
                return;
            }
            const cur = this.store.getState().create;
            // memInput is display-only: convert the typed value to memMiB in
            // the active unit. Writing memMiB directly keeps focus stable.
            if (field === "memInput") {
                const n = Number(ev.v);
                if (Number.isFinite(n)) cur.memMiB = Math.round(n * (cur.memUnit === "GiB" ? 1024 : 1));
                this.patchHints();
                return;
            }
            const k = field as keyof CreateForm;
            const v = NUM_FIELDS.has(k) ? Number(ev.v) || 0 : ev.v;
            // setField would re-render and destroy the focused input — write
            // the value directly to keep DOM focus stable.
            (cur as unknown as Record<string, unknown>)[k] = v;
            this.patchHints();
        });
    }

    /** Re-patch the create form's inline validation containers — create
     *  field writes skip the store notify to keep input focus, so hints
     *  would otherwise go stale until the next unrelated render. */
    private patchHints(): void {
        const hints = createHints(this.store.getState());
        Object.entries(hints).forEach(([sel, html]) => this.panel?.setInnerHtml(sel, html));
    }

    /** Render fresh parts once and push the full doc through the gate —
     *  applyHtml then diffs the parts against what's mounted. */
    private pushRender(): void {
        // A render exception must not escape — this runs in a microtask off
        // the store subscription, so an uncaught throw kills the process.
        // Stale/mixed module frames during an HMR session restart are the
        // known trigger; the next store change re-pushes either way.
        try {
            const st = this.store.getState();
            // Route changes must land even while an input holds focus — the
            // gate defers pushes during editing, which is right for same-page
            // churn but would swallow programmatic nav (dev-harness setRoute,
            // service-driven routes) that never produces a blur event.
            if (`${st.route}:${st.selectedVm ?? ""}` !== this.lastRoute) this.gate.blur();
            this.pendingParts = renderRouteParts(st);
            this.gate.render(this.pendingParts.html);
        } catch (e) {
            log.error("shell", `render failed: ${e instanceof Error ? e.stack ?? e.message : e}`);
        }
    }

    /**
     * Apply fresh markup. Route changes swap the whole document (scroll
     * resets to the top — intentional). Same-route updates patch
     * topbar/content/footer via innerHtml — and routes that declare a fine
     * surface (regions/rowGroup) go one level deeper: contentPatch diffs
     * per-region markup and emits a single batched mutate() covering only
     * the changed subtrees — attr/text-level ops when the structure is
     * unchanged (keeping nodes alive so CSS transitions run), innerHtml
     * when it isn't — so a metrics tick reparses the one row that
     * moved instead of the whole page. The .content scrollport node always
     * survives, so scroll offset persists with no restore scroll —
     * which means no scroll=0 frame between rebuild and restore (the
     * flicker) and no scrollbar thumb re-flash on every poll.
     */
    private applyHtml(): void {
        const p = this.panel;
        const parts = this.pendingParts;
        if (!p || !parts) return;
        const st = this.store.getState();
        const route = `${st.route}:${st.selectedVm ?? ""}`;
        const sameRoute = route === this.lastRoute && this.lastParts !== null;
        this.lastRoute = route;
        if (!sameRoute) {
            p.setHtml(parts.html);
            // Landing on logs from ANY path (nav action, harness setRoute,
            // a future deep-link) refreshes — nav alone used to, which left
            // programmatic entries stuck on "probing…".
            if (st.route === "logs") void this.svc.refreshLogs();
            // Flash the overlay scrollbar on route change so a scrollable
            // page reads as scrollable — thumbs only paint during/after
            // scroll activity (opacity fades out ~700ms after the last one).
            // The 1px nudge is imperceptible; scrollTo clamps, so a page
            // that fits emits no flash and no motion.
            const flash = () => { p.scrollTo(".content", 0, 1); p.scrollTo(".content", 0, 0); };
            queueMicrotask(flash);
            setTimeout(flash, 30);
            // log pane opens pinned to the newest lines
            if (st.route === "logs") {
                this.logPinned = true;
                setTimeout(() => p.scrollTo(".logpre", 0, 1e9), 60);
            }
        } else {
            const prev = this.lastParts!;
            if (applySameRoute(prev, parts, p)
                && (this.logPinned || st.logs.follow)) this.pinLogToBottom();
        }
        this.lastParts = parts;
        // Post-layout: activate/place the terminal view for the term route,
        // deactivate views on every other route (sessions keep running).
        void this.termMgr.syncRoute();
    }

    /** Re-pin the log pane to its newest lines — now + once after layout
     *  (scrollTo clamps against the scroll range, which lags a frame). */
    private pinLogToBottom(): void {
        const p = this.panel;
        if (!p) return;
        this.logPinned = true;
        p.scrollTo(".logpre", 0, 1e9);
        setTimeout(() => this.panel?.scrollTo(".logpre", 0, 1e9), 30);
    }

    /** Sentinel probe: the .logend div sits at the pane's end — when its
     *  rect is within ~2 lines of the pane's bottom edge the user is at the
     *  tail and refreshes may re-pin; scrolled up means "leave me here". */
    private async updateLogPin(): Promise<void> {
        const p = this.panel;
        if (!p) return;
        const [pre, end] = await Promise.all([p.getRect(".logpre"), p.getRect(".logend")]);
        if (!pre || !end) return;
        this.logPinned = end.y <= pre.y + pre.h + 32;
    }
    composite(pass: GPURenderPassEncoder): void {
        this.host.compositor.render(pass, this.W, this.H);
        this.termMgr.render(pass, this.W, this.H);
    }

    resize(w: number, h: number): void {
        this.W = w; this.H = h;
        this.panel?.setRect({ x: 0, y: 0, w, h });
        void this.termMgr.syncRect();
    }

    dispose(): void {
        clearInterval(this.spinTimer);
        if (this.logInputTimer) clearTimeout(this.logInputTimer);
        if (this.confirmTimer) clearTimeout(this.confirmTimer);
        this.termMgr.dispose();
        this.unsub();
        this.host.dispose();
        this.panel = null;
    }
}
