// ============================================================================
// metrics.ts — per-VM runtime stats for the list sparklines + disk line.
//
//   - hostDiskBytes: real size of the disk image on the host fs (stat)
//   - guest disk/cpu/mem: via QGA (guest-get-fsinfo, /proc/stat, /proc/meminfo)
//   - net bytes/s: QGA /proc/net/dev
//   - disk iops: QMP query-blockstats — works without the guest agent
//   - gpu util/mem: host-side /proc/<qemu>/fdinfo DRM client stats
//     (drm-engine-* busy ns, drm-total-*/drm-memory-* region bytes)
//   - fallback when the agent isn't up: QEMU process /proc/<pid> ticks + RSS
//     expressed as a fraction of the VM's vCPU/RAM budget
//
// Keeps a rolling history per VM; cleared when the VM isn't running.
// ============================================================================

import { readFile, readlink, readdir, stat } from "node:fs/promises";
import type { VmHandle, VmState } from "../../vm-core/src/lifecycle/vm";

export interface VmMetrics {
    hostDiskBytes?: number;      // disk image file size on the host fs
    guestUsedBytes?: number;     // guest fs used (QGA; root mount or sum)
    guestTotalBytes?: number;    // guest fs total (≈ the disk cap)
    cpu: number[];               // 0–100 samples, newest last
    mem: number[];
    disk: number[];              // io ops/s (rd+wr across all block devices)
    net: number[];               // bytes/s (rx+tx across non-lo ifaces)
    gpu: number[];               // engine busy %, 0–100
    gpuMemBytes?: number;        // latest DRM client memory total
}

const HIST_LEN = 40;
const CLK_TCK = 100;             // Linux USER_HZ — /proc tick rate

interface Hist { cpu: number[]; mem: number[]; disk: number[]; net: number[]; gpu: number[] }
interface Prev {
    cpuTotal: number; cpuIdle: number; procTicks: number;
    blkOps: number; netBytes: number; gpuNs: number; at: number;
}

export class VmMetricsSampler {
    private hist = new Map<string, Hist>();
    private prev = new Map<string, Prev>();
    /** consecutive samples where QGA didn't answer — the agent can appear
     *  at any time (still installing, confined→fixed, late boot), so the
     *  retry never stops entirely, it just gets rare. */
    private qgaMiss = new Map<string, number>();

