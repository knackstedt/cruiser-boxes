// ============================================================================
// mount.ts — guest→host filesystem access via sshfs over the VM's forwarded
// SSH port. The interface is deliberately boring: one sshfs mount per (vm,
// guest path) at a predictable host mountpoint.
//
//   vm mount <vm> [guestPath] [mountpoint]
//   vm umount <vm> [mountpoint]
//
// Requires `sshfs` on the host (apt install sshfs). virtiofs covers the
// host→guest direction; this covers host-side access to guest files.
// ============================================================================

import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../vm-core/src/paths";
import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import { ensureKeypair, authorizeInGuest } from "../../vm-core/src/sshkey";
import { rdpPassword } from "./freerdp";
import { run, which } from "../../sys/src/exec";

export const MOUNTS_DIR = join(DATA_DIR, "mounts");

export interface MountInfo {
    vm: string;
    guestPath: string;
    mountpoint: string;
}

/** True when sshfs + fusermount are available. */
export async function mountAvailable(): Promise<boolean> {
    return (await which("sshfs")) !== null && (await which("fusermount3")) !== null;
}

/** Default host mountpoint for a VM's guest root. */
export function defaultMountpoint(vm: string): string {
    return join(MOUNTS_DIR, vm);
}

/**
 * Mount guestPath from the VM at mountpoint via sshfs.
 * Password comes from the VM's credential file (never on argv).
 */
export async function mountGuest(h: VmHandle, guestPath?: string, mountpoint?: string): Promise<MountInfo> {
    if (!await which("sshfs"))
        throw new Error("sshfs not installed — 'apt install sshfs' for guest→host mounts");
    const spec = h.spec;
    const port = spec.network.sshPort;
    if (!port) throw new Error(`vm ${spec.name} has no ssh hostfwd — add one to ssh into/mount the guest`);

    const gp = guestPath ?? `/home/${spec.credentials.username}`;
    const mp = mountpoint ?? defaultMountpoint(spec.name);
    await mkdir(mp, { recursive: true });

    // key auth preferred (no prompt); authorize via QGA first if possible
    try { await authorizeInGuest(h); } catch { /* guest may lack agent; try anyway */ }
    const { priv } = await ensureKeypair();
    const base = [
        "-p", String(port),
        "-o", "StrictHostKeyChecking=no,UserKnownHostsFile=/dev/null",
    ];
    const dest = [`${spec.credentials.username}@127.0.0.1:${gp}`, mp];
    const key = await run("sshfs", [
        ...base, "-o", `IdentityFile=${priv},IdentitiesOnly=yes,BatchMode=yes`, ...dest,
    ], { noThrow: true, timeoutMs: 30_000 });
    if (key.code !== 0) {
        // key not authorized in guest — fall back to the provisioning password
        const pw = await rdpPassword(spec);
        if (!pw) throw new Error(`sshfs key auth failed and no password on record: ${key.stderr.slice(-400)}`);
        const { spawn } = await import("node:child_process");
        await new Promise<void>((resolve, reject) => {
            const c = spawn("sshfs", [...base, "-o", "password_stdin", ...dest], { stdio: ["pipe", "inherit", "inherit"] });
            c.stdin!.write(pw + "\n"); c.stdin!.end();
            c.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`sshfs exited ${code}`)));
            c.on("error", reject);
        });
    }
    return { vm: spec.name, guestPath: gp, mountpoint: mp };
}

/** Is `mountpoint` a live mount right now? /proc/self/mounts parse — no
 *  statfs/mountpoint fork for a UI refresh that runs per VM per tick. */
export function isMounted(mountpoint: string): boolean {
    try {
        return readFileSync("/proc/self/mounts", "utf-8").split("\n")
            .some((l) => l.split(" ")[1] === mountpoint);
    } catch { return false; }
}

/** Unmount a guest mount (default mountpoint if not given); idempotent. */
export async function umountGuest(vm: string, mountpoint?: string): Promise<void> {
    const mp = mountpoint ?? defaultMountpoint(vm);
    if (!existsSync(mp)) return;
    const f = (await which("fusermount3")) ?? (await which("fusermount"));
    if (!f) throw new Error("fusermount3 not found");
    const r = await run(f, ["-u", mp], { noThrow: true });
    if (r.code !== 0 && !r.stderr.includes("not found in /etc/mtab"))
        throw new Error(`fusermount failed: ${r.stderr.slice(-300)}`);
}
