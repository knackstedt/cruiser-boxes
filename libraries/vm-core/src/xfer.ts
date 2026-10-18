// ============================================================================
// xfer.ts — file transfer host↔guest.
//
// QGA guest-file-* is the primary transport; scp via the seeded cruiser key
// (over the ssh hostfwd) is the fallback for SELinux-confined agents
// (Fedora's virt_qemu_ga_t) or a dead/mid-boot agent. Pulls read via QGA or
// `base64` over ssh — exec.ts stdout is a decoded string, so raw bytes ride
// inside base64.
// ============================================================================

import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { VmHandle } from "./lifecycle/vm";
import { run, sq } from "../../sys/src/exec";
import { ensureKeypair } from "./sshkey";
import { sshArgv } from "./ssh";

/** ~ expansion for transports that don't shell-expand (QGA guest-file-*).
 *  scp/ssh get the ORIGINAL string — the remote shell expands it itself. */
function expandGuestPath(h: VmHandle, p: string): string {
    const home = h.spec.credentials.username === "root" ? "/root" : `/home/${h.spec.credentials.username}`;
    if (p === "~") return home;
    if (p.startsWith("~/")) return home + p.slice(1);
    return p;
}

/** QGA guest-file-write runs as root — a file dropped into the user's home
 *  ends up root-owned and unwritable to them. chown it back whenever the
 *  destination sits under the login user's home. */
async function chownIfHome(h: VmHandle, dest: string): Promise<void> {
    const u = h.spec.credentials.username;
    const home = u === "root" ? "/root" : `/home/${u}`;
    if (!dest.startsWith(`${home}/`) || u === "root") return;
    await h.withQga((g) => g.sh(`chown ${u}:${u} ${sq(dest)}`), 10_000).catch(() => {});
}

async function scpArgv(h: VmHandle, localPath: string, guestPath: string): Promise<string[]> {
    const port = h.spec.network.sshPort;
    if (!port) throw new Error("no SSH hostfwd is mapped for the scp fallback");
    const { priv } = await ensureKeypair();
    return [
        "-i", priv, "-P", String(port),
        "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=15",
        localPath, `${h.spec.credentials.username}@127.0.0.1:${guestPath}`,
    ];
}

/** Stage `buf` at `guestPath` inside the guest. Throws when both transports fail. */
export async function pushBuffer(h: VmHandle, guestPath: string, buf: Buffer | string): Promise<void> {
    const data = typeof buf === "string" ? Buffer.from(buf) : buf;
    const dest = expandGuestPath(h, guestPath);
    try {
        await h.withQga((g) => g.writeFile(dest, data), 30_000);
        await chownIfHome(h, dest);
        return;
    } catch { /* agent down or confined — try ssh */ }
    const tmp = join(h.paths.run, `xfer.push.${Math.random().toString(36).slice(2, 8)}`);
    await writeFile(tmp, data);
    try {
        const a = await scpArgv(h, tmp, guestPath);
        const r = await run("scp", a, { noThrow: true, timeoutMs: 120_000 });
        if (r.code !== 0)
            throw new Error(`staging ${guestPath} failed via qga and scp: ${r.stderr.slice(-300)}`);
    } finally {
        await rm(tmp, { force: true }).catch(() => {});
    }
}

/** Copy a local file into the guest. `guestPath` may be a file or a dir
 *  (dir destinations ride straight to scp — QGA can't express them). */
export async function pushFile(h: VmHandle, localPath: string, guestPath: string): Promise<void> {
    const dest = expandGuestPath(h, guestPath);
    const data = await readFile(localPath);
    try {
        await h.withQga((g) => g.writeFile(dest, data), 60_000);
        await chownIfHome(h, dest);
        return;
    } catch { /* QGA write failed or path is a dir — scp handles both */ }
    const a = await scpArgv(h, localPath, guestPath);
    const r = await run("scp", a, { noThrow: true, timeoutMs: 300_000 });
    if (r.code !== 0)
        throw new Error(`push ${localPath} → ${guestPath} failed: ${r.stderr.slice(-300)}`);
}

/** Copy a guest file to the host. Returns the transport used. */
export async function pullFile(h: VmHandle, guestPath: string, localPath: string): Promise<"qga" | "ssh"> {
    const src = expandGuestPath(h, guestPath);
    let qgaErr: unknown;
    try {
        await writeFile(localPath, await h.withQga((g) => g.readFile(src), 120_000));
        return "qga";
    } catch (e) { qgaErr = e; }
    const a = await sshArgv(h.spec, { remoteCmd: ["base64", src] });
    const r = await run("ssh", a, { timeoutMs: 300_000 });
    if (r.code !== 0)
        throw new Error(`pull ${guestPath} failed — qga: ${qgaErr instanceof Error ? qgaErr.message : qgaErr}; ssh: ${r.stderr.slice(-300)}`);
    await writeFile(localPath, Buffer.from(r.stdout, "base64"));
    return "ssh";
}
