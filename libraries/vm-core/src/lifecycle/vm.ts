// ============================================================================
// vm.ts — VmHandle: one VM's lifecycle. Builds argv, launches QEMU (daemonized
// or owned), reattaches over monitor/QGA sockets, and exposes disk/usb ops.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";

import type { VmSpec } from "../config/schema";
import { parseVmSpec } from "../config/schema";
import { bootRelevantChanges } from "../config/boot-diff";
import { vmPaths, diskPath as resolveDiskPath, diskKeyPath, homeDiskPath as resolveHomeDiskPath, type VmPaths } from "../paths";
import { buildArgs, ovmfVarsTemplate, type BuildOpts, type BuiltArgs } from "../qemu/args";
import { resolveToolchain, type Toolchain } from "../qemu/resolve";
import { QmpClient } from "../qmp/client";
import { QgaClient } from "../qga/client";
import * as disk from "../disk/ops";
import * as usb from "../usb/usb";
import { appendVmLog } from "../logs";
import { run, spawnChild, virtiofsdPath } from "../../../sys/src/exec";

export type VmState = "stopped" | "starting" | "running" | "stopping" | "paused" | "crashed" | "unknown";

/** `-chardev help` output is a fixed list — cache the verdict per binary. */
const vdagentCache = new Map<string, Promise<boolean>>();

/** Does this qemu build have the qemu-vdagent chardev (CONFIG_SPICE_PROTOCOL)? */
function qemuHasVdagent(qemu: string, ldLibraryPath: string): Promise<boolean> {
    let p = vdagentCache.get(qemu);
    if (!p) {
        p = run(qemu, ["-chardev", "help"], {
            noThrow: true,
            env: { LD_LIBRARY_PATH: ldLibraryPath },
        }).then((r) => /\bqemu-vdagent\b/.test(r.stdout + r.stderr)).catch(() => false);
        vdagentCache.set(qemu, p);
    }
    return p;
}

export class VmHandle {
    spec: VmSpec;
    readonly paths: VmPaths;
    private toolchain: Toolchain | null = null;
    private qemuChild: ChildProcess | null = null;   // owned-mode child handle
    private vfsChildren: ChildProcess[] = [];
    private qmpChain: Promise<unknown> = Promise.resolve();
    private qgaChain: Promise<unknown> = Promise.resolve();
    private lastError: string | null = null;

    private constructor(spec: VmSpec, paths: VmPaths) {
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
    }

    // ── LUKS disk key ──
    // qcow2 encrypt.format=luks encrypts the image file at rest; QEMU and
    // qemu-img both unlock it through a `-object secret,file=` pointer.
    // keyStorage "store" keeps that passphrase at secrets/disk-key (0600);
    // "prompt" keeps it only in the caller's memory, writing run/disk-key
    // transiently per launch/op and deleting it right after.

    /** The key file QEMU/qemu-img unlock the image(s) with, or null when
     *  absent (prompt mode before an unlock, or a store-mode VM missing
     *  its secrets file). */
    diskKeyFile(): string | null {
        const p = diskKeyPath(this.spec, this.paths);
        return p && existsSync(p) ? p : null;
    }

