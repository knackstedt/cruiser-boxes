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
import { spawnSwtpm } from "../../../vm-core/src/lifecycle/vm";
import { QmpClient } from "../../../vm-core/src/qmp/client";
import { run } from "../../../sys/src/exec";

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

    // QEMU's tpm-emulator chardev connects at machine init — the daemon
    // must be listening first (same constraint as the lifecycle's start()).
    if (spec.security.tpm) await spawnSwtpm(paths);

    /** One install-QEMU boot. Resolves true only on a guest-initiated
     *  poweroff; rejects on host kill/crash/timeout (caller aborts). */
    const bootOnce = (): Promise<void> => new Promise<void>((res, rej) => {
        const child = spawn(tc.qemu, built.argv, {
            env: { ...process.env, ...built.env },
            stdio: ["ignore", "ignore", "inherit"],
        });
        // Windows install media parks on "Press any key to boot from CD or
        // DVD" — nobody pressing means OVMF's watchdog kills the boot image
        // (~10s) and it falls through to PXE. Tap a key every 2s for the
        // first ~90s so the prompt is hit whenever OVMF gets there. The key
        // is a LEFT ARROW, not Enter: it still satisfies "any key" but can
        // never activate a focused button — an Enter leaking into the setup
        // GUI (e.g. landing on Cancel → quit-confirm → Yes) would abort the
        // whole install.
        void (async () => {
            try {
                for (let i = 0; i < 45 && child.exitCode === null; i++) {
                    await new Promise((r) => setTimeout(r, 2_000));
                    if (child.exitCode !== null) break;
                    const q = await QmpClient.connect(paths.monitorSock, 2_000).catch(() => null);
                    if (!q) continue;
                    await q.execute("send-key", { keys: [{ type: "qcode", data: "left" }] })
                        .catch(() => {});
                    q.close();
                }
            } catch { /* never sink the install on a key-tap failure */ }
        })();

        // Completion = the guest's own poweroff (cruiser-done.cmd's shutdown):
        // QEMU's SHUTDOWN event carries guest=true only for guest-initiated
        // stops — a host `quit`/kill reports guest=false, so a crashed or
        // force-killed installer can no longer read as "install complete".
        let guestShutdown: boolean | undefined;
        void (async () => {
            for (let i = 0; i < 30 && child.exitCode === null; i++) {
                const q = await QmpClient.connect(paths.monitorSock, 2_000).catch(() => null);
                if (!q) { await new Promise((r) => setTimeout(r, 2_000)); continue; }
                q.on("event", (e: { event: string; data?: { guest?: boolean } }) => {
                    if (e.event === "SHUTDOWN") guestShutdown = e.data?.guest === true;
                });
                q.on("close", () => {});
                return;
            }
        })();
        const timer = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("windows install timed out")); },
            o.timeoutMs ?? 120 * 60_000);
        child.on("exit", (c) => {
            clearTimeout(timer);
            if (guestShutdown === true) res();
            else if (c === 0 || c === null) {
                // clean exit but unverified — monitor conn never landed, or
                // a host-side quit raced the listener. Either way the disk
                // state is unknowable here; reject rather than mark done.
                rej(new Error(guestShutdown === false
                    ? "windows install ended via host-initiated QEMU exit, not the guest's completion shutdown — provisioning likely did not run"
                    : "windows install QEMU exited before the guest completion shutdown could be observed"));
            } else rej(new Error(`qemu windows install exited ${c}`));
        });
        child.on("error", rej);
    });

    // Windows setup survives power cycles — but every stage boundary CAN
    // be a cold poweroff rather than a warm reboot, and all guest exits
    // look identical on the QEMU side. Relaunch the installer until the
    // disk carries the ps1's completion marker; setup resumes where it
    // stopped each boot.
    for (let boot = 0; boot < 8; boot++) {
        await bootOnce();
        if (await guestInstallMarkedDone(disk)) break;
        if (boot === 7) throw new Error(
            "windows install power-cycled 8 times without writing the completion marker — the unattend setup script never ran");
    }

    // sanity — the answer file marks the image before its shutdown
    if (!existsSync(disk) || !statSync(disk).size) throw new Error("install finished but the disk is empty");
    // completedAt is stamped by the orchestrator after first-boot setup.
    spec.provisioned = { method: "windows-iso", source: o.winIso };
}

/** The ps1's last step drops C:\cruiser-installed; after a clean guest
 *  poweroff NTFS is flushed and the MFT filename (UTF-16LE) is readable
 *  straight out of the qcow2's uncompressed clusters — `strings -e l`
 *  finds it without a guest agent or an NTFS reader. */
async function guestInstallMarkedDone(disk: string): Promise<boolean> {
    const r = await run("sh", ["-c", `strings -e l "$1" | grep -m1 -q "^cruiser-installed$"`, "--", disk],
        { noThrow: true });
    return r.code === 0;
}
