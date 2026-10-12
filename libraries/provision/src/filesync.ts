// ============================================================================
// filesync.ts — copy-mode shares: real file copies over rsync+ssh.
//
// Each spec.shares entry with mode:"copy" syncs a host file/dir to a guest
// path. direction "host-to-guest" pushes only (mirror when deletions:true);
// "both" pushes with --update (newest wins) and pulls on a poll interval —
// no delete propagation in either direction.
//
// Lifecycle mirrors SessionSyncs: start() runs for a viewer session,
// applyOnce() is the `vm filesync --once` path. Host-side changes trigger
// pushes via fs.watch (recursive where supported — Bun/node on Linux may
// lack it, so a low-frequency interval is the fallback), guest-side changes
// arrive via the pull interval. Kill switches: CRUISER_HOST_SYNC=0 (master)
// and CRUISER_FILESYNC=0.
// ============================================================================

import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import type { ShareSpec, VmSpec } from "../../vm-core/src/config/schema";
import { guestRun } from "../../vm-core/src/logs";
import { run, which } from "../../sys/src/exec";

/** Enabled copy-mode shares. */
export function copyEntries(spec: VmSpec): ShareSpec[] {
    return spec.shares.filter((s) => s.enabled && s.mode === "copy");
}

/** CRUISER_HOST_SYNC=0 (master) or CRUISER_FILESYNC=0 (this engine) → off. */
export function filesyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.CRUISER_HOST_SYNC !== "0" && env.CRUISER_FILESYNC !== "0";
}

const sq = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;

/**
 * Guest-side destination for a copy entry. guestPath always names a
 * directory — a file source lands inside it under its basename. Default:
 * ~/cruiser-sync/<hostPath basename>.
 */
export function guestTarget(spec: VmSpec, s: ShareSpec): string {
    if (s.guestPath) return s.guestPath;
    const base = basename(s.hostPath.replace(/\/+$/, "")) || s.tag;
    return `/home/${spec.credentials.username}/cruiser-sync/${base}`;
}

/**
 * rsync argv for one direction of one entry. `-e` carries the ssh transport
 * as a single string (rsync word-splits it internally). push honors
 * direction: "host-to-guest" is authoritative (+ --delete when deletions);
 * "both" adds --update both ways so the newer file always wins and nothing
 * is deleted.
 */
export function rsyncArgv(
    spec: VmSpec, s: ShareSpec, dir: "push" | "pull", priv: string, hostIsDir: boolean,
): string[] {
    const port = spec.network.sshPort;
    if (!port) throw new Error(`share '${s.tag}' — no ssh hostfwd mapped, can't rsync`);
    const ssh = `ssh -i ${priv} -p ${port} -o BatchMode=yes -o StrictHostKeyChecking=no` +
        ` -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15`;
    const remote = `${spec.credentials.username}@127.0.0.1`;
    const gt = guestTarget(spec, s).replace(/\/+$/, "");
    const hp = s.hostPath.replace(/\/+$/, "");

    const args = ["-az", "--timeout=60"];
    let src: string, dst: string;
    if (dir === "push") {
        if (s.direction === "both") args.push("--update");
        else if (s.deletions) args.push("--delete");
        src = hostIsDir ? `${hp}/` : hp;
        dst = `${remote}:${gt}/`;
    } else {
        args.push("--update");   // pull side of "both" — newest wins, no deletes
        src = hostIsDir ? `${remote}:${gt}/` : `${remote}:${gt}/${basename(hp)}`;
        dst = hostIsDir ? `${hp}/` : hp;
    }
    return [...args, "-e", ssh, src, dst];
}

/**
 * One-shot guest prep: make sure rsync exists (install best-effort) and the
 * copy targets exist user-owned. Always exits 0 — failures are logged by
 * the follow-up rsync, not here.
 */
export function guestFileSyncPrepScript(spec: VmSpec): string {
    const u = spec.credentials.username;
    const dirs = copyEntries(spec).map((s) => guestTarget(spec, s));
    const mk = dirs.map((d) =>
        `mkdir -p ${sq(d)} 2>/dev/null; chown ${sq(u)}:${sq(u)} ${sq(d)} 2>/dev/null || true`).join("\n");
    return `# copy-share prep — rsync in guest + target dirs
command -v rsync >/dev/null 2>&1 || {
    if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y rsync 2>/dev/null || true
    elif command -v dnf5 >/dev/null 2>&1; then dnf5 install -y rsync 2>/dev/null || true
    elif command -v dnf >/dev/null 2>&1; then dnf install -y rsync 2>/dev/null || true
    elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install rsync 2>/dev/null || true
    elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm rsync 2>/dev/null || true
    fi
}
command -v rsync >/dev/null 2>&1 || echo "cruiser: rsync missing in guest and couldn't be installed — copy shares won't sync" >&2
${mk}
exit 0`;
}

/**
 * Copy-mode sync for the viewer session's lifetime. start() is
 * fire-and-forget — a dead agent, missing rsync, or an unreachable ssh port
 * logs and moves on; nothing here may delay or fail a viewer open.
 */
export class FileSyncs {
    private watchers: FSWatcher[] = [];
    private watched = new Set<string>();   // tags with a live fs.watch
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private pullTimer: ReturnType<typeof setInterval> | null = null;
    private pushTimer: ReturnType<typeof setInterval> | null = null;
    private running = new Set<string>();
    private queued = new Set<string>();
    private prepped = false;
    private disposed = false;
    private rsync: string | null = null;
    private priv: string | null = null;

    constructor(
        private readonly h: VmHandle,
        private readonly log?: (msg: string) => void,
    ) {}

