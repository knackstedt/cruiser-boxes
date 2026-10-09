// ============================================================================
// service.ts — the UI's backend: owns VmRegistry, polls VM state into the
// store, and executes actions (create/provision/start/stop/view/snapshots).
// ============================================================================

import { VmRegistry } from "../../vm-core/src/lifecycle/registry";
import { VmHandle } from "../../vm-core/src/lifecycle/vm";
import { defaultSpec, VmSpec } from "../../vm-core/src/config/schema";
import { CACHE_DIR, CLOUDIMG_DIR, CONFIG_DIR, DATA_DIR, ISO_DIR, VMS_DIR } from "../../vm-core/src/paths";
import { detectAdapter, detectSession } from "../../host-int/src/detect";
import { ViewerSession } from "../../host-int/src/session";
import { listUsbDevices } from "../../vm-core/src/usb/usb";
import { run, which } from "../../sys/src/exec";
import { cpus, totalmem, homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { mark } from "./startup-profile";
import { VmMetricsSampler } from "./metrics";
import type { DoctorRow, HostInfo, Store, VmSummary } from "./store";

export class CruiserService {
    private registry = new VmRegistry();
    private handles = new Map<string, VmHandle>();
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private viewers = new Map<string, ViewerSession>();
    private metrics = new VmMetricsSampler();

    constructor(private store: Store) {}

    async init(): Promise<void> {
        await this.registry.scan();
        mark("svc:scan");
        this.registry.list().forEach((h) => this.handles.set(h.spec.name, h));
        // refresh/host/extras/settings write disjoint store fields — run
        // together; each spawn chain (qdbus, wmctrl, df) overlaps instead
        // of queuing behind the last.
        await Promise.all([
            this.refresh().then(() => mark("svc:refresh")),
            this.refreshHost().then(() => mark("svc:host")),
            this.refreshCreateExtras().then(() => mark("svc:extras")).catch(() => {}),
            this.refreshSettings().catch(() => {}),
        ]);
        this.pollTimer = setInterval(() => this.refresh().catch(() => {}), 3000);
    }

    async dispose(): Promise<void> {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.viewers.forEach((v) => v.close().catch(() => {}));
        // owned = stops with the app; ephemeral = stops AND deletes the vm dir.
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
    private async pickPath(kind: "dir" | "file", title: string, start: string): Promise<string | null> {
        const kd = await which("kdialog");
        if (kd) {
            const args = kind === "dir"
                ? ["--title", title, "--getexistingdirectory", start]
                : ["--title", title, "--getopenfilename", start, "*.qcow2 *.img *.raw *.vmdk *.vdi *.vhdx|Disk images"];
            const r = await run(kd, args, { noThrow: true });
            return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
        }
        const zn = await which("zenity");
        if (zn) {
            const args = kind === "dir"
                ? ["--file-selection", "--directory", "--title", title, `--filename=${start}/`]
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

    private async run<T>(label: string, fn: () => Promise<T>, done?: (r: T) => string): Promise<T | undefined> {
        const st = this.store.getState();
        if (st.busy) return undefined;
        st.setBusy(true); st.setStatus(`${label}…`);
        try {
            const r = await fn();
            st.setStatus(done ? done(r) : `${label} done`);
            return r;
        } catch (e) {
            st.setStatus(`${label} failed: ${e instanceof Error ? e.message : e}`);
            return undefined;
        } finally {
            st.setBusy(false);
            this.refresh().catch(() => {});
        }
    }

    private async summarize(h: VmHandle): Promise<VmSummary> {
        const s = h.spec;
        let state: VmSummary["state"] = "stopped";
        try { state = await h.probe(); } catch { state = "unknown"; }
        const snaps = state === "stopped" ? await h.snapshots().catch(() => []) : [];
        const mt = await this.metrics.sample(h, state);
        return {
            name: s.name, state,
            gpuMode: s.gpu.mode, headMode: s.display.headMode,
            cpus: s.resources.cpus, memMiB: s.resources.memoryMiB,
            diskGiB: s.disk.sizeGiB,
            sshPort: s.network.sshPort, rdpPort: s.network.rdpPort,
            provisioned: s.provisioned.method, persist: s.persist,
            snapshots: snaps.map((x) => x.name),
            hostDiskBytes: mt.hostDiskBytes,
            guestUsedBytes: mt.guestUsedBytes, guestTotalBytes: mt.guestTotalBytes,
            cpu: mt.cpu, mem: mt.mem,
        };
    }

    async refresh(): Promise<void> {
        const vms = await Promise.all([...this.handles.values()].map((h) => this.summarize(h)));
        vms.sort((a, b) => a.name.localeCompare(b.name));
        this.store.getState().setVms(vms);
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
            uiBackend: "local (in-process)",
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

    // ── actions ──

    async createVm(): Promise<void> {
        const f = { ...this.store.getState().create };
        await this.run(`create ${f.name}`, async () => {
            const spec = defaultSpec(f.name);
            spec.resources.cpus = f.cpus;
            spec.resources.memoryMiB = f.memMiB;
            spec.disk.sizeGiB = f.diskGiB;
            spec.gpu.mode = f.gpu as VmSpec["gpu"]["mode"];
            spec.display.headMode = f.headMode as VmSpec["display"]["headMode"];
            spec.persist = f.persist as VmSpec["persist"];
            spec.credentials.username = f.username;
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
        await this.run(`start ${name}`, () => h.start());
    }
    async stop(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        const st = this.store.getState();
        await this.run(`stop ${name}`, () => {
            st.setStatus(`stopping ${name} — sent ACPI shutdown request to the guest OS`);
            return h.stop(20_000, (ms) => st.setStatus(
                `stopping ${name} — guest is shutting down… ${Math.floor(ms / 1000)}s ` +
                `(power off, not suspend — memory is not saved)`,
            ));
        }, (out) => out === "stopped"
            ? `${name} powered off cleanly`
            : `${name} ignored the shutdown request — still running; use Kill to force power off`);
    }
    async kill(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`kill ${name}`, () => h.kill());
    }
    async remove(name: string): Promise<void> {
        await this.run(`remove ${name}`, async () => {
            await this.registry.remove(name, { deleteDisk: true });
            this.handles.delete(name);
            this.metrics.drop(name);
            this.store.getState().setRoute("home");
        });
    }

    async view(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`view ${name}`, async () => {
            const s = new ViewerSession(h.spec);
            await s.open();
            this.viewers.set(name, s);
            s.on("closed", () => this.viewers.delete(name));
        });
    }

    async snapshot(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`snapshot ${name}`, () => h.snapshot(`snap-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`));
    }
    async restoreSnapshot(name: string, snap: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`restore ${snap}`, () => h.restoreSnapshot(snap));
    }

    async launchApp(name: string, cmd: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`launch ${cmd}`, async () => {
            const { launchApp } = await import("../../app-mode/src/waypipe");
            await launchApp(h, cmd);
        });
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
