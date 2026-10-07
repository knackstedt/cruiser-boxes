// ============================================================================
// waypipe.ts — app-only head mode. Single-app windows streamed host↔guest
// via waypipe (protocol-level forwarding, no video compression artifacts).
//
// Transport preference: vsock (guest-cid bridge via socat) → ssh fallback.
//
//   guest:  waypipe -s /tmp/wp.sock server  +  socat VSOCK-LISTEN:fork→unix
//   host:   socat UNIX-LISTEN:wp-host.sock,fork → VSOCK-CONNECT:cid:port
//   app:    waypipe -s wp-host.sock client <command>
// ============================================================================

import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { spawnChild, which, run } from "../../sys/src/exec";
import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { guestCid } from "../../vm-core/src/qemu/args";
import { vmPaths } from "../../vm-core/src/paths";

export const WAYPIPE_VSOCK_PORT = 9922;
const GUEST_SOCK = "/tmp/waypipe-cruiser.sock";

export interface AppLaunch {
    child: ChildProcess;
    transport: "vsock" | "ssh";
    command: string;
}

export class WaypipeError extends Error {}

/** Host-side prerequisites. */
export async function waypipeAvailable(): Promise<{ waypipe: boolean; socat: boolean }> {
    return { waypipe: !!(await which("waypipe")), socat: !!(await which("socat")) };
}

// ── guest side (via QGA) ──

/**
 * Install + start the guest waypipe server and vsock→unix bridge.
 * Idempotent. Requires `waypipe` and `socat` inside the guest (the guest
 * setup script installs them; apt fallback attempted here).
 */
export async function ensureGuestServer(h: VmHandle): Promise<void> {
    await h.guestSh(`command -v waypipe >/dev/null || sudo -n apt-get install -y waypipe socat`, 120_000).catch(() => {});
    const probe = await h.guestSh(`pgrep -f 'waypipe -s ${GUEST_SOCK} server' || true`);
    if (String(probe.stdout).trim()) return; // already running
    await h.guestSh(`
        nohup waypipe -s ${GUEST_SOCK} server >/tmp/waypipe-server.log 2>&1 &
        nohup socat VSOCK-LISTEN:${WAYPIPE_VSOCK_PORT},fork UNIX-CONNECT:${GUEST_SOCK} >/tmp/wp-bridge.log 2>&1 &
        sleep 0.5; echo bridge-up
    `, 10_000);
}

// ── host side ──

function hostSock(spec: VmSpec): string {
    return `${vmPaths(spec.name).run}/waypipe.sock`;
}

/** Bring up the host bridge; returns the unix socket the client should use. */
async function hostBridge(spec: VmSpec): Promise<{ socket: string; transport: "vsock" | "ssh"; bridge?: ChildProcess }> {
    const sock = hostSock(spec);
    if (spec.network.vsock && (await which("socat")) && existsSync("/dev/vhost-vsock")) {
        const bridge = spawnChild("socat", [
            `UNIX-LISTEN:${sock},fork,unlink-early`,
            `VSOCK-CONNECT:${guestCid(spec.name)}:${WAYPIPE_VSOCK_PORT}`,
        ], { detached: true });
        bridge.unref();
        // give socat a beat to bind
        await new Promise((r) => setTimeout(r, 300));
        if (existsSync(sock)) return { socket: sock, transport: "vsock", bridge };
    }
    return { socket: "", transport: "ssh" };
}

/**
 * Launch a guest application as a host-side window.
 *  - vsock: bridge socket + `waypipe -s sock client CMD`
 *  - ssh:   `waypipe ssh -p <port> user@127.0.0.1 CMD` (needs key auth or sshpass)
 */
export async function launchApp(h: VmHandle, command: string): Promise<AppLaunch> {
    const wp = await waypipeAvailable();
    if (!wp.waypipe) throw new WaypipeError("waypipe not installed on host (apt install waypipe)");

    const spec = h.spec;
    // vsock needs the guest bridge; ssh needs nothing extra.
    let br: Awaited<ReturnType<typeof hostBridge>> = { socket: "", transport: "ssh" };
    if (spec.network.vsock) {
        try { await ensureGuestServer(h); } catch { /* falls back to ssh */ }
        br = await hostBridge(spec);
    }

    if (br.transport === "vsock") {
        const child = spawnChild("waypipe", ["-s", br.socket, "client", command], { detached: true });
        child.unref();
        return { child, transport: "vsock", command };
    }

    const port = spec.network.sshPort;
    if (!port) throw new WaypipeError("no sshPort on spec and vsock unavailable");
    const child = spawnChild("waypipe", [
        "--login-shell", "ssh", "-p", String(port), "-o", "StrictHostKeyChecking=no",
        `${spec.credentials.username}@127.0.0.1`, command,
    ], { detached: true });
    child.unref();
    return { child, transport: "ssh", command };
}

/** Enumerate guest .desktop apps via QGA. */
export interface GuestApp { id: string; name: string; exec: string; desktopFile: string }

export async function guestAppCatalog(h: VmHandle): Promise<GuestApp[]> {
    const r = await h.guestSh(`
        for f in /usr/share/applications/*.desktop "$HOME"/.local/share/applications/*.desktop; do
            [ -f "$f" ] || continue
            name=$(grep -m1 '^Name=' "$f" | cut -d= -f2-)
            exec=$(grep -m1 '^Exec=' "$f" | cut -d= -f2-)
            nodisplay=$(grep -m1 '^NoDisplay=' "$f" | cut -d= -f2-)
            [ "$nodisplay" = "true" ] && continue
            printf '%s\\t%s\\t%s\\n' "$(basename "$f")" "$name" "$exec"
        done`, 30_000);
    const apps: GuestApp[] = [];
    for (const line of String(r.stdout).split("\n")) {
        const [id, name, exec] = line.split("\t");
        if (!id || !exec) continue;
        // strip .desktop field codes (%U %F etc.) — waypipe runs the raw command
        const cmd = exec.replace(/%[a-zA-Z]/g, "").replace(/\s+/g, " ").trim();
        apps.push({ id, name: name || id, exec: cmd, desktopFile: id });
    }
    return apps;
}
