// ============================================================================
// vm.ts — VmHandle: one VM's lifecycle. Builds argv, launches QEMU (daemonized
// or owned), reattaches over monitor/QGA sockets, and exposes disk/usb ops.
// ============================================================================

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { killDdproxy, spawnDdproxy } from "./ddproxy";
import { run, spawnChild, virtiofsdPath, which } from "../../../sys/src/exec";

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

/** `-audiodev help` backend list — cached per binary like the chardev probe. */
const audioBackendCache = new Map<string, Promise<Set<string>>>();

function qemuAudioBackends(qemu: string, ldLibraryPath: string): Promise<Set<string>> {
    let p = audioBackendCache.get(qemu);
    if (!p) {
        p = run(qemu, ["-audiodev", "help"], {
            noThrow: true,
            env: { LD_LIBRARY_PATH: ldLibraryPath },
        }).then((r) => new Set(
            (r.stdout + r.stderr).split("\n").map((l) => l.trim()).filter(Boolean),
        )).catch(() => new Set<string>());
        audioBackendCache.set(qemu, p);
    }
    return p;
}

/** dmabuf viewer audio: the dbus backend stays silent until viewer-dd
 *  implements org.qemu.Display1 audio, so prefer a backend QEMU can drive
 *  directly — pipewire when its socket exists, then PA (incl. pipewire-pulse
 *  compat). dbus remains the fallback: the VM still gets the hda device. */
/** Probed once: does `systemd-run --user --scope` work (user bus + delegation)? */
let scopeWorks: Promise<boolean> | null = null;
function userScopeWorks(): Promise<boolean> {
    scopeWorks ??= run("systemd-run", ["--user", "--scope", "--quiet", "true"], { noThrow: true })
        .then((r) => r.code === 0).catch(() => false);
    return scopeWorks;
}

/** resources.sched → the ionice(1) argv prefix for a spawned process —
 *  QEMU itself and virtiofsd (the daemon does the actual share I/O;
 *  ioprio is inherited across its sandbox namespace fork). [] = unset.
 *  ionice EXITS WITHOUT EXEC on a denied ioprio_set (unlike nice(1), which
 *  warns and continues) — an over-privileged class would kill the child
 *  outright, so the sh fallback re-execs the command at default io class
 *  (it also covers a missing ionice binary). */
function schedIoArgv(sched: VmSpec["resources"]["sched"]): string[] {
    if (!sched.ioClass) return [];
    const cls = { realtime: "1", "best-effort": "2", idle: "3" }[sched.ioClass];
    const n = sched.ioClass !== "idle" && sched.ioPrio !== undefined ? ` -n ${sched.ioPrio}` : "";
    return ["sh", "-c", `ionice -c ${cls}${n} "$@" || exec "$@"`, "cruiser-io"];
}

