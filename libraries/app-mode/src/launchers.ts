// ============================================================================
// launchers.ts — host .desktop entries for guest apps. Each entry runs
// `cruiser app run <vm> <desktop-id>` so the host launcher menu carries
// the guest's applications directly (WinBoat-style app integration).
//
// Files land at $XDG_DATA_HOME/applications/cruiser-<vm>-<id> and are owned
// by us — uninstall sweeps that prefix (plus pulled icons) without touching
// user entries. Icons only transfer when the guest .desktop points at an
// absolute file path; themed icon names can't resolve on the host.
// ============================================================================

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import { pullFile } from "../../vm-core/src/xfer";
import { cruiserCliArgv } from "../../host-int/src/session";
import { guestAppCatalog } from "./waypipe";

const dataHome = () => process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const appsDir = () => join(dataHome(), "applications");
const iconsDir = (vm: string) => join(dataHome(), "icons", "cruiser", vm);

/** .desktop Exec tokens: double-quote only when a spec-reserved char needs it. */
function dq(s: string): string {
    return /[\s"\\$`]/.test(s) ? `"${s.replace(/(["\\$`])/g, "\\$1")}"` : s;
}

/** .desktop string values: no newlines; backslash-escape the reserved set. */
function val(s: string): string {
    return s.replace(/[\r\n]/g, " ").replace(/([\\;,])/g, "\\$1");
}

export function launcherPath(vm: string, desktopId: string): string {
    return join(appsDir(), `cruiser-${vm}-${desktopId}`);
}

/** Write host launchers for the VM's guest apps (all of them unless `ids`
 *  filters the set). Returns the .desktop files written. */
export async function installAppLaunchers(h: VmHandle, ids?: string[]): Promise<string[]> {
    const catalog = await guestAppCatalog(h);
    const picks = ids?.length ? catalog.filter((a) => ids.includes(a.id)) : catalog;
    const missing = ids?.filter((i) => !catalog.some((a) => a.id === i)) ?? [];
    if (missing.length) throw new Error(`guest has no desktop entry: ${missing.join(", ")}`);

    await mkdir(appsDir(), { recursive: true });
    const exec = [...cruiserCliArgv(), "app", "run", h.spec.name].map(dq).join(" ");
    const written: string[] = [];
    for (const app of picks) {
        let icon = "";
        // Themed names can't resolve host-side; absolute files can be pulled.
        if (app.icon?.startsWith("/")) {
            const local = join(iconsDir(h.spec.name), basename(app.icon));
            await mkdir(iconsDir(h.spec.name), { recursive: true });
            try { await pullFile(h, app.icon, local); icon = `Icon=${local}`; }
            catch { /* unreadable guest icon — the entry still works without one */ }
        }
        const body = [
            "[Desktop Entry]",
            "Type=Application",
            `Name=${val(app.name)}`,
            `Comment=${val(`${app.name} — guest app on ${h.spec.name}`)}`,
            `Exec=${exec} ${dq(app.id)}`,
            icon,
            "Terminal=false",
            "StartupNotify=true",
            `X-Cruiser-VM=${h.spec.name}`,
        ].filter(Boolean).join("\n");
        const dest = launcherPath(h.spec.name, app.id);
        await writeFile(dest, body + "\n", { mode: 0o644 });
        written.push(dest);
    }
    return written;
}

/** Remove every cruiser-<vm>-*.desktop we wrote, plus the icon stash. */
export async function uninstallAppLaunchers(h: VmHandle): Promise<string[]> {
    const prefix = `cruiser-${h.spec.name}-`;
    const removed: string[] = [];
    if (existsSync(appsDir())) {
        for (const f of await readdir(appsDir())) {
            if (!f.startsWith(prefix) || !f.endsWith(".desktop")) continue;
            const p = join(appsDir(), f);
            await rm(p);
            removed.push(p);
        }
    }
    if (existsSync(iconsDir(h.spec.name))) await rm(iconsDir(h.spec.name), { recursive: true, force: true });
    return removed;
}
