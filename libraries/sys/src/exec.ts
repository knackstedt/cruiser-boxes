// ============================================================================
// exec.ts — shared process helpers. node:child_process so it runs under
// bun AND node hosts (engine house rule: no runtime-only APIs in library code).
// ============================================================================

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Run a command to completion; throws on nonzero exit unless `noThrow`. */
export async function run(
    cmd: string,
    args: string[] = [],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; noThrow?: boolean } = {},
): Promise<ExecResult> {
    try {
        const { stdout, stderr } = await execFileP(cmd, args, {
            cwd: opts.cwd,
            env: opts.env ? { ...process.env, ...opts.env } : undefined,
            timeout: opts.timeoutMs ?? 120_000,
            maxBuffer: 64 * 1024 * 1024,
        });
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
    const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        detached: opts.detached ?? false,
        stdio: opts.stdio ?? "ignore",
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
