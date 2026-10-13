// ============================================================================
// ssh.ts — the single ssh argv builder for guest connections.
//
// Every ssh into a guest shares the same shape: cruiser key, hostfwd port on
// 127.0.0.1, BatchMode, throwaway known_hosts. Used by the journal fallback
// (logs.ts), the embedded terminal (term-dd spawns `ssh -tt` in its PTY),
// the CLI (`vm ssh`/`vm term`), and the host-terminal fallback.
// ============================================================================

import type { VmSpec } from "./config/schema";
import { ensureKeypair } from "./sshkey";

export interface SshArgvOpts {
    /** Allocate a pseudo-tty (`-tt`) — interactive sessions only; the
     *  journal fallback must not ask for one. */
    tty?: boolean;
    /** Command to run on the guest (appended after `--`). */
    remoteCmd?: string[];
    /** Extra -o options (e.g. RequestTTY already covered by `tty`). */
    extraOpts?: string[];
}

/**
 * ssh argv for reaching this VM's guest over the hostfwd port.
 * Throws when the spec has no sshPort mapped — unprovisioned/imported
 * specs can legitimately lack one.
 */
export async function sshArgv(spec: VmSpec, opts: SshArgvOpts = {}): Promise<string[]> {
    const port = spec.network.sshPort;
    if (!port) throw new Error(`vm ${spec.name} has no SSH hostfwd — provision it (or map a port) first`);
    const { priv } = await ensureKeypair();
    const a = [
        ...(opts.tty ? ["-tt"] : []),
        "-i", priv, "-p", String(port),
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=10",
        ...(opts.extraOpts ?? []),
        `${spec.credentials.username}@127.0.0.1`,
    ];
    if (opts.remoteCmd?.length) a.push(...opts.remoteCmd);
    return a;
}

/** Human-readable target for status lines: "user@127.0.0.1:2222". */
export function sshTarget(spec: VmSpec): string {
    return `${spec.credentials.username}@127.0.0.1:${spec.network.sshPort ?? "?"}`;
}
