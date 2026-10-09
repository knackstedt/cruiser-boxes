// ============================================================================
// metrics.ts — per-VM runtime stats for the list sparklines + disk line.
//
//   - hostDiskBytes: real size of the disk image on the host fs (stat)
//   - guest disk/cpu/mem: via QGA (guest-get-fsinfo, /proc/stat, /proc/meminfo)
//   - fallback when the agent isn't up: QEMU process /proc/<pid> ticks + RSS
//     expressed as a fraction of the VM's vCPU/RAM budget
//
// Keeps a rolling history per VM; cleared when the VM isn't running.
// ============================================================================

import { readFile, stat } from "node:fs/promises";
import type { VmHandle, VmState } from "../../vm-core/src/lifecycle/vm";

export interface VmMetrics {
    hostDiskBytes?: number;      // disk image file size on the host fs
    guestUsedBytes?: number;     // guest fs used (QGA; root mount or sum)
    guestTotalBytes?: number;    // guest fs total (≈ the disk cap)
    cpu: number[];               // 0–100 samples, newest last
    mem: number[];
}

const HIST_LEN = 40;
const CLK_TCK = 100;             // Linux USER_HZ — /proc tick rate

interface Hist { cpu: number[]; mem: number[] }
interface Prev { cpuTotal: number; cpuIdle: number; procTicks: number; at: number }

export class VmMetricsSampler {
    private hist = new Map<string, Hist>();
    private prev = new Map<string, Prev>();

    async sample(h: VmHandle, state: VmState): Promise<VmMetrics> {
        const name = h.spec.name;
        const m: VmMetrics = { cpu: [], mem: [] };
        const st = await stat(h.diskPath()).catch(() => null);
        if (st) m.hostDiskBytes = st.size;
        if (state !== "running") {
            this.hist.delete(name);
            this.prev.delete(name);
            return m;
        }
        const hh = this.hist.get(name) ?? { cpu: [], mem: [] };
        this.hist.set(name, hh);
        const pv = this.prev.get(name) ?? { cpuTotal: 0, cpuIdle: 0, procTicks: 0, at: 0 };
        this.prev.set(name, pv);
        const now = Date.now();

        let cpuPct: number | null = null;
        let memPct: number | null = null;
        const guest = await h.withQga(async (qga) => Promise.all([
            qga.readFile("/proc/stat", 256 * 1024, 4_000).catch(() => null),
            qga.readFile("/proc/meminfo", 64 * 1024, 4_000).catch(() => null),
            qga.getFsInfo(4_000).catch(() => null),
        ]), 2_500).catch(() => null);
        if (guest) {
            const [ps, mi, fs] = guest;
            const ct = ps ? parseProcStat(ps.toString("utf-8")) : null;
            if (ct && pv.at) {
                const dt = ct.total - pv.cpuTotal, di = ct.idle - pv.cpuIdle;
                if (dt > 0) cpuPct = Math.max(0, Math.min(100, (1 - di / dt) * 100));
            }
            if (ct) { pv.cpuTotal = ct.total; pv.cpuIdle = ct.idle; }
            if (mi) {
                const mt = meminfoKb(mi.toString("utf-8"), "MemTotal");
                const ma = meminfoKb(mi.toString("utf-8"), "MemAvailable");
                if (mt > 0 && mi.includes("MemAvailable:"))
                    memPct = Math.max(0, Math.min(100, (1 - ma / mt) * 100));
            }
            const u = fs ? fsUsage(fs) : null;
            if (u) { m.guestUsedBytes = u.used; m.guestTotalBytes = u.total; }
        }

        // Host-side fallback: QEMU process ticks / RSS against the vCPU+RAM budget.
        if (cpuPct === null || memPct === null) {
            const pid = h.pid();
            if (pid) {
                const [pstat, pstatus] = await Promise.all([
                    readFile(`/proc/${pid}/stat`, "utf-8").catch(() => ""),
                    readFile(`/proc/${pid}/status`, "utf-8").catch(() => ""),
                ]);
                const t = pstat ? procTicks(pstat) : null;
                if (cpuPct === null && t !== null && pv.at && t > pv.procTicks) {
                    const wall = (now - pv.at) / 1000;
                    const frac = (t - pv.procTicks) / (CLK_TCK * wall) / Math.max(1, h.spec.resources.cpus);
                    cpuPct = Math.max(0, Math.min(100, frac * 100));
                }
                if (t !== null) pv.procTicks = t;
                if (memPct === null) {
                    const rss = Number(pstatus.match(/^VmRSS:\s*(\d+)\s*kB/m)?.[1]);
                    const budget = h.spec.resources.memoryMiB * 1024;
                    if (rss > 0 && budget > 0) memPct = Math.min(100, (rss / budget) * 100);
                }
            }
        }
        pv.at = now;

        if (cpuPct !== null) pushCapped(hh.cpu, cpuPct);
        if (memPct !== null) pushCapped(hh.mem, memPct);
        m.cpu = hh.cpu;
        m.mem = hh.mem;
        return m;
    }

    drop(name: string): void {
        this.hist.delete(name);
        this.prev.delete(name);
    }
}

function pushCapped(a: number[], v: number): void {
    a.push(v);
    if (a.length > HIST_LEN) a.splice(0, a.length - HIST_LEN);
}

/** Aggregate "cpu" line of guest /proc/stat → total + idle jiffies. */
function parseProcStat(txt: string): { total: number; idle: number } | null {
    const f = (txt.split("\n", 1)[0] ?? "").trim().split(/\s+/);
    if (f[0] !== "cpu" || f.length < 5) return null;
    const n = f.slice(1, 9).map(Number);       // user..steal (guest* already folded in)
    if (n.some((x) => !Number.isFinite(x))) return null;
    return { total: n.reduce((a, b) => a + b, 0), idle: (n[3] ?? 0) + (n[4] ?? 0) };
}

function meminfoKb(txt: string, key: string): number {
    return Number(txt.match(new RegExp(`^${key}:\\s*(\\d+)\\s*kB`, "m"))?.[1]) || 0;
}

/** /proc/<pid>/stat utime+stime — comm may contain spaces, split after ')'. */
function procTicks(txt: string): number | null {
    const rest = txt.slice(txt.lastIndexOf(")") + 2).trim().split(/\s+/);
    const utime = Number(rest[11]), stime = Number(rest[12]);
    return Number.isFinite(utime) && Number.isFinite(stime) ? utime + stime : null;
}

/** guest-get-fsinfo → used/total bytes. Prefers the root mount. */
function fsUsage(fsinfo: any[]): { used: number; total: number } | null {
    if (!Array.isArray(fsinfo)) return null;
    const sums = (fs: any) => {
        let used = Number(fs["used-bytes"]) || 0;
        let total = Number(fs["total-bytes"]) || 0;
        if (!total) {
            (fs.disk ?? []).forEach((d: any) => {
                used += Number(d["used-bytes"]) || 0;
                total += Number(d["total-bytes"]) || 0;
            });
        }
        return { used, total };
    };
    const root = fsinfo.find((f) => f && f.mountpoint === "/");
    if (root) { const u = sums(root); return u.total ? u : null; }
    let used = 0, total = 0;
    fsinfo.forEach((f) => { const u = sums(f ?? {}); used += u.used; total += u.total; });
    return total ? { used, total } : null;
}