    start(): void {
        if (!filesyncEnabled()) { this.log?.("file sync disabled (CRUISER_HOST_SYNC/CRUISER_FILESYNC)"); return; }
        const entries = copyEntries(this.h.spec);
        if (!entries.length) return;
        void this.applyAll();
        entries.forEach((s) => this.watchEntry(s));
        const pullMs = Number(process.env.CRUISER_FILESYNC_PULL_MS ?? 30_000);
        if (pullMs > 0 && entries.some((s) => s.direction === "both"))
            this.pullTimer = setInterval(() => {
                copyEntries(this.h.spec)
                    .filter((s) => s.direction === "both")
                    .forEach((s) => void this.syncEntry(s, "pull"));
            }, pullMs);
        // fs.watch recursive is unavailable on some runtimes/kernels — the
        // push interval keeps host→guest copies flowing regardless.
        const pushMs = Number(process.env.CRUISER_FILESYNC_PUSH_MS ?? 15_000);
        if (pushMs > 0)
            this.pushTimer = setInterval(() => {
                copyEntries(this.h.spec)
                    .filter((s) => !this.watched.has(s.tag))
                    .forEach((s) => void this.syncEntry(s, "push"));
            }, pushMs);
    }

    private watchEntry(s: ShareSpec): void {
        if (!existsSync(s.hostPath)) {
            this.log?.(`share '${s.tag}': ${s.hostPath} doesn't exist on the host — watching skipped`);
            return;
        }
        try {
            const w = watch(s.hostPath, { recursive: true, persistent: false }, () => this.kick(s));
            this.watchers.push(w); this.watched.add(s.tag);
        } catch {
            // non-recursive runtime — the push interval covers it
            try {
                this.watchers.push(watch(s.hostPath, { persistent: false }, () => this.kick(s)));
                this.watched.add(s.tag);
            } catch { /* gone */ }
        }
    }

    /** Debounced push trigger — bursts collapse into one rsync per entry. */
    private kick(s: ShareSpec): void {
        const key = s.tag;
        if (this.timers.has(key)) return;
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            void this.syncEntry(s, "push");
        }, 800));
    }

    /** Serialized per-entry rsync — a re-trigger while one runs queues a
     *  single follow-up pass so the last event is never dropped. */
    private async syncEntry(s: ShareSpec, dir: "push" | "pull" | "bothdirs"): Promise<void> {
        if (this.disposed) return;
        const key = s.tag;
        if (this.running.has(key)) { this.queued.add(key + ":" + dir); return; }
        this.running.add(key);
        try {
            if (!this.priv) {
                const { ensureKeypair } = await import("../../vm-core/src/sshkey");
                this.priv = (await ensureKeypair()).priv;
            }
            if (!this.rsync) {
                this.rsync = await which("rsync");
                if (!this.rsync) { this.log?.("rsync not installed on the host — copy shares skipped"); return; }
            }
            const isDir = (() => { try { return statSync(s.hostPath).isDirectory(); } catch { return s.hostPath.endsWith("/"); } })();
            const dirs: ("push" | "pull")[] = dir === "bothdirs"
                ? (s.direction === "both" ? ["push", "pull"] : ["push"])
                : [dir];
            for (let i = 0; i < dirs.length; i++) {
                if (this.disposed) return;
                const d = dirs[i]!;
                const r = await run(this.rsync, rsyncArgv(this.h.spec, s, d, this.priv, isDir),
                    { noThrow: true, timeoutMs: 300_000 });
                if (r.code !== 0)
                    this.log?.(`share '${s.tag}' ${d}: rsync exited ${r.code} — ${r.stderr.trim().slice(-200)}`);
                else this.log?.(`share '${s.tag}' ${d === "push" ? "→" : "←"} guest synced`);
            }
        } catch (e) {
            this.log?.(`share '${s.tag}': ${e instanceof Error ? e.message : e}`);
        } finally {
            this.running.delete(key);
            const dirs = [...this.queued].filter((q) => q.startsWith(key + ":"));
            dirs.forEach((q) => this.queued.delete(q));
            if (dirs.length) void this.syncEntry(s, "bothdirs");
        }
    }

    /** Prep the guest once per session (rsync install + mkdir targets),
     *  then run every entry. */
    async applyAll(): Promise<void> {
        const entries = copyEntries(this.h.spec);
        if (!entries.length || !filesyncEnabled()) return;
        if (!this.prepped) {
            this.prepped = true;
            try {
                const r = await guestRun(this.h, ["/bin/sh", "-c", guestFileSyncPrepScript(this.h.spec)], 120_000);
                if (r.code !== 0) this.log?.(`file sync guest prep: ${(r.stderr || r.stdout).trim().slice(-200)}`);
            } catch (e) {
                this.log?.(`file sync guest prep failed: ${e instanceof Error ? e.message : e}`);
            }
        }
        for (let i = 0; i < entries.length; i++) {
            if (this.disposed) return;
            await this.syncEntry(entries[i]!, "bothdirs");
        }
    }

    /** `vm filesync <name> --once` — one full pass, no watchers. */
    async applyOnce(): Promise<void> { await this.applyAll(); }

    dispose(): void {
        this.disposed = true;
        this.watchers.forEach((w) => w.close());
        this.watchers = [];
        this.timers.forEach((t) => clearTimeout(t));
        this.timers.clear();
        if (this.pullTimer) clearInterval(this.pullTimer);
        if (this.pushTimer) clearInterval(this.pushTimer);
        this.pullTimer = this.pushTimer = null;
    }
}
