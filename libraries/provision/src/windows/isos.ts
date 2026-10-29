// ============================================================================
// windows/isos.ts — Windows install-media + driver-media acquisition.
//
// Sources, all legal downloads fetched at provision time (never vendored):
//   - Windows ISO: Microsoft's own software-download API — the same page a
//     browser user clicks through. The API hands out time-limited signed
//     prss.microsoft.com URLs; resolution runs the quickemu/Mido flow
//     (download page → product-edition id → session tag → SKU → link).
//     Microsoft's Sentinel filter rejects the final hop from some IPs —
//     that's a hard error with manual-download instructions, not a retry.
//   - virtio-win ISO: Red Hat's fedorapeople.org archive — newest versioned
//     dir (stable-virtio is a redirect, not a version pin).
//   - Yttrium (viogpu3d) zip: arehnman/yttrium-virtio-gpu GitHub releases,
//     newest `yttrium-viogpu3d-experimental-*.zip` asset.
//
// No published sha256 exists for either Windows or virtio-win ISOs — media
// are sanity-checked structurally (ISO9660 magic + plausible size) instead.
// ============================================================================

import { existsSync } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDownload } from "../../../sys/src/download";
import { ISO_DIR } from "../../../vm-core/src/paths";

const WIN_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:100.0) Gecko/20100101 Firefox/100.0";
const MS_PROFILE = "606624d44113";
const VIRTIO_ARCHIVE = "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/";
const YTTRIUM_RELEASES = "https://api.github.com/repos/arehnman/yttrium-virtio-gpu/releases";

/** Windows 11 Enterprise Evaluation (25H2) — Microsoft's own CDN, legal
 *  eval media, and the sha256 Microsoft publishes on the eval page.
 *  Used when the consumer-ISO API's Sentinel gate blocks this IP. Single
 *  image ("Windows 11 Enterprise Evaluation"); unactivated, 90-day eval. */
export const WIN_EVAL_ISOS: Record<string, { url: string; file: string; sha256: string; edition: string }> = {
    "11": {
        url: "https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/" +
            "26200.6584.250915-1905.25h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso",
        file: "windows-11-enterprise-eval-x64.iso",
        sha256: "a61adeab895ef5a4db436e0a7011c92a2ff17bb0357f58b13bbc4062e535e7b9",
        edition: "Windows 11 Enterprise Evaluation",
    },
    // 22H2 — sha256 from Microsoft's Windows10Enterprise22H2HashValues.pdf.
    // dwm.exe on this build predates the 24H2 DComp paths that crash the
    // yttrium UMD on Win11 — the upstream-qualified target.
    "10": {
        url: "https://software-static.download.prss.microsoft.com/dbazure/988969d5-f34g-4e03-ac9d-1f9786c66750/" +
            "19045.2006.220908-0225.22h2_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso",
        file: "windows-10-enterprise-eval-x64.iso",
        sha256: "ef7312733a9f5d7d51cfa04ac497671995674ca5e1058d5164d6028f0938d668",
        edition: "Windows 10 Enterprise Evaluation",
    },
};
export const WIN_EVAL_ISO = WIN_EVAL_ISOS["11"]!;

/** ISO9660 primary volume descriptor magic at sector 16. */
export async function isoSanityCheck(path: string, minBytes = 256 * 1024 * 1024): Promise<void> {
    const { size } = await stat(path);
    if (size < minBytes) throw new Error(`${path}: too small (${size} B) — not an install ISO`);
    const fh = await open(path, "r");
    try {
        const buf = Buffer.alloc(5);
        await fh.read(buf, 0, 5, 0x8001);
        if (buf.toString("latin1") !== "CD001") throw new Error(`${path}: no ISO9660 signature — corrupt or wrong file`);
    } finally { await fh.close(); }
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": WIN_UA, ...headers } });
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    return res.json();
}

/**
 * Resolve a signed download URL for the official consumer Windows ISO.
 * `release` = "10" | "11"; the multi-edition ISO is what setup consumes —
 * edition selection happens in unattend's InstallFrom metadata.
 *
 * The signed URL expires in ~24h, so this is resolved immediately before
 * the download and never persisted.
 */
