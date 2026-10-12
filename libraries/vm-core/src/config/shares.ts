// ============================================================================
// shares.ts — spec.shares construction helpers shared by the app-shell
// service and the cli so the two surfaces can't drift on field semantics.
// ============================================================================

import type { ShareSpec, VmSpec } from "./schema";

export interface ShareInput {
    hostPath: string;
    tag?: string;
    guestPath?: string;
    mode?: ShareSpec["mode"];
    direction?: ShareSpec["direction"];
    enabled?: boolean;
    deletions?: boolean;
}

/** First share tag not already in use: share0, share1, … */
export function unusedShareTag(spec: VmSpec): string {
    let i = 0;
    while (spec.shares.some((s) => s.tag === `share${i}`)) i++;
    return `share${i}`;
}

/**
 * Build a spec.shares entry from caller input. direction drives the legacy
 * readOnly alias (ShareSpec's transform keeps them equal downstream too).
 */
export function makeShare(spec: VmSpec, input: ShareInput): ShareSpec {
    const direction = input.direction ?? "both";
    return {
        hostPath: input.hostPath,
        tag: input.tag ?? unusedShareTag(spec),
        ...(input.guestPath ? { guestPath: input.guestPath } : {}),
        mode: input.mode ?? "mount",
        direction,
        readOnly: direction === "host-to-guest",
        enabled: input.enabled ?? true,
        deletions: input.deletions ?? false,
    };
}
