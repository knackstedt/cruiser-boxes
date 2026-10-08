// ============================================================================
// service.ts — the UI's backend: owns VmRegistry, polls VM state into the
// store, and executes actions (create/provision/start/stop/view/snapshots).
// ============================================================================

import { VmRegistry } from "../../vm-core/src/lifecycle/registry";
import { VmHandle } from "../../vm-core/src/lifecycle/vm";
import { defaultSpec, VmSpec } from "../../vm-core/src/config/schema";
import { detectAdapter, detectSession } from "../../host-int/src/detect";
import { ViewerSession } from "../../host-int/src/session";
import type { DoctorRow, HostInfo, Store, VmSummary } from "./store";

export class CruiserService {
    private registry = new VmRegistry();
    private handles = new Map<string, VmHandle>();
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private viewers = new Map<string, ViewerSession>();

    constructor(private store: Store) {}

    async init(): Promise<void> {
        await this.registry.scan();
        this.registry.list().forEach((h) => this.handles.set(h.spec.name, h));
        await this.refresh();
        await this.refreshHost();
        this.pollTimer = setInterval(() => this.refresh().catch(() => {}), 3000);
    }

    dispose(): void {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.viewers.forEach((v) => v.close().catch(() => {}));
    }

    private async run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
        const st = this.store.getState();
        if (st.busy) return undefined;
        st.setBusy(true); st.setStatus(`${label}…`);
        try {
            const r = await fn();
            st.setStatus(`${label} done`);
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
        return {
            name: s.name, state,
            gpuMode: s.gpu.mode, headMode: s.display.headMode,
            cpus: s.resources.cpus, memMiB: s.resources.memoryMiB,
            diskGiB: s.disk.sizeGiB,
            sshPort: s.network.sshPort, rdpPort: s.network.rdpPort,
            provisioned: s.provisioned.method, persist: s.persist,
            snapshots: snaps.map((x) => x.name),
        };
    }

    async refresh(): Promise<void> {
        const vms: VmSummary[] = [];
        const hs = [...this.handles.values()];
        for (let i = 0; i < hs.length; i++) vms.push(await this.summarize(hs[i]!));
        vms.sort((a, b) => a.name.localeCompare(b.name));
        this.store.getState().setVms(vms);
    }

    async refreshHost(): Promise<void> {
        const a = detectAdapter();
        const host: HostInfo = {
            session: detectSession(),
            adapterId: a.id,
            caps: { ...a.caps },
            monitors: await a.monitors().catch(() => []),
            desktops: await a.desktops().catch(() => []),
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
            const h = await this.registry.create(spec);
            this.handles.set(spec.name, h);

            if (f.method !== "none") {
                const pw = f.password || undefined;
                if (f.method === "cloudimg") {
                    const { provisionVmCloudimg } = await import("../../provision/src/provision");
                    await provisionVmCloudimg(h, { release: f.release, username: f.username, password: pw });
                } else if (f.method === "iso") {
                    const { provisionVmIso } = await import("../../provision/src/provision");
                    await provisionVmIso(h, { iso: f.iso, username: f.username, password: pw });
                }
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
        await this.run(`stop ${name}`, () => h.stop(20_000));
    }
    async kill(name: string): Promise<void> {
        const h = this.handles.get(name); if (!h) return;
        await this.run(`kill ${name}`, () => h.kill());
    }
    async remove(name: string): Promise<void> {
        await this.run(`remove ${name}`, async () => {
            await this.registry.remove(name, { deleteDisk: true });
            this.handles.delete(name);
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
            this.store.getState().setDoctor(rows);
        });
    }
}
