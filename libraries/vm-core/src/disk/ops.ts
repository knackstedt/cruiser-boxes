// ============================================================================
// disk.ts — qcow2 operations: create, info, internal snapshots, resize,
// full backups (offline convert + live blockdev-backup).
// ============================================================================

import { run } from "../../../sys/src/exec";
import type { QmpClient } from "../qmp/client";
import type { QgaClient } from "../qga/client";

export interface SnapshotInfo { id: string; name: string; vmSizeBytes: number; date: string; vmClock: string }
export interface DiskInfo { filename: string; format: string; virtualSize: number; actualSize: number; snapshots: SnapshotInfo[] }

export async function createDisk(qemuImg: string, path: string, sizeGiB: number): Promise<void> {
    await run(qemuImg, ["create", "-f", "qcow2", path, `${sizeGiB}G`]);
}

export async function diskInfo(qemuImg: string, path: string): Promise<DiskInfo> {
    const r = await run(qemuImg, ["info", "--output=json", path]);
    const j = JSON.parse(r.stdout);
    return {
        filename: j.filename, format: j.format,
        virtualSize: j["virtual-size"], actualSize: j["actual-size"],
        snapshots: (j.snapshots ?? []).map((s: any) => ({
            id: s.id, name: s.name, vmSizeBytes: s["vm-state-size"],
            date: s["date-gmt"], vmClock: s["vm-clock"],
        })),
    };
}

// ── internal qcow2 snapshots (VM off, or via QMP when running) ──

export async function snapshotCreate(qemuImg: string, disk: string, name: string): Promise<void> {
    await run(qemuImg, ["snapshot", "-c", name, disk]);
}
export async function snapshotApply(qemuImg: string, disk: string, name: string): Promise<void> {
    await run(qemuImg, ["snapshot", "-a", name, disk]);
}
export async function snapshotDelete(qemuImg: string, disk: string, name: string): Promise<void> {
    await run(qemuImg, ["snapshot", "-d", name, disk]);
}
export async function snapshotList(qemuImg: string, disk: string): Promise<SnapshotInfo[]> {
    return (await diskInfo(qemuImg, disk)).snapshots;
}

/** Live snapshot via QMP snapshot-save (QEMU ≥6). Needs a vmstate qcow2 target. */
export async function liveSnapshot(qmp: QmpClient, vmstateFile: string): Promise<void> {
    await qmp.snapshotSave(vmstateFile);
    // completion arrives as JOB_STATUS_CHANGE events; caller polls/waits
}

// ── resize: grow only (shrink needs fs-first ordering — separate tool) ──

export async function resizeDisk(qemuImg: string, path: string, newSizeGiB: number): Promise<void> {
    const info = await diskInfo(qemuImg, path);
    const cur = Math.ceil(info.virtualSize / (1 << 30));
    if (newSizeGiB <= cur) throw new Error(`refusing shrink: ${cur}G → ${newSizeGiB}G`);
    await run(qemuImg, ["resize", path, `${newSizeGiB}G`]);
}

/** After qemu-img resize, grow partition + fs inside the guest (QGA). */
export async function growGuest(qga: QgaClient, device = "/dev/vda"): Promise<string> {
    const lsblk = await qga.sh(`lsblk -pnro NAME,TYPE ${device} | awk '$2=="part"{print $1}' | tail -1`);
    const part = lsblk.stdout.toString().trim();
    if (!part) return "no partition found";
    const dev = part.replace(/p?\d+$/, "");
    const num = part.match(/\d+$/)?.[0];
    const grow = await qga.sh(`growpart ${dev} ${num} || true; (resize2fs ${part} || xfs_growfs ${part} || btrfs filesystem resize max / 2>/dev/null || true)`);
    return grow.stdout.toString() + grow.stderr.toString();
}

// ── backups ──

/** Offline full copy: qcow2 → file (raw or qcow2). */
export async function backupOffline(qemuImg: string, disk: string, destPath: string, format: "qcow2" | "raw" = "qcow2"): Promise<void> {
    await run(qemuImg, ["convert", "-O", format, disk, destPath], { timeoutMs: 3_600_000 });
}

/** Live backup via QMP blockdev-backup job; resolves when the job finishes. */
export async function backupLive(qmp: QmpClient, diskNode: string, destPath: string): Promise<void> {
    // Need the source as a blockdev node-name; the drive attaches as "drive0"-ish —
    // caller resolves via query-block. Add target as a fresh node first.
    const targetNode = `backup-${Date.now()}`;
    await qmp.execute("blockdev-add", {
        node_name: targetNode,
        driver: "qcow2",
        file: { driver: "file", filename: destPath },
    });
    const jobId = `backup-${Date.now()}`;
    await qmp.blockdevBackup(jobId, diskNode, targetNode, "full");
    await new Promise<void>((resolve, reject) => {
        const onEv = (e: any) => {
            if (e.event === "JOB_STATUS_CHANGE" && e.data?.id === jobId && e.data?.status === "concluded") {
                qmp.off("event", onEv);
                qmp.jobDismiss(jobId).then(() => resolve(), resolve);
            }
            if (e.event === "JOB_STATUS_CHANGE" && e.data?.id === jobId && e.data?.status === "null" && e.data?.error) {
                qmp.off("event", onEv);
                reject(new Error(String(e.data.error)));
            }
        };
        qmp.on("event", onEv);
        setTimeout(() => { qmp.off("event", onEv); reject(new Error("backup job timed out")); }, 30 * 60_000);
    });
}

/** Resolve the guest disk's QMP node-name for blockdev ops. */
export async function diskNodeName(qmp: QmpClient, diskPath: string): Promise<string> {
    const blocks = await qmp.execute("query-block");
    for (const b of blocks ?? []) {
        const f = b?.inserted?.file ?? b?.inserted?.image?.filename;
        if (typeof f === "string" && (f === diskPath || f.endsWith("/" + diskPath.split("/").pop()))) {
            return b?.inserted?.node_name ?? b?.device;
        }
    }
    throw new Error(`disk ${diskPath} not found in query-block`);
}
