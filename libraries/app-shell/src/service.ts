// ============================================================================
// service.ts — the UI's backend: owns VmRegistry, polls VM state into the
// store, and executes actions (create/provision/start/stop/view/snapshots).
// ============================================================================

import { VmRegistry, linkVmDir } from "../../vm-core/src/lifecycle/registry";
import { VmHandle } from "../../vm-core/src/lifecycle/vm";
import { syncAutostartUnit, autostartNames } from "../../vm-core/src/lifecycle/autostart";
import { defaultSpec, DevTool, VmSpec } from "../../vm-core/src/config/schema";
import { makeShare } from "../../vm-core/src/config/shares";
import { CACHE_DIR, CLOUDIMG_DIR, CONFIG_DIR, DATA_DIR, ISO_DIR, VMS_DIR, vmRealDir } from "../../vm-core/src/paths";
import { detectAdapter, detectSession } from "../../host-int/src/detect";
import { flatpakId, installHostCli } from "../../host-int/src/host-cli";
import { hostSshKeys } from "../../host-int/src/hoststate";
import { defaultMountpoint, isMounted } from "../../host-int/src/mount";
import type { VmSession } from "../../provision/src/session";
import { ViewerSession } from "../../host-int/src/session";
import { listUsbDevices } from "../../vm-core/src/usb/usb";
import { runnerLogFiles, tailFile, guestJournal, guestJournalUnits } from "../../vm-core/src/logs";
import { run, which } from "../../sys/src/exec";
import { cpus, totalmem, homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { mark } from "./startup-profile";
import { VmMetricsSampler } from "./metrics";
import type { ActionState, CreateForm, DoctorRow, HostInfo, Store, VmSummary } from "./store";
import { SYNC_CHANNELS, type SyncId } from "../../vm-core/src/config/sync-channels";
import { bootRelevantChanges } from "../../vm-core/src/config/boot-diff";
import { runAutoSnapshot } from "../../vm-core/src/lifecycle/autosnap";
import type { SyncFormKey } from "./store";

/** create/edit form sync fields → spec.sync keys — derived from the
 *  channel registry so a new channel needs no edit here. */
const SYNC_FORM: [SyncFormKey, SyncId][] = SYNC_CHANNELS.map((c) => [c.formKey, c.id]);

function applySyncForm(spec: VmSpec, f: CreateForm): void {
    SYNC_FORM.forEach(([fk, sk]) => { spec.sync[sk] = f[fk]; });
}

export class CruiserService {
    /** Doc-backend label shown in settings — the shell knows the real kind. */
    uiBackend = "local (in-process)";
    private registry = new VmRegistry();
    private handles = new Map<string, VmHandle>();
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private logTimer: ReturnType<typeof setInterval> | null = null;
    private viewers = new Map<string, VmSession>();
    private viewerPending = new Map<string, Promise<void>>();
    /** Per-VM action locks — ops on different VMs run concurrently; the
     *  global `busy` flag is only for VM-agnostic actions (create/import/
     *  doctor) and no longer freezes the whole UI during one VM's drain. */
    private busyVms = new Set<string>();
    private metrics = new VmMetricsSampler();
    private refreshing = false;
    /** A refresh requested mid-pass reruns once the current one lands —
     *  post-action refreshes must never be dropped onto the 3s poll. */
    private refreshAgain = false;
    /** VMs mid graceful-shutdown drain — QEMU still answers probes as
     *  "running", so the pill's "stopping" comes from here until the pid
     *  dies (the renderer's transitional branch hides Start/Edit for it). */
    private stopping = new Set<string>();
    private snapCache = new Map<string, { names: string[]; at: number }>();
    /** Set by the shell — drops a VM's terminal session+view on removal. */
    termDropped?: (name: string) => void;

    constructor(private store: Store) {}

    async init(): Promise<void> {
        // Each spec-derived row paints the instant its vm.json parses —
        // probing and metrics fill it in over the next seconds.
        await this.registry.scan((h) => {
            this.handles.set(h.spec.name, h);
            this.paintFast();
        });
        mark("svc:scan");
        this.registry.list().forEach((h) => this.handles.set(h.spec.name, h));
        // refresh/host/settings write disjoint store fields — run together;
        // each spawn chain (qdbus, wmctrl, df) overlaps instead of queuing
        // behind the last. Create-screen extras (desktops, USB list, disk
        // free) take ~8s of spawns and gate nothing — they overlap the same
        // window but deliberately don't hold service-init.
        this.refreshCreateExtras().then(() => mark("svc:extras")).catch(() => {});
        await Promise.all([
            this.refresh().then(() => mark("svc:refresh")),
            this.refreshHost().then(() => mark("svc:host")),
            this.refreshSettings().catch(() => {}),
        ]);
        this.pollTimer = setInterval(() => this.refresh().catch(() => {}), 3000);
        // spec.autostart edge: flagged VMs start with the app, headless —
        // the boot edge (systemd --user unit) runs the same set via
        // `vm autostart-run`. Prompt-locked disks park on the unlock
        // banner; low-space autosnap parks on the space prompt.
        this.autostartVms().catch(() => {});
        // A flatpak can't ship a host PATH entry — drop the `cruiser` cli
        // wrappers (flatpak exports/bin + ~/.local/bin) on every launch so a
        // user delete self-heals. No-op outside flatpak.
        if (flatpakId()) installHostCli().catch(() => {});
        // "follow" on the logs screen — re-fetch while it's open; a slow
        // journal fetch just overlaps the next tick (loading flag guards).
        this.logTimer = setInterval(() => {
            const st = this.store.getState();
            if (st.route === "logs" && st.logs.follow && !st.logs.loading)
                this.refreshLogs().catch(() => {});
        }, 3000);
    }

    /** sessionRestart: dev-shell module swap — skip VM stops/deletes too
     *  (an HMR restart must not take down running guests). */
    async dispose(opts: { sessionRestart?: boolean } = {}): Promise<void> {
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.logTimer) clearInterval(this.logTimer);
        // Viewers are detached/unref'd processes that outlive us — never
        // SIGTERM them on teardown (closing the manager must not close the
        // user's console). open()'s stale-viewer reaper cleans orphans.
        this.viewers.forEach((v) => { v.disposeSyncs(); v.viewer.detach().catch(() => {}); });
        this.viewers.clear();
        // owned = stops with the app; ephemeral = stops AND deletes the vm dir.
        if (opts.sessionRestart) return;
        for (const h of this.handles.values()) {
            if (h.spec.persist === "daemonize") continue;
            const out = await h.stop(4_000).catch(() => "timeout" as const);
            if (out === "timeout") await h.kill().catch(() => {});
            if (h.spec.persist === "ephemeral") {
                const { rm } = await import("node:fs/promises");
                await rm(h.paths.dir, { recursive: true, force: true }).catch(() => {});
            }
        }
    }

    /** App-launch autostart — flagged stopped VMs boot headless (no
     *  viewer: autostart readies the guest, an explicit start/view opens
     *  the console). Serialized so a slow first boot doesn't fan out
     *  parallel QEMU starts. */
    private async autostartVms(): Promise<void> {
        for (const h of this.handles.values()) {
            if (!h.spec.autostart || h.isRunning()) continue;
            if (!this.diskKeyReady(h, "start")) continue;
            if (!(await this.autoSnapEdge(h, "start"))) continue;
            await this.run(`start ${h.spec.name}`, async () => {
                const { hostMirroredGuestMonitors } = await import("../../provision/src/monitors");
                return h.start({ guestMonitors: await hostMirroredGuestMonitors(h.spec) });
            }, { vm: h.spec.name, verb: "starting" });
        }
    }

    /** Populate create-screen extras: host totals, desktops grid, USB list. */
    async refreshCreateExtras(): Promise<void> {
        const st = this.store.getState();
        const dir = st.create.diskDir || st.create.vmDir || VMS_DIR;
        const adapter = detectAdapter();
        const [desktops, usb, sshKeys, freeGiB, rows] = await Promise.all([
            adapter.desktops().catch(() => []),
            listUsbDevices().catch(() => []),
            hostSshKeys().catch(() => []),
            diskFreeGiB(dir).catch(() => 0),
            kdeDesktopRows().catch(() => 1),
        ]);
        st.setDesktops(desktops.map((d) => ({ index: d.index, name: d.name, current: d.current })), rows);
        this.usbToStore(usb);
        st.setSshKeys(sshKeys);
        st.setHostRes({ cpus: cpus().length, memGiB: Math.round(totalmem() / 1073741824), diskFreeGiB: Math.round(freeGiB) });
    }

    /** Native file dialogs via kdialog (KDE) or zenity — both optional. */
    private async pickPath(kind: "dir" | "file" | "save", title: string, start: string): Promise<string | null> {
        const kd = await which("kdialog");
        if (kd) {
            const args = kind === "dir"
                ? ["--title", title, "--getexistingdirectory", start]
                : kind === "save"
                    ? ["--title", title, "--getsavefilename", start]
                    : ["--title", title, "--getopenfilename", start, "*.qcow2 *.img *.raw *.vmdk *.vdi *.vhdx|Disk images"];
            const r = await run(kd, args, { noThrow: true });
            return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
        }
        const zn = await which("zenity");
        if (zn) {
            const args = kind === "dir"
                ? ["--file-selection", "--directory", "--title", title, `--filename=${start}/`]
                : kind === "save"
                    ? ["--file-selection", "--save", "--confirm-overwrite", "--title", title, `--filename=${start}`]
                    : ["--file-selection", "--title", title, `--filename=${start}/`, "--file-filter=*.qcow2 *.img *.raw *.vmdk *.vdi *.vhdx"];
            const r = await run(zn, args, { noThrow: true });
            return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
        }
        this.store.getState().setStatus("no file dialog found (kdialog/zenity) — type the path", "warn");
        return null;
    }

    async pickDiskDir(): Promise<void> {
        const p = await this.pickPath("dir", "Choose disk location", this.store.getState().create.diskDir || VMS_DIR);
        if (!p) return;
        this.store.getState().setField("diskDir", p === VMS_DIR ? "" : p);
        await this.refreshCreateExtras();
    }

    async pickVmDir(): Promise<void> {
        const p = await this.pickPath("dir", "Choose VM storage location", this.store.getState().create.vmDir || VMS_DIR);
        if (!p) return;
        // The literal path is stored — picking VMS_DIR back in edit mode
        // moves a relocated VM home and drops its symlink (create's
        // linkVmDir no-ops on the default too).
        this.store.getState().setField("vmDir", p);
        await this.refreshCreateExtras();
    }

    async pickImportFile(): Promise<void> {
        const p = await this.pickPath("file", "Import existing disk image", homedir());
        if (!p) return;
        const st = this.store.getState();
        st.setField("importPath", p);
        if (st.create.method !== "imported") st.setField("method", "imported");
    }

    private async run<T>(label: string, fn: () => Promise<T>,
        opts: { done?: (r: T) => string; vm?: string; verb?: string } = {},
    ): Promise<T | undefined> {
        const st = this.store.getState();
        // Lock classes: opts.vm → serialized per VM (other VMs' ops still
        // run); no vm → a "global" action serialized only against other
        // globals. Global busy never blocks a per-VM action.
        if (opts.vm ? this.busyVms.has(opts.vm) : st.busy) {
            st.setStatus(`${label} ignored — another action is still running`, "warn");
            return undefined;
        }
        if (opts.vm) this.busyVms.add(opts.vm); else st.setBusy(true);
        st.setStatus(`${label}…`);
        if (opts.verb) st.setAction({ vm: opts.vm ?? null, verb: opts.verb, at: Date.now() });
        try {
            const r = await fn();
            st.setStatus(opts.done ? opts.done(r) : `${label} done`);
            return r;
        } catch (e) {
            st.setStatus(`${label} failed: ${e instanceof Error ? e.message : e}`, "error");
            return undefined;
        } finally {
            if (opts.vm) this.busyVms.delete(opts.vm); else st.setBusy(false);
            st.clearAction(opts.vm ?? null);
            this.refresh().catch(() => {});
        }
    }

    /** Spec-derived fields + provisional pidfile state — no socket I/O. */
    private baseSummary(h: VmHandle, state: VmSummary["state"]): VmSummary {
        const s = h.spec;
        return {
            name: s.name, state,
            gpuMode: s.gpu.mode, swVk: s.gpu.softwareVk, headMode: s.display.headMode,
            viewer: s.display.viewer,
            cpus: s.resources.cpus, memMiB: s.resources.memoryMiB,
            diskGiB: s.disk.sizeGiB, nestedVirt: s.resources.nestedVirt,
            nice: s.resources.sched.nice, ioClass: s.resources.sched.ioClass,
            ioPrio: s.resources.sched.ioPrio,
            sshPort: s.network.sshPort, rdpPort: s.network.rdpPort,
            provisioned: s.provisioned.method, persist: s.persist, autostart: s.autostart,
            netMode: s.network.mode,
            username: s.credentials.username, hasPassword: !!s.credentials.passwordFile,
            encrypt: s.disk.encrypt, keyStorage: s.disk.keyStorage,
            diskLocked: s.disk.encrypt !== "off" && h.diskKeyFile() === null,
            description: s.description,
            origin: s.origin ? `${s.origin.kind}:${s.origin.id ?? s.origin.url ?? ""}` : undefined,
            shares: s.shares.map((sh, idx) => ({
                idx, tag: sh.tag, hostPath: sh.hostPath, guestPath: sh.guestPath,
                mode: sh.mode, direction: sh.direction, enabled: sh.enabled, deletions: sh.deletions,
            })),
            snapshots: [],
            snapAuto: s.snapshots.auto, snapTrigger: s.snapshots.trigger, snapKeep: s.snapshots.keep,
            vd: s.display.virtualDesktop,
            usbKeys: s.usb.autoAttach.map((u) => [u.vendorId, u.productId, u.serial].filter(Boolean).join(":")),
            forwards: s.network.hostfwd.map((f) => ({
                proto: f.proto, hostPort: f.hostPort, guestPort: f.guestPort,
                auto: (f.guestPort === 22 && f.hostPort === s.network.sshPort)
                    || (f.guestPort === 3389 && f.hostPort === s.network.rdpPort),
            })),
            mount: isMounted(defaultMountpoint(s.name)) ? defaultMountpoint(s.name) : null,
            vmDir: vmRealDir(s.name),
            sync: { ...s.sync },
            agentKeys: [...s.credentials.sshAgentKeys],
            pendingRestart: h.pendingRestart(),
            cpu: [], mem: [], disk: [], net: [], gpu: [],
        };
    }

    /** Carry still-valid dynamic fields forward so progressive rows don't
     *  flash empty while the slow pass re-samples. */
    private carryPrev(s: VmSummary, prev?: VmSummary): VmSummary {
        if (!prev) return s;
        if (!s.cpu.length) s.cpu = prev.cpu;
        if (!s.mem.length) s.mem = prev.mem;
        if (!s.disk.length) s.disk = prev.disk;
        if (!s.net.length) s.net = prev.net;
        if (!s.gpu.length) s.gpu = prev.gpu;
        s.gpuMemBytes ??= prev.gpuMemBytes;
        s.hostDiskBytes ??= prev.hostDiskBytes;
        s.guestUsedBytes ??= prev.guestUsedBytes;
        s.guestTotalBytes ??= prev.guestTotalBytes;
        if (!s.snapshots.length) s.snapshots = prev.snapshots;
        return s;
    }

    /** Socket-free row state: pidfile liveness + the local drain flag. */
    private rowState(h: VmHandle): VmSummary["state"] {
        if (!h.isRunning()) return "stopped";
        return this.stopping.has(h.spec.name) ? "stopping" : "running";
    }

    /** Push spec+pidfile rows immediately — scan/refresh refine them in
     *  place as the real probes land. */
    private paintFast(): void {
        const prev = new Map(this.store.getState().vms.map((v) => [v.name, v]));
        const vms = [...this.handles.values()].map((h) =>
            this.carryPrev(this.baseSummary(h, this.rowState(h)), prev.get(h.spec.name)));
        vms.sort((a, b) => a.name.localeCompare(b.name));
        this.store.getState().setVms(vms);
    }

    private async summarize(h: VmHandle, onEarly?: (s: VmSummary) => void): Promise<VmSummary> {
        let state: VmSummary["state"] = "stopped";
        try { state = await h.probe(); } catch { state = "unknown"; }
        // A guest mid shutdown-drain still probes "running" — the drain is
        // only observable locally.
        if (state !== "stopped" && this.stopping.has(h.spec.name)) state = "stopping";
        const base = this.baseSummary(h, state);
        onEarly?.(base);   // real state before the slow metrics/snaps pass
        const [mt, snaps] = await Promise.all([
            this.metrics.sample(h, state),
            this.snapNames(h, state),
        ]);
        base.snapshots = snaps;
        base.hostDiskBytes = mt.hostDiskBytes;
        base.guestUsedBytes = mt.guestUsedBytes;
        base.guestTotalBytes = mt.guestTotalBytes;
        base.cpu = mt.cpu;
        base.mem = mt.mem;
        base.disk = mt.disk;
        base.net = mt.net;
        base.gpu = mt.gpu;
        base.gpuMemBytes = mt.gpuMemBytes;
        return base;
    }

    /** Snapshot names for a stopped VM, cached 30s — `qemu-img info` is a
     *  subprocess spawn and shouldn't run per-VM per-poll. */
    private async snapNames(h: VmHandle, state: VmSummary["state"]): Promise<string[]> {
        if (state !== "stopped") return [];
        const c = this.snapCache.get(h.spec.name);
        if (c && Date.now() - c.at < 30_000) return c.names;
        const names = (await h.snapshots().catch(() => [])).map((x) => x.name);
        this.snapCache.set(h.spec.name, { names, at: Date.now() });
        return names;
    }

    private invalidateSnaps(name: string): void { this.snapCache.delete(name); }

    async refresh(): Promise<void> {
        if (this.refreshing) { this.refreshAgain = true; return; }
        this.refreshing = true;
        try {
            do {
                this.refreshAgain = false;
                // Seed from the last summaries: rows update in place as each
                // summary lands instead of disappearing behind the slow ones.
                const acc = new Map(this.store.getState().vms.map((v) => [v.name, v]));
                const live = new Set(this.handles.keys());
                acc.forEach((_, k) => { if (!live.has(k)) acc.delete(k); });
                const flush = () => this.store.getState().setVms(
                    [...acc.values()].sort((a, b) => a.name.localeCompare(b.name)));
                const put = (h: VmHandle, s: VmSummary) => {
                    acc.set(h.spec.name, this.carryPrev(s, acc.get(h.spec.name)));
                    flush();
                };
                // Instant pass — spec + pidfile rows before any socket I/O.
                this.handles.forEach((h) => acc.set(h.spec.name,
                    this.carryPrev(this.baseSummary(h, this.rowState(h)), acc.get(h.spec.name))));
                flush();
                // Progressive: probe lands the real state first, metrics/snaps
                // fill in behind it (QGA can take ~2.5s on a dead agent).
                await Promise.all([...this.handles.values()].map(async (h) => {
                    const s = await this.summarize(h, (early) => put(h, early)).catch(() => null);
                    if (s) put(h, s);
                }));
            } while (this.refreshAgain);
        } finally {
            this.refreshing = false;
        }
    }

    private usbToStore(usb: Awaited<ReturnType<typeof listUsbDevices>>): void {
        this.store.getState().setUsbDevices(usb.map((d) => ({
            key: `${d.vendorId}:${d.productId}${d.serial ? `:${d.serial}` : ""}`,
            vendorId: d.vendorId, productId: d.productId, serial: d.serial,
            bus: d.bus, addr: d.addr,
            label: [d.vendor, d.product].filter(Boolean).join(" ") || `${d.vendorId}:${d.productId}`,
            writable: d.writable,
        })));
    }

    /** Populate the settings screen: paths, toolchain, runtime, display env. */
    async refreshSettings(): Promise<void> {
        const { resolveToolchain } = await import("../../vm-core/src/qemu/resolve");
        const [tc, usb] = await Promise.all([
            resolveToolchain().catch(() => null),
            listUsbDevices().catch(() => []),
        ]);
        this.usbToStore(usb);
        this.store.getState().setSysinfo({
            configDir: CONFIG_DIR, dataDir: DATA_DIR, cacheDir: CACHE_DIR,
            vmsDir: VMS_DIR, isoDir: ISO_DIR, cloudimgDir: CLOUDIMG_DIR,
            qemu: tc?.qemu ?? null, xfreerdp: tc?.xfreerdp ?? null,
            qemuFromOpt: tc?.fromOpt ?? false,
            runtime: process.versions.bun
                ? `bun ${process.versions.bun}`
                : `${process.release?.name ?? "node"} ${process.version}`,
            displayEnv: `${process.env.XDG_SESSION_TYPE ?? "?"} · ${process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY ?? "no display"}`,
            uiBackend: this.uiBackend,
        });
    }

    async refreshHost(): Promise<void> {
        const a = detectAdapter();
        const [monitors, desktops] = await Promise.all([
            a.monitors().catch(() => [] as HostInfo["monitors"]),
            a.desktops().catch(() => [] as HostInfo["desktops"]),
        ]);
        const host: HostInfo = {
            session: detectSession(),
            adapterId: a.id,
            caps: { ...a.caps },
            monitors,
            desktops,
        };
        this.store.getState().setHost(host);
    }

    // ── logs ──

    /** Fetch the active log source for the selected VM into store.logs.
     *  Text stays raw — the log pane renders ANSI escapes to styled HTML
     *  (ansi.ts) and drops non-printing bytes at paint time. */
    async refreshLogs(): Promise<void> {
        const st = this.store.getState();
        const name = st.selectedVm;
        const h = name ? this.handles.get(name) : undefined;
        if (!h) return;
        const l = st.logs;
        if (l.source === "runner") {
            const files = runnerLogFiles(h.paths);
            const f = files.find((x) => x.id === l.file) ?? files[0]!;
            try {
                const text = f.exists ? await tailFile(f.path, l.lines) : "";
                st.setLogs({
                    files, text,
                    error: f.exists ? null : `${f.name} not created yet`,
                    loading: false, fetchedAt: Date.now(),
                });
            } catch (e) {
                st.setLogs({ files, error: e instanceof Error ? e.message : String(e), loading: false });
            }
            return;
        }
        // journal — needs a live guest
        if (!h.isRunning()) {
            st.setLogs({ error: "the guest isn't running — start it to read its journal", loading: false });
            return;
        }
        st.setLogs({ loading: true });
        try {
            const r = await guestJournal(h, {
                lines: l.lines,
                unit: l.unit || undefined,
                priority: l.priority || undefined,
                boot: l.boot === "" ? undefined : Number(l.boot),
                since: l.since || undefined,
                grep: l.grep || undefined,
            });
            st.setLogs({ text: r.text.trim() || "(no entries match)", transport: r.transport, error: null, loading: false, fetchedAt: Date.now() });
        } catch (e) {
            st.setLogs({ error: e instanceof Error ? e.message : String(e), loading: false });
        }
    }

    /** Unit names for the journal unit picker — one-shot per screen entry. */
    async loadLogUnits(): Promise<void> {
        const st = this.store.getState();
        const h = st.selectedVm ? this.handles.get(st.selectedVm) : undefined;
        if (!h || !h.isRunning()) return;
        try {
            const { units } = await guestJournalUnits(h);
            st.setLogs({ units });
        } catch { /* picker stays empty — the unit text field still works */ }
    }

    // ── actions ──

    /** Parse the form's sched text inputs — "" = unset. Returns an error
     *  string on a bad value so create/save can bail before touching spec. */
    private parseSchedForm(f: CreateForm): VmSpec["resources"]["sched"] | string {
        const out: VmSpec["resources"]["sched"] = {};
        const nice = f.nice.trim();
        if (nice) {
            const n = Number(nice);
            if (!Number.isInteger(n) || n < -20 || n > 19) return "nice must be an integer from -20 to 19";
            // 0 is the effective default — persisting it would flag an
            // untouched spec as changed vs the launch snapshot.
            if (n !== 0) out.nice = n;
        }
        if (f.ioClass !== "default") {
            if (!["realtime", "best-effort", "idle"].includes(f.ioClass))
                return "I/O class must be default, realtime, best-effort or idle";
            out.ioClass = f.ioClass as VmSpec["resources"]["sched"]["ioClass"];
        }
        // ioPrio is only meaningful (and only rendered) for rt/be classes —
        // a leftover value from a class that hides the field stays ignored.
        const ioPrio = f.ioPrio.trim();
        if (ioPrio && (out.ioClass === "realtime" || out.ioClass === "best-effort")) {
            const n = Number(ioPrio);
            if (!Number.isInteger(n) || n < 0 || n > 7) return "I/O priority must be an integer from 0 to 7";
            if (n !== 4) out.ioPrio = n;   // 4 = the class default
        }
        return out;
    }

    /** First zod issue as "field: message" — friendlier than the raw dump. */
    private validateSpec(spec: VmSpec): void {
        const r = VmSpec.safeParse(spec);
        if (r.success) return;
        const i = r.error.issues[0];
        throw new Error(`${i?.path.join(".") || "spec"}: ${i?.message ?? "invalid"}`);
    }

    async createVm(): Promise<void> {
        const f = { ...this.store.getState().create };
        const st = this.store.getState();
        // Pre-flight with friendly messages — a schema rejection this late
        // either leaves a half-provisioned dir or writes an unloadable vm.json.
        if (!/^[a-z0-9][a-z0-9-]*$/.test(f.name)) {
            st.setStatus("name must be lowercase letters/digits/dashes (e.g. 'dev-box')", "warn");
            return;
        }
        if (this.handles.has(f.name)) { st.setStatus(`a VM named '${f.name}' already exists`, "warn"); return; }
        if (f.cpus < 1 || f.cpus > 64) { st.setStatus("vCPUs must be between 1 and 64", "warn"); return; }
        if (f.memMiB < 512) { st.setStatus("memory must be at least 512 MiB", "warn"); return; }
        if (f.diskGiB < 4) { st.setStatus("disk must be at least 4 GiB", "warn"); return; }
        if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(f.username)) {
            st.setStatus("username must start with a letter/underscore, lowercase + digits + - _ only", "warn");
            return;
        }
        // LUKS: encryption is baked into the image at create time, so it
        // requires the passphrase right here — never silently generated.
        // (imported images resolve this post-probe — a LUKS source forces
        // encrypt=full, a plaintext source can't be re-encrypted.)
        if (f.encrypt !== "off" && f.method !== "imported") {
            if (!f.diskPassword) { st.setStatus("set a disk password — encrypted VMs need one at creation", "warn"); return; }
            if (f.diskPassword !== f.diskPassword2) { st.setStatus("disk passwords don't match", "warn"); return; }
        }
        // dmabuf needs exported GL scanouts — a software-gpu VM must use rdp.
        if (f.viewer === "dmabuf" && f.gpu === "software") {
            st.setStatus("the dmabuf viewer needs a GL gpu — pick venus/virgl or the rdp viewer", "warn");
            return;
        }
        const sched = this.parseSchedForm(f);
        if (typeof sched === "string") { st.setStatus(sched, "warn"); return; }
        await this.run(`create ${f.name}`, async () => {
            const spec = defaultSpec(f.name);
            spec.resources.cpus = f.cpus;
            spec.resources.memoryMiB = f.memMiB;
            spec.resources.nestedVirt = f.nestedVirt;
            spec.resources.sched = sched;
            spec.disk.sizeGiB = f.diskGiB;
            spec.gpu.mode = f.gpu as VmSpec["gpu"]["mode"];
            spec.gpu.softwareVk = f.swVk;
            spec.display.headMode = f.headMode as VmSpec["display"]["headMode"];
            spec.display.viewer = f.viewer as VmSpec["display"]["viewer"];
            spec.persist = f.persist as VmSpec["persist"];
            spec.autostart = f.autostart;
            spec.network.mode = f.netMode as VmSpec["network"]["mode"];
            spec.snapshots.auto = f.snapAuto as VmSpec["snapshots"]["auto"];
            spec.snapshots.trigger = f.snapTrigger as VmSpec["snapshots"]["trigger"];
            spec.snapshots.keep = f.snapKeep;
            spec.disk.encrypt = f.encrypt as VmSpec["disk"]["encrypt"];
            spec.disk.keyStorage = f.keyStore as VmSpec["disk"]["keyStorage"];
            spec.disk.homeGiB = f.homeGiB;
            spec.credentials.username = f.username;
            // the ISO autoinstall path is subiquity — ubuntu-only for now;
            // in-guest os-release detection rescues a stale family anyway
            spec.os.family = (f.method === "iso" ? "ubuntu" : f.distro) as VmSpec["os"]["family"];
            spec.os.release = f.method === "cloudimg" ? f.release : "";
            spec.os.desktop = f.desktop as VmSpec["os"]["desktop"];
            spec.os.browser = f.browser as VmSpec["os"]["browser"];
            spec.os.snap = f.snap;
            spec.os.extraFonts = f.extraFonts;
            spec.os.autologin = f.autologin;
            // filter through the enum — a stray chip id shouldn't sink create
            spec.os.devtools = f.devtools.filter((d) => DevTool.safeParse(d).success) as VmSpec["os"]["devtools"];
            applySyncForm(spec, f);
            spec.credentials.sshAgentKeys = [...f.agentKeys];
            if (spec.os.desktop === "kde" && f.method === "cloudimg") {
                const { supportsKrdp } = await import("../../provision/src/distros");
                if (!supportsKrdp(spec.os.family, spec.os.release))
                    throw new Error(`KDE needs a guest release that ships krdp — ${spec.os.family} ${spec.os.release} doesn't have one`);
            }
            if (f.vd > 0) spec.display.virtualDesktop = f.vd;
            spec.usb.autoAttach = f.usb.map((k) => {
                const [vendorId = "", productId = "", serial = ""] = k.split(":");
                return { vendorId, productId, ...(serial ? { serial } : {}), atBoot: true };
            });
            if (f.method === "imported") {
                if (!f.importPath) throw new Error("choose a disk image file to import");
                spec.disk.file = f.importPath;
                const img = await this.probeImage(f.importPath);
                spec.disk.format = img.format;
                if (img.encrypted) {
                    // LUKS source: it only boots keyed — adopt encrypt=full
                    // and require the existing passphrase.
                    if (!f.diskPassword) throw new Error(`${f.importPath} is LUKS-encrypted — enter its disk password`);
                    if (f.diskPassword2 && f.diskPassword !== f.diskPassword2)
                        throw new Error("disk passwords don't match");
                    spec.disk.encrypt = "full";
                    spec.disk.keyStorage = f.keyStore as VmSpec["disk"]["keyStorage"];
                } else if (f.encrypt !== "off") {
                    throw new Error(`${f.importPath} is plaintext — an existing image can't be re-encrypted (encryption is chosen at image creation)`);
                }
            } else if (f.diskDir) {
                spec.disk.file = join(f.diskDir, `${f.name}.qcow2`);
            }
            this.validateSpec(spec);
            // A non-default VM location lands the whole dir elsewhere via a
            // vms/<name> symlink — linkVmDir creates the target + the link,
            // then registry.create writes through it as usual.
            if (f.vmDir) await linkVmDir(spec.name, f.vmDir);
            const h = await this.registry.create(spec);
            this.handles.set(spec.name, h);
            if (spec.autostart)
                syncAutostartUnit(autostartNames(this.registry.list())).catch(() => {});
            // Hand the LUKS passphrase to the VM before any keyed disk op —
            // secrets/disk-key for "store" (boots unattended), transient
            // run/disk-key for "prompt" (provision/start clear it after
            // QEMU consumes the secret).
            if (spec.disk.encrypt !== "off") await h.provideDiskKey(f.diskPassword);

            const onLog = (m: string) => this.store.getState().setStatus(m);
            const pw = f.password || undefined;
            if (f.method === "cloudimg") {
                const { provisionVmCloudimg } = await import("../../provision/src/provision");
                await provisionVmCloudimg(h, { release: f.release, username: f.username, password: pw, onLog });
            } else if (f.method === "iso") {
                const { provisionVmIso } = await import("../../provision/src/provision");
                await provisionVmIso(h, { iso: f.iso, username: f.username, password: pw, onLog });
            } else if (f.method === "imported") {
                spec.provisioned = { method: "imported", source: f.importPath, completedAt: new Date().toISOString() };
                if (pw) {
                    const { writePasswordFile } = await import("../../provision/src/nocloud");
                    await writePasswordFile(spec, pw);
                }
                await h.saveSpec();
            }
            this.store.getState().resetCreate();
            this.store.getState().setRoute("vm", spec.name);
        });
    }

    /** Gate for ops that touch a LUKS image. When the VM's passphrase isn't
     *  on file (keyStorage=prompt keeps nothing at rest), the op parks on
     *  the unlock banner instead of failing — unlockGo() re-dispatches it
     *  once the passphrase lands at the key path. */
    private diskKeyReady(h: VmHandle, op: string, arg?: string): boolean {
        if (h.spec.disk.encrypt === "off" || h.diskKeyFile()) return true;
        const st = this.store.getState();
        st.setUnlockPrompt({ vm: h.spec.name, op, arg });
        st.setStatus(`${h.spec.name}'s disk is encrypted — enter its passphrase to continue`, "warn");
        return false;
    }

    /** Unlock banner → write the passphrase to the VM's key path (transient
     *  run/disk-key for prompt mode — consumed + deleted by the next boot)
     *  and re-run the parked op. A wrong passphrase just fails the retried
     *  op with QEMU's own error, which re-parks on the banner. */
    async unlockGo(name: string): Promise<void> {
        const st = this.store.getState();
        const p = st.unlockPrompt;
        const pw = st.unlockPw;
        st.setUnlockPrompt(null);
        this.store.setState({ unlockPw: "" });
        if (!p || p.vm !== name) return;
        const h = this.handles.get(name); if (!h) return;
        if (!pw) { st.setStatus("no passphrase entered", "warn"); return; }
        await h.provideDiskKey(pw);
        try {
            switch (p.op) {
                case "start": await this.start(name); break;
                case "clone": await this.cloneVm(name); break;
                case "snapshot": await this.snapshot(name); break;
                case "restore": await this.restoreSnapshot(name, p.arg!); break;
                case "snapdel": await this.deleteSnapshot(name, p.arg!); break;
                case "grow": await this.saveVm(); break;
            }
        } finally {
            await h.clearDiskKey();   // prompt-mode keys never outlive their op
        }
    }

    async unlockCancel(): Promise<void> {
        this.store.getState().setUnlockPrompt(null);
        this.store.setState({ unlockPw: "" });
    }

    async start(name: string, opts: { skipAutoSnap?: boolean } = {}): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        if (!this.diskKeyReady(h, "start")) return;
        // Auto-snapshot "before start" edge — a space shortfall parks the
        // start on the user's choice in the prompt banner.
        if (!opts.skipAutoSnap && !(await this.autoSnapEdge(h, "start"))) return;
        await this.run(`start ${name}`, async () => {
            const { hostMirroredGuestMonitors } = await import("../../provision/src/monitors");
            return h.start({ guestMonitors: await hostMirroredGuestMonitors(h.spec) });
        }, { vm: name, verb: "starting" });
        // Boot → autologin → gnome-remote-desktop takes a while; open()'s
        // waitRdpPort polls for it in the background instead of holding
        // `busy`. headMode "app" has no freerdp viewer (waypipe is explicit).
        if (h.isRunning() && h.spec.display.headMode !== "app") void this.autoView(h);
    }
    async stop(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        const st = this.store.getState();
        // Flip the pill to "stopping" up front — a drain probe only reads
        // "running", so without this the row sits unchanged for the drain.
        this.stopping.add(name);
        this.paintFast();
        try {
            const out = await this.run(`stop ${name}`, () => {
                st.setStatus(`stopping ${name} — sent shutdown request to the guest OS`);
                return h.stop(60_000, (ms) => st.setStatus(
                    `stopping ${name} — guest is shutting down… ${Math.floor(ms / 1000)}s ` +
                    `(power off, not suspend — memory is not saved)`,
                ));
            }, {
                done: (out) => out === "stopped"
                    ? `${name} powered off cleanly`
                    : `${name} ignored the shutdown request — still running; use Kill to force power off`,
                vm: name, verb: "stopping",
            });
            // Auto-snapshot "after stop" edge — only a clean power-off qualifies.
            if (out === "stopped") await this.autoSnapEdge(h, "stop");
        } finally {
            this.stopping.delete(name);
            this.paintFast();
        }
    }

    /** Auto-snapshot hook for the start/stop lifecycle edges. Returns false
     *  only when a "start" is parked on the low-space prompt — a snapshot
     *  problem never blocks a stop, and a failed probe never blocks at all. */
    private async autoSnapEdge(h: VmHandle, trigger: "start" | "stop"): Promise<boolean> {
        const st = this.store.getState();
        const r = await runAutoSnapshot(h, trigger).catch((e) => {
            st.setStatus(`auto snapshot skipped: ${e instanceof Error ? e.message : e}`, "warn");
            return null;
        });
        if (!r || r.skipped) return true;
        if (r.shortfall) {
            st.setAutoSnapPrompt({ vm: h.spec.name, ...r.shortfall, context: trigger });
            st.setStatus(`${h.spec.name}: not enough free space for an auto snapshot`, "warn");
            return trigger !== "start";
        }
        if (r.created || r.freed.length || r.pruned.length) {
            const parts = [r.created && `'${r.created}' saved`];
            if (r.freed.length) parts.push(`${r.freed.length} deleted for space`);
            if (r.pruned.length) parts.push(`${r.pruned.length} pruned`);
            st.setStatus(`${h.spec.name}: auto snapshot ${parts.filter(Boolean).join(", ")}`);
            this.invalidateSnaps(h.spec.name);
        }
        return true;
    }

    /** Space prompt → "start without snapshot" / "dismiss". */
    async autoSnapSkip(name: string): Promise<void> {
        const p = this.store.getState().autoSnapPrompt;
        this.store.getState().setAutoSnapPrompt(null);
        if (p?.vm === name && p.context === "start") await this.start(name, { skipAutoSnap: true });
    }

    /** Space prompt → delete the remaining snapshots to make room, then
     *  retry the parked action. */
    async autoSnapPurge(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        const p = this.store.getState().autoSnapPrompt;
        this.store.getState().setAutoSnapPrompt(null);
        if (!p || p.vm !== name) return;
        await this.run(`delete ${p.remaining.length} snapshot${p.remaining.length === 1 ? "" : "s"} on ${name}`,
            async () => { for (let i = 0; i < p.remaining.length; i++) await h.deleteSnapshot(p.remaining[i]!); },
            { vm: name, verb: "deleting snapshots" });
        this.invalidateSnaps(name);
        if (p.context === "start") await this.start(name);
    }
    async kill(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`kill ${name}`, () => h.kill(), { vm: name, verb: "killing" });
    }
    async remove(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        if (h.isRunning()) {
            this.store.getState().setStatus(`stop ${name} before deleting it`, "warn");
            return;
        }
        await this.run(`remove ${name}`, async () => {
            await this.registry.remove(name, { deleteDisk: true });
            this.handles.delete(name);
            this.termDropped?.(name);
            this.metrics.drop(name);
            this.snapCache.delete(name);
            this.store.getState().setRoute("home");
        }, { vm: name, verb: "deleting" });
    }

    /** Current spec for a registered VM (null when unknown). */
    specOf(name: string): VmSpec | null {
        return this.handles.get(name)?.spec ?? null;
    }

    /** Detail-screen "show/hide" — reads the 0600 secrets file on demand;
     *  the plaintext never rides along in VmSummary's 3s poll. */
    async togglePassword(name: string): Promise<void> {
        const st = this.store.getState();
        if (st.pwReveal?.vm === name) { st.setPwReveal(null); return; }
        const h = this.handles.get(name); if (!h) return;
        const { rdpPassword } = await import("../../host-int/src/freerdp");
        const pw = await rdpPassword(h.spec);
        if (!pw) { st.setStatus(`${name}: no password on record`, "warn"); return; }
        st.setPwReveal({ vm: name, pw });
    }

    /**
     * Terminal for a running VM: route to the embedded webui terminal when
     * the whole path is staged (backend + term-dd + xterm bundle), else
     * spawn a host terminal emulator over the same ssh connection.
     */
    async term(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        const st = this.store.getState();
        if (!h.isRunning()) { st.setStatus(`${name} isn't running`, "warn"); return; }
        const { TermManager } = await import("./term/term-manager");
        const { termBundleReady } = await import("./term/page");
        const { termDdPath } = await import("../../host-int/src/termemu");
        if (TermManager.embeddedAvailable() && termBundleReady() && (await termDdPath())) {
            st.setTermLine("connecting…");
            st.setRoute("term", name);
            return;
        }
        await this.termHost(name);
    }

    /** Escape hatch — always opens a host terminal emulator on the guest. */
    async termHost(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        const st = this.store.getState();
        try {
            const { openHostTerm } = await import("../../host-int/src/termemu");
            await openHostTerm(h.spec);
            st.setStatus(`${name} — opened a host terminal`);
        } catch (e) {
            st.setStatus(`terminal failed: ${(e as Error).message}`, "error");
        }
    }

    async resume(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`resume ${name}`, () => h.resume(), { vm: name, verb: "resuming" });
    }

    /** Save the edit form back onto the VM's spec. Only boot-time fields are
     *  editable — provisioning/credentials are baked in at provision time. */
    async saveVm(): Promise<void> {
        const st = this.store.getState();
        const name = st.editVm;
        if (!name) return;
        const h = this.handles.get(name);
        if (!h) return;
        const f = st.create;
        if (f.cpus < 1 || f.cpus > 64) { st.setStatus("vCPUs must be between 1 and 64", "warn"); return; }
        if (f.memMiB < 512) { st.setStatus("memory must be at least 512 MiB", "warn"); return; }
        if (f.diskGiB < h.spec.disk.sizeGiB) { st.setStatus("disk can only grow", "warn"); return; }
        if (f.diskGiB !== h.spec.disk.sizeGiB && h.isRunning()) {
            st.setStatus("stop the VM before growing the disk", "warn");
            return;
        }
        // LUKS resize needs the passphrase — park the whole save on the
        // unlock banner when prompt-mode has no key on file.
        if (f.diskGiB !== h.spec.disk.sizeGiB && !this.diskKeyReady(h, "grow")) return;
        if (f.viewer === "dmabuf" && f.gpu === "software") {
            st.setStatus("the dmabuf viewer needs a GL gpu — pick venus/virgl or the rdp viewer", "warn");
            return;
        }
        const sched = this.parseSchedForm(f);
        if (typeof sched === "string") { st.setStatus(sched, "warn"); return; }
        // A changed VM location physically moves the dir — QEMU must not
        // hold open files under it.
        const curParent = dirname(vmRealDir(name));
        if (f.vmDir && f.vmDir !== curParent && h.isRunning()) {
            st.setStatus(`stop ${name} before moving its storage`, "warn");
            return;
        }
        await this.run(`save ${name}`, async () => {
            const prev = h.spec;
            // Clone-then-validate: a schema rejection must not leave h.spec
            // half-mutated while the VM keeps running.
            const spec: VmSpec = JSON.parse(JSON.stringify(prev));
            spec.resources.cpus = f.cpus;
            spec.resources.memoryMiB = f.memMiB;
            spec.resources.nestedVirt = f.nestedVirt;
            spec.resources.sched = sched;
            spec.disk.sizeGiB = f.diskGiB;
            spec.gpu.mode = f.gpu as VmSpec["gpu"]["mode"];
            spec.gpu.softwareVk = f.swVk;
            spec.display.headMode = f.headMode as VmSpec["display"]["headMode"];
            spec.display.viewer = f.viewer as VmSpec["display"]["viewer"];
            if (f.vd > 0) spec.display.virtualDesktop = f.vd;
            spec.persist = f.persist as VmSpec["persist"];
            spec.autostart = f.autostart;
            spec.network.mode = f.netMode as VmSpec["network"]["mode"];
            spec.snapshots.auto = f.snapAuto as VmSpec["snapshots"]["auto"];
            spec.snapshots.trigger = f.snapTrigger as VmSpec["snapshots"]["trigger"];
            spec.snapshots.keep = f.snapKeep;
            spec.usb.autoAttach = f.usb.map((k) => {
                const [vendorId = "", productId = "", serial = ""] = k.split(":");
                return { vendorId, productId, ...(serial ? { serial } : {}), atBoot: true };
            });
            spec.description = st.vmDesc.trim();
            applySyncForm(spec, f);
            spec.credentials.sshAgentKeys = [...f.agentKeys];
            this.validateSpec(spec);
            if (f.diskGiB !== h.spec.disk.sizeGiB) await h.resizeDisk(f.diskGiB);
            h.spec = spec;
            await h.saveSpec();
            // autostart is live — the boot unit follows the flagged set.
            if (prev.autostart !== spec.autostart)
                syncAutostartUnit(autostartNames(this.registry.list())).catch(() => {});
            // headMode/virtualDesktop are live fields — a running viewer
            // re-places its window + retargets the KWin map rule right now.
            if (prev.display.headMode !== spec.display.headMode
                || prev.display.virtualDesktop !== spec.display.virtualDesktop)
                this.applyLiveDisplay(h);
            // Last: relocate the real dir and repoint absolute spec paths
            // (relocate() writes vm.json itself). The disk resize above ran
            // against the old location — qemu-img follows the link either way.
            if (f.vmDir && f.vmDir !== curParent) await this.registry.relocate(name, f.vmDir);
            st.resetCreate();
            st.setRoute("vm", name);
            return h.isRunning() ? bootRelevantChanges(prev, spec) : [];
        }, {
            done: (pending) => pending?.length
                ? `saved ${name} — restart to apply: ${pending.join(", ")}`
                : `saved ${name}`,
        });
    }

    /** Push h.spec.display into the VM's live viewer: the tracked session
     *  when there is one, else a throwaway session that adopts the detached
     *  window by title (it never respawns the viewer). Fire-and-forget —
     *  placement failure is a status note, not a save failure. */
    private applyLiveDisplay(h: VmHandle): void {
        const name = h.spec.name;
        const v = this.viewers.get(name)?.viewer ?? new ViewerSession(h.spec, {
            log: (m) => this.store.getState().setStatus(`${name}: ${m}`),
        });
        v.applyDisplaySpec(h.spec.display)
            .catch((e) => this.store.getState().setStatus(`${name} viewer placement failed: ${(e as Error).message}`, "error"));
    }

    /** Open (or raise) the VM's viewer in the background — RDP may take tens
     *  of seconds to appear and must not hold the UI's busy lock. */
    async view(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        if (this.viewers.has(name)) {
            const s = this.viewers.get(name)!;
            // Adopted sessions track no child — if their window died, drop
            // the stale entry and relaunch instead of focusing a ghost.
            if (await s.viewer.windowGone()) {
                this.viewers.delete(name);
                s.disposeSyncs();
                void s.viewer.close();
            } else {
                void s.viewer.focus();
                this.store.getState().setStatus(`${name} viewer raised`);
                return;
            }
        }
        void this.autoView(h);
    }

    /** Open the VM's freerdp viewer; joins an open already in flight. */
    private ensureViewer(h: VmHandle): Promise<void> {
        const name = h.spec.name;
        if (this.viewers.has(name)) return Promise.resolve();
        const inflight = this.viewerPending.get(name);
        if (inflight) return inflight;
        const p = (async () => {
            try {
                const { openVmSession } = await import("../../provision/src/session");
                const s = await openVmSession(h,
                    { log: (m) => this.store.getState().setStatus(`${name}: ${m}`) });
                if (this.viewers.has(name)) { s.disposeSyncs(); await s.viewer.close(); return; }
                this.viewers.set(name, s);
                s.viewer.on("closed", () => { this.viewers.delete(name); });
            } finally {
                this.viewerPending.delete(name);
            }
        })();
        this.viewerPending.set(name, p);
        return p;
    }

    /** Background viewer open after start/view — no busy lock (the RDP wait
     *  can take tens of seconds), but the VM's button cluster shows the live
     *  action glyph until the window lands or the open fails. */
    private async autoView(h: VmHandle): Promise<void> {
        const name = h.spec.name;
        const st = this.store.getState();
        st.setStatus(`waiting for ${name} guest login (rdp :${h.spec.network.rdpPort ?? "–"})…`);
        // Only claim the indicator when it's free — don't stomp another
        // in-flight action, and don't clear one either.
        let ours: ActionState | null = null;
        if (!st.actions[name]) {
            ours = { vm: name, verb: "opening viewer", at: Date.now() };
            st.setAction(ours);
        }
        try {
            await this.ensureViewer(h);
            if (this.viewers.has(name)) st.setStatus(`${name} viewer opened`);
        } catch (e) {
            st.setStatus(`viewer for ${name}: ${e instanceof Error ? e.message : e}`, "error");
        } finally {
            if (ours && this.store.getState().actions[name] === ours) st.clearAction(name);
        }
    }

    async snapshot(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        if (!this.diskKeyReady(h, "snapshot")) return;
        if (h.isRunning()) {
            this.store.getState().setStatus(`stop ${name} before taking a snapshot — qemu-img needs the disk offline`, "warn");
            return;
        }
        await this.run(`snapshot ${name}`, () => h.snapshot(`snap-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`),
            { vm: name, verb: "saving snapshot" });
        this.invalidateSnaps(name);
    }
    async restoreSnapshot(name: string, snap: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        if (!this.diskKeyReady(h, "restore", snap)) return;
        await this.run(`restore ${snap}`, () => h.restoreSnapshot(snap), { vm: name, verb: "restoring" });
        this.invalidateSnaps(name);
    }
    async deleteSnapshot(name: string, snap: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        if (!this.diskKeyReady(h, "snapdel", snap)) return;
        if (h.isRunning()) {
            this.store.getState().setStatus(`stop ${name} before deleting a snapshot — qemu-img needs the disk offline`, "warn");
            return;
        }
        await this.run(`delete snapshot ${snap}`, () => h.deleteSnapshot(snap), { vm: name, verb: "deleting snapshot" });
        this.invalidateSnaps(name);
    }

    /** Console capture — QMP screendump when the console has a surface
     *  (rdp/virgl viewers), guest-DE screenshot as fallback (dmabuf
     *  viewers never materialize one — "no surface"). */
    async screenshot(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        if (!h.isRunning()) { this.store.getState().setStatus(`start ${name} before taking a screenshot`, "warn"); return; }
        await this.run(`screenshot ${name}`, async () => {
            const out = join(h.paths.run, `screenshot-${Date.now()}.png`);
            try { return await h.screenshot(out); } catch { /* fall through to the guest path */ }
            const { guestScreenshot } = await import("../../vm-core/src/screen");
            const { writeFile } = await import("node:fs/promises");
            await writeFile(out, await guestScreenshot(h));
            return out;
        }, { done: (p) => `screenshot → ${p}`, vm: name, verb: "capturing" });
    }

    // ── port forwards (live — slirp hostfwd_add/remove + spec save) ──

    async fwdAdd(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        const f = this.store.getState().fwdForm;
        const hostPort = Number(f.hostPort), guestPort = Number(f.guestPort);
        if (!Number.isInteger(hostPort) || !Number.isInteger(guestPort)
            || hostPort < 1 || hostPort > 65535 || guestPort < 1 || guestPort > 65535) {
            this.store.getState().setStatus("both ports must be 1–65535", "warn");
            return;
        }
        if (h.spec.network.hostfwd.some((x) => x.proto === f.proto && x.hostPort === hostPort)) {
            this.store.getState().setStatus(`127.0.0.1:${hostPort} (${f.proto}) is already forwarded`, "warn");
            return;
        }
        await this.run(`forward :${hostPort}→${guestPort}`, async () => {
            await h.applyForwards([...h.spec.network.hostfwd, { proto: f.proto, hostPort, guestPort }]);
            this.store.getState().setFwdForm({ hostPort: "", guestPort: "", open: false });
        }, { done: () => `forwarding ${f.proto} 127.0.0.1:${hostPort} → :${guestPort}${h.isRunning() ? " (live)" : ""}`, vm: name, verb: "forwarding" });
    }

    async fwdRm(name: string, hostPort: number, proto: "tcp" | "udp"): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`remove forward :${hostPort}`, () =>
            h.applyForwards(h.spec.network.hostfwd.filter((f) => !(f.proto === proto && f.hostPort === hostPort))),
            { vm: name, verb: "removing forward" });
    }

    // ── guest→host sshfs mount (cli: vm mount/umount) ──

    async mountVm(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`mount ${name}`, async () => {
            const { mountGuest } = await import("../../host-int/src/mount");
            const m = await mountGuest(h);
            this.paintFast();
            return m.mountpoint;
        }, { done: (mp) => `mounted ${name} → ${mp}`, vm: name, verb: "mounting" });
    }

    async umountVm(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`unmount ${name}`, async () => {
            const { umountGuest } = await import("../../host-int/src/mount");
            await umountGuest(name);
            this.paintFast();
        }, { vm: name, verb: "unmounting" });
    }

    async openMount(name: string): Promise<void> {
        const mp = this.store.getState().vms.find((v) => v.name === name)?.mount;
        if (!mp) return;
        const { spawnChild } = await import("../../sys/src/exec");
        spawnChild("xdg-open", [mp], { detached: true }).unref();
    }

    /** Status-line path action ("open" on "— see /…log"): a runner log
     *  routes to the Logs screen (selectable text + follow), anything
     *  else goes to xdg-open. */
    async openPath(p: string): Promise<void> {
        for (const [name, h] of this.handles.entries()) {
            const f = runnerLogFiles(h.paths).find((x) => x.path === p);
            if (!f) continue;
            const st = this.store.getState();
            st.setRoute("logs", name);
            st.setLogs({ source: "runner", file: f.id });
            void this.refreshLogs();
            void this.loadLogUnits();
            return;
        }
        const { spawnChild } = await import("../../sys/src/exec");
        spawnChild("xdg-open", [p], { detached: true }).unref();
    }

    /** OSC-8 links inside the log pane — scheme-filtered to http(s) like
     *  the guest urlopen channel; log text is guest-influenced. */
    async openUrl(u: string): Promise<void> {
        if (!/^https?:\/\//i.test(u)) return;
        const { spawnChild } = await import("../../sys/src/exec");
        spawnChild("xdg-open", [u], { detached: true }).unref();
    }

    /** Host clipboard write ("copy path") — the native window owns the
     *  selection itself (arboard behind dd_window_* FFI); wl-copy/xclip/xsel
     *  stay as fallback for hosts where that path is absent or dead. */
    async copyText(text: string): Promise<void> {
        const st = this.store.getState();
        const nw = (globalThis as {
            __nativeWindow?: { setClipboardText?: (t: string) => void; getClipboardText?: () => string };
        }).__nativeWindow;
        let ok = false;
        try {
            nw?.setClipboardText?.(text);
            // a dead arboard init is a silent no-op inside the FFI — read
            // back to confirm the selection took (its buffer is 4K, so
            // longer writes just trust the call).
            ok = !!nw?.setClipboardText
                && (text.length >= 4000 || nw?.getClipboardText?.() === text);
        } catch { /* no window / FFI error — shell tools below */ }
        if (!ok) {
            const tool = async (bin: string, args: string[]) =>
                !!(await which(bin)) &&
                await run(bin, args, { input: text, timeoutMs: 8_000 }).then(() => true, () => false);
            const x11 = () => tool("xclip", ["-selection", "clipboard"])
                .then((o) => o || tool("xsel", ["--clipboard", "--input"]));
            ok = process.env.WAYLAND_DISPLAY
                ? await tool("wl-copy", []) || await x11()
                : await x11() || await tool("wl-copy", []);
        }
        st.setStatus(ok ? "path copied to clipboard"
            : "no clipboard tool found (install wl-clipboard or xclip)", ok ? "info" : "warn");
    }

    /** Clone a stopped VM — auto-names '<name>-copy' ('-copy-2'…). The disk
     *  is reflinked/converted without its snapshots; ports re-allocate. */
    async cloneVm(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        if (!this.diskKeyReady(h, "clone")) return;
        if (h.isRunning()) {
            this.store.getState().setStatus(`stop ${name} before cloning it`, "warn");
            return;
        }
        let newName = `${name}-copy`;
        for (let i = 2; this.handles.has(newName); i++) newName = `${name}-copy-${i}`;
        await this.run(`clone ${name} → ${newName}`, async () => {
            const nh = await this.registry.clone(name, newName);
            this.handles.set(newName, nh);
            this.store.getState().setRoute("vm", newName);
            return newName;
        }, { done: (n) => `cloned ${name} → '${n}' (snapshots not carried over)`, vm: name, verb: "cloning" });
    }

    async launchApp(name: string, cmd: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`launch ${cmd}`, async () => {
            const { launchApp } = await import("../../app-mode/src/waypipe");
            return await launchApp(h, cmd);
        }, { vm: name, verb: "launching",
             done: (l) => l.warning ?? `launched ${cmd} via ${l.transport}` });
    }

    // ── config import/export + shares ──

    /** Create-screen "Import" — a gist url/id or a local *.cruiser.* file.
     *  Creates the VM directly (the form can't represent every spec field,
     *  e.g. shares/escapeShortcuts, so filling it would lose data). */
    async importConfig(): Promise<void> {
        const st = this.store.getState();
        const ref = st.create.importRef.trim();
        if (!ref) { st.setStatus("paste a gist url/id or a config file path first", "warn"); return; }
        await this.run(`import ${ref}`, async () => {
            const P = await import("../../vm-core/src/config/portable");
            const { doc, origin } = await P.loadPortableRef(ref);
            let name = doc.spec.name;
            for (let n = 1; this.handles.has(name); n++) name = `${doc.spec.name}-${n}`;
            const spec = doc.spec;
            spec.name = name;
            spec.origin = origin;
            if (doc.description && !spec.description) spec.description = doc.description;
            const h = await this.registry.create(VmSpec.parse(spec));
            this.handles.set(name, h);
            this.store.getState().resetCreate();
            this.store.getState().setRoute("vm", name);
            return name;
        }, { done: (n) => `imported '${n}' — provision it to boot` });
    }

    /** Export the VM's portable config — save dialog when kdialog/zenity is
     *  around, else <vmdir>/<name>.cruiser.yaml. */
    async exportConfig(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        const P = await import("../../vm-core/src/config/portable");
        const suggested = join(h.paths.dir, P.portableFilename(name, "yaml"));
        const hasDlg = (await which("kdialog")) || (await which("zenity"));
        let out = suggested;
        if (hasDlg) {
            const picked = await this.pickPath("save", "Export VM config", suggested);
            if (!picked) return;
            out = picked;
        }
        await this.run(`export ${name}`, async () => {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(out, P.serializePortable(P.exportPortable(h.spec), "yaml"));
            return out;
        }, { done: (o) => `exported → ${o}`, vm: name, verb: "exporting" });
    }

    /** Push the portable config to a gist — updates the recorded gist when
     *  this VM was pushed/imported before, else creates a secret one. */
    async gistPush(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`push ${name} to gist`, async () => {
            const P = await import("../../vm-core/src/config/portable");
            const G = await import("../../sys/src/gist");
            const desc = h.spec.description || `cruiser vm '${name}'`;
            const doc = P.exportPortable(h.spec, desc);
            const fname = P.portableFilename(name, "yaml");
            const id = h.spec.origin?.kind === "gist" ? h.spec.origin.id : undefined;
            const r = await G.pushGist({ id, description: desc, files: { [fname]: P.serializePortable(doc, "yaml") } });
            h.spec.origin = { kind: "gist", id: r.id, url: r.url };
            if (!h.spec.description) h.spec.description = desc;
            await h.saveSpec();
            return r.url;
        }, { done: (u) => `pushed → ${u}`, vm: name, verb: "pushing" });
    }

    /** Re-import the spec from spec.origin (gist or file). */
    async gistPull(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        if (!h.spec.origin) {
            this.store.getState().setStatus(`${name} has no origin — push or import it first`, "warn");
            return;
        }
        await this.run(`pull config for ${name}`, async () => {
            const P = await import("../../vm-core/src/config/portable");
            const prev = h.spec.display;
            const { needsRestart } = await P.pullConfigFromOrigin(h);
            // A pulled headMode/virtualDesktop is a live field — re-place the
            // running viewer instead of waiting for a viewer relaunch.
            if (prev.headMode !== h.spec.display.headMode
                || prev.virtualDesktop !== h.spec.display.virtualDesktop)
                this.applyLiveDisplay(h);
            return needsRestart;
        }, {
            done: (nr) => nr.length ? `pulled — applies at next boot: ${nr.join(", ")}` : "pulled — nothing boot-relevant changed",
            vm: name, verb: "pulling",
        });
    }

    /** Browse for the share's host directory. */
    async pickShareDir(): Promise<void> {
        const p = await this.pickPath("dir", "Choose host folder to share", homedir());
        if (p) this.store.getState().setShareForm({ hostPath: p });
    }

    async shareAdd(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        const st = this.store.getState();
        const f = st.shareForm;
        if (!f.hostPath.trim()) { st.setStatus("set a host path for the share first", "warn"); return; }
        await this.run(`add share`, async () => {
            const next = JSON.parse(JSON.stringify(h.spec)) as VmSpec;
            next.shares.push(makeShare(next, {
                hostPath: f.hostPath.trim(),
                guestPath: f.guestPath.trim() || undefined,
                mode: f.mode,
                direction: f.direction,
            }));
            h.spec = VmSpec.parse(next);
            await h.saveSpec();
            st.setShareForm({ hostPath: "", guestPath: "", open: false });
            return f.mode;
        }, {
            done: (m) => m === "copy"
                ? "share added — copy entries sync live while a viewer session is open"
                : h.isRunning() ? "share added — fstab lands on the next sync pass; the device attaches at next boot" : "share added",
            vm: name, verb: "adding share",
        });
    }

    async shareRemove(name: string, idx: number): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`remove share`, async () => {
            const next = JSON.parse(JSON.stringify(h.spec)) as VmSpec;
            next.shares.splice(idx, 1);
            h.spec = VmSpec.parse(next);
            await h.saveSpec();
        }, { vm: name, verb: "removing share" });
    }

    /** Toggle a share attribute — enabled, mode, or direction. */
    async shareAttr(name: string, idx: number, field: string, value: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        const next = JSON.parse(JSON.stringify(h.spec)) as VmSpec;
        const s = next.shares[idx];
        if (!s) return;
        if (field === "enabled") s.enabled = value === "true";
        else if (field === "mode" && (value === "mount" || value === "copy")) s.mode = value;
        else if (field === "direction" && (value === "both" || value === "host-to-guest")) {
            s.direction = value;
            s.readOnly = value === "host-to-guest";
        } else return;
        h.spec = VmSpec.parse(next);
        await h.saveSpec();
        this.store.getState().setStatus("share updated");
        this.refresh().catch(() => {});
    }

    /** Run the copy-mode shares once, right now. */
    async filesyncNow(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        if (!h.isRunning()) { this.store.getState().setStatus(`${name} isn't running`, "warn"); return; }
        await this.run(`file sync`, async () => {
            const { FileSyncs } = await import("../../provision/src/filesync");
            await new FileSyncs(h, (m) => this.store.getState().setStatus(`${name}: ${m}`)).applyOnce();
        }, { vm: name, verb: "syncing" });
    }

    async runDoctor(): Promise<void> {
        await this.run("doctor", async () => {
            const { existsSync } = await import("node:fs");
            const { run, which, virtiofsdPath } = await import("../../sys/src/exec");
            const { resolveToolchain } = await import("../../vm-core/src/qemu/resolve");
            const rows: DoctorRow[] = [];
            const k = await run("test", ["-w", "/dev/kvm"], { noThrow: true });
            rows.push({ label: "/dev/kvm writable", ok: k.code === 0, fix: "usermod -aG kvm $USER" });
            const tools = ["xfreerdp3", "cloud-localds", "genisoimage", "wmctrl", "xdotool", "qdbus", "waypipe", "socat", "sshfs"];
            for (let i = 0; i < tools.length; i++)
                rows.push({ label: `tool: ${tools[i]}`, ok: !!(await which(tools[i]!)), fix: "see toolchain/versions.json systemTools" });
            rows.push({ label: "tool: virtiofsd", ok: (await virtiofsdPath()) !== null, fix: "apt install virtiofsd" });
            rows.push({ label: "tool: rsync (copy shares)", ok: !!(await which("rsync")), fix: "apt install rsync — needed for copy-mode shares" });
            rows.push({ label: "tool: gh (gist push)", ok: !!(await which("gh")), fix: "apt install gh + gh auth login, or set GITHUB_TOKEN" });
            const tc = await resolveToolchain().catch(() => null);
            rows.push({ label: "qemu toolchain", ok: !!tc, fix: "cruiser toolchain build" });
            if (tc) {
                // qcow2 LUKS — the --encrypt option needs QEMU's crypto
                // backend (gcrypt/nettle); a tiny keyed create is the probe.
                const key = join("/var/tmp", `cruiser-doctor-key-${process.pid}`);
                const img = join("/var/tmp", `cruiser-doctor-luks-${process.pid}.qcow2`);
                const { writeFile: wf, rm: rmp } = await import("node:fs/promises");
                await wf(key, "doctor", { mode: 0o600 });
                const luks = await run(tc.qemuImg, ["create", "-f", "qcow2",
                    "--object", `secret,id=diskkey,file=${key}`,
                    "-o", "encrypt.format=luks,encrypt.key-secret=diskkey",
                    img, "1G"], { noThrow: true, env: { LD_LIBRARY_PATH: tc.ldLibraryPath } });
                await rmp(key, { force: true }); await rmp(img, { force: true });
                rows.push({ label: "qemu LUKS disk encryption", ok: luks.code === 0,
                    fix: `qemu-img lacks crypto support — encryption (--encrypt) won't work${luks.stderr ? `: ${luks.stderr.trim().slice(0, 80)}` : ""}` });
            }
            const { ovmfCode } = await import("../../vm-core/src/qemu/args");
            rows.push({ label: "OVMF firmware", ok: existsSync(ovmfCode()), fix: "apt install ovmf" });
            const usbDevs = await listUsbDevices().catch(() => []);
            const blocked = usbDevs.filter((d) => !d.writable).length;
            rows.push({ label: `usb passthrough (${blocked}/${usbDevs.length} blocked)`, ok: blocked === 0,
                fix: 'udev: SUBSYSTEM=="usb" GROUP="plugdev" MODE="0660" in /etc/udev/rules.d/99-cruiser-usb.rules' });
            this.store.getState().setDoctor(rows);
        });
    }

    /** Probe a disk image's real format + LUKS flag for `method:"imported"`.
     *  `qemu-img info` reads LUKS headers without the key, so the probe is
     *  safe on encrypted images (mutations are what need it). */
    private async probeImage(path: string): Promise<{ format: string; encrypted: boolean }> {
        try {
            const { resolveToolchain } = await import("../../vm-core/src/qemu/resolve");
            const tc = await resolveToolchain();
            const r = await run(tc.qemuImg, ["info", "--output=json", path]);
            const j = JSON.parse(r.stdout);
            if (typeof j?.format === "string" && j.format)
                return { format: j.format, encrypted: j.encrypted === true };
        } catch { /* qemu-img unavailable — fall through to default */ }
        return { format: "qcow2", encrypted: false };
    }
}

/** Free GiB on the filesystem containing `dir` (via df; dir needn't exist). */
async function diskFreeGiB(dir: string): Promise<number> {
    const r = await run("df", ["-k", dir], { noThrow: true });
    const cols = r.stdout.trim().split("\n").pop()?.trim().split(/\s+/) ?? [];
    const kb = Number(cols[3]);
    return Number.isFinite(kb) ? kb / 1048576 : 0;
}

/** KWin virtual-desktop grid rows from kwinrc [Desktops] Rows=N (1 = strip). */
async function kdeDesktopRows(): Promise<number> {
    const cfgDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const txt = await readFile(join(cfgDir, "kwinrc"), "utf-8").catch(() => "");
    const m = txt.match(/\[Desktops\]([\s\S]*?)(?:\n\[|$)/);
    const rows = Number(m?.[1]?.match(/^\s*Rows\s*=\s*(\d+)/m)?.[1]);
    return Number.isInteger(rows) && rows > 0 && rows <= 4 ? rows : 1;
}
