// ============================================================================
// iso-install.ts — generalized path: desktop ISO + autoinstall seed → installed
// disk. Ports ~/devvm `cmd_install`: casper kernel/initrd direct-boot so the
// install runs text-mode on the serial console (log to run/install-serial.log).
// ============================================================================

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { run, which } from "../../sys/src/exec";
import { ISO_DIR, vmPaths } from "../../vm-core/src/paths";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { buildSeedIso, autoinstallUserData, metaData, passwordHash, type SeedOpts } from "./nocloud";
import { resolveToolchain } from "../../vm-core/src/qemu/resolve";
import { createDisk } from "../../vm-core/src/disk/ops";

/** Fetch a desktop ISO into ISO_DIR if absent. */
export async function ensureIso(url: string, name?: string): Promise<string> {
    await mkdir(ISO_DIR, { recursive: true });
    const file = join(ISO_DIR, name ?? url.split("/").pop() ?? "install.iso");
    if (existsSync(file)) return file;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    return file;
}

/** Extract casper/vmlinuz + casper/initrd from a Ubuntu live ISO (no root needed). */
export async function extractCasper(iso: string, outDir: string): Promise<{ kernel: string; initrd: string }> {
    await mkdir(outDir, { recursive: true });
    const kernel = join(outDir, "vmlinuz");
    const initrd = join(outDir, "initrd");
    if (existsSync(kernel) && existsSync(initrd)) return { kernel, initrd };

    if (await which("xorriso")) {
        await run("xorriso", ["-osirrox", "on", "-indev", iso,
            "-extract", "/casper/vmlinuz", kernel, "-extract", "/casper/initrd", initrd]);
    } else if (await which("isoinfo")) {
        const { writeFile } = await import("node:fs/promises");
        const files: [string, string][] = [["/casper/vmlinuz", kernel], ["/casper/initrd", initrd]];
        for (let i = 0; i < files.length; i++) {
            const r = await run("isoinfo", ["-i", iso, "-x", files[i]![0]]);
            // isoinfo streams binary to stdout — execFile buffer is fine for vmlinuz (~15M)
            await writeFile(files[i]![1], r.stdout, { encoding: "latin1" });
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
    o: { iso: string; username: string; password: string; sshKeys?: string[]; timezone?: string; timeoutMs?: number },
): Promise<void> {
    const paths = vmPaths(spec.name);
    const tc = await resolveToolchain();
    await mkdir(paths.dir, { recursive: true });
    await mkdir(paths.run, { recursive: true });

    if (!existsSync(paths.disk))
        await createDisk(tc.qemuImg, paths.disk, spec.disk.sizeGiB);
    const { copyFile } = await import("node:fs/promises");
    if (!existsSync(paths.ovmfVars))
        await copyFile("/usr/share/OVMF/OVMF_VARS_4M.fd", paths.ovmfVars);

    const hash = await passwordHash(o.password);
    const seedOpts: SeedOpts = {
        hostname: spec.name, username: o.username, passwordHash: hash,
        sshAuthorizedKeys: o.sshKeys, timezone: o.timezone,
    };
    const seedIso = await buildSeedIso(join(paths.dir, "seed"), autoinstallUserData(seedOpts), metaData(seedOpts));
    const casper = await extractCasper(o.iso, join(paths.dir, "casper"));

    const { buildArgs } = await import("../../vm-core/src/qemu/args");
    const built = buildArgs(spec, paths, {
        mode: "install",
        install: {
            iso: o.iso, seedIso,
            kernel: casper.kernel, initrd: casper.initrd,
            serialLog: join(paths.run, "install-serial.log"),
        },
    }, { ldLibraryPath: tc.ldLibraryPath });

    // install run is owned — QEMU exits on `shutdown: poweroff`
    const child = spawn(tc.qemu, built.argv.filter((a) => a !== "-daemonize"), {
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
    spec.provisioned = { method: "iso", source: o.iso, completedAt: new Date().toISOString() };
}
