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

/** Guest→window geometry for ddViewerArgs. Both lists are in console
 *  order (= picked monitor order = virtio outputs[] order). */
export interface DdViewerGeo {
    /** "x,y x,y …" — each guest console's position in the composite
     *  desktop. Needed because the guest's single virtio tablet maps over
     *  the whole composite — QEMU does NOT add per-console offsets. */
    offsets?: string;
    /** "x,y,w,h x,y,w,h …" — picked host monitor rects in absolute px. The
     *  viewer self-positions one window over their union and spans it via
     *  _NET_WM_FULLSCREEN_MONITORS (freerdp /multimon semantics). */
    rects?: string;
}

/** viewer-dd argv — pure builder (tested like freerdpArgs). `escapes` are
 *  "<keys>=<action>" pairs ({vm}/{cli} expanded by the caller) — under
 *  --grab the WM's global bindings can't fire, so the viewer recognizes
 *  the combos itself and dispatches the actions. `proxySock` attaches the
 *  viewer to the per-VM ddproxy broker instead of minting fresh QEMU
 *  @dbus-display channels; viewer-dd falls back to the direct channel if
 *  the socket is dead, so passing a stale path is safe. */
export function ddViewerArgs(spec: VmSpec, monitorSock: string, geo?: DdViewerGeo, escapes?: string[], proxySock?: string): string[] {
    const { w, h } = spec.display.windowSize;
    const argv = [monitorSock, "--title", `cruiser:${spec.name}`, "--size", `${w}x${h}`];
    if (proxySock) argv.push("--proxy", proxySock);
    if (geo?.offsets) argv.push("--offsets", geo.offsets);
    if (geo?.rects) argv.push("--rects", geo.rects);
    if (!spec.display.clipboard) argv.push("--no-clipboard");
    // --grab: XGrabKeyboard while the window is focused (freerdp
    // +grab-keyboard analog — guest sees alt-tab etc. instead of the host WM)
    if (spec.display.grabKeyboard) argv.push("--grab");
    // --relmouse: pointer-lock capture policy — the viewer flips QEMU's
    // active handler between the PS/2 mouse (RelMotion deltas) and the
    // virtio tablet per its state machine
    argv.push("--relmouse", spec.display.pointerLock);
    (escapes ?? []).forEach((e) => argv.push("--escape", e));
    return argv;
}

/**
 * Launch the dmabuf viewer process; returns immediately (caller waits for
 * window). `geo.offsets`/`geo.rects` describe the guest composite and the
 * picked host monitors — see DdViewerGeo.
 */
export async function launchDdViewer(spec: VmSpec, geo?: DdViewerGeo, escapes?: string[]): Promise<ViewerLaunch> {
    const bin = await ddViewerPath();
    if (!bin) throw new Error("viewer-dd not found — cargo build --release in viewer-dd/ (or install it on PATH)");
    const paths = vmPaths(spec.name);
    // ddproxy binds its socket only AFTER the QEMU-side conns are attached,
    // so an existing socket means the broker is fully up.
    const proxySock = existsSync(paths.ddproxySock) ? paths.ddproxySock : undefined;
    const argv = ddViewerArgs(spec, paths.monitorSock, geo, escapes, proxySock);
    const child = spawnChild(bin, argv, {
        detached: true,
        logFile: join(paths.run, "viewer-dd.log"),
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
