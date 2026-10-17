// ============================================================================
// provision.ts — top-level orchestration: cloudimg fast path + ISO install,
// first-boot with seed, guest setup, monitor layout.
// ============================================================================

import { VmSpec } from "../../vm-core/src/config/schema";
import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import { appendVmLog } from "../../vm-core/src/logs";
import { requireDiskKeyFile } from "../../vm-core/src/disk/ops";
import { detectAdapter } from "../../host-int/src/detect";
import { guestLayoutFromHost, hostMirroredGuestMonitors } from "./monitors";
import { provisionCloudimg } from "./cloudimg";
import { ensureIso, runIsoInstall } from "./iso-install";
import { waitForAgent, runGuestSetup } from "./guest-setup";
import { applyHostScale, gatherHostSync, seedTimezone, syncEnabled, type HostSnapshot } from "./sync";
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
    /** bake the host's dark/light hint into the guest (default true). */
    syncHostTheme?: boolean;
    onLog?: (msg: string) => void;
}

const noop = () => {};
function log(h: VmHandle, o: ProvisionOpts, m: string) {
    (o.onLog ?? noop)(m);
    // tee into run/cruiser.log — the runner journal the Logs screen reads
    void appendVmLog(h.paths, m);
}

/** Generate + persist credentials; returns plaintext password for the run. */
async function ensurePassword(spec: VmSpec, o: ProvisionOpts): Promise<string> {
    const pw = o.password ?? randomBytes(9).toString("base64url");
    // o.username is unchecked CLI/UI input — run it through the schema regex
    // (POSIX username) since it lands in cloud-init YAML and guest shell.
    if (o.username) spec.credentials.username = VmSpec.shape.credentials.unwrap().shape.username.parse(o.username);
    await writePasswordFile(spec, pw);
    return pw;
}

async function monitorsXml(spec: VmSpec, o: ProvisionOpts): Promise<string | undefined> {
    if (o.mirrorHostMonitors === false || !syncEnabled(spec, "monitors")) return undefined;
    const adapter = detectAdapter();
    if (!adapter.caps.monitors) return undefined;
    const host = await applyHostScale(spec, await adapter.monitors().catch(() => []));
    return host.length ? guestLayoutFromHost(spec.name, host).xml : undefined;
}

/** Host values for the guest-setup bake — every field channel-gated by
 *  spec.sync + env. The legacy syncHostTheme opt only strips the scheme. */
async function hostSnapshot(spec: VmSpec, o: ProvisionOpts): Promise<HostSnapshot> {
    const s = await gatherHostSync(spec);
    if (o.syncHostTheme === false) delete s.scheme;
    return s;
}

/** Push the managed wallpaper + shortcuts doc after guest setup. Best-effort:
 *  a wallpaper failure must never fail provisioning, and a no-live-session
 *  guest just records `staged` — the session-start sync retries. */
async function wallpaperApply(h: VmHandle, o: ProvisionOpts): Promise<void> {
    try {
        const { ensureGuestWallpaper } = await import("./wallpaper");
        await ensureGuestWallpaper(h, (m) => log(h, o, `wallpaper: ${m}`), { force: true });
    } catch (e) {
        log(h, o, `wallpaper: ${e instanceof Error ? e.message : e}`);
    }
}

