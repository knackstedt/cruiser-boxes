// ============================================================================
// stage.ts — push a host-side buffer to a guest path. QGA guest-file-write
// first (writes to /tmp are allowed even under most policy), scp via the
// seeded cruiser key as the SELinux-confined-agent fallback. Shared by
// wallpaper.ts (PNG) and sync.ts (monitors.xml, CA certs).
// ============================================================================

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import { run } from "../../sys/src/exec";
import { ensureKeypair } from "../../vm-core/src/sshkey";

/** Stage `buf` at `guestPath` inside the guest. Throws when both transports fail. */
export async function pushFileToGuest(h: VmHandle, guestPath: string, buf: Buffer | string): Promise<void> {
    const data = typeof buf === "string" ? Buffer.from(buf) : buf;
    try {
        await h.withQga((g) => g.writeFile(guestPath, data), 30_000);
        return;
    } catch { /* agent down or confined — try ssh */ }
    const port = h.spec.network.sshPort;
    if (!port) throw new Error(`can't stage ${guestPath}: guest-file-write failed and no SSH hostfwd is mapped`);
    const { priv } = await ensureKeypair();
    const tmp = join(h.paths.run, `stage.push.${Math.random().toString(36).slice(2, 8)}`);
    await writeFile(tmp, data);
    const r = await run("scp", [
        "-i", priv, "-P", String(port),
        "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=15",
        tmp, `${h.spec.credentials.username}@127.0.0.1:${guestPath}`,
    ], { noThrow: true, timeoutMs: 60_000 });
    if (r.code !== 0)
        throw new Error(`staging ${guestPath} failed via qga and scp: ${r.stderr.slice(-300)}`);
}
