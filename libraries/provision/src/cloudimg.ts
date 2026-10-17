// ============================================================================
// cloudimg.ts — fast path: distro cloud image + NoCloud seed → bootable VM.
// Ubuntu/Debian/Fedora all publish NoCloud-compatible generic images; see
// distros.ts for the release matrix and URL resolution.
// ============================================================================

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CLOUDIMG_DIR, vmPaths, diskPath } from "../../vm-core/src/paths";
import { createOverlay, requireDiskKeyFile } from "../../vm-core/src/disk/ops";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { buildSeedIso, cloudimgUserData, metaData, passwordHash, type SeedOpts } from "./nocloud";
import { cloudImageFor, defaultRelease } from "./distros";
import { imageDigestFor } from "./checksums";
import { profileFromSpec, resolvePackages } from "./packages";
import { ensureDownload, type Digest } from "../../sys/src/download";

/** Cached by name — a .part suffix means the last fetch died mid-flight
 *  and this call re-downloads instead of trusting a truncated file. With a
 *  resolved publisher digest the cache hit is hash-checked too, so a
 *  corrupt partial that somehow lost its .part suffix gets refetched. */
async function fetchImg(url: string, dst: string, digest: Digest | null): Promise<void> {
    await ensureDownload(url, dst, { expect: digest ?? undefined });
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
    o: {
        release?: string; username: string; password: string; sshKeys?: string[];
        timezone?: string; locale?: string; keyboard?: string;
    },
): Promise<{ disk: string; seedIso: string }> {
    const paths = vmPaths(spec.name);
    const release = o.release ?? (spec.os.release || defaultRelease(spec.os.family));
    const { url, file } = await cloudImageFor(spec.os.family, release);
    const base = join(CLOUDIMG_DIR, file);
    // Publisher checksum — best-effort: a failed sums fetch must not block
    // provisioning (integrity check, not a signature gate).
    const digest = await imageDigestFor(spec.os.family, release, file).catch(() => null);
    await fetchImg(url, base, digest);

    // qcow2 overlay sized to spec — at spec.disk.file, which may live outside
    // the vm dir (custom disk location). disk.encrypt="full" makes the
    // overlay LUKS (the shared plaintext backing stays untouched); "home"
    // leaves this overlay plaintext — the second image is created on first
    // boot by VmHandle.ensureAuxDisks.
    const disk = diskPath(spec, paths.dir);
    const keyFile = spec.disk.encrypt === "full" ? requireDiskKeyFile(spec, paths) : undefined;
    await mkdir(paths.dir, { recursive: true });
    await mkdir(dirname(disk), { recursive: true });
    if (!existsSync(disk))
        await createOverlay(qemuImg, base, "qcow2", disk, spec.disk.sizeGiB, keyFile);

    const hash = await passwordHash(o.password);
    const opts: SeedOpts = {
        hostname: spec.name, username: o.username, password: o.password,
        passwordHash: hash, sshAuthorizedKeys: o.sshKeys, timezone: o.timezone,
        locale: o.locale, keyboard: o.keyboard,
        packages: resolvePackages(profileFromSpec(spec), "seed"),
        pkgMgr: profileFromSpec(spec).family === "fedora" ? "dnf" : "apt",
    };
    const seedIso = await buildSeedIso(join(paths.dir, "seed"), cloudimgUserData(opts), metaData(opts));

    spec.credentials.username = o.username;
    spec.os.release = release;
    spec.provisioned = { method: "cloudimg", source: base };
    return { disk, seedIso };
}
