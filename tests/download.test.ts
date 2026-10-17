import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadTo, ensureDownload, fileDigest } from "../libraries/sys/src/download";
import { parseSumsFile } from "../libraries/provision/src/checksums";

const BODY = Buffer.from("cruiser-test-image-bytes".repeat(1024)); // ~24KB
const SHA256 = createHash("sha256").update(BODY).digest("hex");

let server: Server;
let base: string;
let hits = 0;

beforeAll(async () => {
    server = createServer((req, res) => {
        hits++;
        if (req.url === "/ok") { res.end(BODY); return; }
        if (req.url === "/ok.sha256") { res.end(`${SHA256}  ok\n`); return; }
        if (req.url === "/SHA256SUMS") { res.end(`${SHA256}  ok\n${"0".repeat(64)}  other.iso\n`); return; }
        if (req.url === "/fedora.CHECKSUM") {
            res.end(`-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n` +
                `# ok: ${BODY.length} bytes\nSHA256 (ok) = ${SHA256}\n` +
                `-----BEGIN PGP SIGNATURE-----\nfakesig\n-----END PGP SIGNATURE-----\n`);
            return;
        }
        // chunked trickle — forces the streaming path across many events
        if (req.url === "/trickle") {
            res.writeHead(200);
            let i = 0;
            const t = setInterval(() => {
                if (i >= 8) { clearInterval(t); res.end(); return; }
                res.write(BODY.subarray(i * BODY.length / 8, (i + 1) * BODY.length / 8));
                i++;
            }, 5);
            return;
        }
        res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

async function tmp(): Promise<string> {
    return mkdtemp(join(tmpdir(), "cruiser-dl-"));
}

describe("parseSumsFile", () => {
    test("coreutils format (two-space and binary-star)", () => {
        expect(parseSumsFile(`${SHA256}  ubuntu.img\n${"1".repeat(64)}  other.img`, "ubuntu.img"))
            .toEqual({ algo: "sha256", hex: SHA256 });
        expect(parseSumsFile(`${SHA256} *ubuntu.img`, "ubuntu.img"))
            .toEqual({ algo: "sha256", hex: SHA256 });
    });

    test("sha512 lines resolve to sha512", () => {
        const h = "a".repeat(128);
        expect(parseSumsFile(`${h}  debian.qcow2`, "debian.qcow2"))
            .toEqual({ algo: "sha512", hex: h });
    });

    test("BSD/fedora CHECKSUM format inside PGP armor", () => {
        const text = `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n` +
            `SHA256 (Fedora-Cloud-Base-43.qcow2) = ${SHA256.toUpperCase()}\n` +
            `-----BEGIN PGP SIGNATURE-----\nxyz\n`;
        expect(parseSumsFile(text, "Fedora-Cloud-Base-43.qcow2"))
            .toEqual({ algo: "sha256", hex: SHA256 });
    });

    test("missing entry / wrong length → null", () => {
        expect(parseSumsFile(`${SHA256}  other.img`, "me.img")).toBeNull();
        expect(parseSumsFile(`${"ab".repeat(10)}  me.img`, "me.img")).toBeNull();
        expect(parseSumsFile("", "me.img")).toBeNull();
    });
});

describe("downloadTo", () => {
    test("streams to disk and returns the computed digest", async () => {
        const dir = await tmp();
        const dst = join(dir, "ok.img");
        const r = await downloadTo(`${base}/ok`, dst);
        expect(r.verified).toBe(false);
        expect(r.digest).toBe(SHA256);
        expect(r.bytes).toBe(BODY.length);
        expect(await readFile(dst)).toEqual(BODY);
        await rm(dir, { recursive: true });
    });

    test("matching expected digest verifies", async () => {
        const dir = await tmp();
        const r = await downloadTo(`${base}/ok`, join(dir, "ok.img"), { expect: { algo: "sha256", hex: SHA256 } });
        expect(r.verified).toBe(true);
        await rm(dir, { recursive: true });
    });

    test("digest mismatch throws, leaves no dst or .part behind", async () => {
        const dir = await tmp();
        const dst = join(dir, "ok.img");
        await expect(downloadTo(`${base}/ok`, dst, { expect: { algo: "sha256", hex: "0".repeat(64) } }))
            .rejects.toThrow(/mismatch/);
        expect(existsSync(dst)).toBe(false);
        expect(existsSync(`${dst}.part`)).toBe(false);
        await rm(dir, { recursive: true });
    });

    test("mismatch never replaces a good existing dst", async () => {
        const dir = await tmp();
        const dst = join(dir, "ok.img");
        await writeFile(dst, "KEEP-ME");
        await expect(downloadTo(`${base}/ok`, dst, { expect: { algo: "sha256", hex: "0".repeat(64) } }))
            .rejects.toThrow(/mismatch/);
        expect(await readFile(dst, "utf8")).toBe("KEEP-ME");
        await rm(dir, { recursive: true });
    });

    test("chunked/trickled responses hash correctly", async () => {
        const dir = await tmp();
        const r = await downloadTo(`${base}/trickle`, join(dir, "t.img"),
            { expect: { algo: "sha256", hex: SHA256 } });
        expect(r.verified).toBe(true);
        await rm(dir, { recursive: true });
    });
});

describe("ensureDownload", () => {
    test("clean cache hit: verified, no network request", async () => {
        const dir = await tmp();
        const dst = join(dir, "ok.img");
        await writeFile(dst, BODY);
        const before = hits;
        const r = await ensureDownload(`${base}/ok`, dst, { expect: { algo: "sha256", hex: SHA256 } });
        expect(r.cached).toBe(true);
        expect(r.verified).toBe(true);
        expect(hits).toBe(before); // not even a HEAD — local hash suffices
        await rm(dir, { recursive: true });
    });

    test("corrupt cache entry is deleted and refetched", async () => {
        const dir = await tmp();
        const dst = join(dir, "ok.img");
        await writeFile(dst, "TRUNCATED-GARBAGE");
        const r = await ensureDownload(`${base}/ok`, dst, { expect: { algo: "sha256", hex: SHA256 } });
        expect(r.cached).toBe(false);
        expect(r.verified).toBe(true);
        expect(await readFile(dst)).toEqual(BODY);
        await rm(dir, { recursive: true });
    });

    test("no digest → existsSync reuse (legacy behavior)", async () => {
        const dir = await tmp();
        const dst = join(dir, "ok.img");
        await writeFile(dst, "WHATEVER");
        const r = await ensureDownload(`${base}/ok`, dst);
        expect(r.cached).toBe(true);
        expect(r.verified).toBe(false);
        expect(await readFile(dst, "utf8")).toBe("WHATEVER");
        await rm(dir, { recursive: true });
    });
});

describe("fileDigest", () => {
    test("hashes a file on disk", async () => {
        const dir = await tmp();
        const f = join(dir, "f.bin");
        await writeFile(f, BODY);
        expect(await fileDigest(f)).toBe(SHA256);
        await rm(dir, { recursive: true });
    });
});
