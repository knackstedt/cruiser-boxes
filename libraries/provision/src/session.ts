// ============================================================================
// session.ts — the shared viewer-session kit: open the viewer (rdp freerdp
// or dmabuf viewer-dd) and wire the session-lifetime host→guest syncs.
// Both entry surfaces (app-shell CruiserService + src/cli.ts) call this
// instead of duplicating the wiring — the "closed" hook disposes every
// sync so nothing outlives the window.
// ============================================================================

import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import { ViewerSession, type ViewerSessionOpts } from "../../host-int/src/session";
import { SessionSyncs } from "./sync";
import { FileSyncs } from "./filesync";

export interface VmSessionOpts extends ViewerSessionOpts {
    /** Progress/diag — the service routes it to store status, cli to console. */
    log?: (msg: string) => void;
}

export interface VmSession {
    readonly viewer: ViewerSession;
    /** Stop the sync engines (watchers, forwards, filesync timers).
     *  Does NOT close the viewer window. Idempotent; also runs
     *  automatically when the viewer exits. */
    disposeSyncs(): void;
}

/**
 * Open the VM's viewer and start everything that rides the session:
 * SessionSyncs (portal/timezone live channels + hash-gated one-shots +
 * optional agent forward), FileSyncs (copy-mode shares), and the
 * managed-wallpaper pass (fire-and-forget — a dead agent or slow jimp
 * decode mustn't delay the viewer).
 */
export async function openVmSession(h: VmHandle, opts: VmSessionOpts = {}): Promise<VmSession> {
    const viewer = new ViewerSession(h.spec, opts);
    await viewer.open();

    const syncs = new SessionSyncs(h, opts.log);
    syncs.start();
    const filesyncs = new FileSyncs(h, opts.log);
    filesyncs.start();

    let disposed = false;
    const disposeSyncs = () => {
        if (disposed) return;
        disposed = true;
        syncs.dispose();
        filesyncs.dispose();
    };
    viewer.on("closed", disposeSyncs);

    void import("./wallpaper").then(({ ensureGuestWallpaper }) =>
        ensureGuestWallpaper(h, opts.log)).catch(() => {});

    return { viewer, disposeSyncs };
}
