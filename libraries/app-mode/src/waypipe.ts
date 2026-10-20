// ============================================================================
// appmode.ts — app-only head mode. Single guest applications appear as host
// windows. Transport is chosen by host session type:
//
//   host Wayland  → waypipe (protocol-level forwarding, no video artifacts)
//                     · vsock: host socat VSOCK-LISTEN → waypipe client sock;
//                       guest socat unix→VSOCK-CONNECT:host, waypipe server+app
//                     · ssh:   `waypipe ssh -p port user@host CMD`
//   host X11      → ssh -X (X11 forwarding; waypipe needs a host compositor
//                     to display into and simply cannot run on X11)
//
// waypipe direction (read the man page carefully — it's counterintuitive):
//   `waypipe client` runs on the COMPOSITOR side (host): listens on a socket,
//   displays whatever a matching `waypipe server` sends into $WAYLAND_DISPLAY.
//   `waypipe server -- CMD` runs on the APP side (guest): fake compositor for
//   CMD, channel socket connects back to the host client.
// ============================================================================

import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { spawnChild, which } from "../../sys/src/exec";
import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { ensureKeypair, authorizeInGuest } from "../../vm-core/src/sshkey";
import { vmPaths } from "../../vm-core/src/paths";

export const WAYPIPE_VSOCK_PORT = 9922;
const HOST_CID = 2;
const GUEST_SOCK = "/tmp/waypipe-cruiser.sock";

export interface AppLaunch {
    child: ChildProcess;
    transport: "waypipe-vsock" | "waypipe-ssh" | "ssh-x";
    command: string;
    /** Set when the transport saw the app exit immediately — e.g. a
     *  single-instance app (Chromium family) that delegated to a copy already
     *  running in the guest's own session, so the window opened inside the
     *  guest desktop instead of on the host. */
    warning?: string;
}

export class WaypipeError extends Error {}

/** Chromium-family singleton messages that mean "handed off to the copy
 *  already running inside the guest session". */
const DELEGATED_RE = /existing browser session|existing process/i;

/**
 * Watch a just-spawned launch child briefly — long enough to catch an app
 * that delegates to a running guest instance and exits, or dies on a bad
 * command line. On survival the pipes are switched to drain-noop + unref'd
 * (a full host-side pipe buffer would stall the remote's channel flow
 * control) and the child is unref'd back to detached.
 * Returns { code, out } on exit within the window, null on survival.
 */
