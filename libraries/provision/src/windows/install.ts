// ============================================================================
// windows/install.ts — owned install run: Windows ISO + unattend seed +
// virtio-win driver disc on native AHCI (WinPE has no virtio drivers),
// powers off via the unattend FirstLogonCommands hook → QEMU exits.
// ============================================================================

import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { vmPaths, diskPath, homeDiskPath } from "../../../vm-core/src/paths";
import type { VmSpec } from "../../../vm-core/src/config/schema";
import { resolveToolchain } from "../../../vm-core/src/qemu/resolve";
import { createDisk, requireDiskKeyFile } from "../../../vm-core/src/disk/ops";
import { buildArgs, ovmfVarsTemplate } from "../../../vm-core/src/qemu/args";

export interface WindowsInstallOpts {
    /** install media (eval/consumer ISO). */
    winIso: string;
    /** generated unattend.iso (autounattend.xml + scripts + yttrium?). */
    unattendIso: string;
    /** virtio-win driver disc (guest-tools installed during specialize). */
    driverIso: string;
    timeoutMs?: number;
}

/**
 * Boot the installer — OVMF picks the install CD since the disk is blank.
 * Resolves when QEMU exits (the unattend's shutdown hook); a nonzero or
 * timed-out exit means the answer file stalled — run/install-serial.log
 * won't have much (EMS only turns on post-install) so check QEMU's own
 * stderr + the Windows Panther logs inside the disk for diagnosis.
 */
export async function runWindowsInstall(spec: VmSpec, o: WindowsInstallOpts): Promise<void> {
    const paths = vmPaths(spec.name);
    const tc = await resolveToolchain();
    await mkdir(paths.dir, { recursive: true });
    await mkdir(paths.run, { recursive: true });

    const keyFile = spec.disk.encrypt !== "off" ? requireDiskKeyFile(spec, paths) : undefined;
    const disk = diskPath(spec, paths.dir);
    await mkdir(dirname(disk), { recursive: true });
    if (!existsSync(disk))
        await createDisk(tc.qemuImg, disk, spec.disk.sizeGiB, spec.disk.encrypt === "full" ? keyFile : undefined);
    if (spec.disk.encrypt === "home") {
        const hp = homeDiskPath(spec, paths.dir);
        await mkdir(dirname(hp), { recursive: true });
        if (!existsSync(hp)) await createDisk(tc.qemuImg, hp, spec.disk.homeGiB, keyFile);
    }
    if (!existsSync(paths.ovmfVars))
        await copyFile(ovmfVarsTemplate(spec.security.secureBoot), paths.ovmfVars);

    const built = buildArgs(spec, paths, {
        mode: "install",
        daemonize: false,
        install: {
            iso: o.winIso,
            seedIso: o.unattendIso,
            extraCds: [o.driverIso],
            // WinPE ships no virtio storage drivers — disk + all three CDs
            // go on the q35's native AHCI so the installer sees everything
            // out of the box. Production boots still get virtio-blk (the
            // specialize pass installs viostor via virtio-win-guest-tools).
            sata: true,
            serialLog: join(paths.run, "install-serial.log"),
        },
    }, { ldLibraryPath: tc.ldLibraryPath });

    const child = spawn(tc.qemu, built.argv, {
        env: { ...process.env, ...built.env },
        stdio: ["ignore", "ignore", "inherit"],
    });
    await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("windows install timed out")); },
            o.timeoutMs ?? 120 * 60_000);
        child.on("exit", (c) => {
            clearTimeout(timer);
            if (c === 0 || c === null) res(); else rej(new Error(`qemu windows install exited ${c}`));
        });
        child.on("error", rej);
    });

    // sanity — the answer file marks the image before its shutdown
    if (!existsSync(disk) || !statSync(disk).size) throw new Error("install finished but the disk is empty");
    // completedAt is stamped by the orchestrator after first-boot setup.
    spec.provisioned = { method: "windows-iso", source: o.winIso };
}
