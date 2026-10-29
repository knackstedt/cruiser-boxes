// ============================================================================
// host-cli.ts — putting a `cruiser` command on the HOST PATH.
//
// The packaged binary is the CLI (native-entry.ts dispatches cli-area argv
// to src/cli.ts), so "install the cli" means giving the host a `cruiser`
// invocation for the current install flavor:
//   deb / rpm — the package itself installs /usr/bin/cruiser → nothing to do.
//   flatpak   — a flatpak can't touch host PATH; drop wrapper scripts that
//               exec `flatpak run <app-id>` next to flatpak's own exported
//               launchers (exports/bin) and in ~/.local/bin. Runs on every
//               app start inside flatpak (idempotent) and on demand via
//               `cruiser host install-cli`.
//   appimage / dev — ~/.local/bin/cruiser → the AppImage / dev cli argv.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sq, which } from "../../sys/src/exec";
import { cruiserCliArgv } from "./session";

/** The flatpak app-id when running inside a flatpak sandbox, else null. */
export function flatpakId(): string | null {
    return process.env.FLATPAK_ID || null;
}

const MARKER = "# managed by cruiser (host-cli.ts)";

function localBin(): string {
    return join(homedir(), ".local/bin/cruiser");
}

/** Shell line the `cruiser` wrapper execs — one per install flavor. */
function cliExecLine(): string {
    const fp = flatpakId();
    if (fp) return `exec flatpak run ${sq(fp)} "$@"`;
    // Inside an AppImage, dirname(process.execPath) is the temp .mount dir —
    // the wrapper must point at the .AppImage file itself.
    if (process.env.APPIMAGE) return `exec ${sq(process.env.APPIMAGE)} "$@"`;
    return `exec ${cruiserCliArgv().map(sq).join(" ")} "$@"`;
}

/** Paths that host our `cruiser` wrapper for this install flavor. */
function cliTargets(): string[] {
    const t = [localBin()];
    // flatpak: also sit beside flatpak's own exported launchers —
    // <data>/flatpak/exports/bin is on PATH via profile.d on most distros.
    if (flatpakId()) t.unshift(join(homedir(), ".local/share/flatpak/exports/bin/cruiser"));
    return t;
}

/** Drop the host-side `cruiser` wrapper(s). Idempotent: identical content is
 *  left in place, foreign files at the target paths are never clobbered. */
export async function installHostCli(): Promise<{ installed: string[]; notes: string[] }> {
    const installed: string[] = [];
    const notes: string[] = [];
    // deb/rpm already put /usr/bin/cruiser on PATH — only write a wrapper
    // when nothing else provides the command (flatpak, appimage, dev).
    if (!flatpakId()) {
        const onPath = await which("cruiser");
        if (onPath && onPath !== localBin()) {
            notes.push(`'cruiser' already on PATH (${onPath}) — nothing installed`);
            return { installed, notes };
        }
    }
    const body = `#!/bin/sh\n${MARKER}\n${cliExecLine()}\n`;
    for (const t of cliTargets()) {
        if (existsSync(t)) {
            const cur = readFileSync(t, "utf8");
            if (cur === body) { installed.push(t); continue; }
            if (!cur.includes(MARKER)) { notes.push(`skipped ${t} — exists, not managed by cruiser`); continue; }
        }
        await mkdir(dirname(t), { recursive: true });
        await writeFile(t, body, { mode: 0o755 });
        await chmod(t, 0o755);
        installed.push(t);
    }
    return { installed, notes };
}

/** Remove only the wrappers we installed (marker-checked). */
export async function uninstallHostCli(): Promise<string[]> {
    const removed: string[] = [];
    for (const t of cliTargets()) {
        if (!existsSync(t)) continue;
        const cur = await readFile(t, "utf8").catch(() => "");
        if (!cur.includes(MARKER)) continue;
        await rm(t, { force: true });
        removed.push(t);
    }
    return removed;
}
