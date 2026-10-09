// ============================================================================
// vm.ts — VmHandle: one VM's lifecycle. Builds argv, launches QEMU (daemonized
// or owned), reattaches over monitor/QGA sockets, and exposes disk/usb ops.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import type { VmSpec } from "../config/schema";
import { parseVmSpec } from "../config/schema";
import { vmPaths, diskPath as resolveDiskPath, type VmPaths } from "../paths";
import { buildArgs, OVMF_VARS_TEMPLATE, type BuildOpts, type BuiltArgs } from "../qemu/args";
import { resolveToolchain, type Toolchain } from "../qemu/resolve";
import { QmpClient } from "../qmp/client";
import { QgaClient } from "../qga/client";
import * as disk from "../disk/ops";
import * as usb from "../usb/usb";
import { run, spawnChild, virtiofsdPath } from "../../../sys/src/exec";

export type VmState = "stopped" | "starting" | "running" | "stopping" | "paused" | "crashed" | "unknown";

export class VmHandle extends EventEmitter {
    spec: VmSpec;
    readonly paths: VmPaths;
    private toolchain: Toolchain | null = null;
    private qemuChild: ChildProcess | null = null;   // owned-mode child handle
    private vfsChildren: ChildProcess[] = [];
    private qmpChain: Promise<unknown> = Promise.resolve();
    private qgaChain: Promise<unknown> = Promise.resolve();
    private lastError: string | null = null;

    private constructor(spec: VmSpec, paths: VmPaths) {
        super();
        this.spec = spec;
        this.paths = paths;
    }

    static async load(name: string): Promise<VmHandle> {
        const paths = vmPaths(name);
        const spec = parseVmSpec(JSON.parse(await readFile(paths.spec, "utf-8")));
        return new VmHandle(spec, paths);
    }

    static async create(spec: VmSpec): Promise<VmHandle> {
        const paths = vmPaths(spec.name);
        await mkdir(paths.dir, { recursive: true });
        await mkdir(paths.run, { recursive: true });
        await writeFile(paths.spec, JSON.stringify(spec, null, 2) + "\n", { mode: 0o644 });
        return new VmHandle(spec, paths);
    }

    async saveSpec(): Promise<void> {
        await writeFile(this.paths.spec, JSON.stringify(this.spec, null, 2) + "\n");
        this.emit("spec", this.spec);
    }

    // ── state probing ──

    pid(): number | null {
        try { return Number(readFileSync(this.paths.pidFile, "utf-8").trim()) || null; } catch { return null; }
    }

    /** QEMU process alive (pidfile + kill -0) AND monitor socket present. */
    isRunning(): boolean {
        const pid = this.pid();
        if (!pid || !existsSync(this.paths.monitorSock)) return false;
        try { process.kill(pid, 0); return true; } catch { return false; }
    }

    async probe(): Promise<VmState> {
        if (!this.isRunning()) return "stopped";
        try {
            const st = await this.withQmp((q) => q.queryStatus());
            if (st.status === "paused" || st.status === "prelaunch") return "paused";
            return st.running ? "running" : "stopped";
        } catch {
            // pid alive but QMP not answering: QEMU still initializing (or wedged).
            // "crashed" is only for a dead pid, which isRunning() already excluded.
            return "starting";
        }
    }

    // ── client accessors ──
    // QEMU's monitor/agent chardevs accept ONE pending client each — a cached
    // socket starves every other client (the CLI while the UI holds a probe
    // connection, and vice versa; the second connect() just sits in the
    // listen backlog until the first client closes). Connections are
    // therefore short-lived per op, serialized in-process so overlapping ops
    // queue instead of racing on the backlog.

    /** Run fn on a fresh QMP connection (closed afterwards). */
    withQmp<T>(fn: (q: QmpClient) => Promise<T>, timeoutMs = 10_000): Promise<T> {
        const p = this.qmpChain.then(async () => {
            const q = await QmpClient.connect(this.paths.monitorSock, timeoutMs);
            try { return await fn(q); } finally { q.close(); }
        });
        this.qmpChain = p.catch(() => {});
        return p;
    }

