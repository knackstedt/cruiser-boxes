// ============================================================================
// checksums.ts — publisher checksum resolution for downloads.
//
// Each distro publishes sums differently:
//   ubuntu  <dir>/SHA256SUMS                coreutils: "<hex>  <file>" / "*<file>"
//   debian  <dir>/SHA512SUMS                coreutils, sha512
//   fedora  <dir>/Fedora-Cloud-*-CHECKSUM   BSD-style "SHA256 (<file>) = <hex>",
//                                           inside a PGP-signed wrapper
// User ISOs get best-effort sidecar probing (<url>.sha256, then dir
// SHA256SUMS/SHA512SUMS). Nothing here fetches more than the sums files —
// a failed/absent sums source resolves to null and the caller proceeds
// unverified (integrity, not signatures — availability wins).
// ============================================================================

import type { DigestAlgo, Digest } from "../../sys/src/download";
import type { DistroFamily } from "../../vm-core/src/config/schema";
import { pickImageFromIndex } from "./distros";

const HEX_LEN: Record<number, DigestAlgo> = { 64: "sha256", 128: "sha512" };

/**
 * Pull `file`'s digest out of a sums document. Handles both published
 * layouts — coreutils "<hex>[ *]<file>" (ubuntu/debian) and BSD
 * "<ALGO> (<file>) = <hex>" (fedora CHECKSUM) — and ignores anything else
 * (PGP armor, comment lines, size annotations). Hash length picks the algo.
 */
export function parseSumsFile(text: string, file: string): Digest | null {
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        // BSD: "SHA256 (name) = hex" — fedora CHECKSUM (also PGP-signed, so
        // the regex anchors on the algo keyword specifically).
        const bsd = /^SHA(256|512)\s*\(([^)]+)\)\s*=\s*([0-9a-fA-F]+)$/.exec(line);
        if (bsd && bsd[2] === file && bsd[3]) {
            const algo = `sha${bsd[1]}` as DigestAlgo;
            if (bsd[3].length === (algo === "sha256" ? 64 : 128))
                return { algo, hex: bsd[3].toLowerCase() };
            continue;
        }
        // coreutils: "hex  name" / "hex *name" / "hex name"
        const cu = /^([0-9a-fA-F]{64,128})\s+\*?(\S+)$/.exec(line);
        if (cu && cu[2] === file) {
            const algo = HEX_LEN[cu[1]!.length];
            if (algo) return { algo, hex: cu[1]!.toLowerCase() };
        }
    }
    return null;
}

async function fetchText(url: string): Promise<string | null> {
    try {
        const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
        return res.ok ? await res.text() : null;
    } catch {
        return null; // offline / blip — caller proceeds unverified
    }
}

/**
 * Publisher checksum for the curated cloud image `file` of family+release.
 * Mirrors the URLs cloudImageFor() resolves. Null = couldn't resolve a sums
 * entry — the caller downloads unverified.
 */
export async function imageDigestFor(family: DistroFamily, release: string, file: string): Promise<Digest | null> {
    if (family === "ubuntu") {
        const sums = await fetchText(`https://cloud-images.ubuntu.com/releases/${release}/release/SHA256SUMS`);
        return sums ? parseSumsFile(sums, file) : null;
    }
    if (family === "debian") {
        const sums = await fetchText(`https://cloud.debian.org/images/cloud/${release}/latest/SHA512SUMS`);
        return sums ? parseSumsFile(sums, file) : null;
    }
    // fedora — the CHECKSUM filename embeds the compose version; scrape the
    // same images index cloudImageFor used.
    const dir = `https://dl.fedoraproject.org/pub/fedora/linux/releases/${release}/Cloud/x86_64/images/`;
    const index = await fetchText(dir);
    if (!index) return null;
    const sumsName = pickImageFromIndex(index, /^Fedora-Cloud-\d+-[\d.]+-x86_64-CHECKSUM$/);
    if (!sumsName) return null;
    const sums = await fetchText(dir + sumsName);
    return sums ? parseSumsFile(sums, file) : null;
}

/**
 * Best-effort digest probe for an arbitrary ISO URL: a `<url>.sha256`
 * sidecar first, then SHA256SUMS/SHA512SUMS in the same directory. Null =
 * nothing published — proceed unverified.
 */
export async function probeIsoDigest(url: string): Promise<Digest | null> {
    const file = url.split("/").pop() ?? "";
    if (!file) return null;
    const sidecar = await fetchText(`${url}.sha256`);
    if (sidecar) {
        // bare hex or "hex  file" — a sidecar names only its own file, so a
        // lone hash on the first content line counts too.
        const bare = /^([0-9a-fA-F]{64,128})\s*$/.exec(sidecar.trim());
        if (bare) {
            const algo = HEX_LEN[bare[1]!.length];
            if (algo) return { algo, hex: bare[1]!.toLowerCase() };
        }
        const parsed = parseSumsFile(sidecar, file);
        if (parsed) return parsed;
    }
    const dir = url.slice(0, url.length - file.length);
    const sumsFiles = ["SHA256SUMS", "SHA512SUMS"];
    for (let i = 0; i < sumsFiles.length; i++) {
        const sums = await fetchText(dir + sumsFiles[i]!);
        const parsed = sums ? parseSumsFile(sums, file) : null;
        if (parsed) return parsed;
    }
    return null;
}