    /** Hand the passphrase to the VM — writes it at the keyStorage path
     *  (secrets/disk-key for "store"; transient run/disk-key for
     *  "prompt", cleared by start()/clearDiskKey/cleanup). */
    async provideDiskKey(plain: string): Promise<string> {
        const p = diskKeyPath(this.spec, this.paths);
        if (!p) throw new Error(`${this.spec.name} isn't encrypted`);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, plain, { mode: 0o600 });
        return p;
    }

    /** Drop the transient run/ key file — a prompt-mode passphrase never
     *  sits on disk outside the launch/op that needed it. Store-mode's
     *  secrets/ copy is left alone (it's the persistent one). */
    async clearDiskKey(): Promise<void> {
        if (this.spec.disk.encrypt === "off") return;
        const p = diskKeyPath(this.spec, this.paths);
        if (p && this.spec.disk.keyStorage === "prompt")
            await rm(p, { force: true }).catch(() => {});
    }

    /** Key for a READ-level disk op — keyed when the file happens to be
     *  present, plain otherwise (qemu-img info reads LUKS headers fine
     *  without the secret; the mutation ops below hard-require it). */
    private diskKeyRead(): string | undefined {
        if (this.spec.disk.encrypt === "off") return undefined;
        return this.diskKeyFile() ?? undefined;
    }

    /** Key for a MUTATING disk op — throws when the disk is encrypted and
     *  no passphrase has been provided this session. */
    private needDiskKey(): string | undefined {
        if (this.spec.disk.encrypt === "off") return undefined;
        return disk.requireDiskKeyFile(this.spec, this.paths);
    }

    /** The encrypted /home image's path (disk.encrypt="home"). */
    homeDiskPath(): string {
        return resolveHomeDiskPath(this.spec, this.paths.dir);
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
        this.watchVfsd();   // adopted QEMU — cover daemon crashes too
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

    /** Spec sections changed since this QEMU launched — saved settings
     *  that can only apply at the next boot (the "restart pending"
     *  indicator). Empty when the VM isn't running or no launch baseline
     *  was recorded (VMs started by older builds). */
    pendingRestart(): string[] {
        if (!this.isRunning()) return [];
        try {
            const launch = parseVmSpec(
                JSON.parse(readFileSync(this.paths.launchSpec, "utf-8")));
            return bootRelevantChanges(launch, this.spec);
        } catch { return []; }
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
        if (this.spec.display.viewer === "dmabuf") {
            if (this.spec.gpu.mode === "software")
                throw new Error("display.viewer=dmabuf needs gpu.mode virgl or venus — QEMU exports no GL scanouts in software mode");
            // QEMU exports the guest scanout from this node; the viewer's EGL
            // must import same-vendor dma-bufs → always the display GPU.
            const { pickDisplayRenderNode } = await import("../gpu/rendernode");
            opts.dbusRenderNode ??= (await pickDisplayRenderNode()) ?? undefined;
            if (!opts.dbusRenderNode)
                throw new Error("display.viewer=dmabuf: no DRM render node found for the host display GPU");
            // Clipboard rides a qemu-vdagent chardev → org.qemu.Display1.Clipboard.
            // The backend needs CONFIG_SPICE_PROTOCOL — absent on some distro
            // builds, so probe once per binary and warn instead of failing.
            if (this.spec.display.clipboard) {
                opts.vdagent ??= await qemuHasVdagent(this.toolchain.qemu, this.toolchain.ldLibraryPath);
                if (!opts.vdagent)
                    void appendVmLog(this.paths, "clipboard: qemu lacks the qemu-vdagent chardev — guest clipboard sync disabled");
            }
        }
        return buildArgs(this.spec, this.paths, opts, { ldLibraryPath: this.toolchain.ldLibraryPath });
    }

    /** Materialize boot-attached images that aren't the system disk —
     *  currently the encrypt="home" image. Runs inside start() (before
     *  argv/spawn) so every boot path — cli start, provision's first boot,
     *  the UI — sees the same devices; the ISO-install spawn calls it
     *  directly since it bypasses start(). */
    async ensureAuxDisks(): Promise<void> {
        if (this.spec.disk.encrypt !== "home") return;
        const hp = this.homeDiskPath();
        if (existsSync(hp)) return;
        const kp = this.needDiskKey();
        await mkdir(dirname(hp), { recursive: true });
        await disk.createDisk((await this.tc()).qemuImg, hp, this.spec.disk.homeGiB, kp);
        void appendVmLog(this.paths, `created encrypted home image ${hp} (${this.spec.disk.homeGiB}G)`);
    }

    async start(opts: BuildOpts & { timeoutMs?: number } = {}): Promise<void> {
        if (this.isRunning()) return;
        if (!existsSync(this.diskPath())) throw new Error(`no disk at ${this.diskPath()} — provision first`);
        this.toolchain ??= await resolveToolchain();
        // LUKS: the passphrase must resolve to a key file before QEMU
        // parses argv — fail here, before any daemon spawn.
        if (this.spec.disk.encrypt !== "off") this.needDiskKey();
        await mkdir(this.paths.run, { recursive: true });
        // The "home" image materializes on first boot (after run/ exists —
        // ensureAuxDisks logs into it).
        if (this.spec.disk.encrypt !== "off") await this.ensureAuxDisks();
        if (!existsSync(this.paths.ovmfVars)) await copyFile(ovmfVarsTemplate(), this.paths.ovmfVars);

        const built = await this.buildArgv(opts);
        void appendVmLog(this.paths, `start: mode=${opts.mode ?? "run"} persist=${this.spec.persist} gpu=${this.spec.gpu.mode}`);

        // virtiofsd daemons must be up before QEMU opens the sockets —
        // the vhost-user device's handshake happens at machine init.
        // Reap strays of a dead launcher first or they'd keep their
        // listeners + pidfiles.
        this.killVfsd();
        const vfsdBin = built.virtiofsd.length ? await virtiofsdPath() : null;
        for (let i = 0; i < built.virtiofsd.length; i++)
            if (vfsdBin) await this.spawnVfsd(built.virtiofsd[i]!, vfsdBin);

        const env = { ...process.env, ...built.env };
        try {
            if (this.spec.persist === "daemonize") {
                // QEMU -daemonize: spawn returns after the daemon fork.
                await run(this.toolchain.qemu, built.argv, { env });
            } else {
                this.qemuChild = spawnChild(this.toolchain.qemu, built.argv, { env, stdio: "ignore" });
                this.qemuChild.on("exit", (code) => {
                    this.qemuChild = null;
                    void appendVmLog(this.paths, `qemu exited (code ${code})`);
                });
                this.qemuChild.unref();
            }

            // Wait for the monitor socket, then QMP handshake.
            const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
            for (;;) {
                if (existsSync(this.paths.monitorSock)) {
                    try {
                        await this.withQmp((q) => q.queryStatus());
                        void appendVmLog(this.paths, `started: pid ${this.pid()}`);
                        // Snapshot the spec QEMU actually launched with —
                        // pendingRestart() diffs later saves against it.
                        await writeFile(this.paths.launchSpec,
                            JSON.stringify(this.spec)).catch(() => {});
                        this.watchVfsd();
                        return;
                    } catch { /* not ready */ }
                }
                if (Date.now() > deadline) {
                    const tail = existsSync(this.paths.log) ? readFileSync(this.paths.log, "utf-8").slice(-2000) : "";
                    void appendVmLog(this.paths, `start timed out after ${opts.timeoutMs ?? 30000}ms`);
                    throw new Error(`qemu did not come up in ${opts.timeoutMs ?? 30000}ms\n${tail}`);
                }
                await new Promise((r) => setTimeout(r, 250));
            }
        } catch (e) {
            // QEMU never came up — the detached daemons we just spawned are
            // orphans (and a retry would stack dup listeners on the sockets).
            this.killVfsd();
            throw e;
        } finally {
            // QEMU consumed the secret during init — a -daemonize parent
            // only returns once the child is fully up, and the owned path
            // gates on the QMP handshake. A prompt-mode key never outlives
            // the launch it unlocked.
            await this.clearDiskKey();
        }
    }

    /**
     * Graceful shutdown: asks the guest OS to power off — this is a normal
     * shutdown, NOT suspend-to-disk; memory contents are discarded. Two
     * mechanisms are attempted: QMP `system_powerdown` (an ACPI power-button
     * event — desktop sessions can inhibit it: KDE's Powerdevil swallows it
     * on Fedora guests) and QGA `guest-shutdown` (an init-level shutdown
     * that doesn't depend on power-button handling). Whichever the guest
     * honors first wins; a missing monitor or dead agent just drops that
     * path. `onWait` fires ~every 500ms with the elapsed time while the
     * guest drains. Returns "stopped" once the QEMU process exits, or
     * "timeout" if the guest ignored the request — callers decide whether
     * to escalate to kill().
     */
    async stop(timeoutMs = 60_000, onWait?: (elapsedMs: number) => void): Promise<"stopped" | "timeout"> {
        if (!this.isRunning()) return "stopped";
        let acpi = false, agent = false;
        try { await this.withQmp((q) => q.systemPowerdown()); acpi = true; } catch { /* no monitor */ }
        // The agent may take seconds to not-answer; keep the probe budget
        // short so an agent-less guest doesn't stall the drain wait.
        try { await this.withQga((g) => g.shutdown("powerdown"), 5_000); agent = true; } catch { /* no agent */ }
        void appendVmLog(this.paths, `stop: shutdown requested (acpi=${acpi} agent=${agent})`);
        const deadline = Date.now() + timeoutMs;
        const started = Date.now();
        while (this.isRunning() && Date.now() < deadline) {
            onWait?.(Date.now() - started);
            await new Promise((r) => setTimeout(r, 500));
        }
        if (this.isRunning()) {
            void appendVmLog(this.paths, `stop: guest ignored shutdown request (${timeoutMs}ms, acpi=${acpi} agent=${agent})`);
            return "timeout";
        }
        this.cleanupRunDir();
        void appendVmLog(this.paths, "stopped: guest powered off");
        return "stopped";
    }

    async kill(timeoutMs = 10_000): Promise<void> {
        void appendVmLog(this.paths, "kill: SIGKILL");
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
        this.killVfsd();
        if (this.vfsdTimer) { clearInterval(this.vfsdTimer); this.vfsdTimer = null; }
        void this.clearDiskKey();   // kill/crash edge — drop any leftover run/disk-key
    }

    /** virtiofsd's <socket>.pid is MULTI-LINE (supervisor pid, then sandbox
     *  internals) — parse the first line only; Number() on the whole file
     *  is NaN and reads as "dead forever". */
    private vfsdPid(socket: string): number | null {
        try {
            const pid = Number(readFileSync(`${socket}.pid`, "utf-8").split("\n", 1)[0]!.trim());
            return pid || null;
        } catch { return null; }
    }

    /** Kill every virtiofsd for this VM — both children this handle spawned
     *  and daemons only reachable via their pidfiles (orphans of a dead
     *  launcher, strays of a failed start). Without QEMU they're orphans
     *  serving nothing. */
    private killVfsd(): void {
        this.vfsChildren.forEach((c) => c.kill());
        this.vfsChildren = [];
        this.vfsdTargets().forEach((v) => {
            const pid = this.vfsdPid(v.socket);
            if (!pid) return;
            try {
                if (readFileSync(`/proc/${pid}/comm`, "utf-8").trim() === "virtiofsd")
                    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
            } catch { /* gone */ }
        });
    }

    // ── virtiofsd ──

    /** virtiofsd for one share — detached like the viewer: QEMU (-daemonize)
     *  outlives the launching session, and a non-detached daemon dies with
     *  its launcher's process group, leaving every guest mount hung in
     *  D-state. stderr lands in run/virtiofsd-<tag>.log. */
    private async spawnVfsd(v: { socket: string; sharedDir: string; tag: string }, bin?: string): Promise<void> {
        const b = bin ?? await virtiofsdPath();
        if (!b) return;
        await rm(v.socket, { force: true });
        const c = spawnChild(b, [
            `--socket-path=${v.socket}`, `--shared-dir=${v.sharedDir}`,
            "--cache=auto", "--sandbox=namespace",
        ], { detached: true, logFile: join(this.paths.run, `virtiofsd-${v.tag}.log`) });
        this.vfsChildren.push(c);
        this.vfsdSpawned.set(v.socket, Date.now());
    }

    /** Mount-mode shares expecting a virtiofsd backend — the same
     *  filter/index order buildArgs uses (socket i ↔ filtered share i). */
    private vfsdTargets(): { socket: string; sharedDir: string; tag: string }[] {
        return this.spec.shares
            .filter((s) => s.enabled !== false && s.mode !== "copy")
            .map((s, i) => ({ socket: `${this.paths.vfsSock}.${i}`, sharedDir: s.hostPath, tag: s.tag }));
    }

    /** virtiofsd writes <socket>.pid itself — live pid + comm match means
     *  the backend is up (pid reuse can't fake the comm). */
    private vfsdAlive(socket: string): boolean {
        const pid = this.vfsdPid(socket);
        if (!pid) return false;
        try { return readFileSync(`/proc/${pid}/comm`, "utf-8").trim() === "virtiofsd"; }
        catch { return false; }
    }

    /** Respawn dead virtiofsd while this QEMU lives. QEMU can't re-pair a
     *  fresh daemon on the existing chardev (see args.ts), so the mount
     *  still needs a VM restart — the respawn exists to keep the backend
     *  present for stop-time cleanup and to surface the loss in the log. */
    private vfsdSpawned = new Map<string, number>();
    private vfsdTimer: ReturnType<typeof setInterval> | null = null;
    private vfsdTicking = false;

    private watchVfsd(): void {
        if (this.vfsdTimer) return;
        const entries = this.vfsdTargets();
        if (!entries.length) return;
        const tick = async () => {
            if (this.vfsdTicking) return;
            this.vfsdTicking = true;
            try {
                if (!this.isRunning()) {
                    if (this.vfsdTimer) { clearInterval(this.vfsdTimer); this.vfsdTimer = null; }
                    return;
                }
                for (let i = 0; i < entries.length; i++) {
                    const v = entries[i]!;
                    if (this.vfsdAlive(v.socket)) continue;
                    // a just-spawned daemon needs a beat to write its
                    // pidfile — don't double-spawn on top of it
                    if (Date.now() - (this.vfsdSpawned.get(v.socket) ?? 0) < 15_000) continue;
                    await this.spawnVfsd(v).catch(() => {});
                    void appendVmLog(this.paths, `virtiofsd for share '${v.tag}' respawned after death`);
                }
            } finally { this.vfsdTicking = false; }
        };
        this.vfsdTimer = setInterval(() => void tick(), 10_000);
        this.vfsdTimer.unref();
    }

    async suspend(): Promise<void> { await this.withQmp((q) => q.stop()); }
    async resume(): Promise<void> { await this.withQmp((q) => q.cont()); }

    /** Reboot: graceful guest-initiated restart via QGA guest-shutdown
     *  (mode=reboot), falling back to a hard QMP system_reset when the
     *  agent is absent — same escalation shape as stop(). */
    async reboot(): Promise<void> {
        let agent = false;
        try { await this.withQga((g) => g.shutdown("reboot"), 5_000); agent = true; } catch { /* no agent */ }
        if (!agent) await this.withQmp((q) => q.execute("system_reset"));
        void appendVmLog(this.paths, `reboot: requested (agent=${agent})`);
    }

    // ── disk ops ──

    diskPath(): string {
        return resolveDiskPath(this.spec, this.paths.dir);
    }

    async diskInfo() { return disk.diskInfo((await this.tc()).qemuImg, this.diskPath(), this.diskKeyRead()); }
    async snapshots() { return disk.snapshotList((await this.tc()).qemuImg, this.diskPath(), this.diskKeyRead()); }
    async snapshot(name: string) {
        if (this.isRunning()) throw new Error("stop the VM before taking a snapshot (qemu-img needs the disk offline)");
        return disk.snapshotCreate((await this.tc()).qemuImg, this.diskPath(), name, this.needDiskKey());
    }
    async restoreSnapshot(name: string) {
        if (this.isRunning()) throw new Error("stop the VM before restoring a snapshot");
        return disk.snapshotApply((await this.tc()).qemuImg, this.diskPath(), name, this.needDiskKey());
    }
    async deleteSnapshot(name: string) {
        if (this.isRunning()) throw new Error("stop the VM before deleting a snapshot");
        return disk.snapshotDelete((await this.tc()).qemuImg, this.diskPath(), name, this.needDiskKey());
    }
    async resizeDisk(newSizeGiB: number) {
        if (this.isRunning()) throw new Error("stop the VM before resizing the disk (guest growfs happens next boot)");
        return disk.resizeDisk((await this.tc()).qemuImg, this.diskPath(), newSizeGiB, this.needDiskKey());
    }
    async backup(destPath: string) {
        if (this.isRunning()) {
            // Encrypted source: the backup target is LUKS too — a plaintext
            // copy would silently defeat the encryption. blockdev-add needs
            // the file to exist, so pre-create it keyed with the same
            // passphrase the running QEMU already holds (id "diskkey").
            const key = this.needDiskKey();
            if (key && !existsSync(destPath)) {
                const info = await this.diskInfo();
                await disk.createDisk((await this.tc()).qemuImg, destPath,
                    Math.ceil(info.virtualSize / (1 << 30)), key);
            }
            return this.withQmp(async (q) => {
                const node = await disk.diskNodeName(q, this.diskPath());
                return disk.backupLive(q, node, destPath, this.spec.disk.encrypt !== "off");
            });
        }
        return disk.backupOffline((await this.tc()).qemuImg, this.diskPath(), destPath, "qcow2", this.needDiskKey());
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

    /** Restart the display manager in the guest (connector-probe race fix — the old fixdisplays). */
    async fixDisplays() {
        return this.guestSh("systemctl restart gdm 2>/dev/null || systemctl restart sddm 2>/dev/null || true", 15_000);
    }

    /** qemu/qemu-img binaries — lazily resolved so post-load handles (which
     *  never ran buildArgv) can still do offline disk ops. */
    private async tc(): Promise<Toolchain> {
        return this.toolchain ??= await resolveToolchain();
    }
}
