// ============================================================================
// ddproxy.ts — per-VM display broker lifecycle.
//
// QEMU's -display dbus backend keeps effectively ONE client relationship
// and can wedge its in-process p2p auth permanently ("EXTERNAL rejected")
// after enough viewer attach/detach churn — the only repair is a QEMU
// restart. ddproxy holds the QEMU-side connection set (control + per-console
// listeners + input/clipboard) for the VM's whole uptime and re-exports the
// same org.qemu.Display1 object tree on run/ddproxy.sock, so viewer churn
// never reaches QEMU's auth surface.
//
// Spawned detached at VM start for display.viewer=dmabuf (default-on) and
// self-exits via its own qemu.pid watchdog when the VM dies/restarts.
// Absence is never fatal: viewer-dd falls back to the direct QMP channel.
// ============================================================================

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnChild, which } from "../../../sys/src/exec";
import { appendVmLog } from "../logs";
import type { VmPaths } from "../paths";

/** Resolve the ddproxy binary: PATH → packaged appdir → repo target dirs —
 *  the same convention ddViewerPath() uses for viewer-dd. */
export async function ddproxyPath(): Promise<string | null> {
    const onPath = await which("ddproxy");
    if (onPath) return onPath;
    const packaged = join(dirname(process.execPath), "native", "ddproxy");
    if (existsSync(packaged)) return packaged;
    // dev: libraries/vm-core/src/lifecycle → repo root
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const rels = ["ddproxy/target/release/ddproxy", "ddproxy/target/debug/ddproxy"];
    for (let i = 0; i < rels.length; i++) {
        const p = join(root, rels[i]!);
        if (existsSync(p)) return p;
    }
    return null;
}

/** Live-broker check: pidfile + comm match (pid reuse safe). */
export function ddproxyAlive(paths: VmPaths): boolean {
    let pid: number;
    try {
        pid = Number(readFileSync(paths.ddproxyPid, "utf-8").split("\n", 1)[0]!.trim());
    } catch { return false; }
    if (!pid) return false;
    try {
        return readFileSync(`/proc/${pid}/comm`, "utf-8").trim() === "ddproxy";
    } catch { return false; }
}

/** Kill any broker reachable via its pidfile (orphans of a dead launcher,
 *  strays of a failed start) and drop stale socket/pid files. The broker
 *  would self-exit on QEMU's death anyway — this just makes it immediate. */
export function killDdproxy(paths: VmPaths): void {
    try {
        const pid = Number(readFileSync(paths.ddproxyPid, "utf-8").split("\n", 1)[0]!.trim());
        if (pid && readFileSync(`/proc/${pid}/comm`, "utf-8").trim() === "ddproxy")
            try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
    } catch { /* no pidfile */ }
    rmSync(paths.ddproxySock, { force: true });
    rmSync(paths.ddproxyPid, { force: true });
}

// Last-spawn stamps per VM dir — a crash-looping broker must not respawn in
// a poll loop (each respawn mints fresh QEMU add_client channels, which is
// the auth churn the broker exists to avoid).
const lastSpawn = new Map<string, number>();

/** Detached broker spawn — detached like virtiofsd/the viewer: QEMU
 *  (-daemonize) outlives the launching session and the broker must match
 *  that lifetime. Never throws: a missing binary or spawn failure just
 *  leaves the viewer on the direct path. The 60s attach retry inside
 *  ddproxy covers the QMP-up/display-backend-init race. `respawn` suppresses
 *  the spawn when one already ran recently (adopt path on probe()). */
export async function spawnDdproxy(paths: VmPaths, opts: { respawn?: boolean } = {}): Promise<void> {
    if (ddproxyAlive(paths)) return;
    const now = Date.now();
    if (opts.respawn && now - (lastSpawn.get(paths.dir) ?? 0) < 30_000) return;
    const bin = await ddproxyPath();
    if (!bin) return;
    rmSync(paths.ddproxySock, { force: true });
    rmSync(paths.ddproxyPid, { force: true });
    lastSpawn.set(paths.dir, now);
    const c = spawnChild(bin, [
        "--monitor", paths.monitorSock,
        "--sock", paths.ddproxySock,
        "--pidfile", paths.ddproxyPid,
    ], { detached: true, logFile: paths.ddproxyLog });
    c.unref();
    c.on("exit", (code) =>
        void appendVmLog(paths, `ddproxy exited (code ${code})`));
}
