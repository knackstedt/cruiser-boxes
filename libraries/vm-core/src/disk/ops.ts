// ============================================================================
// disk.ts — qcow2 operations: create, info, internal snapshots, resize,
// full backups (offline convert + live blockdev-backup).
// ============================================================================

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { run } from "../../../sys/src/exec";
import { diskKeyPath } from "../paths";
import type { QmpClient } from "../qmp/client";
import type { QgaClient } from "../qga/client";

export interface SnapshotInfo { id: string; name: string; vmSizeBytes: number; date: string; vmClock: string }
export interface DiskInfo { filename: string; format: string; virtualSize: number; actualSize: number; snapshots: SnapshotInfo[] }

/** The -object secret id every LUKS consumer shares — qemu-img gets one
 *  object per invocation, QEMU's argv uses the same id for all of a VM's
 *  encrypted drives (one passphrase per VM). */
export const DISK_SECRET_ID = "diskkey";

/** The `--object secret` argv pair qemu-img needs before it can open a
 *  LUKS image (or write one with the key). */
export function imgSecretObject(keyFile: string): string[] {
    return ["--object", `secret,id=${DISK_SECRET_ID},file=${keyFile}`];
}

/** Image filename operand carrying the key-secret reference — the `json:`
 *  pseudo-filename form works everywhere qemu-img takes an image path. */
export function imgJsonTarget(path: string): string {
    return `json:${JSON.stringify({
        driver: "qcow2",
        file: { driver: "file", filename: path },
        "encrypt.key-secret": DISK_SECRET_ID,
    })}`;
}

/** Image operand for qemu-img: the plain path when unencrypted (or the key
 *  isn't needed/available — `info` reads headers fine without it), the
 *  secret object + json: target when it is. */
export function imgTarget(path: string, keyFile?: string): string[] {
    return keyFile ? [...imgSecretObject(keyFile), imgJsonTarget(path)] : [path];
}

/** Resolve the LUKS key file for an encrypted spec — throws a directed
 *  error when the passphrase hasn't been provided this session. Returns
 *  undefined for unencrypted specs. */
export function requireDiskKeyFile(
    spec: { name: string; disk: { encrypt: string; keyStorage: string } },
    paths: { dir: string; run: string },
): string | undefined {
    if (spec.disk.encrypt === "off") return undefined;
    const p = diskKeyPath(spec, paths);
    if (!p || !existsSync(p))
        throw new Error(`${spec.name}'s disk is LUKS-encrypted — provide the passphrase first (cli: --disk-password, ui: the unlock prompt)`);
    return p;
}

/** Persist the VM's LUKS passphrase next to the rdp password
 *  (secrets/disk-key, 0600). Used by create/import for keyStorage=store. */
export async function writeDiskKeyFile(vmDir: string, plain: string): Promise<string> {
    const p = join(vmDir, "secrets", "disk-key");
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, plain, { mode: 0o600 });
    return p;
}

export async function createDisk(qemuImg: string, path: string, sizeGiB: number, keyFile?: string): Promise<void> {
    await run(qemuImg, ["create", "-f", "qcow2",
        ...(keyFile ? [...imgSecretObject(keyFile), "-o", `encrypt.format=luks,encrypt.key-secret=${DISK_SECRET_ID}`] : []),
        path, `${sizeGiB}G`]);
}

/** qcow2 backing-file overlay — the cloudimg fast path. A LUKS overlay on
 *  a plaintext backing image is fine: the overlay's header carries the
 *  encryption, reads of untouched clusters pass through to the backing. */
export async function createOverlay(qemuImg: string, backing: string, backingFmt: string, path: string, sizeGiB: number, keyFile?: string): Promise<void> {
    await run(qemuImg, ["create", "-f", "qcow2", "-b", backing, "-F", backingFmt,
        ...(keyFile ? [...imgSecretObject(keyFile), "-o", `encrypt.format=luks,encrypt.key-secret=${DISK_SECRET_ID}`] : []),
        path, `${sizeGiB}G`]);
}