    /** Run fn on a fresh QGA connection (closed afterwards). */
    withQga<T>(fn: (g: QgaClient) => Promise<T>, timeoutMs = 15_000): Promise<T> {
        const p = this.qgaChain.then(async () => {
            const g = await QgaClient.connect(this.paths.qgaSock, timeoutMs);
            await g.ping(Math.min(timeoutMs, 3_000)).catch(() => {});   // agent may not be up yet even if socket is
            try { return await fn(g); } finally { g.close(); }
        });
        this.qgaChain = p.catch(() => {});
        return p;
    }

    // ── lifecycle ──

    /** Build argv — exposed for tests + `cli vm args` debugging. */
    async buildArgv(opts: BuildOpts = {}): Promise<BuiltArgs> {
        this.toolchain ??= await resolveToolchain();
        if (opts.virtiofs === undefined) opts.virtiofs = (await virtiofsdPath()) !== null;
        // GL modes need an explicit mesa render node — QEMU auto-picking NVIDIA
        // EGL wedges init. Persist the pick so it's stable across restarts.
        if (this.spec.gpu.mode !== "software" && !this.spec.gpu.renderNode) {
            const { pickRenderNode } = await import("../gpu/rendernode");
            this.spec.gpu.renderNode = (await pickRenderNode()) ?? undefined;
            if (this.spec.gpu.renderNode) await this.saveSpec();
        }
        return buildArgs(this.spec, this.paths, opts, { ldLibraryPath: this.toolchain.ldLibraryPath });
    }

    async start(opts: BuildOpts & { timeoutMs?: number } = {}): Promise<void> {
        if (this.isRunning()) return;
        if (!existsSync(this.diskPath())) throw new Error(`no disk at ${this.diskPath()} — provision first`);
        this.toolchain ??= await resolveToolchain();
        await mkdir(this.paths.run, { recursive: true });
        if (!existsSync(this.paths.ovmfVars)) await copyFile(OVMF_VARS_TEMPLATE, this.paths.ovmfVars);

        const built = await this.buildArgv(opts);

        // virtiofsd daemons must be up before QEMU opens the sockets.
        const vfsdBin = built.virtiofsd.length ? await virtiofsdPath() : null;
        for (let i = 0; i < built.virtiofsd.length; i++) {
            const v = built.virtiofsd[i]!;
            await rm(v.socket, { force: true });
            const c = spawnChild(vfsdBin!, [
                `--socket-path=${v.socket}`, `--shared-dir=${v.sharedDir}`,
                "--cache=auto", "--sandbox=namespace",
            ]);
            this.vfsChildren.push(c);
        }

        const env = { ...process.env, ...built.env };
        if (this.spec.persist === "daemonize") {
            // QEMU -daemonize: spawn returns after the daemon fork.
            await run(this.toolchain.qemu, built.argv, { env });
        } else {
            this.qemuChild = spawnChild(this.toolchain.qemu, built.argv, { env, stdio: "ignore" });
            this.qemuChild.on("exit", (code) => {
                this.qemuChild = null;
                this.emit("exit", code);
            });
            this.qemuChild.unref();
        }

        // Wait for the monitor socket, then QMP handshake.
        const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
        for (;;) {
            if (existsSync(this.paths.monitorSock)) {
                try { await this.withQmp((q) => q.queryStatus()); return; } catch { /* not ready */ }
            }
            if (Date.now() > deadline) {
                const tail = existsSync(this.paths.log) ? readFileSync(this.paths.log, "utf-8").slice(-2000) : "";
                throw new Error(`qemu did not come up in ${opts.timeoutMs ?? 30000}ms\n${tail}`);
            }
            await new Promise((r) => setTimeout(r, 250));
        }
    }