    async sample(h: VmHandle, state: VmState): Promise<VmMetrics> {
        const name = h.spec.name;
        const m: VmMetrics = { cpu: [], mem: [], disk: [], net: [], gpu: [] };
        const st = await stat(h.diskPath()).catch(() => null);
        if (st) m.hostDiskBytes = st.size;
        if (state !== "running") {
            this.hist.delete(name);
            this.prev.delete(name);
            this.qgaMiss.delete(name);
            return m;
        }
        const hh = this.hist.get(name) ?? { cpu: [], mem: [], disk: [], net: [], gpu: [] };
        this.hist.set(name, hh);
        const pv = this.prev.get(name) ?? { cpuTotal: 0, cpuIdle: 0, procTicks: 0, blkOps: 0, netBytes: 0, gpuNs: 0, at: 0 };
        this.prev.set(name, pv);
        const now = Date.now();
        const wall = pv.at ? (now - pv.at) / 1000 : 0;
        const pid = h.pid();

        // A guest with no agent burns the whole ~2.5s QGA timeout on every
        // 3s tick. After 3 misses back off to ~1 retry/minute (miss counts
        // samples since the last answer — cheap bookkeeping, no timer).
        const miss = (this.qgaMiss.get(name) ?? 0) + 1;
        this.qgaMiss.set(name, miss);
        const wantQga = miss <= 3 || miss % 20 === 0;

        const [guest, blkOps, drm] = await Promise.all([
            wantQga
                ? h.withQga(async (qga) => Promise.all([
                    qga.readFile("/proc/stat", 256 * 1024, 4_000).catch(() => null),
                    qga.readFile("/proc/meminfo", 64 * 1024, 4_000).catch(() => null),
                    qga.readFile("/proc/net/dev", 64 * 1024, 4_000).catch(() => null),
                    qga.getFsInfo(4_000).catch(() => null),
                ]), 2_500).catch(() => null)
                : Promise.resolve(null),
            h.withQmp((q) => q.execute("query-blockstats"), 2_500).catch(() => null),
            pid ? drmGpu(pid) : Promise.resolve(null),
        ]);
        if (guest) this.qgaMiss.delete(name);

        let cpuPct: number | null = null;
        let memPct: number | null = null;
        if (guest) {
            const [ps, mi, nd, fs] = guest;
            const ct = ps ? parseProcStat(ps.toString("utf-8")) : null;
            if (ct && wall) {
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
            if (nd) {
                const nb = parseNetDev(nd.toString("utf-8"));
                if (wall && pv.netBytes) pushCapped(hh.net, Math.max(0, (nb - pv.netBytes) / wall));
                pv.netBytes = nb;
            }
            const u = fs ? fsUsage(fs) : null;
            if (u) { m.guestUsedBytes = u.used; m.guestTotalBytes = u.total; }
        }
        if (blkOps !== null) {
            const ops = blockOps(blkOps);
            if (ops !== null) {
                if (wall && pv.blkOps) pushCapped(hh.disk, Math.max(0, (ops - pv.blkOps) / wall));
                pv.blkOps = ops;
            }
        }
        if (drm) {
            if (wall && pv.gpuNs) {
                const pct = ((drm.engineNs - pv.gpuNs) / (wall * 1e9)) * 100;
                pushCapped(hh.gpu, Math.max(0, Math.min(100, pct)));
            }
            pv.gpuNs = drm.engineNs;
            m.gpuMemBytes = drm.memBytes;
        }

        // Host-side fallback: QEMU process ticks / RSS against the vCPU+RAM budget.
        if ((cpuPct === null || memPct === null) && pid) {
            const [pstat, pstatus] = await Promise.all([
                readFile(`/proc/${pid}/stat`, "utf-8").catch(() => ""),
                readFile(`/proc/${pid}/status`, "utf-8").catch(() => ""),
            ]);
            const t = pstat ? procTicks(pstat) : null;
            if (cpuPct === null && t !== null && wall && t > pv.procTicks) {
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
        pv.at = now;

        if (cpuPct !== null) pushCapped(hh.cpu, cpuPct);
        if (memPct !== null) pushCapped(hh.mem, memPct);
        m.cpu = hh.cpu;
        m.mem = hh.mem;
        m.disk = hh.disk;
        m.net = hh.net;
        m.gpu = hh.gpu;
        return m;
    }

    drop(name: string): void {
        this.hist.delete(name);
        this.prev.delete(name);
        this.qgaMiss.delete(name);
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

/** Guest /proc/net/dev → rx+tx bytes across all non-lo interfaces. */
function parseNetDev(txt: string): number {
    let bytes = 0;
    for (const line of txt.split("\n")) {
        const c = line.indexOf(":");
        if (c < 0 || line.slice(0, c).trim() === "lo") continue;
        const f = line.slice(c + 1).trim().split(/\s+/);
        bytes += (Number(f[0]) || 0) + (Number(f[8]) || 0);   // rx bytes + tx bytes
    }
    return bytes;
}

/** QMP query-blockstats → summed guest rd+wr ops across all devices. */
function blockOps(bs: any): number | null {
    if (!Array.isArray(bs)) return null;
    let ops = 0;
    bs.forEach((d) => {
        const st = d?.stats;
        if (st) ops += (Number(st.rd_operations) || 0) + (Number(st.wr_operations) || 0);
    });
    return ops;
}

const SIZE_MUL: Record<string, number> = { B: 1, KiB: 1024, kB: 1024, MiB: 2 ** 20, GiB: 2 ** 30 };

/** DRM client memory from one fdinfo: drm-total-* preferred (per-region
 *  sums), drm-memory-* is the older per-heap equivalent. */
function drmMemBytes(txt: string): number {
    const sum = (re: RegExp): number => {
        let b = 0;
        for (const m of txt.matchAll(re)) b += Number(m[1]) * (SIZE_MUL[m[2] ?? "KiB"] ?? 1024);
        return b;
    };
    return sum(/^drm-total-\S+:\s*(\d+)\s*(\w+)?/gm) || sum(/^drm-memory-\S+:\s*(\d+)\s*(\w+)?/gm);
}

/** Host-side GPU usage of the QEMU process — scans /proc/<pid>/fd for
 *  /dev/dri handles and reads their fdinfo drm-engine + drm-memory
 *  counters. Null when QEMU holds no DRM fds (software mode, no rendernode). */
async function drmGpu(pid: number): Promise<{ engineNs: number; memBytes: number } | null> {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
    let engineNs = 0, memBytes = 0, found = false;
    await Promise.all(fds.map(async (fd) => {
        const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
        if (!link.startsWith("/dev/dri/")) return;
        const txt = await readFile(`/proc/${pid}/fdinfo/${fd}`, "utf-8").catch(() => "");
        if (!txt.includes("drm-")) return;
        found = true;
        for (const m of txt.matchAll(/^drm-engine-\S+:\s*(\d+)\s*ns/gm)) engineNs += Number(m[1]);
        memBytes += drmMemBytes(txt);
    }));
    return found ? { engineNs, memBytes } : null;
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
