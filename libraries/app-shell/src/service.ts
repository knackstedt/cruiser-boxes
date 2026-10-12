// ============================================================================
// service.ts — the UI's backend: owns VmRegistry, polls VM state into the
// store, and executes actions (create/provision/start/stop/view/snapshots).
// ============================================================================

import { VmRegistry } from "../../vm-core/src/lifecycle/registry";
import { VmHandle } from "../../vm-core/src/lifecycle/vm";
import { defaultSpec, DevTool, VmSpec } from "../../vm-core/src/config/schema";
import { makeShare } from "../../vm-core/src/config/shares";
import { CACHE_DIR, CLOUDIMG_DIR, CONFIG_DIR, DATA_DIR, ISO_DIR, VMS_DIR } from "../../vm-core/src/paths";
import { detectAdapter, detectSession } from "../../host-int/src/detect";
import type { VmSession } from "../../provision/src/session";
import { listUsbDevices } from "../../vm-core/src/usb/usb";
import { runnerLogFiles, tailFile, guestJournal, guestJournalUnits } from "../../vm-core/src/logs";
import { run, which } from "../../sys/src/exec";
import { cpus, totalmem, homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { mark } from "./startup-profile";
import { VmMetricsSampler } from "./metrics";
import type { ActionState, CreateForm, DoctorRow, HostInfo, Store, VmSummary } from "./store";
import { SYNC_CHANNELS, type SyncId } from "../../vm-core/src/config/sync-channels";
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
    private snapCache = new Map<string, { names: string[]; at: number }>();

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

    /** Populate create-screen extras: host totals, desktops grid, USB list. */
    async refreshCreateExtras(): Promise<void> {
        const st = this.store.getState();
        const dir = st.create.diskDir || VMS_DIR;
        const adapter = detectAdapter();
        const [desktops, usb, freeGiB, rows] = await Promise.all([
            adapter.desktops().catch(() => []),
            listUsbDevices().catch(() => []),
            diskFreeGiB(dir).catch(() => 0),
            kdeDesktopRows().catch(() => 1),
        ]);
        st.setDesktops(desktops.map((d) => ({ index: d.index, name: d.name, current: d.current })), rows);
        this.usbToStore(usb);
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
        this.store.getState().setStatus("no file dialog found (kdialog/zenity) — type the path");
        return null;
    }

    async pickDiskDir(): Promise<void> {
        const p = await this.pickPath("dir", "Choose disk location", this.store.getState().create.diskDir || VMS_DIR);
        if (!p) return;
        this.store.getState().setField("diskDir", p === VMS_DIR ? "" : p);
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
            st.setStatus(`${label} ignored — another action is still running`);
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
            st.setStatus(`${label} failed: ${e instanceof Error ? e.message : e}`);
            return undefined;
        } finally {
            if (opts.vm) this.busyVms.delete(opts.vm); else st.setBusy(false);
            st.setAction(null);
            this.refresh().catch(() => {});
        }
    }

    /** Spec-derived fields + provisional pidfile state — no socket I/O. */
    private baseSummary(h: VmHandle, state: VmSummary["state"]): VmSummary {
        const s = h.spec;
        return {
            name: s.name, state,
            gpuMode: s.gpu.mode, headMode: s.display.headMode,
            cpus: s.resources.cpus, memMiB: s.resources.memoryMiB,
            diskGiB: s.disk.sizeGiB,
            sshPort: s.network.sshPort, rdpPort: s.network.rdpPort,
            provisioned: s.provisioned.method, persist: s.persist,
            description: s.description,
            origin: s.origin ? `${s.origin.kind}:${s.origin.id ?? s.origin.url ?? ""}` : undefined,
            shares: s.shares.map((sh, idx) => ({
                idx, tag: sh.tag, hostPath: sh.hostPath, guestPath: sh.guestPath,
                mode: sh.mode, direction: sh.direction, enabled: sh.enabled, deletions: sh.deletions,
            })),
            snapshots: [],
            vd: s.display.virtualDesktop,
            usbKeys: s.usb.autoAttach.map((u) => [u.vendorId, u.productId, u.serial].filter(Boolean).join(":")),
            sync: { ...s.sync },
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

    /** Push spec+pidfile rows immediately — scan/refresh refine them in
     *  place as the real probes land. */
    private paintFast(): void {
        const prev = new Map(this.store.getState().vms.map((v) => [v.name, v]));
        const vms = [...this.handles.values()].map((h) =>
            this.carryPrev(this.baseSummary(h, h.isRunning() ? "running" : "stopped"), prev.get(h.spec.name)));
        vms.sort((a, b) => a.name.localeCompare(b.name));
        this.store.getState().setVms(vms);
    }

    private async summarize(h: VmHandle, onEarly?: (s: VmSummary) => void): Promise<VmSummary> {
        let state: VmSummary["state"] = "stopped";
        try { state = await h.probe(); } catch { state = "unknown"; }
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
        if (this.refreshing) return;
        this.refreshing = true;
        try {
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
                this.carryPrev(this.baseSummary(h, h.isRunning() ? "running" : "stopped"), acc.get(h.spec.name))));
            flush();
            // Progressive: probe lands the real state first, metrics/snaps
            // fill in behind it (QGA can take ~2.5s on a dead agent).
            await Promise.all([...this.handles.values()].map(async (h) => {
                const s = await this.summarize(h, (early) => put(h, early)).catch(() => null);
                if (s) put(h, s);
            }));
        } finally {
            this.refreshing = false;
        }
    }

    private usbToStore(usb: Awaited<ReturnType<typeof listUsbDevices>>): void {
        this.store.getState().setUsbDevices(usb.map((d) => ({
            key: `${d.vendorId}:${d.productId}${d.serial ? `:${d.serial}` : ""}`,
            vendorId: d.vendorId, productId: d.productId, serial: d.serial,
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

    /** Fetch the active log source for the selected VM into store.logs. */
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
            st.setStatus("name must be lowercase letters/digits/dashes (e.g. 'dev-box')");
            return;
        }
        if (this.handles.has(f.name)) { st.setStatus(`a VM named '${f.name}' already exists`); return; }
        if (f.cpus < 1 || f.cpus > 64) { st.setStatus("vCPUs must be between 1 and 64"); return; }
        if (f.memMiB < 512) { st.setStatus("memory must be at least 512 MiB"); return; }
        if (f.diskGiB < 4) { st.setStatus("disk must be at least 4 GiB"); return; }
        if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(f.username)) {
            st.setStatus("username must start with a letter/underscore, lowercase + digits + - _ only");
            return;
        }
        await this.run(`create ${f.name}`, async () => {
            const spec = defaultSpec(f.name);
            spec.resources.cpus = f.cpus;
            spec.resources.memoryMiB = f.memMiB;
            spec.disk.sizeGiB = f.diskGiB;
            spec.gpu.mode = f.gpu as VmSpec["gpu"]["mode"];
            spec.display.headMode = f.headMode as VmSpec["display"]["headMode"];
            spec.persist = f.persist as VmSpec["persist"];
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
                spec.disk.format = await this.probeImageFormat(f.importPath);
            } else if (f.diskDir) {
                spec.disk.file = join(f.diskDir, `${f.name}.qcow2`);
            }
            this.validateSpec(spec);
            const h = await this.registry.create(spec);
            this.handles.set(spec.name, h);

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

    async start(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
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
        await this.run(`stop ${name}`, () => {
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
    }
    async kill(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`kill ${name}`, () => h.kill(), { vm: name, verb: "killing" });
    }
    async remove(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        if (h.isRunning()) {
            this.store.getState().setStatus(`stop ${name} before deleting it`);
            return;
        }
        await this.run(`remove ${name}`, async () => {
            await this.registry.remove(name, { deleteDisk: true });
            this.handles.delete(name);
            this.metrics.drop(name);
            this.snapCache.delete(name);
            this.store.getState().setRoute("home");
        }, { vm: name, verb: "deleting" });
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
        if (f.cpus < 1 || f.cpus > 64) { st.setStatus("vCPUs must be between 1 and 64"); return; }
        if (f.memMiB < 512) { st.setStatus("memory must be at least 512 MiB"); return; }
        if (f.diskGiB < h.spec.disk.sizeGiB) { st.setStatus("disk can only grow"); return; }
        if (f.diskGiB !== h.spec.disk.sizeGiB && h.isRunning()) {
            st.setStatus("stop the VM before growing the disk");
            return;
        }
        await this.run(`save ${name}`, async () => {
            // Clone-then-validate: a schema rejection must not leave h.spec
            // half-mutated while the VM keeps running.
            const spec: VmSpec = JSON.parse(JSON.stringify(h.spec));
            spec.resources.cpus = f.cpus;
            spec.resources.memoryMiB = f.memMiB;
            spec.disk.sizeGiB = f.diskGiB;
            spec.gpu.mode = f.gpu as VmSpec["gpu"]["mode"];
            spec.display.headMode = f.headMode as VmSpec["display"]["headMode"];
            if (f.vd > 0) spec.display.virtualDesktop = f.vd;
            spec.persist = f.persist as VmSpec["persist"];
            spec.usb.autoAttach = f.usb.map((k) => {
                const [vendorId = "", productId = "", serial = ""] = k.split(":");
                return { vendorId, productId, ...(serial ? { serial } : {}), atBoot: true };
            });
            spec.description = st.vmDesc.trim();
            applySyncForm(spec, f);
            this.validateSpec(spec);
            if (f.diskGiB !== h.spec.disk.sizeGiB) await h.resizeDisk(f.diskGiB);
            h.spec = spec;
            await h.saveSpec();
            st.resetCreate();
            st.setRoute("vm", name);
        });
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
        // Only claim the indicator when it's free or already ours — don't
        // stomp another in-flight action, and don't clear one either.
        let ours: ActionState | null = null;
        if (!st.action || st.action.vm === name) {
            ours = { vm: name, verb: "opening viewer", at: Date.now() };
            st.setAction(ours);
        }
        try {
            await this.ensureViewer(h);
            if (this.viewers.has(name)) st.setStatus(`${name} viewer opened`);
        } catch (e) {
            st.setStatus(`viewer for ${name}: ${e instanceof Error ? e.message : e}`);
        } finally {
            if (ours && this.store.getState().action === ours) st.setAction(null);
        }
    }

    async snapshot(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        if (h.isRunning()) {
            this.store.getState().setStatus(`stop ${name} before taking a snapshot — qemu-img needs the disk offline`);
            return;
        }
        await this.run(`snapshot ${name}`, () => h.snapshot(`snap-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`),
            { vm: name, verb: "saving snapshot" });
        this.invalidateSnaps(name);
    }
    async restoreSnapshot(name: string, snap: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`restore ${snap}`, () => h.restoreSnapshot(snap), { vm: name, verb: "restoring" });
        this.invalidateSnaps(name);
    }

    async launchApp(name: string, cmd: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`launch ${cmd}`, async () => {
            const { launchApp } = await import("../../app-mode/src/waypipe");
            await launchApp(h, cmd);
        }, { vm: name, verb: "launching" });
    }

    // ── config import/export + shares ──

    /** Create-screen "Import" — a gist url/id or a local *.cruiser.* file.
     *  Creates the VM directly (the form can't represent every spec field,
     *  e.g. shares/escapeShortcuts, so filling it would lose data). */
    async importConfig(): Promise<void> {
        const st = this.store.getState();
        const ref = st.create.importRef.trim();
        if (!ref) { st.setStatus("paste a gist url/id or a config file path first"); return; }
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
            this.store.getState().setStatus(`${name} has no origin — push or import it first`);
            return;
        }
        await this.run(`pull config for ${name}`, async () => {
            const P = await import("../../vm-core/src/config/portable");
            return (await P.pullConfigFromOrigin(h)).needsRestart;
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
        if (!f.hostPath.trim()) { st.setStatus("set a host path for the share first"); return; }
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
        if (!h.isRunning()) { this.store.getState().setStatus(`${name} isn't running`); return; }
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
            rows.push({ label: "OVMF firmware", ok: existsSync("/usr/share/OVMF/OVMF_CODE_4M.fd"), fix: "apt install ovmf" });
            const usbDevs = await listUsbDevices().catch(() => []);
            const blocked = usbDevs.filter((d) => !d.writable).length;
            rows.push({ label: `usb passthrough (${blocked}/${usbDevs.length} blocked)`, ok: blocked === 0,
                fix: 'udev: SUBSYSTEM=="usb" GROUP="plugdev" MODE="0660" in /etc/udev/rules.d/99-cruiser-usb.rules' });
            this.store.getState().setDoctor(rows);
        });
    }

    /** Probe a disk image's real format for `method:"imported"` (qcow2/raw/vmdk/…). */
    private async probeImageFormat(path: string): Promise<string> {
        try {
            const { resolveToolchain } = await import("../../vm-core/src/qemu/resolve");
            const tc = await resolveToolchain();
            const r = await run(tc.qemuImg, ["info", "--output=json", path]);
            const fmt = JSON.parse(r.stdout)?.format;
            if (typeof fmt === "string" && fmt) return fmt;
        } catch { /* qemu-img unavailable — fall through to default */ }
        return "qcow2";
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
