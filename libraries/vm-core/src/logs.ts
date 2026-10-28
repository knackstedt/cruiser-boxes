// ============================================================================
// logs.ts — VM log sources.
//
// Runner side: host files under <vm>/run/ —
//   cruiser.log           lifecycle + provision journal (appendVmLog,
//                         capped at 256 KiB then head-trimmed to 192 KiB)
//   qemu.log              QEMU -D diagnostics (QEMU truncates each launch)
//   serial.log            guest serial console (attached on every boot;
//                         QEMU truncates each launch — a marathon boot with
//                         a chatty console can still grow unbounded)
//   install-serial.log    ISO autoinstall boot console
//   *.log                 any other run/ log (viewer-dd, freerdp, swtpm,
//                         urlopen, virtiofsd-<tag>) — picked up when present
//
// Guest side: systemd journal read live. Transport is QGA guest-exec
// normally; when the agent is SELinux-confined (Fedora's virt_qemu_ga_t
// can't read the journal) or a provisioned guest is mid-boot, ssh+sudo over
// the hostfwd port is the fallback (cruiser key + NOPASSWD from the seed).
// ============================================================================

import { readdirSync, statSync } from "node:fs";
import { appendFile, mkdir, open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VmHandle } from "./lifecycle/vm";
import type { VmPaths } from "./paths";
import { run, sq } from "../../sys/src/exec";
import { sshArgv } from "./ssh";

// ── runner logs (host files) ──

export interface RunnerLogFile {
    id: string;             // "cruiser" | "qemu" | "serial" | "install-serial" | basename of any extra run/*.log
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
    // Any other *.log in run/ — viewer-dd.log, freerdp.log, swtpm.log,
    // urlopen.log, virtiofsd-<tag>.log — listed only once the file exists.
    const labels: Record<string, string> = {
        "viewer-dd": "viewer (dmabuf)", freerdp: "viewer (rdp)",
    };
    let extra: string[] = [];
    try {
        extra = readdirSync(paths.run)
            .filter((f) => f.endsWith(".log") && !defs.some((d) => d.path === join(paths.run, f)))
            .sort();
    } catch { /* run/ may not exist yet */ }
    defs.push(...extra.map((f) => {
        const id = f.slice(0, -".log".length);
        return { id, name: labels[id] ?? id, path: join(paths.run, f) };
    }));
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

// cruiser.log is the only run/ file cruiser appends to — QEMU truncates
// -serial file: and -D outputs at every launch, so those are bounded per
// boot. The lifecycle journal must not grow forever either: once it passes
// the cap the oldest bytes are dropped, keeping the newest LOG_KEEP_BYTES.
const LOG_CAP_BYTES = 256 * 1024;
const LOG_KEEP_BYTES = 192 * 1024;

/** Append a timestamped line to <vm>/run/cruiser.log — the runner's own
 *  journal. Best-effort: logging must never break a lifecycle op. */
export async function appendVmLog(paths: VmPaths, msg: string): Promise<void> {
    try {
        await mkdir(paths.run, { recursive: true });
        const file = join(paths.run, "cruiser.log");
        await appendFile(file, `${new Date().toISOString()} ${msg}\n`);
        const { size } = await stat(file);
        if (size <= LOG_CAP_BYTES) return;
        const fh = await open(file, "r");
        const buf = Buffer.alloc(LOG_KEEP_BYTES);
        try {
            await fh.read(buf, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES);
        } finally {
            await fh.close();
        }
        // drop the partial first line so the trimmed log starts mid-stream
        const nl = buf.indexOf(0x0a);
        const tail = nl >= 0 ? buf.subarray(nl + 1) : buf;
        await writeFile(file, Buffer.concat([Buffer.from("… older log trimmed …\n"), tail]));
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

interface GuestRunResult { code: number; stdout: string; stderr: string }

/** Run argv in the guest over ssh (sudo -n). Requires the cruiser key
 *  authorized + NOPASSWD sudo — true for seeded/provisioned VMs. */
async function sshGuestExec(h: VmHandle, argv: string[], timeoutMs: number): Promise<GuestRunResult> {
    const a = await sshArgv(h.spec, { remoteCmd: [`sudo -n ${argv.map(sq).join(" ")}`] })
        .catch(() => { throw new Error("no SSH hostfwd mapped — can't reach the guest journal"); });
    const r = await run("ssh", a, { noThrow: true, timeoutMs });
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
    if (h.spec.os.family === "windows")
        throw new Error("no systemd journal in a windows guest — the Logs screen shows run/ files (serial.log captures EMS output)");
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
    if (h.spec.os.family === "windows") return { units: [], transport: "qga" };
    const r = await guestRun(h, journalUnitsArgs(), timeoutMs);
    if (r.code !== 0) throw new Error(`journalctl -F exited ${r.code}: ${(r.stderr || r.stdout).slice(-400)}`);
    const units = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).sort();
    return { units, transport: r.transport };
}