async function pickAudioBackend(qemu: string, ldLibraryPath: string): Promise<BuildOpts["audioBackend"]> {
    const backends = await qemuAudioBackends(qemu, ldLibraryPath);
    const xdg = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}`;
    if (backends.has("pipewire") && existsSync(join(xdg, "pipewire-0"))) return "pipewire";
    if (backends.has("pa") && existsSync(join(xdg, "pulse", "native"))) return "pa";
    return "dbus";
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

    /** QEMU process alive (pidfile + kill -0 + the pid is really QEMU) AND
     *  the monitor socket is present. The comm check guards pid reuse: a
     *  crashed QEMU whose pid was recycled by an unrelated process must not
     *  read as "running" (the monitor socket would then never answer and
     *  probe() would report "starting" forever). */
    isRunning(): boolean {
        const pid = this.pid();
        if (!pid || !existsSync(this.paths.monitorSock)) return false;
        try {
            process.kill(pid, 0);
            return readFileSync(`/proc/${pid}/comm`, "utf-8").trim().startsWith("qemu");
        } catch { return false; }
    }

    async probe(): Promise<VmState> {
        if (!this.isRunning()) return "stopped";
        this.watchVfsd();   // adopted QEMU — cover daemon crashes too
        this.watchUsb();    // …and autoAttach hot-plug
        // Adopted QEMU whose broker died/never spawned (older build started
        // it, proxy crashed): a throttled respawn is safe on a healthy QEMU.
        if (this.spec.display.viewer === "dmabuf")
            void spawnDdproxy(this.paths, { respawn: true });
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
            if (this.spec.display.sound)
                opts.audioBackend ??= await pickAudioBackend(this.toolchain.qemu, this.toolchain.ldLibraryPath);
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
        if (!existsSync(this.paths.ovmfVars)) await copyFile(ovmfVarsTemplate(this.spec.security.secureBoot), this.paths.ovmfVars);

        // Hibernate resume: a run/suspend.mig from hibernate() means this
        // boot is a state-load, not a cold boot — -incoming makes QEMU
        // consume the saved RAM+device stream at startup (disks are never
        // rolled). The legacy run/hibernate.vmstate path is a paused (-S)
        // boot + snapshot-load.
        const resumeMig = join(this.paths.run, "suspend.mig");
        const resumeVs = join(this.paths.run, "hibernate.vmstate");
        const resuming = existsSync(resumeMig) || existsSync(resumeVs);
        if (resuming) {
            // The vmstate is bound to the launch-time device model — a
            // boot-frozen spec edit since the save (RAM size, cpu count,
            // gpu mode…) makes snapshot-load fail partway. Refuse the
            // resume with the drift named; the state survives for a retry
            // after reverting, or --discard-state cold-boots.
            let drift: string[] = [];
            try {
                drift = bootRelevantChanges(
                    parseVmSpec(JSON.parse(readFileSync(this.paths.launchSpec, "utf-8"))),
                    this.spec);
            } catch { /* no launch baseline — take the state at face value */ }
            if (drift.length) {
                await this.clearDiskKey();   // the spawn-time finally never runs on this throw
                throw new Error(
                    `hibernate state predates a spec change (${drift.join(", ")}) — ` +
                    `revert it, or cold-boot with 'vm start ${this.spec.name} --discard-state'`);
            }
        }

        // swtpm: QEMU's tpm-emulator chardev connects at machine init, so
        // the daemon must be listening first (same shape as virtiofsd).
        if (this.spec.security.tpm) await this.spawnSwtpm();
        // The GPU device's max_outputs must match the SAVE-time argv or
        // virtio-gpu's vmstate refuses to load (VMSTATE_UINT32_EQUAL →
        // "1 != 3"-style failure). hibernate() persists the exact list as
        // suspend-monitors.json; launch-monitors.json is the fallback.
        let savedMons: BuildOpts["guestMonitors"] | undefined;
        if (resuming) {
            const monPaths = [this.suspendMonitorsPath(), this.launchMonitorsPath()];
            for (let i = 0; i < monPaths.length && !savedMons?.length; i++) {
                try { savedMons = JSON.parse(readFileSync(monPaths[i]!, "utf-8")); } catch { /* try next */ }
            }
        }
        // The list that actually shaped this launch's GPU device — a resume
        // reuses the save-time list even when the caller's differs, and the
        // persisted record must match what went into argv (a later
        // restoreSnapshot rebuilds the device from it). An EMPTY saved list
        // reads as "no monitors were mirrored" — not a zero-monitor save —
        // so it falls back like a missing file (buildArgs crashes on []).
        const launchMons = resuming && savedMons?.length ? savedMons : opts.guestMonitors;

        const built = await this.buildArgv({
            ...opts,
            guestMonitors: launchMons,
            extraArgs: [...(opts.extraArgs ?? []),
                ...(existsSync(resumeMig) ? ["-incoming", `exec:cat '${resumeMig}'`]
                    : existsSync(resumeVs) ? ["-S"] : [])],
        });
        void appendVmLog(this.paths, `start: mode=${opts.mode ?? "run"} persist=${this.spec.persist} gpu=${this.spec.gpu.mode}`);

        // virtiofsd daemons must be up before QEMU opens the sockets —
        // the vhost-user device's handshake happens at machine init.
        // Reap strays of a dead launcher first or they'd keep their
        // listeners + pidfiles.
        this.killVfsd();
        killDdproxy(this.paths);   // same stray-reap for a stale display broker
        const vfsdBin = built.virtiofsd.length ? await virtiofsdPath() : null;
        for (let i = 0; i < built.virtiofsd.length; i++)
            if (vfsdBin) await this.spawnVfsd(built.virtiofsd[i]!, vfsdBin);

        const env = { ...process.env, ...built.env };
        // resources.limits → run QEMU inside a delegated user scope so the
        // kernel enforces CPU/mem/IO caps on the whole process (daemonized
        // children stay in the scope cgroup after systemd-run exits).
        const lim = this.spec.resources.limits;
        const props = [
            ...(lim.cpuQuota ? [`CPUQuota=${lim.cpuQuota}`] : []),
            ...(lim.memoryMax ? [`MemoryMax=${lim.memoryMax}`] : []),
            ...(lim.ioWeight ? [`IOWeight=${lim.ioWeight}`] : []),
        ];
        // resources.sched → nice/ionice wrappers around QEMU itself, applied
        // INSIDE the cgroup scope (systemd-run runs the wrapped command).
        // The ionice wrap self-falls-back (schedIoArgv): denied or missing
        // ionice → the VM still boots at default io class.
        const sched = this.spec.resources.sched;
        let inner = [this.toolchain.qemu, ...built.argv];
        inner = [...schedIoArgv(sched), ...inner];
        if (sched.nice !== undefined) {
            const bin = await which("nice");
            if (bin)
                inner = [bin, "-n", String(sched.nice), ...inner];
            else void appendVmLog(this.paths, "resources.sched.nice set but nice is not on PATH — running at default priority");
        }
        if ((sched.nice !== undefined && sched.nice < 0) || sched.ioClass === "realtime"
            || (sched.ioClass === "best-effort" && sched.ioPrio !== undefined && sched.ioPrio < 4))
            void appendVmLog(this.paths, "resources.sched raises priority above default — runs at default without CAP_SYS_NICE/SYS_ADMIN");
        let qemuCmd = inner[0]!;
        let qemuArgv = inner.slice(1);
        if (props.length) {
            if (await userScopeWorks()) {
                qemuCmd = "systemd-run";
                qemuArgv = ["--user", "--scope", "--quiet", "--unit", `cruiser-${this.spec.name}`,
                    ...props.flatMap((p) => ["-p", p]), "--", ...inner];
            } else {
                void appendVmLog(this.paths, "resources.limits set but systemd-run --user unavailable — running uncapped");
            }
        }
        try {
            if (this.spec.persist === "daemonize") {
                // QEMU -daemonize: spawn returns after the daemon fork.
                await run(qemuCmd, qemuArgv, { env });
            } else {
                this.qemuChild = spawnChild(qemuCmd, qemuArgv, { env, stdio: "ignore" });
                this.qemuChild.on("exit", (code) => {
                    this.qemuChild = null;
                    void appendVmLog(this.paths, `qemu exited (code ${code})`);
                });
                this.qemuChild.unref();
            }

            // Wait for the monitor socket, then QMP handshake. The post-
            // launch steps (state-load, spec snapshot, watchers, ddproxy)
            // run OUTSIDE the readiness probe — a loadVmstate failure must
            // surface as itself, not a swallowed "qemu did not come up" at
            // the deadline.
            const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
            for (;;) {
                let ready = false;
                if (existsSync(this.paths.monitorSock)) {
                    try { await this.withQmp((q) => q.queryStatus()); ready = true; }
                    catch { /* not ready */ }
                }
                if (ready) {
                    void appendVmLog(this.paths, `started: pid ${this.pid()}${resuming ? " (hibernate resume)" : ""}`);
                    if (resuming) {
                        try {
                            if (existsSync(resumeMig)) {
                                // -incoming consumes the stream during
                                // startup; poll query-migrate for the
                                // outcome, then cont out of the paused
                                // post-load state and drop the file.
                                const migDl = Date.now() + 120_000;
                                for (;;) {
                                    if (!this.isRunning()) {
                                        const tail = existsSync(this.paths.log)
                                            ? readFileSync(this.paths.log, "utf-8").slice(-800) : "";
                                        throw new Error(`qemu exited while loading state${tail ? `\n${tail}` : ""}`);
                                    }
                                    const m = await this.withQmp((q) => q.execute("query-migrate")).catch(() => null) as { status?: string; error?: { desc?: string } } | null;
                                    if (m?.status === "completed") break;
                                    if (m?.status === "failed" || m?.status === "cancelled")
                                        throw new Error(`migrate ${m.status}${m.error?.desc ? `: ${m.error.desc}` : ""}`);
                                    if (Date.now() > migDl) throw new Error("state load did not finish in 120s");
                                    await new Promise((r) => setTimeout(r, 200));
                                }
                                await this.withQmp((q) => q.cont()).catch(() => {});
                                await rm(resumeMig, { force: true });
                                await rm(this.suspendMonitorsPath(), { force: true });
                            } else {
                                await this.loadVmstate(resumeVs, "hibernate", { dropAfter: true });
                            }
                        } catch (e) {
                            // A failed state-load leaves QEMU a paused
                            // half-boot — kill it. The state file survives
                            // for a retry or discard.
                            const msg = e instanceof Error ? e.message : String(e);
                            void appendVmLog(this.paths, `hibernate resume failed: ${msg}`);
                            await this.kill().catch(() => {});
                            throw new Error(`hibernate resume failed: ${msg} — ` +
                                `state kept; retry 'vm start' or cold-boot with --discard-state`);
                        }
                    }
                    // Snapshot the spec QEMU actually launched with —
                    // pendingRestart() diffs later saves against it.
                    await writeFile(this.paths.launchSpec,
                        JSON.stringify(this.spec)).catch(() => {});
                    // …and the monitor list that shaped the GPU device —
                    // a live-snapshot/hibernate restore must reproduce
                    // that exact max_outputs.
                    await writeFile(this.launchMonitorsPath(),
                        JSON.stringify(launchMons ?? [])).catch(() => {});
                    this.watchVfsd();
                    this.watchUsb();
                    this.startUrlListener();
                    // ddproxy: the dmabuf display broker holds QEMU's
                    // @dbus-display conns for the VM's lifetime so viewer
                    // churn never reaches QEMU's wedgable p2p auth.
                    // Default-on for dmabuf VMs; a missing binary is not
                    // fatal (viewer-dd falls back to the direct channel).
                    // Awaited (it's just a detached spawn — the attach
                    // retry runs inside the daemon) so the pidfile lands
                    // before start() returns.
                    if (this.spec.display.viewer === "dmabuf")
                        await spawnDdproxy(this.paths);
                    return;
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
        killDdproxy(this.paths);
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
        const argv = [
            // the daemon does the real share I/O — ride the VM's io sched
            ...schedIoArgv(this.spec.resources.sched),
            b,
            `--socket-path=${v.socket}`, `--shared-dir=${v.sharedDir}`,
            "--cache=auto", "--sandbox=namespace",
        ];
        const c = spawnChild(argv[0]!, argv.slice(1), { detached: true, logFile: join(this.paths.run, `virtiofsd-${v.tag}.log`) });
        this.vfsChildren.push(c);
        this.vfsdSpawned.set(v.socket, Date.now());
    }

    /** swtpm daemon for security.tpm — TPM 2.0 state persists at <vm>/tpm/;
     *  the daemon self-terminates when QEMU drops the ctrl connection (-t),
     *  so a VM stop cleans it up without tracking. */
    private async spawnSwtpm(): Promise<void> {
        const bin = await which("swtpm");
        if (!bin) throw new Error("security.tpm is set but swtpm isn't installed — apt install swtpm");
        await mkdir(this.paths.tpmDir, { recursive: true });
        await rm(this.paths.tpmSock, { force: true });
        await run(bin, ["socket", "--tpm2", "--daemon",
            "--tpmstate", `dir=${this.paths.tpmDir},mode=0600`,
            "--ctrl", `type=unixio,path=${this.paths.tpmSock},mode=0600`,
            "--pid", `file=${join(this.paths.run, "swtpm.pid")}`,
            "--log", `file=${join(this.paths.run, "swtpm.log")},level=1`,
            "--flags", "not-need-init,startup-clear",
            "-t",
        ]);
    }

    /** org.cruiser.urlopen.0 bridge: the guest writes one URL per line to the
     *  virtserialport and real xdg-open runs on the host — scheme-filtered to
     *  http(s) so a guest can't drive arbitrary xdg-open handlers. The socat
     *  client dies with QEMU's socket (EOF → SYSTEM loop ends) so it needs no
     *  lifecycle tracking; absent socat just disables the feature. */
    private startUrlListener(): void {
        if (!this.spec.display.urlOpen) return;
        // socat's SYSTEM: address splits its command on spaces — the loop
        // lives in a script file so the address arg stays a single token.
        const script = join(this.paths.run, "urlopen-listen.sh");
        writeFileSync(script, `#!/bin/sh
