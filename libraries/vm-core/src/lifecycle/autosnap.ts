// ============================================================================
// autosnap.ts — the auto-snapshot policy driven by spec.snapshots
// {auto, trigger, keep}.
//
// All snapshots here are OFFLINE qemu-img internal snapshots — the disk
// must be idle, so the only lifecycle edges are "start" (before QEMU
// launches) and "stop" (after a graceful shutdown). Unclean exits — kill,
// QEMU crash, host power loss — never snapshot: the disk isn't in a state
// qemu-img can touch safely, and the process that would do it may be gone.
//
// Space policy: an internal snapshot pins every cluster it references —
// worst case the qcow2 grows by up to its current actualSize while the
// snap is held. Before creating one we require that headroom; when it's
// missing the oldest auto-* snapshots are sacrificed until there's room.
// Still short → a shortfall report for the caller (UI prompt / CLI warn).
// ============================================================================

import { dirname } from "node:path";

import type { VmHandle } from "./vm";
import { freeSpaceBytes, type SnapshotInfo } from "../disk/ops";

/** Auto snapshots are name-prefix tagged so rotation never touches manual
 *  snap-* snapshots. */
export const AUTO_SNAP_PREFIX = "auto-";

const PERIOD_MS = {
    daily: 86_400_000,
    weekly: 7 * 86_400_000,
    monthly: 30 * 86_400_000,
} as const;

export type AutoSnapFreq = keyof typeof PERIOD_MS;
export type AutoSnapTrigger = "start" | "stop";

export interface AutoSnapResult {
    /** name of the snapshot just taken. */
    created?: string;
    /** auto-* names deleted by the keep-N rotation after creating. */
    pruned: string[];
    /** auto-* names deleted to free disk space before creating. */
    freed: string[];
    skipped?: "off" | "trigger" | "fresh";
    /** set when freeing auto snapshots still left free < need — the
     *  snapshot was NOT taken; the caller decides whether to proceed.
     *  `remaining` lists the snapshots still on disk (the auto-* rotation
     *  is already empty at this point, so these are manual ones) for a
     *  "delete these to make room" prompt. */
    shortfall?: { needBytes: number; freeBytes: number; remaining: string[] };
}

/** diskInfo's date is ISO already; older json or hand-built entries may
 *  carry the "YYYY-MM-DD HH:MM:SS" gmt form — parse both as UTC. */
function snapMs(s: SnapshotInfo): number {
    const ms = Date.parse(s.date.includes("T") ? s.date : `${s.date.replace(" ", "T")}Z`);
    return Number.isFinite(ms) ? ms : 0;
}

/** Auto-managed snapshots oldest → newest. */
export function autoSnaps(snaps: SnapshotInfo[]): SnapshotInfo[] {
    return snaps
        .filter((s) => s.name.startsWith(AUTO_SNAP_PREFIX))
        .sort((a, b) => snapMs(a) - snapMs(b));
}

/** Is a fresh auto snapshot due — none yet, or the newest is older than
 *  the configured cadence. */
export function autoSnapshotDue(snaps: SnapshotInfo[], freq: AutoSnapFreq, now = Date.now()): boolean {
    const autos = autoSnaps(snaps);
    if (!autos.length) return true;
    return now - snapMs(autos[autos.length - 1]!) >= PERIOD_MS[freq];
}

/** Names to delete so only the `keep` newest auto-* remain. */
export function autoPruneList(snaps: SnapshotInfo[], keep: number): string[] {
    const autos = autoSnaps(snaps);
    return autos.slice(0, Math.max(0, autos.length - keep)).map((s) => s.name);
}

/**
 * Take an auto snapshot if the spec wants one on this trigger and the
 * cadence has elapsed. Deletes the oldest auto-* snapshots first when
 * free space can't cover worst-case growth (and again afterwards to hold
 * the keep-N rotation). Never touches manual snapshots.
 *
 * Caller guarantees the VM is stopped (h.snapshot throws otherwise).
 */
export async function runAutoSnapshot(h: VmHandle, trigger: AutoSnapTrigger, now = Date.now()): Promise<AutoSnapResult> {
    const cfg = h.spec.snapshots;
    const empty = { pruned: [], freed: [] };
    if (cfg.auto === "off") return { ...empty, skipped: "off" };
    if (cfg.trigger !== "both" && cfg.trigger !== trigger) return { ...empty, skipped: "trigger" };

    const info = await h.diskInfo();
    if (!autoSnapshotDue(info.snapshots, cfg.auto, now)) return { ...empty, skipped: "fresh" };

    // Headroom for the worst case: the file doubling while a snapshot pins
    // the current clusters. df failure (<0) = unknown → don't block on it.
    const disk = h.diskPath();
    const need = Math.min(info.actualSize, info.virtualSize);
    const freed: string[] = [];
    const autos = autoSnaps(info.snapshots);
    let free = await freeSpaceBytes(dirname(disk));
    while (free >= 0 && free < need && autos.length) {
        const oldest = autos.shift()!;
        await h.deleteSnapshot(oldest.name);
        freed.push(oldest.name);
        free = await freeSpaceBytes(dirname(disk));
    }
    if (free >= 0 && free < need) {
        const remaining = info.snapshots.map((s) => s.name).filter((n) => !freed.includes(n));
        return { pruned: [], freed, shortfall: { needBytes: need, freeBytes: free, remaining } };
    }

    const created = `${AUTO_SNAP_PREFIX}${new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    await h.snapshot(created);

    const pruned = autoPruneList([...autos, {
        id: "", name: created, vmSizeBytes: 0, date: new Date(now).toISOString(), vmClock: "",
    }], cfg.keep);
    for (let i = 0; i < pruned.length; i++) await h.deleteSnapshot(pruned[i]!);
    return { created, freed, pruned };
}