    /**
     * Graceful shutdown: asks the guest OS to power off via ACPI
     * (`system_powerdown`) — this is a normal shutdown, NOT suspend-to-disk;
     * memory contents are discarded. `onWait` fires ~every 500ms with the
     * elapsed time while the guest drains. Returns "stopped" once the QEMU
     * process exits, or "timeout" if the guest ignored the request — callers
     * decide whether to escalate to kill().
     */
    async stop(timeoutMs = 30_000, onWait?: (elapsedMs: number) => void): Promise<"stopped" | "timeout"> {
        if (!this.isRunning()) return "stopped";
        try { await this.withQmp((q) => q.systemPowerdown()); } catch { /* fall through */ }
        const deadline = Date.now() + timeoutMs;
        const started = Date.now();
        while (this.isRunning() && Date.now() < deadline) {
            onWait?.(Date.now() - started);
            await new Promise((r) => setTimeout(r, 500));
        }
        if (this.isRunning()) return "timeout";
        this.cleanupRunDir();
        return "stopped";
    }

    async kill(timeoutMs = 10_000): Promise<void> {
        const pid = this.pid();
        if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
        // quit's reply races the socket teardown — swallow the rejection either way.
        try { await this.withQmp((q) => q.quit().catch(() => {})); } catch { /* no monitor */ }
        this.qemuChild?.kill("SIGKILL");
        // SIGKILL delivery is not synchronous — a start() that runs while the
        // old pid is still dying would early-return on isRunning() and leave
        // the VM down. Wait for the process to actually be reaped.
        if (pid) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                try { process.kill(pid, 0); } catch { break; }
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        this.cleanupRunDir();
    }

    private cleanupRunDir(): void {
        this.vfsChildren.forEach((c) => c.kill());
        this.vfsChildren = [];
    }

    async suspend(): Promise<void> { await this.withQmp((q) => q.stop()); }
    async resume(): Promise<void> { await this.withQmp((q) => q.cont()); }

    // ── disk ops ──

    diskPath(): string {
        return resolveDiskPath(this.spec, this.paths.dir);
    }

    async snapshots() { return disk.snapshotList(this.tc().qemuImg, this.diskPath()); }
    async snapshot(name: string) { return disk.snapshotCreate(this.tc().qemuImg, this.diskPath(), name); }
    async restoreSnapshot(name: string) {
        if (this.isRunning()) throw new Error("stop the VM before restoring a snapshot");
        return disk.snapshotApply(this.tc().qemuImg, this.diskPath(), name);
    }
    async deleteSnapshot(name: string) { return disk.snapshotDelete(this.tc().qemuImg, this.diskPath(), name); }
    async resizeDisk(newSizeGiB: number) {
        if (this.isRunning()) throw new Error("stop the VM before resizing the disk (guest growfs happens next boot)");
        return disk.resizeDisk(this.tc().qemuImg, this.diskPath(), newSizeGiB);
    }
    async backup(destPath: string) {
        if (this.isRunning()) {
            return this.withQmp(async (q) => {
                const node = await disk.diskNodeName(q, this.diskPath());
                return disk.backupLive(q, node, destPath);
            });
        }
        return disk.backupOffline(this.tc().qemuImg, this.diskPath(), destPath);
    }

    // ── usb ──

    listUsb() { return usb.listUsbDevices(); }
    async usbAttach(vendorId: string, productId: string, serial?: string) {
        const d = await usb.findUsb(vendorId, productId, serial);
        if (!d) throw new Error(`usb ${vendorId}:${productId} not present`);
        if (!d.writable) throw new Error(`no rw access to ${d.devNode} — run the udev setup (cruiser doctor)`);
        return this.withQmp((q) => usb.usbAttach(q, d));
    }
    async usbDetach(id: string) { return this.withQmp((q) => usb.usbDetach(q, id)); }

    // ── guest ops ──

    /** Run a command in the guest via QGA. */
    async guestExec(path: string, args: string[] = [], timeoutMs = 60_000) {
        return this.withQga((g) => g.exec(path, args, { timeoutMs }));
    }
    async guestSh(script: string, timeoutMs = 60_000) {
        return this.withQga((g) => g.sh(script, { timeoutMs }));
    }

    /** Restart GDM in the guest (connector-probe race fix — the old fixdisplays). */
    async fixDisplays() {
        return this.guestExec("/bin/systemctl", ["restart", "gdm"], 10_000);
    }

    private tc(): Toolchain {
        if (!this.toolchain) throw new Error("toolchain unresolved — call start()/buildArgv() first");
        return this.toolchain;
    }
}