export async function diskInfo(qemuImg: string, path: string, keyFile?: string): Promise<DiskInfo> {
    // -U (force-share): reading info off a running VM's image is safe —
    // qemu-img would otherwise fail on the write lock QEMU holds.
    const r = await run(qemuImg, ["info", "-U", "--output=json", ...imgTarget(path, keyFile)]);
    const j = JSON.parse(r.stdout);
    return {
        filename: j.filename, format: j.format,
        virtualSize: j["virtual-size"], actualSize: j["actual-size"],
        snapshots: (j.snapshots ?? []).map((s: any) => ({
            id: s.id, name: s.name, vmSizeBytes: s["vm-state-size"],
            // qcow2 json reports date-sec/date-nsec + vm-clock-sec/nsec —
            // NOT the "date-gmt"/"vm-clock" columns of the human table.
            date: new Date((s["date-sec"] ?? 0) * 1000 + Math.round((s["date-nsec"] ?? 0) / 1e6)).toISOString(),
            vmClock: `${s["vm-clock-sec"] ?? 0}.${s["vm-clock-nsec"] ?? 0}`,
        })),
    };
}

/** Free bytes on the filesystem containing `path` (df -k). -1 when the
 *  probe fails — callers treat that as "unknown" rather than "empty". */
export async function freeSpaceBytes(path: string): Promise<number> {
    const r = await run("df", ["-k", path], { noThrow: true });
    const kb = Number(r.stdout.trim().split("\n").pop()?.trim().split(/\s+/)[3]);
    return Number.isFinite(kb) ? kb * 1024 : -1;
}

/**
 * Copy a disk image for a VM clone. A reflink (`cp --reflink=always`) is
 * instant on CoW filesystems; everything else falls back to `qemu-img
 * convert`. Internal qcow2 snapshots never survive the clone — convert
 * drops them outright, and a reflinked byte-copy gets them stripped.
 */
export async function cloneDisk(qemuImg: string, src: string, dst: string, format = "qcow2", keyFile?: string): Promise<void> {
    const cp = await run("cp", ["--reflink=always", src, dst], { noThrow: true, timeoutMs: 3_600_000 });
    if (cp.code !== 0) {
        // convert on a LUKS source needs the key to read; the clone is
        // re-keyed with the SAME passphrase (the new VM's secrets/ copy
        // unlocks it identically).
        await run(qemuImg, ["convert",
            ...(keyFile ? [...imgSecretObject(keyFile), "-o", `encrypt.format=luks,encrypt.key-secret=${DISK_SECRET_ID}`] : []),
            "-O", format,
            keyFile ? imgJsonTarget(src) : src, dst], { timeoutMs: 3_600_000 });
        return;
    }
    const snaps = await snapshotList(qemuImg, dst, keyFile);
    for (let i = 0; i < snaps.length; i++) await snapshotDelete(qemuImg, dst, snaps[i]!.name, keyFile);
}

// ── internal qcow2 snapshots (VM off, or via QMP when running) ──

export async function snapshotCreate(qemuImg: string, disk: string, name: string, keyFile?: string): Promise<void> {
    await run(qemuImg, ["snapshot", "-c", name, ...imgTarget(disk, keyFile)]);
}
export async function snapshotApply(qemuImg: string, disk: string, name: string, keyFile?: string): Promise<void> {
    await run(qemuImg, ["snapshot", "-a", name, ...imgTarget(disk, keyFile)]);
}
export async function snapshotDelete(qemuImg: string, disk: string, name: string, keyFile?: string): Promise<void> {
    await run(qemuImg, ["snapshot", "-d", name, ...imgTarget(disk, keyFile)]);
}
export async function snapshotList(qemuImg: string, disk: string, keyFile?: string): Promise<SnapshotInfo[]> {
    return (await diskInfo(qemuImg, disk, keyFile)).snapshots;
}

/** Wait for a QMP job (snapshot-save/load/delete, backup) to conclude.
 *  JOB_STATUS_CHANGE carries no error — the failure string lives in
 *  query-jobs; the job is dismissed either way. On timeout the job is
 *  cancelled and the call rejects. */
