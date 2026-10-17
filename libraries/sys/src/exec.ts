// ============================================================================
// exec.ts — shared process helpers. node:child_process so it runs under
// bun AND node hosts (engine house rule: no runtime-only APIs in library code).
// ============================================================================

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { openSync } from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** POSIX single-quote escape — every interpolated value in a guest/host
 *  shell string goes through this. */
export const sq = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;

/** Run a command to completion; throws on nonzero exit unless `noThrow`. */
export async function run(
    cmd: string,
    args: string[] = [],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; noThrow?: boolean; input?: string | Buffer } = {},
): Promise<ExecResult> {
    try {
        const p = execFileP(cmd, args, {
            cwd: opts.cwd,
            env: opts.env ? { ...process.env, ...opts.env } : undefined,
            timeout: opts.timeoutMs ?? 120_000,
            maxBuffer: 64 * 1024 * 1024,
        });
        // stdin feeder — for secrets that must never appear in argv
        // (openssl passwd -stdin, etc.). A failed execFile still carries
        // .child; EPIPE on a dead child is expected and ignored.
        if (opts.input !== undefined)
            p.child.stdin?.on("error", () => {}).end(opts.input);
        const { stdout, stderr } = await p;
        return { code: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (e: any) {
        if (e.code === "ENOENT" && opts.noThrow) return { code: 127, stdout: "", stderr: String(e) };
        if (opts.noThrow) {
            return { code: e.code ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message ?? e) };
        }
        throw new Error(`${cmd} ${args.join(" ")} failed (${e.code ?? e.signal ?? e}): ${String(e.stderr ?? e.message ?? "").slice(0, 4000)}`);
    }
}

// PATH is fixed for the process lifetime — memoize lookups so repeat
// callers (qdbus wrappers, doctor checks) don't respawn `which` each time.
const whichCache = new Map<string, Promise<string | null>>();

/** First-found binary on PATH (via `command -v` semantics without a shell). */
export function which(name: string): Promise<string | null> {
    let p = whichCache.get(name);
    if (!p) {
        p = run("which", [name], { noThrow: true })
            .then((r) => (r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null));
        whichCache.set(name, p);
    }
    return p;
}

/** Spawn a long-running child (daemon helper, viewer, virtiofsd…). */
export function spawnChild(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean; stdio?: "ignore" | "inherit" | "pipe"; logFile?: string } = {},
): ChildProcess {
    // logFile: child's stdout+stderr append to the given path (viewer/debug
    // output we'd otherwise lose with stdio:"ignore").
    const stdio: import("node:child_process").StdioOptions = opts.logFile
        ? ["ignore", openSync(opts.logFile, "a"), openSync(opts.logFile, "a")]
        : (opts.stdio ?? "ignore");
    const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        detached: opts.detached ?? false,
        stdio,
    });
    return child;
}

/** virtiofsd ships off-PATH on Debian/Ubuntu (/usr/libexec, /usr/lib/qemu). */
export async function virtiofsdPath(): Promise<string | null> {
    const onPath = await which("virtiofsd");
    if (onPath) return onPath;
    const candidates = ["/usr/libexec/virtiofsd", "/usr/lib/qemu/virtiofsd", "/usr/lib/virtiofsd/virtiofsd"];
    for (let i = 0; i < candidates.length; i++) {
        const p = candidates[i]!;
        if (await canAccess(p, 1 /* X_OK */)) return p;
    }
    return null;
}

/** Parse "X.Y.Z" out of a version string; returns [major,minor,patch]. */
export function parseVersion(s: string): [number, number, number] | null {
    const m = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export function versionGte(found: [number, number, number], floor: [number, number, number]): boolean {
    for (let i = 0; i < 3; i++) {
        if (found[i] !== floor[i]) return found[i] > floor[i];
    }
    return true;
}

/** Check rw access to a path. */
export async function canAccess(p: string, mode: number): Promise<boolean> {
    try {
        const { access } = await import("node:fs/promises");
        await access(p, mode);
        return true;
    } catch {
        return false;
    }
}
