// ============================================================================
// screen.ts — guest display capture.
//
// Two transports, because QEMU's `screendump` only sees consoles that have
// a QEMU-side surface: rdp/virgl VMs (virtio-gpu scanout) capture fine, but
// dmabuf VMs present guest dma-bufs straight to viewer-dd — the console has
// no surface ("no surface" error) and screendump can't see real pixels.
//
//   vm screenshot <name> [out.png]           QMP screendump (console surface)
//   vm screenshot <name> [out.png] --guest   DE-native screenshot inside the
//                                            guest (works on any viewer,
//                                            needs the desktop session up)
// ============================================================================

import type { VmHandle } from "./lifecycle/vm";
import { guestRun } from "./logs";
import { sshArgv } from "./ssh";
import { sq, run } from "../../sys/src/exec";

/** Shell run as root in the guest — RUNU drops to the desktop user with the
 *  session env the DE screenshot paths need (same shape as sync.ts's
 *  runuser preamble). Prints "shot-ok <path>" on success. */
function guestShotScript(user: string, out: string): string {
    return `
U=${sq(user)}; UUID="$(id -u "$U" 2>/dev/null || echo 1000)"
RUNU() { runuser -u "$U" -- env DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$UUID/bus" XDG_RUNTIME_DIR="/run/user/$UUID" DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 "$@"; }
OUT=${sq(out)}
rm -f "$OUT"
# GNOME Shell's own screenshot service — cursor hidden, flash on. Works on
# both GNOME X11 and Wayland; refuses silently under the lock screen.
if command -v gdbus >/dev/null 2>&1; then
    RUNU gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell/Screenshot \\
        -m org.gnome.Shell.Screenshot.Screenshot false true "$OUT" >/dev/null 2>&1 || true
fi
# KDE: spectacle's non-interactive background mode.
[ -s "$OUT" ] || { command -v spectacle >/dev/null 2>&1 && \\
    RUNU spectacle -b -o "$OUT" >/dev/null 2>&1 || true; }
# wlroots compositors.
[ -s "$OUT" ] || { command -v grim >/dev/null 2>&1 && \\
    RUNU grim "$OUT" >/dev/null 2>&1 || true; }
# last resort: ImageMagick on X11.
[ -s "$OUT" ] || { command -v import >/dev/null 2>&1 && \\
    RUNU import -window root "$OUT" >/dev/null 2>&1 || true; }
[ -s "$OUT" ] && echo "shot-ok $OUT"`;
}

/** Take a DE-native screenshot inside the guest and return the PNG bytes.
 *  Throws when no capture tool succeeded (locked screen counts as a
 *  failure on GNOME — the shell refuses grabs while locked). */
export async function guestScreenshot(h: VmHandle, timeoutMs = 45_000): Promise<Buffer> {
    const out = `/tmp/cruiser-shot-${Date.now()}.png`;
    try {
        const r = await guestRun(h, ["/bin/sh", "-c", guestShotScript(h.spec.credentials.username, out)], timeoutMs);
        if (r.code !== 0 || !r.stdout.includes("shot-ok")) {
            throw new Error(
                `no guest screenshot tool succeeded${r.stderr ? ` — ${r.stderr.trim().slice(-300)}` : ""}` +
                " (locked screen? GNOME refuses grabs while locked)",
            );
        }
        // Pull the png: QGA file-read first, ssh base64 when the agent is
        // dead (exec.ts stdout is a decoded string — raw bytes would corrupt).
        try {
            return await h.withQga((g) => g.readFile(out));
        } catch {
            const a = await sshArgv(h.spec, { remoteCmd: ["base64", out] });
            const res = await run("ssh", a, { timeoutMs });
            if (res.code !== 0) throw new Error(`couldn't pull ${out} from the guest: ${res.stderr.trim()}`);
            return Buffer.from(res.stdout.trim(), "base64");
        }
    } finally {
        await guestRun(h, ["rm", "-f", out], 10_000).catch(() => {});
    }
}