export async function resolveWindowsIsoUrl(release: string): Promise<string> {
    if (release !== "10" && release !== "11")
        throw new Error(`no ISO catalog entry for windows release "${release}" — pass --iso explicitly`);
    const page = `https://www.microsoft.com/en-us/software-download/windows${release === "10" ? "10ISO" : "11"}`;

    const html = await (await fetch(page, { headers: { "User-Agent": WIN_UA } })).text();
    const editionId = /<option value="(\d+)">Windows/.exec(html)?.[1];
    if (!editionId) throw new Error("windows download page layout changed — could not find a product edition id");

    const sid = randomUUID();
    // Microsoft's Sentinel gate keys on this session tag — the request must
    // fire (its response is ignored) or the link call is rejected.
    await fetch(`https://vlscppe.microsoft.com/tags?org_id=y6jn8c31&session_id=${sid}`,
        { headers: { "User-Agent": WIN_UA } }).catch(() => {});

    const skus = await fetchJson(
        `https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition` +
        `?profile=${MS_PROFILE}&ProductEditionId=${editionId}&SKU=undefined&friendlyFileName=undefined&Locale=en-US&sessionID=${sid}`);
    const sku = (skus.Skus as any[]).find((s) => s.Language === "English" || s.LocalizedLanguage === "English")
        ?? skus.Skus?.[0];
    if (!sku) throw new Error("windows SKU list came back empty — Microsoft's API may have changed");

    // The referer is required; without it the API 4xxs. Sentinel rejects
    // this specific call from some IPs (datacenter ranges notably) — the
    // same failure quickemu documents.
    const links = await fetchJson(
        `https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku` +
        `?profile=${MS_PROFILE}&productEditionId=undefined&SKU=${sku.Id}&friendlyFileName=undefined&Locale=en-US&sessionID=${sid}`,
        { Referer: page });
    if (JSON.stringify(links).includes("Sentinel marked this request as rejected"))
        throw new Error(
            `Microsoft blocked the automated ISO request from this IP (Sentinel). ` +
            `Download Windows ${release} manually from ${page} and re-run with --iso <path>`);
    const url = (links.ProductDownloadOptions as any[] ?? [])
        .map((o) => o.Uri as string).find((u) => /x64/i.test(u));
    if (!url) throw new Error(`no x64 ISO link in Microsoft's response — download manually from ${page} and use --iso`);
    return url;
}

export interface WindowsMedia { path: string; /** /IMAGE/NAME hint for eval media. */ edition?: string }

/** Fetch (or reuse) the official Windows ISO. `userIso` = a path or URL the
 *  caller supplied — trusted as-is aside from the structural check. The
 *  returned `edition` hints the unattend /IMAGE/NAME for single-image
 *  media (eval) so InstallFrom can't select a name that isn't there. */
export async function ensureWindowsIso(release: string, userIso?: string,
    onLog?: (msg: string) => void): Promise<WindowsMedia> {
    await mkdir(ISO_DIR, { recursive: true });
    if (userIso) {
        if (!userIso.startsWith("http")) {
            await isoSanityCheck(userIso);
            return { path: userIso };
        }
        const file = join(ISO_DIR, userIso.split("/").pop() ?? `windows-${release}.iso`);
        await ensureDownload(userIso, file);
        await isoSanityCheck(file);
        return { path: file };
    }
    const file = join(ISO_DIR, `windows-${release}-x64.iso`);
    if (!existsSync(file)) {
        try {
            const url = await resolveWindowsIsoUrl(release);
            await ensureDownload(url, file);
        } catch (e) {
            // Sentinel blocks the consumer flow from some IPs — the eval ISO
            // is the sanctioned fallback (digest-pinned, no API gate).
            const evalIso = WIN_EVAL_ISOS[release];
            if (evalIso && e instanceof Error && /Sentinel|manually/.test(e.message)) {
                onLog?.("consumer ISO blocked by Microsoft's IP filter — using the official Enterprise Evaluation ISO instead");
                const evalFile = join(ISO_DIR, evalIso.file);
                await ensureDownload(evalIso.url, evalFile,
                    { expect: { algo: "sha256", hex: evalIso.sha256 } });
                await isoSanityCheck(evalFile);
                return { path: evalFile, edition: evalIso.edition };
            }
            throw e;
        }
    }
    await isoSanityCheck(file);
    return { path: file };
}

/** Newest versioned virtio-win driver ISO from the Red Hat archive.
 *  fedorapeople sits behind Anubis — it PoW-challenges browser UAs but
 *  passes CLI agents, so this host's fetches wear a curl UA. */
const CLI_UA = "curl/8.0";

export async function ensureVirtioWinIso(): Promise<string> {
    await mkdir(ISO_DIR, { recursive: true });
    const index = await (await fetch(VIRTIO_ARCHIVE, { headers: { "User-Agent": CLI_UA } })).text();
    const dirs = [...index.matchAll(/virtio-win-(\d+(?:\.\d+)+(?:-\d+)?)\//g)]
        .map((m) => m[1]!)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const latest = dirs[dirs.length - 1];
    if (!latest) throw new Error(`no virtio-win releases under ${VIRTIO_ARCHIVE}`);
    const file = join(ISO_DIR, `virtio-win-${latest}.iso`);
    await ensureDownload(`${VIRTIO_ARCHIVE}virtio-win-${latest}/virtio-win.iso`, file,
        { headers: { "User-Agent": CLI_UA } });
    await isoSanityCheck(file, 32 * 1024 * 1024);
    return file;
}

/** Newest yttrium viogpu3d driver bundle (alpha — test-signed release zip). */
export async function ensureYttrium(): Promise<string> {
    await mkdir(ISO_DIR, { recursive: true });
    const releases = await fetchJson(YTTRIUM_RELEASES, { Accept: "application/vnd.github+json" });
    const asset = (releases as any[])
        .flatMap((r) => (r.assets ?? []) as any[])
        .find((a) => /^yttrium-viogpu3d-experimental-[\d-]+\.zip$/.test(a.name ?? ""));
    if (!asset) throw new Error("no yttrium-viogpu3d-experimental zip in the latest releases — pin a URL via CRUISER_YTTRIUM_ZIP");
    const file = join(ISO_DIR, asset.name);
    await ensureDownload(asset.browser_download_url, file);
    return file;
}
