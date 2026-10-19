// ============================================================================
// autostart.ts — spec.autostart consumers.
//
// Two edges start flagged VMs:
//   1. app launch — the service starts stopped autostart VMs headless
//      (the viewer stays closed; autostart readies the guest, an explicit
//      start/view opens the console).
//   2. boot — a systemd --user oneshot unit runs `vm autostart-run`, which
//      starts the same set headless (no DISPLAY guarantee in a session
//      service, and none under lingering).
// The unit exists iff ≥1 VM is flagged — the last unflag removes it.
// ============================================================================

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { run } from "../../../sys/src/exec";

const UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT_PATH = join(UNIT_DIR, "cruiser-autostart.service");

/** argv the unit invokes. The packaged binary IS the cli (arg1 dispatch);
 *  under bun/dev, execPath is the bun binary and argv[1] the script. */
function cliArgv(): string[] {
    const exe = process.execPath;
    const script = process.argv[1];
    if (/(^|[/\\])bun([/\\]|$)/.test(exe) && script) return [exe, "run", script];
    return [exe];
}

/** Write or remove the --user unit to match `enabled`. Returns whether a
 *  unit is installed. systemctl failures are non-fatal — the unit file is
 *  the state; a missing/disabled systemd user instance just means no boot
 *  edge (app-launch autostart still works). */
export async function syncAutostartUnit(enabledNames: string[]): Promise<boolean> {
    if (enabledNames.length === 0) {
        if (!existsSync(UNIT_PATH)) return false;
        await run("systemctl", ["--user", "disable", "cruiser-autostart.service"], { noThrow: true });
        await rm(UNIT_PATH, { force: true });
        await run("systemctl", ["--user", "daemon-reload"], { noThrow: true });
        return false;
    }
    const cmd = cliArgv().map((a) => JSON.stringify(a)).join(" ");
    await mkdir(UNIT_DIR, { recursive: true });
    await writeFile(UNIT_PATH, `[Unit]
Description=Cruiser autostart VMs (${enabledNames.join(", ")})
After=default.target

[Service]
Type=oneshot
ExecStart=${cmd} vm autostart-run

[Install]
WantedBy=default.target
`);
    await run("systemctl", ["--user", "daemon-reload"], { noThrow: true });
    await run("systemctl", ["--user", "enable", "cruiser-autostart.service"], { noThrow: true });
    return true;
}

/** The set of names the boot unit + app-launch edge should start. */
export function autostartNames(vms: { spec: { name: string; autostart: boolean } }[]): string[] {
    return vms.filter((v) => v.spec.autostart).map((v) => v.spec.name);
}