export async function waitJob(qmp: QmpClient, jobId: string, timeoutMs = 10 * 60_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        // Shared event/poll path: a concluded job reports its failure
        // string via query-jobs, then gets dismissed either way.
        const conclude = async () => {
            const jobs = await qmp.execute("query-jobs").catch(() => [] as any[]);
            const job = (jobs ?? []).find((j: any) => j?.id === jobId);
            if (!job) { finish(() => resolve()); return; }   // concluded + auto-dismissed, or never registered
            if (job.status !== "concluded") return;          // still running
            const err = job.error;
            await qmp.jobDismiss(jobId).catch(() => {});
            finish(() => err ? reject(new Error(String(err))) : resolve());
        };
        const onEv = (e: any) => {
            if (e.event !== "JOB_STATUS_CHANGE" || e.data?.id !== jobId
                || e.data?.status !== "concluded") return;
            void conclude();
        };
        const timer = setTimeout(() => {
            void (async () => {
                await qmp.execute("job-cancel", { id: jobId }).catch(() => {});
                await qmp.jobDismiss(jobId).catch(() => {});
                finish(() => reject(new Error("job timed out")));
            })();
        }, timeoutMs);
        function finish(fn: () => void) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            qmp.off("event", onEv);
            fn();
        }
        qmp.on("event", onEv);
        // The concluded event can fire between the job-creating command's
        // reply and listener registration — poll once so a fast job isn't
        // waited out to the timeout.
        void conclude();
    });
}

/** Sparse-rewrite a stopped VM's image in place: qemu-img convert drops
 *  the qcow2's accumulated dead clusters so the file shrinks to live
 *  data. LUKS sources convert back to LUKS with the same key (a
 *  plaintext output would defeat the encryption). The swap is
 *  rename-based so a failed convert leaves the original untouched.
 *  CAVEAT: like clone, convert drops internal snapshots — callers must
 *  refuse or confirm when snapshotList() is non-empty. */
export async function compactDisk(qemuImg: string, path: string, keyFile?: string): Promise<{ before: number; after: number }> {
    const before = (await diskInfo(qemuImg, path, keyFile)).actualSize;
    const tmp = `${path}.compact`;
    await run(qemuImg, ["convert",
        ...(keyFile ? [...imgSecretObject(keyFile), "-o", `encrypt.format=luks,encrypt.key-secret=${DISK_SECRET_ID}`] : []),
        "-O", "qcow2",
        keyFile ? imgJsonTarget(path) : path, tmp], { timeoutMs: 3_600_000 });
    // Reading the new image's headers (with the key for LUKS) is the
    // sanity gate before the original goes away.
    const after = (await diskInfo(qemuImg, tmp, keyFile)).actualSize;
    const { rename: mv, rm } = await import("node:fs/promises");
    await mv(path, `${path}.old`);
    try { await mv(tmp, path); }
    catch (e) { await mv(`${path}.old`, path).catch(() => {}); await rm(tmp, { force: true }).catch(() => {}); throw e; }
    await rm(`${path}.old`, { force: true });
    return { before, after };
}

// ── resize: grow only (shrink needs fs-first ordering — separate tool) ──

