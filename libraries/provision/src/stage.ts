// ============================================================================
// stage.ts — push a host-side buffer to a guest path. Thin wrapper over
// vm-core/xfer's pushBuffer (QGA guest-file-write first, scp via the seeded
// cruiser key as the SELinux-confined-agent fallback). Shared by
// wallpaper.ts (PNG) and sync.ts (monitors.xml, CA certs).
// ============================================================================

import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import { pushBuffer } from "../../vm-core/src/xfer";

/** Stage `buf` at `guestPath` inside the guest. Throws when both transports fail. */
export async function pushFileToGuest(h: VmHandle, guestPath: string, buf: Buffer | string): Promise<void> {
    return pushBuffer(h, guestPath, buf);
}