/** Cloud image path: fetch img → overlay disk → seed → boot → agent → setup. */
export async function provisionVmCloudimg(h: VmHandle, o: ProvisionOpts): Promise<void> {
    const spec = h.spec;
    // LUKS gate: the passphrase must already sit at the key path (caller
    // wrote it via provideDiskKey — secrets/ for store, run/ for prompt).
    // The overlay create + every boot need it.
    requireDiskKeyFile(spec, h.paths);
    try {
    const pw = await ensurePassword(spec, o);
    const { pubText } = await (await import("../../vm-core/src/sshkey")).ensureKeypair();
    const sshKeys = [...(o.sshKeys ?? []), pubText];
    const snap = await hostSnapshot(spec, o);
    log(h, o, `fetching cloud image (${spec.os.family} ${o.release ?? (spec.os.release || "default")})…`);
    const tc = await (await import("../../vm-core/src/qemu/resolve")).resolveToolchain();
    const { seedIso } = await provisionCloudimg(spec, tc.qemuImg, {
        release: o.release, username: spec.credentials.username, password: pw,
        sshKeys, timezone: await seedTimezone(spec, o.timezone),
        locale: snap.locale, keyboard: snap.keyboard?.layout,
    });
    await h.saveSpec();

    log(h, o, "first boot with NoCloud seed (cloud-init provisioning)…");
    await h.start({ mode: "install", install: { seedIso }, guestMonitors: await hostMirroredGuestMonitors(spec) });

    log(h, o, "waiting for guest agent (cloud-init is installing the desktop stack — first boot is slow)…");
    await waitForAgent(h, 25 * 60_000);

    log(h, o, "running guest setup (rdp, autologin, monitors)…");
    const xml = await monitorsXml(spec, o);
    await runGuestSetup(h, { rdpPassword: pw, monitorsXml: xml, host: snap, timeoutMs: 20 * 60_000 });
    await wallpaperApply(h, o);

    spec.provisioned.completedAt = new Date().toISOString();
    await h.saveSpec();
    log(h, o, `provisioned ${spec.name} — connect with 'cruiser vm view ${spec.name}'`);
    } finally {
        // prompt mode: drop run/disk-key — QEMU holds the secret in memory.
        await h.clearDiskKey();
    }
}

/** ISO path: autoinstall to disk (long), then normal boot + guest setup. */
export async function provisionVmIso(h: VmHandle, o: ProvisionOpts): Promise<void> {
    const spec = h.spec;
    requireDiskKeyFile(spec, h.paths);
    try {
    const pw = await ensurePassword(spec, o);
    const { pubText } = await (await import("../../vm-core/src/sshkey")).ensureKeypair();
    const sshKeys = [...(o.sshKeys ?? []), pubText];
    const iso = o.iso!.startsWith("http") ? await ensureIso(o.iso!) : o.iso!;
    const snap = await hostSnapshot(spec, o);

    log(h, o, "running unattended install (watch: tail -f run/install-serial.log)…");
    await runIsoInstall(spec, {
        iso, username: spec.credentials.username, password: pw, sshKeys,
        timezone: await seedTimezone(spec, o.timezone),
        locale: snap.locale, keyboard: snap.keyboard?.layout,
    });
    await h.saveSpec();

    log(h, o, "install complete — first normal boot…");
    await h.start({ guestMonitors: await hostMirroredGuestMonitors(spec) });
    log(h, o, "waiting for guest agent…");
    // first boot of a fully installed desktop is slow (gdm/snap/agent init) —
    // the 26.04 desktop ISO took ~9min to a live agent
    await waitForAgent(h, 15 * 60_000);

    log(h, o, "running guest setup…");
    const xml = await monitorsXml(spec, o);
    await runGuestSetup(h, { rdpPassword: pw, monitorsXml: xml, host: snap });
    await wallpaperApply(h, o);

    spec.provisioned.completedAt = new Date().toISOString();
    await h.saveSpec();
    log(h, o, `provisioned ${spec.name} — connect with 'cruiser vm view ${spec.name}'`);
    } finally {
        await h.clearDiskKey();
    }
}

/** Re-run just the in-guest setup on an already-provisioned VM. */
export async function reprovisionGuest(h: VmHandle, o: ProvisionOpts): Promise<void> {
    if (!h.isRunning()) await h.start({ guestMonitors: await hostMirroredGuestMonitors(h.spec) });
    await waitForAgent(h);
    const pw = o.password ?? "";
    if (!pw && !h.spec.credentials.passwordFile) throw new Error("no password on record — pass --password");
    const { rdpPassword } = await import("../../host-int/src/freerdp");
    const password = pw || (await rdpPassword(h.spec))!;
    const xml = await monitorsXml(h.spec, o);
    await runGuestSetup(h, { rdpPassword: password, monitorsXml: xml, host: await hostSnapshot(h.spec, o) });
    await wallpaperApply(h, o);
    log(h, o, "guest setup re-applied");
}