export async function earlyWatch(child: ChildProcess, ms = 2500): Promise<{ code: number | null; out: string } | null> {
    let out = "";
    const onData = (d: Buffer) => { if (out.length < 8192) out += d.toString(); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // a spawn ENOENT still emits 'error' — unhandled it would crash the
    // host; fold it into the captured output so a nonzero close reports it
    child.on("error", (e) => { out += `spawn: ${e.message}`; });
    // 'close' waits for the stdio streams to flush — 'exit' can beat the
    // final chunk of stderr.
    const res = await new Promise<{ code: number | null; out: string } | null>((resolve) => {
        const t = setTimeout(() => resolve(null), ms);
        child.once("close", (code) => { clearTimeout(t); resolve({ code, out }); });
    });
    child.stdout?.off("data", onData);
    child.stderr?.off("data", onData);
    [child.stdout, child.stderr].forEach((s) => {
        s?.on("data", () => {});
        (s as unknown as { unref?: () => void })?.unref?.();
    });
    child.unref();
    return res;
}

/** Judge an early exit: delegated-instance → warning, nonzero → throw. */
export function judgeEarlyExit(command: string, transport: AppLaunch["transport"], early: { code: number | null; out: string }): string | undefined {
    const out = early.out.trim();
    if (DELEGATED_RE.test(out))
        return `'${command}' delegated to an instance already running in the guest session — the window opened inside the guest desktop, not on this host`;
    if (early.code !== 0)
        throw new WaypipeError(`${transport} launch of '${command}' exited ${early.code}: ${out.slice(0, 400)}`);
    return undefined;
}

/** Host-side prerequisites. */
export async function waypipeAvailable(): Promise<{ waypipe: boolean; socat: boolean }> {
    return { waypipe: !!(await which("waypipe")), socat: !!(await which("socat")) };
}

/** Does the host session have a Wayland compositor to render into? */
export function hostHasWayland(): boolean {
    if (process.env.WAYLAND_DISPLAY) return true;
    const rt = process.env.XDG_RUNTIME_DIR;
    return !!rt && existsSync(`${rt}/wayland-0`);
}

// ── guest side (via QGA, runs as root — runuser for the app itself) ──

/**
 * Ensure guest waypipe + socat and the unix→vsock bridge are running.
 * Idempotent. Guest `waypipe server` connects GUEST_SOCK → host CID:9922.
 */
export async function ensureGuestServer(h: VmHandle): Promise<void> {
    await h.guestSh(`command -v waypipe >/dev/null || {
        if command -v apt-get >/dev/null; then apt-get install -y waypipe socat;
        elif command -v dnf >/dev/null; then dnf install -y waypipe socat;
        elif command -v zypper >/dev/null; then zypper --non-interactive install waypipe socat; fi
    }`, 120_000).catch(() => {});
    const probe = await h.guestSh(`pgrep -f 'socat UNIX-LISTEN:${GUEST_SOCK}' || true`);
    if (String(probe.stdout).trim()) return; // bridge already up
    await h.guestSh(`
        nohup socat UNIX-LISTEN:${GUEST_SOCK},fork,unlink-early VSOCK-CONNECT:${HOST_CID}:${WAYPIPE_VSOCK_PORT} >/tmp/wp-bridge.log 2>&1 &
        sleep 0.5; echo bridge-up
    `, 10_000);
}

// ── host side ──

function hostSock(spec: VmSpec): string {
    return `${vmPaths(spec.name).run}/waypipe.sock`;
}

/**
 * Bring up the host half: `waypipe client` (per VM — displays incoming guest
 * app channels into the host compositor) + `socat VSOCK-LISTEN → client sock`.
 */
async function hostBridge(spec: VmSpec): Promise<ChildProcess | null> {
    const sock = hostSock(spec);
    if (!spec.network.vsock || !(await which("socat")) || !existsSync("/dev/vhost-vsock"))
        return null;
    const wp = spawnChild("waypipe", ["-s", sock, "--unlink-socket", "client"], { detached: true });
    wp.unref();
    const bridge = spawnChild("socat", [
        `VSOCK-LISTEN:${WAYPIPE_VSOCK_PORT},fork`,
        `UNIX-CONNECT:${sock}`,
    ], { detached: true });
    bridge.unref();
    await new Promise((r) => setTimeout(r, 400));
    return existsSync(sock) ? bridge : null;
}

/**
 * Launch a guest application as a host-side window.
 *   - Wayland host + vsock: waypipe client+socat on host, `waypipe server`
 *     run in the guest via QGA (returns immediately — the app is a detached
 *     guest process, so `child` is a held-open placeholder process).
 *   - Wayland host, no vsock: `waypipe ssh` single-shot.
 *   - X11 host: `ssh -X` (needs xauth in guest; setup script installs it).
 */
export async function launchApp(h: VmHandle, command: string): Promise<AppLaunch> {
    const spec = h.spec;

    if (hostHasWayland() && (await waypipeAvailable()).waypipe) {
        if (spec.network.vsock) {
            try {
                await ensureGuestServer(h);
                const bridge = await hostBridge(spec);
                if (bridge) {
                    // run `waypipe server` in the guest — it connects through the
                    // bridge to the host client and execs the app against the
                    // fake compositor it creates.
                    const u = spec.credentials.username;
                    await h.guestSh(`runuser -u ${u} -- env XDG_RUNTIME_DIR=/run/user/$(id -u ${u}) ` +
                        `nohup waypipe -s ${GUEST_SOCK} server -- ${command} >/tmp/wp-app.log 2>&1 &`, 15_000);
                    return { child: bridge, transport: "waypipe-vsock", command };
                }
            } catch { /* falls through to ssh transports */ }
        }
        const port = spec.network.sshPort;
        if (port) {
            const { priv } = await ensureKeypair();
            const child = spawnChild("waypipe", [
                "--login-shell", "ssh", "-p", String(port),
                "-i", priv, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                `${spec.credentials.username}@127.0.0.1`, command,
            ], { detached: true, stdio: "pipe" });
            const early = await earlyWatch(child);
            return { child, transport: "waypipe-ssh", command,
                     warning: early ? judgeEarlyExit(command, "waypipe-ssh", early) : undefined };
        }
    }

    const port = spec.network.sshPort;
    if (!port) throw new WaypipeError(`no usable app transport for ${spec.name} (no wayland host, no ssh port)`);
    try { await authorizeInGuest(h); } catch { /* rely on existing auth */ }
    const { priv } = await ensureKeypair();
    const child = spawnChild("ssh", [
        "-X", "-p", String(port),
        "-i", priv, "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        `${spec.credentials.username}@127.0.0.1`,
        // force X11 backend so wayland-native toolkits go through the X
        // forward instead of the guest's own compositor
        `GDK_BACKEND=x11 QT_QPA_PLATFORM=xcb ${command}`,
    ], { detached: true, stdio: "pipe" });
    const early = await earlyWatch(child);
    return { child, transport: "ssh-x", command,
             warning: early ? judgeEarlyExit(command, "ssh-x", early) : undefined };
}

/** Strip .desktop Exec field codes for running the raw command — `%U %F`…
 *  and flatpak's wrapped form (`@@u %U @@`) both go. */
export function desktopExecToCmd(exec: string): string {
    return exec
        .replace(/@@u?[^@]*@@/g, " ")
        .replace(/%[a-zA-Z]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** Enumerate guest .desktop apps via QGA. */
export interface GuestApp { id: string; name: string; exec: string; desktopFile: string; icon?: string }

export async function guestAppCatalog(h: VmHandle): Promise<GuestApp[]> {
    // guestSh runs as root — enumerate the configured user's local apps dir
    // too. Scan order is XDG precedence: user dirs first, deduped by id below.
    // Flatpak exports live outside the usual applications dirs, so a
    // provisioned flatpak browser is invisible without them.
    const u = h.spec.credentials.username;
    const r = await h.guestSh(`
        UHOME=$(getent passwd '${u}' | cut -d: -f6)
        for f in "$UHOME"/.local/share/applications/*.desktop \
                 "$UHOME"/.local/share/flatpak/exports/share/applications/*.desktop \
                 /usr/local/share/applications/*.desktop \
                 /usr/share/applications/*.desktop \
                 /var/lib/flatpak/exports/share/applications/*.desktop \
                 /var/lib/snapd/desktop/applications/*.desktop; do
            [ -f "$f" ] || continue
            name=$(grep -m1 '^Name=' "$f" | cut -d= -f2-)
            exec=$(grep -m1 '^Exec=' "$f" | cut -d= -f2-)
            icon=$(grep -m1 '^Icon=' "$f" | cut -d= -f2-)
            nodisplay=$(grep -m1 '^NoDisplay=' "$f" | cut -d= -f2-)
            [ "$nodisplay" = "true" ] && continue
            printf '%s\\t%s\\t%s\\t%s\\n' "$(basename "$f")" "$name" "$exec" "$icon"
        done`, 30_000);
    const apps: GuestApp[] = [];
    const seen = new Set<string>();
    String(r.stdout).split("\n").forEach((line) => {
        const [id, name, exec, icon] = line.split("\t");
        if (!id || !exec || seen.has(id)) return;
        seen.add(id);
        apps.push({ id, name: name || id, exec: desktopExecToCmd(exec), desktopFile: id, icon: icon || undefined });
    });
    return apps;
}
