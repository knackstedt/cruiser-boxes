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
 *  disk keeps {file, format, encrypt, keyStorage, homeGiB} — sizeGiB is a
 *  qemu-img resize property (growth is already refused while the VM runs),
 *  while the encrypt fields drive argv (the -object secret / key-secret /
 *  home-blk drive) and are create-time only. */
function bootSlice(s: VmSpec) {
    return {
        resources: s.resources,
        disk: { file: s.disk.file, format: s.disk.format,
            encrypt: s.disk.encrypt, keyStorage: s.disk.keyStorage, homeGiB: s.disk.homeGiB },
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

/** Key-order-insensitive JSON.stringify. Runtime code appends spec fields
 *  after zod parse (registry's sshPort/rdpPort, buildArgv's renderNode), so
 *  a re-parsed launch snapshot carries canonical schema order while the
 *  same-process spec holds append order — identical values, different
 *  JSON.stringify output, phantom "restart pending". Object keys sort;
 *  array order stays significant (shares index ↔ virtiofsd socket). */
function stable(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    if (v && typeof v === "object")
        return `{${Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
            .join(",")}}`;
    return JSON.stringify(v);
}

/** Section names that differ between two specs and need a VM restart to
 *  take effect. Empty = every difference applies live. */
export function bootRelevantChanges(a: VmSpec, b: VmSpec): string[] {
    const sa = bootSlice(a);
    const sb = bootSlice(b);
    return (Object.keys(sa) as (keyof typeof sa)[])
        .filter((k) => stable(sa[k]) !== stable(sb[k]));
}
