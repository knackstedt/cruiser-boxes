// ============================================================================
// theme.ts — the dark/light channel's guest script + apply helper.
// guestThemeScript is baked into guest-setup at provision time and pushed
// live by SessionSyncs (provision/sync.ts) on host portal changes for a
// viewer session's lifetime.
// ============================================================================

import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { guestRun } from "../../vm-core/src/logs";
import { sq } from "../../sys/src/exec";
import type { ColorScheme } from "../../host-int/src/appearance";

export type { ColorScheme };

/**
 * Best-effort in-guest script — every line guarded, so it can embed in
 * guestSetupScript (set -eu) without aborting provisioning. Both desktops
 * are tried (spec.os.desktop can be wrong on imported disks — command -v
 * is the real gate):
 *   GNOME/GTK  → gsettings color-scheme (dconf write; a private bus works
 *                pre-login, so the dbus-run-session fallback covers the
 *                provision bake).
 *   Plasma     → plasma-apply-colorscheme (live apply + kdeglobals persist)
 *                under QT_QPA_PLATFORM=offscreen — the QGA/ssh context has
 *                no DISPLAY or WAYLAND_DISPLAY and the Qt xcb plugin aborts;
 *                or a bare kdeglobals write for next login.
 * Light maps to 'default'/'BreezeLight' — 'default' is the "no preference"
 * enum value and renders light in practice, and older gsettings schemas
 * may not carry 'prefer-light'.
 */
export function guestThemeScript(spec: VmSpec, scheme: ColorScheme): string {
    const gs = scheme === "dark" ? "prefer-dark" : "default";
    const breeze = scheme === "dark" ? "BreezeDark" : "BreezeLight";
    return `# host theme → guest DE (scheme: ${scheme})
U=${sq(spec.credentials.username)}
UHOME=$(getent passwd "$U" | cut -d: -f6)
UUID=$(id -u "$U")
if command -v gsettings >/dev/null 2>&1; then
    runuser -u "$U" -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \\
        gsettings set org.gnome.desktop.interface color-scheme '${gs}' 2>/dev/null || \\
    runuser -u "$U" -- dbus-run-session -- \\
        gsettings set org.gnome.desktop.interface color-scheme '${gs}' 2>/dev/null || true
fi
if command -v plasma-apply-colorscheme >/dev/null 2>&1; then
    # QT_QPA_PLATFORM=offscreen: it aborts without a display env, and a
    # QGA-issued apply has neither DISPLAY nor WAYLAND_DISPLAY.
    runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/"$UUID" DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \\
        QT_QPA_PLATFORM=offscreen plasma-apply-colorscheme ${breeze} 2>/dev/null || \\
    runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/"$UUID" QT_QPA_PLATFORM=offscreen \\
        plasma-apply-colorscheme ${breeze} 2>/dev/null || \\
    { mkdir -p "$UHOME/.config" 2>/dev/null; \\
      command -v kwriteconfig6 >/dev/null 2>&1 && \\
      kwriteconfig6 --file "$UHOME/.config/kdeglobals" --group General --key ColorScheme ${breeze} 2>/dev/null && \\
      chown -R "$U:$U" "$UHOME/.config" 2>/dev/null; true; }
elif command -v kwriteconfig6 >/dev/null 2>&1; then
    mkdir -p "$UHOME/.config" 2>/dev/null || true
    kwriteconfig6 --file "$UHOME/.config/kdeglobals" --group General --key ColorScheme ${breeze} 2>/dev/null || true
    chown -R "$U:$U" "$UHOME/.config" 2>/dev/null || true
fi`;
}

/** Push one scheme into a running guest (QGA, ssh+sudo fallback via guestRun). */
export async function applyColorScheme(h: VmHandle, scheme: ColorScheme): Promise<void> {
    const r = await guestRun(h, ["/bin/sh", "-c", guestThemeScript(h.spec, scheme)], 30_000);
    if (r.code !== 0)
        throw new Error(`theme apply exited ${r.code} via ${r.transport}: ${(r.stderr || r.stdout).slice(-400)}`);
}
