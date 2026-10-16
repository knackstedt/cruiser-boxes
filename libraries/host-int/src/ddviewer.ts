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

/** Resolve the viewer-dd binary: PATH → packaged appdir → repo target dirs.
 *  Releases stage it via the engine's game-native convention:
 *  `toolchain/stage-viewer-dd.mts` drops it into native/dist/<plat>-<arch>/
 *  and the packager copies that whole dir to <appdir>/native/, where
 *  dirname(process.execPath) == appdir root anchors the lookup. */
export async function ddViewerPath(): Promise<string | null> {
    const onPath = await which("viewer-dd");
    if (onPath) return onPath;
    const packaged = join(dirname(process.execPath), "native", "viewer-dd");
    if (existsSync(packaged)) return packaged;
    // dev: libraries/host-int/src → repo root
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const rels = ["viewer-dd/target/release/viewer-dd", "viewer-dd/target/debug/viewer-dd"];
    for (let i = 0; i < rels.length; i++) {
        const p = join(root, rels[i]!);
        if (existsSync(p)) return p;
    }
    return null;
}

/** viewer-dd argv — pure builder (tested like freerdpArgs). `escapes` are
 *  "<keys>=<action>" pairs ({vm}/{cli} expanded by the caller) — under
 *  --grab the WM's global bindings can't fire, so the viewer recognizes
 *  the combos itself and dispatches the actions. */
export function ddViewerArgs(spec: VmSpec, monitorSock: string, offsets?: string, escapes?: string[]): string[] {
    const { w, h } = spec.display.windowSize;
    const argv = [monitorSock, "--title", `cruiser:${spec.name}`, "--size", `${w}x${h}`];
    if (offsets) argv.push("--offsets", offsets);
    if (!spec.display.clipboard) argv.push("--no-clipboard");
    // --grab: XGrabKeyboard while a head is focused (freerdp +grab-keyboard
    // analog — guest sees alt-tab etc. instead of the host WM)
    if (spec.display.grabKeyboard) argv.push("--grab");
    (escapes ?? []).forEach((e) => argv.push("--escape", e));
    return argv;
}

/**
 * Launch the dmabuf viewer process; returns immediately (caller waits for
 * window). `offsets` = each guest console's position in the composite
 * desktop (console order = virtio outputs[] order = picked monitor order),
 * needed because the guest's single virtio tablet maps over the whole
 * composite — QEMU does NOT add per-console offsets for us.
 */
export async function launchDdViewer(spec: VmSpec, offsets?: string, escapes?: string[]): Promise<ViewerLaunch> {
    const bin = await ddViewerPath();
    if (!bin) throw new Error("viewer-dd not found — cargo build --release in viewer-dd/ (or install it on PATH)");
    const argv = ddViewerArgs(spec, vmPaths(spec.name).monitorSock, offsets, escapes);
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
