// ============================================================================
// provision.ts — top-level orchestration: cloudimg fast path + ISO install,
// first-boot with seed, guest setup, monitor layout.
// ============================================================================

import type { VmSpec } from "../../vm-core/src/config/schema";
import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import { detectAdapter } from "../../host-int/src/detect";
import { guestLayoutFromHost } from "./monitors";
import { provisionCloudimg } from "./cloudimg";
import { ensureIso, runIsoInstall } from "./iso-install";
import { waitForAgent, runGuestSetup } from "./guest-setup";
import { writePasswordFile } from "./nocloud";
import { randomBytes } from "node:crypto";

export interface ProvisionOpts {
    release?: string;              // cloudimg: distro release override (default: spec.os.release or curated)
    iso?: string;                  // iso path or URL
    username?: string;
    password?: string;             // generated if omitted
    timezone?: string;
    sshKeys?: string[];
    /** generate guest monitors.xml from live host probe (default true). */
    mirrorHostMonitors?: boolean;
    onLog?: (msg: string) => void;
}

const noop = () => {};
function log(o: ProvisionOpts, m: string) { (o.onLog ?? noop)(m); }

/** Generate + persist credentials; returns plaintext password for the run. */
async function ensurePassword(spec: VmSpec, o: ProvisionOpts): Promise<string> {
    const pw = o.password ?? randomBytes(9).toString("base64url");
    spec.credentials.username = o.username ?? spec.credentials.username;
    await writePasswordFile(spec, pw);
    return pw;
}

async function monitorsXml(spec: VmSpec, o: ProvisionOpts): Promise<string | undefined> {
    if (o.mirrorHostMonitors === false) return undefined;
    const adapter = detectAdapter();
    if (!adapter.caps.monitors) return undefined;
    const host = await adapter.monitors().catch(() => []);
    return host.length ? guestLayoutFromHost(spec.name, host).xml : undefined;
}

/** Cloud image path: fetch img → overlay disk → seed → boot → agent → setup. */
export async function provisionVmCloudimg(h: VmHandle, o: ProvisionOpts): Promise<void> {
    const spec = h.spec;
    const pw = await ensurePassword(spec, o);
    const { pubText } = await (await import("../../vm-core/src/sshkey")).ensureKeypair();
    const sshKeys = [...(o.sshKeys ?? []), pubText];
    log(o, `fetching cloud image (${spec.os.family} ${o.release ?? (spec.os.release || "default")})…`);
    const tc = await (await import("../../vm-core/src/qemu/resolve")).resolveToolchain();
    const { seedIso } = await provisionCloudimg(spec, tc.qemuImg, {
        release: o.release, username: spec.credentials.username, password: pw,
        sshKeys, timezone: o.timezone,
    });
    await h.saveSpec();

    log(o, "first boot with NoCloud seed (cloud-init provisioning)…");
    await h.start({ mode: "install", install: { seedIso } });

    log(o, "waiting for guest agent (cloud-init is installing the desktop stack — first boot is slow)…");
    await waitForAgent(h, 25 * 60_000);

    log(o, "running guest setup (rdp, autologin, monitors)…");
    const xml = await monitorsXml(spec, o);
    await runGuestSetup(h, { rdpPassword: pw, monitorsXml: xml, timeoutMs: 20 * 60_000 });

    spec.provisioned.completedAt = new Date().toISOString();
    await h.saveSpec();
    log(o, `provisioned ${spec.name} — connect with 'cruiser vm view ${spec.name}'`);
}

/** ISO path: autoinstall to disk (long), then normal boot + guest setup. */
export async function provisionVmIso(h: VmHandle, o: ProvisionOpts): Promise<void> {
    const spec = h.spec;
    const pw = await ensurePassword(spec, o);
    const { pubText } = await (await import("../../vm-core/src/sshkey")).ensureKeypair();
    const sshKeys = [...(o.sshKeys ?? []), pubText];
    const iso = o.iso!.startsWith("http") ? await ensureIso(o.iso!) : o.iso!;

    log(o, "running unattended install (watch: tail -f run/install-serial.log)…");
    await runIsoInstall(spec, { iso, username: spec.credentials.username, password: pw, sshKeys, timezone: o.timezone });
    await h.saveSpec();

    log(o, "install complete — first normal boot…");
    await h.start();
    log(o, "waiting for guest agent…");
    // first boot of a fully installed desktop is slow (gdm/snap/agent init) —
    // the 26.04 desktop ISO took ~9min to a live agent
    await waitForAgent(h, 15 * 60_000);

    log(o, "running guest setup…");
    const xml = await monitorsXml(spec, o);
    await runGuestSetup(h, { rdpPassword: pw, monitorsXml: xml });

    spec.provisioned.completedAt = new Date().toISOString();
    await h.saveSpec();
    log(o, `provisioned ${spec.name} — connect with 'cruiser vm view ${spec.name}'`);
}

/** Re-run just the in-guest setup on an already-provisioned VM. */
export async function reprovisionGuest(h: VmHandle, o: ProvisionOpts): Promise<void> {
    if (!h.isRunning()) await h.start();
    await waitForAgent(h);
    const pw = o.password ?? "";
    if (!pw && !h.spec.credentials.passwordFile) throw new Error("no password on record — pass --password");
    const { rdpPassword } = await import("../../host-int/src/freerdp");
    const password = pw || (await rdpPassword(h.spec))!;
    const xml = await monitorsXml(h.spec, o);
    await runGuestSetup(h, { rdpPassword: password, monitorsXml: xml });
    log(o, "guest setup re-applied");
}
