// ============================================================================
// theme.ts — mirror the host's dark/light hint into the guest desktop.
// guestThemeScript is baked into guest-setup at provision time; ThemeSync
// re-pushes on host portal changes for a viewer session's lifetime.
// ============================================================================

import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { guestRun } from "../../vm-core/src/logs";
import { hostColorScheme, watchHostColorScheme, type ColorScheme } from "../../host-int/src/appearance";

export type { ColorScheme };

/** CRUISER_THEME_SYNC=0 disables both the provision bake and live sync. */
export function themeSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.CRUISER_THEME_SYNC !== "0";
}

const sq = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;

/**
 * Best-effort in-guest script — every line guarded, so it can embed in
 * guestSetupScript (set -eu) without aborting provisioning. Both desktops
 * are tried (spec.os.desktop can be wrong on imported disks — command -v
 * is the real gate):
 *   GNOME/GTK  → gsettings color-scheme (dconf write; a private bus works
 *                pre-login, so the dbus-run-session fallback covers the
 *                provision bake).
 *   Plasma     → plasma-apply-colorscheme (live apply + kdeglobals persist)
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
    runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/"$UUID" DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \\
        plasma-apply-colorscheme ${breeze} 2>/dev/null || \\
    runuser -u "$U" -- plasma-apply-colorscheme ${breeze} 2>/dev/null || true
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

/**
 * Mirror the host color-scheme into a guest while a viewer session is up:
 * start() pushes the current hint, then a dbus-monitor watcher re-pushes on
 * host changes until dispose(). Scoped to the session so the watcher child
 * dies with the viewer.
 */
export class ThemeSync {
    private unwatch: (() => void) | null = null;
    private last: ColorScheme | null = null;
    private pushing = false;
    private queued = false;

    constructor(
        private readonly h: VmHandle,
        private readonly log?: (msg: string) => void,
    ) {}

    start(): void {
        if (!themeSyncEnabled()) return;
        void this.push();
        this.unwatch = watchHostColorScheme(() => void this.push());
    }

    private async push(): Promise<void> {
        if (this.pushing) { this.queued = true; return; }
        this.pushing = true;
        try {
            const s = await hostColorScheme();
            // `last` only advances on success — a failed push retries on the
            // next host change instead of sticking on the attempted value.
            if (s && s !== this.last) {
                await applyColorScheme(this.h, s);
                this.last = s;
                this.log?.(`theme synced: guest → ${s}`);
            }
        } catch {
            // agent down or no guest session yet — the next host change
            // retries; a watcher must never throw.
        } finally {
            this.pushing = false;
        }
        if (this.queued) { this.queued = false; void this.push(); }
    }

    dispose(): void {
        this.unwatch?.();
        this.unwatch = null;
    }
}
