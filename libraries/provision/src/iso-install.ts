// ============================================================================
// iso-install.ts — generalized path: desktop ISO + autoinstall seed → installed
// disk. Ports ~/devvm `cmd_install`: casper kernel/initrd direct-boot so the
// install runs text-mode on the serial console (log to run/install-serial.log).
// ============================================================================

import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { run, which } from "../../sys/src/exec";
import { ensureDownload } from "../../sys/src/download";
import { probeIsoDigest } from "./checksums";
import { ISO_DIR, vmPaths, diskPath, homeDiskPath } from "../../vm-core/src/paths";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { buildSeedIso, autoinstallUserData, metaData, passwordHash, type SeedOpts } from "./nocloud";
import { profileFromSpec, resolvePackages } from "./packages";
import { resolveToolchain } from "../../vm-core/src/qemu/resolve";
import { createDisk, requireDiskKeyFile } from "../../vm-core/src/disk/ops";

/** Fetch a desktop ISO into ISO_DIR if absent. When the mirror publishes a
 *  sidecar/sums digest it's enforced — a corrupt cached file refetches. */
export async function ensureIso(url: string, name?: string): Promise<string> {
    await mkdir(ISO_DIR, { recursive: true });
    const file = join(ISO_DIR, name ?? url.split("/").pop() ?? "install.iso");
    const digest = await probeIsoDigest(url).catch(() => null);
    await ensureDownload(url, file, { expect: digest ?? undefined });
    return file;
}

/** Extract casper/vmlinuz + casper/initrd from a Ubuntu live ISO (no root needed). */
export async function extractCasper(iso: string, outDir: string): Promise<{ kernel: string; initrd: string }> {
    await mkdir(outDir, { recursive: true });
    const kernel = join(outDir, "vmlinuz");
    const initrd = join(outDir, "initrd");
    const nonEmpty = (p: string) => existsSync(p) && statSync(p).size > 0;
    if (nonEmpty(kernel) && nonEmpty(initrd)) return { kernel, initrd };

    if (await which("xorriso")) {
        await run("xorriso", ["-osirrox", "on", "-indev", iso,
            "-extract", "/casper/vmlinuz", kernel, "-extract", "/casper/initrd", initrd]);
    } else if (await which("isoinfo")) {
        // -R = Rock Ridge names (/casper/vmlinuz); without it isoinfo only
        // sees ISO9660 mangled names (/CASPER/VMLINUZ.;) and emits nothing.
        // stdout is binary — stream straight to disk, never through a string.
        const { spawn } = await import("node:child_process");
        const { createWriteStream } = await import("node:fs");
        const files: [string, string][] = [["/casper/vmlinuz", kernel], ["/casper/initrd", initrd]];
        for (let i = 0; i < files.length; i++) {
            const [isoPath, dst] = files[i]!;
            await new Promise<void>((resolve, reject) => {
                const out = createWriteStream(dst);
                const c = spawn("isoinfo", ["-R", "-i", iso, "-x", isoPath]);
                c.stdout.pipe(out);
                c.stderr.on("data", () => {});
                c.on("exit", (code) => code === 0 ? out.close(() => resolve()) : reject(new Error(`isoinfo -x ${isoPath} exited ${code}`)));
                c.on("error", reject);
            });
            const { size } = await (await import("node:fs/promises")).stat(dst);
            if (!size) throw new Error(`isoinfo extracted empty ${isoPath} — ISO layout not recognized`);
        }
    } else {
        throw new Error("need xorriso or isoinfo (genisoimage) to extract casper kernel/initrd");
    }
    return { kernel, initrd };
}

/**
 * Run the unattended ISO install: boots casper with `autoinstall ds=nocloud`,
 * installs to disk.qcow2, powers off when done. Resolves when QEMU exits.
 * Caller should then start the VM normally + run guest setup.
 */
export async function runIsoInstall(
    spec: VmSpec,
    o: {
        iso: string; username: string; password: string; sshKeys?: string[];
        timezone?: string; locale?: string; keyboard?: string; timeoutMs?: number;
    },
): Promise<void> {
    const paths = vmPaths(spec.name);
    const tc = await resolveToolchain();
    await mkdir(paths.dir, { recursive: true });
    await mkdir(paths.run, { recursive: true });

    // spec.disk.file may point outside the vm dir (custom disk location).
    // disk.encrypt="full" makes the install target LUKS; "home" adds the
    // second LUKS image the installer also sees (buildArgs attaches it —
    // it must exist before spawn).
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
    const { copyFile } = await import("node:fs/promises");
    const { ovmfVarsTemplate } = await import("../../vm-core/src/qemu/args");
    if (!existsSync(paths.ovmfVars))
        await copyFile(ovmfVarsTemplate(), paths.ovmfVars);

    const hash = await passwordHash(o.password);
    const seedOpts: SeedOpts = {
        hostname: spec.name, username: o.username, passwordHash: hash,
        sshAuthorizedKeys: o.sshKeys, timezone: o.timezone,
        locale: o.locale, keyboard: o.keyboard,
        packages: resolvePackages(profileFromSpec(spec), "seed"),
    };
    const seedIso = await buildSeedIso(join(paths.dir, "seed"), autoinstallUserData(seedOpts), metaData(seedOpts));
    const casper = await extractCasper(o.iso, join(paths.dir, "casper"));

    const { buildArgs } = await import("../../vm-core/src/qemu/args");
    const built = buildArgs(spec, paths, {
        mode: "install",
        daemonize: false,   // install run is owned — QEMU exits on poweroff
        install: {
            iso: o.iso, seedIso,
            kernel: casper.kernel, initrd: casper.initrd,
            serialLog: join(paths.run, "install-serial.log"),
        },
    }, { ldLibraryPath: tc.ldLibraryPath });

    const child = spawn(tc.qemu, built.argv, {
        env: { ...process.env, ...built.env },
        stdio: ["ignore", "ignore", "inherit"],
    });
    await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("iso install timed out")); }, o.timeoutMs ?? 90 * 60_000);
        child.on("exit", (c) => {
            clearTimeout(timer);
            if (c === 0 || c === null) res(); else rej(new Error(`qemu install exited ${c}`));
        });
        child.on("error", rej);
    });

    spec.credentials.username = o.username;
    // completedAt is the orchestrator's (provision.ts stamps it after guest
    // setup) — the install step alone isn't a completed provision.
    spec.provisioned = { method: "iso", source: o.iso };
}
