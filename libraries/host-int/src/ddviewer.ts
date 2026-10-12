// ============================================================================
// ddviewer.ts — launch the dma-buf direct-display viewer (viewer-dd).
//
// The binary connects to QEMU's D-Bus display backend over the VM's QMP
// monitor socket and presents exported scanouts zero-copy (dma-buf → EGL).
// Needs QEMU launched with -display dbus (args.ts handles that when
// spec.display.viewer === "dmabuf").
// ============================================================================

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { vmPaths } from "../../vm-core/src/paths";
import { spawnChild, which } from "../../sys/src/exec";

export interface ViewerLaunch { child: ChildProcess; argv: string[] }

/** Resolve the viewer-dd binary: packaged PATH lookup → repo target dirs. */
export async function ddViewerPath(): Promise<string | null> {
    const onPath = await which("viewer-dd");
    if (onPath) return onPath;
    // dev: libraries/host-int/src → repo root
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const rels = ["viewer-dd/target/release/viewer-dd", "viewer-dd/target/debug/viewer-dd"];
    for (let i = 0; i < rels.length; i++) {
        const p = join(root, rels[i]!);
        if (existsSync(p)) return p;
    }
    return null;
}

/**
 * Launch the dmabuf viewer process; returns immediately (caller waits for
 * window). `offsets` = each guest console's position in the composite
 * desktop (console order = virtio outputs[] order = picked monitor order),
 * needed because the guest's single virtio tablet maps over the whole
 * composite — QEMU does NOT add per-console offsets for us.
 */
export async function launchDdViewer(spec: VmSpec, offsets?: string): Promise<ViewerLaunch> {
    const bin = await ddViewerPath();
    if (!bin) throw new Error("viewer-dd not found — cargo build --release in viewer-dd/ (or install it on PATH)");
    const monitorSock = vmPaths(spec.name).monitorSock;
    const { w, h } = spec.display.windowSize;
    const argv = [monitorSock, "--title", `cruiser:${spec.name}`, "--size", `${w}x${h}`];
    if (offsets) argv.push("--offsets", offsets);
    if (!spec.display.clipboard) argv.push("--no-clipboard");
    const child = spawnChild(bin, argv, {
        detached: true,
        logFile: join(vmPaths(spec.name).run, "viewer-dd.log"),
    });
    child.unref();
    return { child, argv };
}

/** Poll until the QMP monitor socket exists (QEMU up). */
export async function waitMonitorSock(spec: VmSpec, timeoutMs = 15_000): Promise<boolean> {
    const sock = vmPaths(spec.name).monitorSock;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(sock)) return true;
        await new Promise((r) => setTimeout(r, 200));
    }
    return false;
}
