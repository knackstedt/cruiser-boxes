// ============================================================================
// download.ts — fetch a URL to disk the boring way: streamed (no whole-file
// buffering — a desktop ISO is 5+ GB), and atomic (writes <dst>.part then
// renames, so an interrupted fetch can never masquerade as a completed one
// behind an existsSync check). Content-Length mismatch counts as truncated.
// node-only APIs — runs under bun AND node.
// ============================================================================

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function downloadTo(url: string, dst: string): Promise<void> {
    await mkdir(dirname(dst), { recursive: true });
    const part = `${dst}.part`;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    try {
        await pipeline(Readable.fromWeb(
            res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
            createWriteStream(part));
        const want = Number(res.headers.get("content-length"));
        if (Number.isFinite(want) && want > 0) {
            const { size } = await stat(part);
            if (size !== want)
                throw new Error(`fetch ${url}: truncated body (${size} != ${want} bytes)`);
        }
        await rename(part, dst);
    } catch (e) {
        await rm(part, { force: true }).catch(() => {});
        throw e;
    }
}