while IFS= read -r u; do
    case "$u" in
        http://*|https://*) xdg-open "$u" ;;
    esac
done
`, { mode: 0o755 });
        try {
            const c = spawnChild("socat", [
                `UNIX-CONNECT:${this.paths.urlOpenSock},retry=30,interval=1`,
                `SYSTEM:${script}`,
            ], { detached: true, logFile: join(this.paths.run, "urlopen.log") });
            c.unref();
        } catch { /* no socat — feature disabled */ }
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

    // ── usb autoAttach watch ──
    // Polls sysfs while the VM runs: an autoAttach entry that shows up on
    // the host gets hot-attached (QMP device_add usb-host); one that
    // vanishes gets device_del'd so a re-plug at a new bus/addr attaches
    // cleanly instead of colliding with the stale guest-side device.
    private usbTimer: ReturnType<typeof setInterval> | null = null;
    private usbTicking = false;
    /** autoAttach key → qmp id (the id embeds bus/addr — a stale id means
     *  the device re-appeared elsewhere and needs a detach first). */
    private usbAttached = new Map<string, string>();

    private watchUsb(): void {
        if (this.usbTimer || !this.spec.usb.autoAttach.length) return;
        const tick = async () => {
            if (this.usbTicking) return;
            this.usbTicking = true;
            try {
                if (!this.isRunning()) {
                    if (this.usbTimer) { clearInterval(this.usbTimer); this.usbTimer = null; }
                    this.usbAttached.clear();
                    return;
                }
                const present = await usb.listUsbDevices().catch(() => []);
                for (let i = 0; i < this.spec.usb.autoAttach.length; i++) {
                    const w = this.spec.usb.autoAttach[i]!;
                    const key = `${w.vendorId}:${w.productId}${w.serial ? `:${w.serial}` : ""}`;
                    const match = present.find((d) =>
                        d.vendorId === w.vendorId && d.productId === w.productId
                        && (!w.serial || d.serial === w.serial));
                    const cur = this.usbAttached.get(key);
                    if (!match) {
                        if (cur) {
                            await this.withQmp((q) => usb.usbDetach(q, cur)).catch(() => {});
                            this.usbAttached.delete(key);
                        }
                        continue;
                    }
                    if (cur === usb.usbAttachId(match)) continue;   // same device, still there
                    if (cur) {
                        await this.withQmp((q) => usb.usbDetach(q, cur)).catch(() => {});
                        this.usbAttached.delete(key);
                    }
                    if (!match.writable) continue;
                    const id = await this.withQmp((q) => usb.usbAttach(q, match)).catch(() => null);
                    if (id) {
                        this.usbAttached.set(key, id);
                        void appendVmLog(this.paths, `usb auto-attach: ${match.product ?? key} (${id})`);
                    }
                }
            } finally { this.usbTicking = false; }
        };
        void tick();
        this.usbTimer = setInterval(() => void tick(), 3_000);
    }

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

    /** PNG screendump of the primary console — writes `file` (default
     *  run/screenshot.png) and returns the path. Running VM required. */
    async screenshot(file?: string): Promise<string> {
        const out = file ?? join(this.paths.run, "screenshot.png");
        await this.withQmp((q) => q.screendump(out, { format: "png" }));
        return out;
    }

    /** Live guest-visible memory target via virtio-balloon (MiB, clamped to
     *  the boot allocation — the balloon can only reclaim, never add).
     *  Session-level; spec.resources.memoryMiB stays the boot value. */
    async setMemory(mib: number): Promise<number> {
        const target = Math.min(mib, this.spec.resources.memoryMiB);
        try {
            await this.withQmp((q) => q.balloon(target * (1 << 20)));
        } catch (e) {
            throw new Error(`balloon failed — this boot predates the virtio-balloon device; restart the VM (${e instanceof Error ? e.message : e})`);
        }
        return target;
    }
    /** query-balloon: actual = guest-visible memory in bytes. */
    balloonInfo(): Promise<{ actual: number }> {
        return this.withQmp((q) => q.queryBalloon()).catch((e) => {
            throw new Error(`no balloon device — this boot predates virtio-balloon; restart the VM (${e instanceof Error ? e.message : e})`);
        });
    }

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
    /** run/launch-monitors.json — the guestMonitors BuildOpts a live boot
     *  used; a snapshot-load must reproduce the same GPU device shape. */
    private launchMonitorsPath(): string {
        return join(this.paths.run, "launch-monitors.json");
    }

    /** snapshots/<name>.vmstate — RAM+device state for live snapshots. */
    private snapVmstate(name: string): string {
        return join(this.paths.snapshotsDir, `${name}.vmstate`);
    }

    /** Block nodes a live snapshot must cover — the system disk plus the
     *  encrypt=home volume when it exists. */
    private async snapNodes(q: QmpClient): Promise<string[]> {
        const nodes = [await disk.diskNodeName(q, this.diskPath())];
        const hp = this.homeDiskPath();
        if (this.spec.disk.encrypt === "home" && hp && existsSync(hp))
            nodes.push(await disk.diskNodeName(q, hp));
        return nodes;
    }

    /** snapshot-save/load's `vmstate` arg is a blockdev NODE name, not a
     *  filename — register the qcow2 first, drop the node after. */
    private static async addVmstateNode(q: QmpClient, file: string): Promise<string> {
        const node = `vmstate-${Date.now()}`;
        await q.execute("blockdev-add", {
            "node-name": node, driver: "qcow2",
            file: { driver: "file", filename: file },
        });
        return node;
    }

    /** QMP snapshot-load into a paused QEMU — brings back RAM + device
     *  state and rolls every device to the tag's internal snapshot in one
     *  job. dropAfter also drops the tag + vmstate file (hibernate is a
     *  one-shot state). */
    private async loadVmstate(vmstate: string, tag: string, { dropAfter = false } = {}): Promise<void> {
        await this.withQmp(async (q) => {
            const nodes = await this.snapNodes(q);
            const vsNode = await VmHandle.addVmstateNode(q, vmstate);
            try {
                const jobId = `snapload-${Date.now()}`;
                // devices must INCLUDE the vmstate node — QEMU looks the
                // vmstate name up among them, not globally.
                await q.execute("snapshot-load", { "job-id": jobId, tag, vmstate: vsNode, devices: [...nodes, vsNode] });
                await disk.waitJob(q, jobId);
                if (dropAfter) {
                    const dj = `snapdel-${Date.now()}`;
                    await q.execute("snapshot-delete", { "job-id": dj, tag, vmstate: vsNode, devices: [...nodes, vsNode] }).catch(() => {});
                    await disk.waitJob(q, dj).catch(() => {});
                    await rm(vmstate, { force: true }).catch(() => {});
                }
            } finally {
                await q.execute("blockdev-del", { "node-name": vsNode }).catch(() => {});
            }
            // -S boots stay paused after the load — resume explicitly
            // (a no-op when the state already runs).
            await q.cont().catch(() => {});
        });
    }

    async snapshot(name: string) {
        if (this.isRunning()) {
            // Live snapshot: QMP snapshot-save writes RAM+device state to a
            // vmstate file and tags an internal snapshot on every covered
            // disk — `vm snapshots` shows it like any other. GL devices
            // (virgl/venus) go through the migration path and QEMU refuses
            // them — software GPUs are the only migratable display.
            if (this.spec.gpu.mode !== "software")
                throw new Error("live snapshots need gpu.mode=software — virgl/venus devices aren't migratable; stop the VM for an offline snapshot");
            await mkdir(this.paths.snapshotsDir, { recursive: true });
            // vmstate must be a pre-created qcow2 (RAM-sized + slack).
            await disk.createDisk((await this.tc()).qemuImg, this.snapVmstate(name),
                Math.ceil(this.spec.resources.memoryMiB / 1024) + 1);
            return this.withQmp(async (q) => {
                const nodes = await this.snapNodes(q);
                const vsNode = await VmHandle.addVmstateNode(q, this.snapVmstate(name));
                try {
                    const jobId = `snap-${Date.now()}`;
                    await q.execute("snapshot-save", {
                        "job-id": jobId, tag: name, vmstate: vsNode,
                        devices: [...nodes, vsNode],   // vmstate must be listed too
                    });
                    await disk.waitJob(q, jobId);
                } finally {
                    await q.execute("blockdev-del", { "node-name": vsNode }).catch(() => {});
                }
            });
        }
        return disk.snapshotCreate((await this.tc()).qemuImg, this.diskPath(), name, this.needDiskKey());
    }
    async restoreSnapshot(name: string) {
        if (this.isRunning()) throw new Error("stop the VM before restoring a snapshot");
        const vs = this.snapVmstate(name);
        if (existsSync(vs)) {
            // A live snapshot carries RAM state — boot paused, then
            // snapshot-load rolls disk + drops in the memory image. The
            // launch-time monitor list reproduces the GPU shape the state
            // was saved under.
            let mons: BuildOpts["guestMonitors"] | undefined;
            try { mons = JSON.parse(readFileSync(this.launchMonitorsPath(), "utf-8")); } catch { /* no snapshot — undefined is fine */ }
            await this.start({ guestMonitors: mons, extraArgs: ["-S"] });
            await this.loadVmstate(vs, name);
            return;
        }
        return disk.snapshotApply((await this.tc()).qemuImg, this.diskPath(), name, this.needDiskKey());
    }
    async deleteSnapshot(name: string) {
        if (this.isRunning()) throw new Error("stop the VM before deleting a snapshot");
        await rm(this.snapVmstate(name), { force: true }).catch(() => {});
        return disk.snapshotDelete((await this.tc()).qemuImg, this.diskPath(), name, this.needDiskKey());
    }

    /** run/suspend-mons.json — the guestMonitors that shaped the SUSPENDED
     *  VM's GPU device. Lives next to suspend.mig (not in
     *  launch-monitors.json, which each new boot overwrites). */
    private suspendMonitorsPath(): string {
        return join(this.paths.run, "suspend-mons.json");
    }

    /** Suspend-to-disk: freeze the guest, migrate RAM+device state to
     *  run/suspend.mig, then quit. The next start() detects the file and
     *  launches with -incoming — QEMU consumes the stream and lands the
     *  guest where it left off. Unlike the old internal-snapshot path the
     *  disks are never rolled and any format works; the file is roughly
     *  guest-RAM sized. */
    async hibernate(): Promise<void> {
        if (!this.isRunning()) throw new Error("start the VM to hibernate it");
        if (this.spec.gpu.mode !== "software")
            throw new Error("hibernate needs gpu.mode=software — virgl/venus devices aren't migratable");
        // virtiofs shares are vhost-user: device state lives in the
        // external daemon, which QEMU can't serialize — migrate refuses.
        if (this.vfsdTargets().length)
            throw new Error("hibernate can't save VMs with mount-mode shares — vhost-user-fs state lives in virtiofsd and isn't migratable");
        const mig = join(this.paths.run, "suspend.mig");
        await rm(mig, { force: true });            // a stale file can't host a fresh save
        await rm(this.suspendMonitorsPath(), { force: true });
        await this.withQmp(async (q) => {
            await q.stop();   // quiesce vcpus + disk I/O for a consistent stream
            try {
                await q.execute("migrate", { uri: `exec:cat > '${mig}'` });
                const deadline = Date.now() + 10 * 60_000;
                for (;;) {
                    const m = await q.execute("query-migrate").catch(() => null) as { status?: string; error?: { desc?: string } } | null;
                    if (m?.status === "completed") break;
                    if (m?.status === "failed" || m?.status === "cancelled")
                        throw new Error(`migrate ${m.status}${m.error?.desc ? `: ${m.error.desc}` : ""}`);
                    if (Date.now() > deadline) throw new Error("migrate timed out");
                    await new Promise((r) => setTimeout(r, 200));
                }
            } catch (e) {
                // Keep the running VM usable — unpause and drop the
                // partial stream so start() can't pick up a truncated file.
                await q.cont().catch(() => {});
                await rm(mig, { force: true }).catch(() => {});
                throw e;
            }
            // The resume must reproduce this device's exact shape — stash
            // the launch-time monitor list next to the stream (host
            // topology may differ by resume time).
            try { await writeFile(this.suspendMonitorsPath(), readFileSync(this.launchMonitorsPath())); }
            catch { /* none — resume falls back to the caller's list */ }
            // quit's reply races the socket teardown — a rejection just
            // means QEMU took the order.
            await q.quit().catch(() => {});
        });
        // Wait for the pid to die so the stream is durable, then reap the
        // detached companions — virtiofsd listeners and ddproxy would
        // otherwise sit orphaned until the next start's stray-sweep.
        const deadline = Date.now() + 15_000;
        while (this.isRunning() && Date.now() < deadline)
            await new Promise((r) => setTimeout(r, 100));
        this.cleanupRunDir();
    }

    /** Drop a pending hibernate state WITHOUT resuming — the suspend.mig
     *  stream and its sidecar, plus (legacy) the run/hibernate.vmstate
     *  file and the "hibernate" internal-snapshot tags the old
     *  snapshot-save path left on every covered disk. Encrypted disks
     *  need the passphrase like any mutating op. */
    async discardHibernate(): Promise<void> {
        if (this.isRunning()) throw new Error("stop the VM first");
        const vs = join(this.paths.run, "hibernate.vmstate");
        await rm(join(this.paths.run, "suspend.mig"), { force: true });
        await rm(this.suspendMonitorsPath(), { force: true });
        if (!existsSync(vs)) return;
        const key = this.spec.disk.encrypt === "off" ? undefined : this.needDiskKey();
        await rm(vs, { force: true });
        const img = (await this.tc()).qemuImg;
        const imgs = [this.diskPath(), this.spec.disk.encrypt === "home" ? this.homeDiskPath() : null];
        for (let i = 0; i < imgs.length; i++) {
            const d = imgs[i];
            if (d && existsSync(d))
                await disk.snapshotDelete(img, d, "hibernate", key).catch(() => {});
        }
    }

    /** A hibernate image is pending — start() will resume it. */
    hibernated(): boolean {
        return existsSync(join(this.paths.run, "suspend.mig"))
            || existsSync(join(this.paths.run, "hibernate.vmstate"));
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

    /** FITRIM all guest mounts so the host qcow2 can deallocate the freed
     *  clusters. QGA guest-fstrim first; confined agents fall back to
     *  `sudo fstrim -av` over the ssh forward. */
    async fstrim(): Promise<string> {
        if (!this.isRunning()) throw new Error("start the VM to fstrim it");
        try {
            await this.withQga((g) => g.fstrim(), 310_000);
            return "fstrim issued on all guest mounts";
        } catch {
            const { sshArgv } = await import("../ssh");
            const a = await sshArgv(this.spec, { remoteCmd: ["sudo", "fstrim", "-av"] });
            const r = await run("ssh", a, { timeoutMs: 300_000 });
            return r.stdout.trim() || "fstrim done (ssh)";
        }
    }

    /** Sparse-rewrite the disk in place (stopped VM only) — qemu-img
     *  convert sheds the qcow2's dead clusters. Refuses while the image
     *  holds internal snapshots (convert drops them); `force` accepts
     *  that loss. Pair with fstrim first for real reclamation. */
    async compact({ force = false } = {}): Promise<{ before: number; after: number }> {
        if (this.isRunning()) throw new Error("stop the VM before compacting the disk");
        const snaps = await this.snapshots();
        if (snaps.length && !force)
            throw new Error(`'${this.spec.name}' has ${snaps.length} internal snapshot(s) — compact drops them (pass --force to proceed)`);
        return disk.compactDisk((await this.tc()).qemuImg, this.diskPath(), this.needDiskKey());
    }

    // ── port forwards ──

    /** Apply hostfwd deltas to the running QEMU via HMP and persist the
     *  spec — the diff key is proto+hostPort+guestPort, so removing one
     *  entry and adding an identical one is a no-op. Stopped VMs just take
     *  the spec change (it lands in argv at the next boot). The forwards
     *  backing sshPort/rdpPort are only removable with allowEssential. */
    private fwdKey = (f: { proto: string; hostPort: number; guestPort: number }) => `${f.proto}:${f.hostPort}:${f.guestPort}`;

    async applyForwards(next: VmSpec["network"]["hostfwd"], opts: { prev?: VmSpec["network"]["hostfwd"]; allowEssential?: boolean } = {}): Promise<void> {
        const prev = opts.prev ?? this.spec.network.hostfwd;
        const essential = new Set([22, 3389].map((g) => this.fwdKey(
            { proto: "tcp", hostPort: g === 22 ? this.spec.network.sshPort! : this.spec.network.rdpPort!, guestPort: g })));
        const drop = prev.filter((f) => !next.some((n) => this.fwdKey(n) === this.fwdKey(f)));
        const add = next.filter((f) => !prev.some((p) => this.fwdKey(p) === this.fwdKey(f)));
        if (!opts.allowEssential && drop.some((f) => essential.has(this.fwdKey(f))))
            throw new Error("that forward carries guest ssh/rdp — refusing to drop it");
        if (this.isRunning() && (drop.length || add.length)) {
            await this.withQmp(async (q) => {
                for (let i = 0; i < drop.length; i++)
                    await q.hmp(`hostfwd_remove n0 ${drop[i]!.proto}:127.0.0.1:${drop[i]!.hostPort}`);
                for (let i = 0; i < add.length; i++)
                    await q.hmp(`hostfwd_add n0 ${add[i]!.proto}:127.0.0.1:${add[i]!.hostPort}-:${add[i]!.guestPort}`);
            });
        }
        this.spec.network.hostfwd = next;
        await this.saveSpec();
    }

    /** Bring the running QEMU's slirp forwards in line with the spec —
     *  used after a config pull changes hostfwd under a live VM (the
     *  applied set is the launch-time spec's, snapshotted at start()). */
    async reconcileForwards(): Promise<string[]> {
        if (!this.isRunning()) return [];
        let booted: VmSpec["network"]["hostfwd"] = [];
        try { booted = parseVmSpec(JSON.parse(readFileSync(this.paths.launchSpec, "utf-8"))).network.hostfwd; } catch { /* no launch snapshot — nothing to diff against */ }
        const changed = this.fwdKeyDiff(booted, this.spec.network.hostfwd);
        if (!changed.length) return [];
        await this.applyForwards(this.spec.network.hostfwd, { prev: booted, allowEssential: false });
        return changed;
    }

    private fwdKeyDiff(a: VmSpec["network"]["hostfwd"], b: VmSpec["network"]["hostfwd"]): string[] {
        const gone = a.filter((f) => !b.some((n) => this.fwdKey(n) === this.fwdKey(f))).map((f) => `-${this.fwdKey(f)}`);
        const came = b.filter((f) => !a.some((p) => this.fwdKey(p) === this.fwdKey(f))).map((f) => `+${this.fwdKey(f)}`);
        return [...gone, ...came];
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
