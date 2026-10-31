// ============================================================================
// download.ts — fetch a URL to disk the boring way: streamed (no whole-file
// buffering — a desktop ISO is 5+ GB), and atomic (writes <dst>.part then
// renames, so an interrupted fetch can never masquerade as a completed one
// behind an existsSync check). Content-Length mismatch counts as truncated.
// `expect` adds cryptographic verification: the digest is computed while
// streaming and compared BEFORE the rename — a mismatch deletes the .part
// and never touches a good existing dst. `ensureDownload` is the cache-aware
// wrapper: an existing file is reused only when it hashes clean (or no digest
// is available — then existsSync is all we have).
// node-only APIs — runs under bun AND node.
// ============================================================================

import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type DigestAlgo = "sha256" | "sha512";
export interface Digest { algo: DigestAlgo; hex: string }

export interface DownloadOpts {
    /** Expected content digest — verified before the atomic rename. */
    expect?: Digest;
    /** Extra request headers — some mirrors (fedorapeople's Anubis wall)
     *  challenge browser UAs but pass CLI tools. */
    headers?: Record<string, string>;
}

export interface DownloadResult {
    bytes: number;
    /** Hex digest of the bytes written — always computed (algo from
     *  `expect`, else sha256) so callers can verify/logging anyway. */
    digest: string;
    /** True when a digest was supplied AND matched. */
    verified: boolean;
}

export async function downloadTo(url: string, dst: string, opts: DownloadOpts = {}): Promise<DownloadResult> {
    await mkdir(dirname(dst), { recursive: true });
    const part = `${dst}.part`;
    const res = await fetch(url, { redirect: "follow", headers: opts.headers });
    if (!res.ok || !res.body) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    const algo = opts.expect?.algo ?? "sha256";
    const hash = createHash(algo);
    let bytes = 0;
    const meter = new Transform({
        transform(chunk: Uint8Array, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); },
    });
    try {
        await pipeline(Readable.fromWeb(
            res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
            meter, createWriteStream(part));
        const want = Number(res.headers.get("content-length"));
        if (Number.isFinite(want) && want > 0 && bytes !== want)
            throw new Error(`fetch ${url}: truncated body (${bytes} != ${want} bytes)`);
        const digest = hash.digest("hex");
        if (opts.expect && digest !== opts.expect.hex.toLowerCase())
            throw new Error(`fetch ${url}: ${algo} mismatch (got ${digest}, want ${opts.expect.hex})`);
        await rename(part, dst);
        return { bytes, digest, verified: !!opts.expect };
    } catch (e) {
        await rm(part, { force: true }).catch(() => {});
        throw e;
    }
}

/** Streamed digest of an existing file — for cache verification. */
export function fileDigest(path: string, algo: DigestAlgo = "sha256"): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash(algo);
        const s = createReadStream(path);
        s.on("data", (c) => hash.update(c as Uint8Array));
        s.on("error", reject);
        s.on("end", () => resolve(hash.digest("hex")));
    });
}

/**
 * Cache-aware download: reuse `dst` when present, but only after proving it —
 * with a digest the file must hash clean or it's deleted and refetched (an
 * interrupted/corrupt cache entry can never be served back). Without a digest
 * the existsSync short-circuit is all we can do.
 */
export async function ensureDownload(url: string, dst: string, opts: DownloadOpts = {}): Promise<DownloadResult & { cached: boolean }> {
    if (existsSync(dst)) {
        if (!opts.expect) {
            const { size } = await stat(dst);
            return { bytes: size, digest: "", verified: false, cached: true };
        }
        const got = await fileDigest(dst, opts.expect.algo);
        if (got === opts.expect.hex.toLowerCase())
            return { bytes: (await stat(dst)).size, digest: got, verified: true, cached: true };
        await rm(dst, { force: true }); // corrupt cache — refetch below
    }
    const r = await downloadTo(url, dst, opts);
    return { ...r, cached: false };
}
