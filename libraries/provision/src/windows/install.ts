// ============================================================================
// windows/install.ts — owned install run: Windows ISO + unattend seed +
// virtio-win driver disc, all CDs on native AHCI (WinPE has no virtio
// drivers — the disk itself stays virtio via the seed's DriverPaths),
// powers off via the unattend FirstLogonCommands hook → QEMU exits.
// ============================================================================

import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
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

    const serialLog = join(paths.run, "install-serial.log");
    const built = buildArgs(spec, paths, {
        mode: "install",
        daemonize: false,
        install: {
            iso: o.winIso,
            seedIso: o.unattendIso,
            extraCds: [o.driverIso],
            // WinPE ships no virtio storage drivers — all three CDs go on
            // the q35's native AHCI so the installer sees them out of the
            // box. The DISK stays virtio (install.sata scopes to cdroms):
            // the seed ISO's DriverPaths gives WinPE viostor, and booting
            // the production device path avoids a 0x7B on first real boot.
            sata: true,
            serialLog,
        },
    }, { ldLibraryPath: tc.ldLibraryPath });

    // A stale sentinel from a previous provision attempt must not read as
    // this run's completion marker.
    await rm(serialLog, { force: true });

    /** One install-QEMU boot. Resolves true only on a guest-initiated
     *  poweroff; rejects on host kill/crash/timeout (caller aborts). */
    const bootOnce = (): Promise<void> => new Promise<void>((res, rej) => {
        const child = spawn(tc.qemu, built.argv, {
            env: { ...process.env, ...built.env },
            stdio: ["ignore", "ignore", "inherit"],
        });
        // Completion = the guest's own poweroff (cruiser-done.cmd's shutdown):
        // QEMU's SHUTDOWN event carries guest=true only for guest-initiated
        // stops — a host `quit`/kill reports guest=false, so a crashed or
        // force-killed installer can no longer read as "install complete".
        let guestShutdown: boolean | undefined;
        // Held for the boot's lifetime so the event listener keeps firing —
        // the socket owns its callbacks once dropped from scope, but an
        // explicit reference is clearer than relying on that.
        let monitor: QmpClient | null = null;
        void (async () => {
            // QEMU's unix QMP accepts extra socket connections but services
            // only ONE client at a time — a second connect gets no greeting
            // until the first drops (verified against QEMU 8.2: a held conn
            // starves every later client). The SHUTDOWN watch holds its conn
            // for the whole boot, so the "press any key" taps MUST ride the
            // same connection — separate tap conns would queue forever and
            // the OVMF CD-boot prompt would lapse to PXE.
            //
            // The prompt: install media parks on "Press any key to boot
            // from CD or DVD" — nobody pressing means OVMF's watchdog kills
            // the boot image (~10s) and it falls through to PXE. Tap a key
            // every 2s for the first ~90s so the prompt is hit whenever
            // OVMF gets there. The key is a LEFT ARROW, not Enter: it still
            // satisfies "any key" but can never activate a focused button —
            // an Enter leaking into the setup GUI (e.g. landing on Cancel →
            // quit-confirm → Yes) would abort the whole install.
            let q: QmpClient | null = null;
            for (let i = 0; i < 60 && !q && child.exitCode === null; i++) {
                q = await QmpClient.connect(paths.monitorSock, 2_000).catch(() => null);
                if (!q) await new Promise((r) => setTimeout(r, 1_000));
            }
            if (!q) return;
            monitor = q;   // keep the conn referenced for the boot's lifetime
            q.on("event", (e: { event: string; data?: { guest?: boolean } }) => {
                if (e.event === "SHUTDOWN") guestShutdown = e.data?.guest === true;
            });
            try {
                for (let i = 0; i < 45 && child.exitCode === null; i++) {
                    await new Promise((r) => setTimeout(r, 2_000));
                    if (child.exitCode !== null) break;
                    await q.execute("send-key", { keys: [{ type: "qcode", data: "left" }] })
                        .catch(() => {});
                }
            } catch { /* never sink the install on a key-tap failure */ }
        })();
        const timer = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("windows install timed out")); },
            o.timeoutMs ?? 120 * 60_000);
        child.on("exit", (c) => {
            clearTimeout(timer);
            monitor?.close();
            monitor = null;
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
    // completion marker is observed; setup resumes where it stopped.
    const luks = spec.disk.encrypt === "full";
    for (let boot = 0; boot < 8; boot++) {
        // QEMU's tpm-emulator chardev connects at machine init — the daemon
        // must be listening first. swtpm -t exits when the connection
        // drops (i.e. at every guest poweroff), so it has to be respawned
        // for EVERY boot, not just the first.
        if (spec.security.tpm) await spawnSwtpm(paths);
        await bootOnce();
        if (await guestInstallMarkedDone(disk, serialLog, luks)) break;
        if (boot === 7) throw new Error(
            "windows install power-cycled 8 times without a completion marker — the unattend setup script never ran");
    }

    // sanity — the answer file marks the image before its shutdown
    if (!existsSync(disk) || !statSync(disk).size) throw new Error("install finished but the disk is empty");
    // completedAt is stamped by the orchestrator after first-boot setup.
    spec.provisioned = { method: "windows-iso", source: o.winIso };
}

/** Two markers signal a viable image: done.cmd writes C:\cruiser-installed
 *  before its shutdown, and the specialize preinstall writes
 *  C:\cruiser-preinstall-done. Two host-readable channels carry them:
 *   - COM1: both scripts echo the marker text to the serial port, which
 *     lands in the install serial log — the only channel that works for a
 *     LUKS'd disk (qcow2 payload is ciphertext to us).
 *   - MFT filenames: after flush both names (UTF-16LE) sit in the qcow2's
 *     uncompressed clusters — `strings -e l` finds them without a guest
 *     agent or an NTFS reader. Unencrypted disks only. */
async function guestInstallMarkedDone(disk: string, serialLog: string, luks: boolean): Promise<boolean> {
    if (existsSync(serialLog)) {
        const s = await run("grep", ["-qE", "cruiser-installed|cruiser-preinstall-done", serialLog],
            { noThrow: true });
        if (s.code === 0) return true;
    }
    if (luks) return false;
    const r = await run("sh", ["-c", `strings -e l "$1" | grep -m1 -q "^cruiser-installed$\\|^cruiser-preinstall-done$"`, "--", disk],
        { noThrow: true });
    return r.code === 0;
}
