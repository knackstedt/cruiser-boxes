// ============================================================================
// logs.ts — VM log sources.
//
// Runner side: host files under <vm>/run/ —
//   cruiser.log           lifecycle + provision journal (appendVmLog)
//   qemu.log              QEMU -D diagnostics
//   serial.log            guest serial console (attached on every boot)
//   install-serial.log    ISO autoinstall boot console
//
// Guest side: systemd journal read live. Transport is QGA guest-exec
// normally; when the agent is SELinux-confined (Fedora's virt_qemu_ga_t
// can't read the journal) or a provisioned guest is mid-boot, ssh+sudo over
// the hostfwd port is the fallback (cruiser key + NOPASSWD from the seed).
// ============================================================================

import { statSync } from "node:fs";
import { appendFile, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { VmHandle } from "./lifecycle/vm";
import type { VmPaths } from "./paths";
import { run } from "../../sys/src/exec";
import { ensureKeypair } from "./sshkey";

// ── runner logs (host files) ──

export interface RunnerLogFile {
    id: string;             // "cruiser" | "qemu" | "serial" | "install-serial"
    name: string;           // display label
    path: string;
    exists: boolean;
    sizeBytes: number;
}

export function runnerLogFiles(paths: VmPaths): RunnerLogFile[] {
    const defs: { id: string; name: string; path: string }[] = [
        { id: "cruiser", name: "cruiser (lifecycle)", path: join(paths.run, "cruiser.log") },
        { id: "qemu", name: "qemu diagnostics", path: paths.log },
        { id: "serial", name: "serial console", path: paths.serialLog },
        { id: "install-serial", name: "install serial", path: join(paths.run, "install-serial.log") },
    ];
    return defs.map((d) => {
        let sizeBytes = 0, exists = false;
        try { sizeBytes = statSync(d.path).size; exists = true; } catch { /* not created yet */ }
        return { ...d, exists, sizeBytes };
    });
}

/** Last `lines` lines of a file, reading at most `maxBytes` from the tail. */
export async function tailFile(path: string, lines = 300, maxBytes = 512 * 1024): Promise<string> {
    const fh = await open(path, "r");
    try {
        const { size } = await fh.stat();
        const start = Math.max(0, size - maxBytes);
        const buf = Buffer.alloc(size - start);
        await fh.read(buf, 0, buf.length, start);
        const parts = buf.toString("utf-8").split("\n");
        if (parts[parts.length - 1] === "") parts.pop();
        // when we sliced mid-line the first fragment is partial — drop it
        if (start > 0) parts.shift();
        return parts.slice(-lines).join("\n");
    } finally {
        await fh.close();
    }
}

/** Append a timestamped line to <vm>/run/cruiser.log — the runner's own
 *  journal. Best-effort: logging must never break a lifecycle op. */
export async function appendVmLog(paths: VmPaths, msg: string): Promise<void> {
    try {
        await mkdir(paths.run, { recursive: true });
        await appendFile(join(paths.run, "cruiser.log"), `${new Date().toISOString()} ${msg}\n`);
    } catch { /* run/ may not exist yet (pre-create) — drop the line */ }
}

// ── guest journal ──

export interface JournalFilters {
    lines?: number;         // -n (clamped 1..5000, default 300)
    unit?: string;          // -u UNIT
    priority?: string;      // -p: emerg|alert|crit|err|warning|notice|info|debug
    boot?: number;          // -b N (0 current boot, -1 previous…; undefined = all)
    since?: string;         // --since "…" (journalctl timespec)
    grep?: string;          // -g PATTERN (regex)
}

const JOURNAL_PRIORITIES = new Set(["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"]);

/** journalctl argv implementing the filter set. */
export function journalArgs(f: JournalFilters = {}): string[] {
    const lines = Math.max(1, Math.min(5000, Math.trunc(f.lines ?? 300)));
    // absolute path — QGA guest-exec doesn't resolve PATH
    const a = ["/usr/bin/journalctl", "--no-pager", "-o", "short-iso", "-n", String(lines)];
    if (f.unit) a.push("-u", f.unit);
    if (f.priority && JOURNAL_PRIORITIES.has(f.priority)) a.push("-p", f.priority);
    if (f.boot !== undefined && Number.isFinite(f.boot)) a.push("-b", String(Math.trunc(f.boot)));
    if (f.since) a.push("--since", f.since);
    if (f.grep) a.push("-g", f.grep);
    return a;
}

/** Distinct units logged this boot — the unit filter's option list. */
export function journalUnitsArgs(): string[] {
    return ["/usr/bin/journalctl", "--no-pager", "-b", "-F", "_SYSTEMD_UNIT"];
}

/**
 * Is the guest-agent exec context confined? Fedora runs qemu-ga under
 * SELinux (virt_qemu_ga_t): uid 0 but no system privileges — journalctl
 * can't read the journal files. Returns the context string, or "" when
 * unconfined or the probe fails (caller should then just try QGA and let
 * the real error surface).
 */
export async function guestAgentContext(h: VmHandle, timeoutMs = 15_000): Promise<string> {
    const r = await h.guestSh("cat /proc/self/attr/current 2>/dev/null; id -u", timeoutMs)
        .catch(() => null);
    if (!r) return "";
    const out = String(r.stdout);
    const last = out.trim().split("\n").pop() ?? "";
    return out.includes("_ga_t:") || !last.startsWith("0") ? out : "";
}

/** POSIX single-quote escape for ssh-remote shell commands. */
const sq = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;

interface GuestRunResult { code: number; stdout: string; stderr: string }

/** Run argv in the guest over ssh (sudo -n). Requires the cruiser key
 *  authorized + NOPASSWD sudo — true for seeded/provisioned VMs. */
async function sshGuestExec(h: VmHandle, argv: string[], timeoutMs: number): Promise<GuestRunResult> {
    const port = h.spec.network.sshPort;
    if (!port) throw new Error("no SSH hostfwd mapped — can't reach the guest journal");
    const { priv } = await ensureKeypair();
    const r = await run("ssh", [
        "-i", priv, "-p", String(port),
        "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=10",
        `${h.spec.credentials.username}@127.0.0.1`,
        `sudo -n ${argv.map(sq).join(" ")}`,
    ], { noThrow: true, timeoutMs });
    if (r.code === 255)
        throw new Error(`ssh to guest failed — is the cruiser key authorized and sudo NOPASSWD?\n${r.stderr.slice(-600)}`);
    return r;
}

export type LogTransport = "qga" | "ssh";

/** Run argv in the guest, choosing QGA vs ssh+sudo; reports the transport
 *  actually used. */
export async function guestRun(
    h: VmHandle, argv: string[], timeoutMs = 45_000,
): Promise<GuestRunResult & { transport: LogTransport }> {
    const confined = await guestAgentContext(h);
    if (confined) return { ...(await sshGuestExec(h, argv, timeoutMs)), transport: "ssh" };
    try {
        const r = await h.guestExec(argv[0]!, argv.slice(1), timeoutMs);
        return { code: r.exitcode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), transport: "qga" };
    } catch (e) {
        // agent dead/mid-boot — ssh may still work on a provisioned guest
        try { return { ...(await sshGuestExec(h, argv, timeoutMs)), transport: "ssh" }; }
        catch { throw e; }
    }
}

