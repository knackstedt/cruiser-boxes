// ============================================================================
// distros.ts — curated distro/release matrix + cloud-image resolution.
//
// Ubuntu image URLs are deterministic; Debian and Fedora filenames embed a
// build/version component, so their URLs are resolved by scraping the mirror
// index (see pickImageFromIndex). `krdp` marks releases that ship Plasma 6's
// KRDP server — the KDE desktop option is gated on it.
// ============================================================================

import type { DistroFamily } from "../../vm-core/src/config/schema";

export interface DistroRelease {
    id: string;                      // "26.04" | "trixie" | "44"
    label: string;                   // UI label
    /** ships the `krdp` package → KDE guests can be served over RDP. */
    krdp: boolean;
}

export interface DistroInfo {
    label: string;
    releases: DistroRelease[];
}

export const DISTROS: Record<DistroFamily, DistroInfo> = {
    ubuntu: {
        label: "Ubuntu",
        releases: [
            { id: "26.04", label: "26.04 LTS", krdp: true },
            { id: "24.04", label: "24.04 LTS", krdp: false },  // Plasma 5.27 — no krdp
        ],
    },
    debian: {
        label: "Debian",
        releases: [
            { id: "trixie", label: "13 (trixie)", krdp: true },
        ],
    },
    fedora: {
        label: "Fedora",
        releases: [
            { id: "44", label: "44", krdp: true },
            { id: "43", label: "43", krdp: true },
        ],
    },
    windows: {
        label: "Windows",
        releases: [
            // provisioned from ISOs, not cloud images — cloudImageFor throws.
            { id: "11", label: "11 Pro (consumer ISO)", krdp: false },
            { id: "10", label: "10 Pro (consumer ISO)", krdp: false },
        ],
    },
};

export function defaultRelease(family: DistroFamily): string {
    return DISTROS[family].releases[0]!.id;
}

/** Can `release` of `family` serve a KDE guest over RDP (krdp packaged)? */
export function supportsKrdp(family: DistroFamily, release: string): boolean {
    const r = DISTROS[family].releases.find((x) => x.id === release);
    return r?.krdp ?? false;
}

/** Deterministic Ubuntu cloud image URL. */
export function ubuntuImageUrl(release: string): { url: string; file: string } {
    const file = `ubuntu-${release}-server-cloudimg-amd64.img`;
    return { url: `https://cloud-images.ubuntu.com/releases/${release}/release/${file}`, file };
}

/**
 * Pick the newest matching filename from an Apache-style mirror index page.
 * Returns the bare filename (caller joins onto the index dir).
 */
export function pickImageFromIndex(indexHtml: string, pattern: RegExp): string | null {
    const matches = [...indexHtml.matchAll(/href="([^"]+)"/g)]
        .map((m) => m[1]!)
        .filter((h) => pattern.test(h))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return matches.length ? matches[matches.length - 1]! : null;
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    return res.text();
}

/**
 * Resolve the cloud-image download for a family+release. Debian/Fedora file
 * names embed a compose version — scrape the mirror index for the newest.
 * Throws if no matching image is found.
 */
export async function cloudImageFor(family: DistroFamily, release: string): Promise<{ url: string; file: string }> {
    if (family === "windows")
        throw new Error("windows guests install from ISO, not a cloud image — use `provision windows`");
    if (family === "ubuntu") return ubuntuImageUrl(release);
    if (family === "debian") {
        const dir = `https://cloud.debian.org/images/cloud/${release}/latest/`;
        const file = pickImageFromIndex(await fetchText(dir), /^debian-\d+-genericcloud-amd64\.qcow2$/);
        if (!file) throw new Error(`no debian genericcloud image found under ${dir}`);
        return { url: dir + file, file };
    }
    // fedora
    const dir = `https://dl.fedoraproject.org/pub/fedora/linux/releases/${release}/Cloud/x86_64/images/`;
    const file = pickImageFromIndex(await fetchText(dir), /^Fedora-Cloud-Base-Generic-\d+-[\d.]+\.x86_64\.qcow2$/);
    if (!file) throw new Error(`no Fedora Cloud Base image found under ${dir} (is ${release} released?)`);
    return { url: dir + file, file };
}
