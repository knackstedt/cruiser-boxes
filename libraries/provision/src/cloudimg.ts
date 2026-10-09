// ============================================================================
// cloudimg.ts — fast path: distro cloud image + NoCloud seed → bootable VM.
// Ubuntu/Debian/Fedora all publish NoCloud-compatible generic images; see
// distros.ts for the release matrix and URL resolution.
// ============================================================================

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "../../sys/src/exec";
import { CLOUDIMG_DIR, vmPaths, diskPath } from "../../vm-core/src/paths";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { buildSeedIso, cloudimgUserData, metaData, passwordHash, type SeedOpts } from "./nocloud";
import { cloudImageFor, defaultRelease } from "./distros";
import { profileFromSpec, resolvePackages } from "./packages";

async function fetchImg(url: string, dst: string): Promise<void> {
    if (existsSync(dst)) return;
    await mkdir(CLOUDIMG_DIR, { recursive: true });
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(dst, Buffer.from(await res.arrayBuffer()));
}

/**
 * Provision a VM from a cloud image:
 *   1. fetch base img into ~/.cache/cruiser/cloudimg (shared across VMs)
 *   2. create per-VM qcow2 backing-file disk
 *   3. build seed.iso with cloudimg user-data
 * Mutates spec: os.release (if resolved from the curated default),
 * provisioned, credentials.passwordFile.
 */
export async function provisionCloudimg(
    spec: VmSpec,
    qemuImg: string,
    o: { release?: string; username: string; password: string; sshKeys?: string[]; timezone?: string },
): Promise<{ disk: string; seedIso: string }> {
    const paths = vmPaths(spec.name);
    const release = o.release ?? (spec.os.release || defaultRelease(spec.os.family));
    const { url, file } = await cloudImageFor(spec.os.family, release);
    const base = join(CLOUDIMG_DIR, file);
    await fetchImg(url, base);

    // qcow2 overlay sized to spec — at spec.disk.file, which may live outside
    // the vm dir (custom disk location).
    const disk = diskPath(spec, paths.dir);
    await mkdir(paths.dir, { recursive: true });
    await mkdir(dirname(disk), { recursive: true });
    if (!existsSync(disk))
        await run(qemuImg, ["create", "-f", "qcow2", "-b", base, "-F", "qcow2", disk, `${spec.disk.sizeGiB}G`]);

    const hash = await passwordHash(o.password);
    const opts: SeedOpts = {
        hostname: spec.name, username: o.username, password: o.password,
        passwordHash: hash, sshAuthorizedKeys: o.sshKeys, timezone: o.timezone,
        packages: resolvePackages(profileFromSpec(spec), "seed"),
        pkgMgr: profileFromSpec(spec).family === "fedora" ? "dnf" : "apt",
    };
    const seedIso = await buildSeedIso(join(paths.dir, "seed"), cloudimgUserData(opts), metaData(opts));

    spec.credentials.username = o.username;
    spec.os.release = release;
    spec.provisioned = { method: "cloudimg", source: base };
    return { disk, seedIso };
}
