// ============================================================================
// boot-diff.ts — the argv-relevant spec diff.
//
// A running QEMU was launched with a fixed argv — spec fields that feed
// buildArgs (or the virtiofsd companions) can't change underneath it; they
// apply at the next boot. Everything else is live: display headMode/
// virtualDesktop/wallpaper, persist, sync channels, and share metadata all
// drive the viewer session and guest-side sync scripts, which re-read the
// spec each pass.
//
// bootRelevantChanges is the single source for "needs restart":
//   - mergePulledSpec's needsRestart report (config pull)
//   - VmHandle.pendingRestart — diffs run/launch-spec.json (the spec
//     snapshot start() writes at launch) against the current spec
// ============================================================================

import type { VmSpec } from "./schema";

/** The boot-frozen slices of a spec — mirrors what buildArgs/start() read.
 *
 *  shares keep only {hostPath, tag}: enabled/mode fold into membership of
 *  the filtered list, while direction/readOnly/guestPath/deletions are
 *  guest-fstab + filesync state — the shares sync channel reconciles those
 *  live. usb keeps {vendorId, productId} — usb-host argv carries no serial.
 *  disk keeps {file, format} — sizeGiB is a qemu-img resize property, and
 *  growth is already refused while the VM runs. */
function bootSlice(s: VmSpec) {
    return {
        resources: s.resources,
        disk: { file: s.disk.file, format: s.disk.format },
        gpu: s.gpu,
        display: {
            viewer: s.display.viewer,
            clipboard: s.display.clipboard,
            // guest monitor topology lands in the GPU device's outputs[].
            monitors: s.display.monitors,
        },
        network: s.network,
        usb: s.usb.autoAttach.filter((u) => u.atBoot)
            .map((u) => ({ vendorId: u.vendorId, productId: u.productId })),
        shares: s.shares.filter((x) => x.enabled !== false && x.mode !== "copy")
            .map((x) => ({ hostPath: x.hostPath, tag: x.tag })),
    };
}

/** Section names that differ between two specs and need a VM restart to
 *  take effect. Empty = every difference applies live. */
export function bootRelevantChanges(a: VmSpec, b: VmSpec): string[] {
    const sa = bootSlice(a);
    const sb = bootSlice(b);
    return (Object.keys(sa) as (keyof typeof sa)[])
        .filter((k) => JSON.stringify(sa[k]) !== JSON.stringify(sb[k]));
}