export interface JournalResult {
    text: string;
    transport: LogTransport;
}

/** Read the guest's systemd journal with filters. Throws on hard failure. */
export async function guestJournal(h: VmHandle, f: JournalFilters = {}, timeoutMs = 45_000): Promise<JournalResult> {
    const argv = journalArgs(f);
    const r = await guestRun(h, argv, timeoutMs);
    if (r.code !== 0 && r.transport === "qga") {
        // exit-code failures QGA-side (confined mid-read, PATH oddity) get
        // one ssh retry before we give up.
        const s = await sshGuestExec(h, argv, timeoutMs).catch(() => null);
        if (s && s.code === 0) return { text: s.stdout, transport: "ssh" };
    }
    if (r.code !== 0)
        throw new Error(`journalctl exited ${r.code} via ${r.transport}: ${(r.stderr || r.stdout).slice(-800)}`);
    return { text: r.stdout, transport: r.transport };
}

/** Unit names logged in the current boot — for the unit filter picker. */
export async function guestJournalUnits(h: VmHandle, timeoutMs = 30_000): Promise<{ units: string[]; transport: LogTransport }> {
    const r = await guestRun(h, journalUnitsArgs(), timeoutMs);
    if (r.code !== 0) throw new Error(`journalctl -F exited ${r.code}: ${(r.stderr || r.stdout).slice(-400)}`);
    const units = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).sort();
    return { units, transport: r.transport };
}
