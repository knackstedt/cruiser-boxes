// ============================================================================
// windows/provision.ts — orchestrator: ISO + unattend + driver media →
// owned install run → first normal boot → QGA guest setup.
// ============================================================================

import { join } from "node:path";
import type { VmHandle } from "../../../vm-core/src/lifecycle/vm";
import { requireDiskKeyFile } from "../../../vm-core/src/disk/ops";
import { ensureIso } from "../iso-install";
import { waitForAgent } from "../guest-setup";
import { hostMirroredGuestMonitors } from "../monitors";
import { seedTimezone, gatherHostSync } from "../sync";
import { ensurePassword, log, type ProvisionOpts } from "../provision";
import { ensureWindowsIso, ensureVirtioWinIso, ensureYttrium } from "./isos";
import { buildUnattendIso, windowsHostname, windowsTimezone, windowsLocale } from "./unattend";
import { runWindowsInstall } from "./install";
import { runWindowsSetup } from "./setup";

/** Default /IMAGE/NAME for the consumer multi-edition ISOs. Custom media
 *  (Enterprise eval, retail) can carry a different image name — spec
 *  os.winEdition overrides, "" picks setup's default (single-image ISOs). */
export function defaultWinEdition(release: string): string {
    return release === "10" ? "Windows 10 Pro" : "Windows 11 Pro";
}

/** ISO path: download media → unattend install (long) → normal boot +
 *  PowerShell guest setup. */
export async function provisionVmWindows(h: VmHandle, o: ProvisionOpts): Promise<void> {
    const spec = h.spec;
    requireDiskKeyFile(spec, h.paths);
    try {
        const pw = await ensurePassword(spec, o);
        const snap = await gatherHostSync(spec);

        log(h, o, `resolving Windows ${spec.os.release || "11"} media…`);
        // a user-supplied --iso goes through ensureIso (sidecar digest when
        // the mirror publishes one); the catalog path resolves Microsoft's
        // signed URL itself (no published digest — structural check only).
        const winIso = o.iso?.startsWith("http")
            ? await ensureIso(o.iso)
            : await ensureWindowsIso(spec.os.release || "11", o.iso);
        log(h, o, `install media: ${winIso}`);

        log(h, o, "fetching virtio-win driver disc…");
        const driverIso = await ensureVirtioWinIso();

        let yttriumZip: string | undefined;
        if (spec.os.winDriver === "yttrium") {
            log(h, o, "fetching yttrium viogpu3d bundle (alpha, test-signed)…");
            yttriumZip = await ensureYttrium();
        }

        const unattendIso = await buildUnattendIso(join(h.paths.dir, "unattend"), {
            hostname: windowsHostname(spec.name),
            username: spec.credentials.username,
            password: pw,
            edition: spec.os.winEdition ?? defaultWinEdition(spec.os.release || "11"),
            timezone: windowsTimezone(await seedTimezone(spec, o.timezone)),
            locale: windowsLocale(snap.locale),
            testsigning: spec.os.winDriver === "yttrium",
            yttriumZip,
        });

        log(h, o, "running unattended install — attach `cruiser vm view " + spec.name +
            "` to watch (the installer boots on native SATA; production gets virtio)…");
        await runWindowsInstall(spec, { winIso, unattendIso, driverIso });
        await h.saveSpec();

        log(h, o, "install complete — first normal boot (drivers + testsigning take effect)…");
        await h.start({ guestMonitors: await hostMirroredGuestMonitors(spec) });
        log(h, o, "waiting for guest agent…");
        await waitForAgent(h, 10 * 60_000);

        log(h, o, "running guest setup…");
        await runWindowsSetup(h, { onLog: (m) => log(h, o, m) });

        spec.provisioned.completedAt = new Date().toISOString();
        await h.saveSpec();
        log(h, o, `provisioned ${spec.name} — connect with 'cruiser vm view ${spec.name}'`);
    } finally {
        await h.clearDiskKey();
    }
}