export async function resizeDisk(qemuImg: string, path: string, newSizeGiB: number, keyFile?: string): Promise<void> {
    const info = await diskInfo(qemuImg, path, keyFile);
    const cur = Math.ceil(info.virtualSize / (1 << 30));
    if (newSizeGiB <= cur) throw new Error(`refusing shrink: ${cur}G → ${newSizeGiB}G`);
    await run(qemuImg, ["resize", ...imgTarget(path, keyFile), `${newSizeGiB}G`]);
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

/** Offline full copy: qcow2 → file (raw or qcow2). A LUKS source needs the
 *  key to read, and the backup is written LUKS-encrypted with the same
 *  passphrase — a plaintext convert would silently leak the data. */
export async function backupOffline(qemuImg: string, disk: string, destPath: string, format: "qcow2" | "raw" = "qcow2", keyFile?: string): Promise<void> {
    await run(qemuImg, ["convert",
        ...(keyFile ? [...imgSecretObject(keyFile), "-o", `encrypt.format=luks,encrypt.key-secret=${DISK_SECRET_ID}`] : []),
        "-O", format,
        keyFile ? imgJsonTarget(disk) : disk, destPath], { timeoutMs: 3_600_000 });
}

/** Live backup via QMP blockdev-backup job; resolves when the job finishes.
 *  `encrypted` re-keys the target with the running QEMU's existing
 *  `diskkey` secret object (argv already carries it for LUKS drives). */
export async function backupLive(qmp: QmpClient, diskNode: string, destPath: string, encrypted = false): Promise<void> {
    // Need the source as a blockdev node-name; the drive attaches as "drive0"-ish —
    // caller resolves via query-block. Add target as a fresh node first.
    const stamp = Date.now();
    const targetNode = `backup-${stamp}`;
    const jobId = `backup-${stamp}`;
    let ok = false;
    try {
        await qmp.execute("blockdev-add", {
            // QAPI spells it "node-name" — a node_name key here just
            // errors "Parameter 'node_name' is unexpected".
            "node-name": targetNode,
            driver: "qcow2",
            file: { driver: "file", filename: destPath },
            ...(encrypted ? { encrypt: { format: "luks", "key-secret": DISK_SECRET_ID } } : {}),
        });
        await qmp.blockdevBackup(jobId, diskNode, targetNode, "full");
        await new Promise<void>((resolve, reject) => {
            const onEv = (e: any) => {
                if (e.event !== "JOB_STATUS_CHANGE" || e.data?.id !== jobId
                    || e.data?.status !== "concluded") return;
                void (async () => {
                    try {
                        // JOB_STATUS_CHANGE carries no error field — a failed
                        // job reports "concluded" the same as a clean one.
                        // The error string lives in query-jobs.
                        const jobs = await qmp.execute("query-jobs").catch(() => [] as any[]);
                        const err = (jobs ?? []).find((j: any) => j?.id === jobId)?.error;
                        await qmp.jobDismiss(jobId).catch(() => {});
                        finish(() => err ? reject(new Error(String(err))) : resolve());
                    } catch (x) {
                        finish(() => reject(x));
                    }
                })();
            };
            const timer = setTimeout(() => {
                // Unwind best-effort: cancel the job, wait for it to reach a
                // dismissable state so the target node can be dropped, then
                // reject. Nothing here may throw past finish().
                void (async () => {
                    await qmp.execute("job-cancel", { id: jobId }).catch(() => {});
                    const deadline = Date.now() + 15_000;
                    for (;;) {
                        const jobs = await qmp.execute("query-jobs").catch(() => [] as any[]);
                        const st = (jobs ?? []).find((j: any) => j?.id === jobId)?.status;
                        if (st !== "running" && st !== "aborting") break;
                        if (Date.now() > deadline) break;
                        await new Promise((r) => setTimeout(r, 500));
                    }
                    await qmp.jobDismiss(jobId).catch(() => {});
                    finish(() => reject(new Error("backup job timed out")));
                })();
            }, 30 * 60_000);
            function finish(fn: () => void) {
                clearTimeout(timer);
                qmp.off("event", onEv);
                fn();
            }
            qmp.on("event", onEv);
        });
        ok = true;
    } finally {
        // The target node keeps an open fd on the destination — drop it on
        // every path. A failed run also drops the partial backup file so it
        // can't masquerade as a valid backup.
        await qmp.execute("blockdev-del", { "node-name": targetNode }).catch(() => {});
        if (!ok) await rm(destPath, { force: true }).catch(() => {});
    }
}

/** Resolve the guest disk's QMP node-name for blockdev ops. */
export async function diskNodeName(qmp: QmpClient, diskPath: string): Promise<string> {
    const blocks = await qmp.execute("query-block");
    const basename = diskPath.split("/").pop()!;
    // file values: a plain path, or a `json:` pseudo-filename whose inner
    // file.filename is the real one (LUKS drives attach this way).
    const fileName = (f: unknown): string | null => {
        if (typeof f !== "string") return null;
        if (!f.startsWith("json:")) return f;
        try {
            const j = JSON.parse(f.slice(5));
            return typeof j?.file?.filename === "string" ? j.file.filename : null;
        } catch { return null; }
    };
    const suffixHits: string[] = [];
    for (let i = 0; i < (blocks ?? []).length; i++) {
        const ins = blocks[i]?.inserted;
        // QMP spells it "node-name" — a frontend-only drive (no blockdev
        // node) falls back to its device name, which backup ops accept.
        const node = ins?.["node-name"] ?? ins?.node_name ?? blocks[i]?.device;
        if (!node) continue;
        const f = fileName(ins?.file) ?? fileName(ins?.image?.filename);
        if (f === diskPath) return node;
        if (f?.endsWith(`/${basename}`)) suffixHits.push(node);
    }
    // Last resort only when unambiguous — two disks sharing a basename
    // (same filename in different dirs) must fail loud, not pick wrong.
    if (suffixHits.length === 1) return suffixHits[0]!;
    throw new Error(`disk ${diskPath} not found in query-block`);
}
