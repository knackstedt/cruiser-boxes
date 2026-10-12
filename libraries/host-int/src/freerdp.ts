// ============================================================================
// freerdp.ts — xfreerdp3 argv construction + launch + RDP port wait.
// ============================================================================

import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { run, spawnChild, which } from "../../sys/src/exec";
import type { VmSpec } from "../../vm-core/src/config/schema";

export interface ViewerLaunch {
    child: ChildProcess;
    argv: string[];
}

/** Wait for the guest's forwarded RDP port to answer an X.224 negotiation.
 *  A bare connect is useless here — slirp hostfwd completes the handshake
 *  host-side even when nothing is listening inside the guest, so a cold boot
 *  would launch freerdp into a dead forward. */
export async function waitRdpPort(port: number, timeoutMs = 90_000): Promise<boolean> {
    // TPKT + X.224 CR TPDU (dst-ref, src-ref, class 0) + RDP_NEG_REQ
    // (type 1, len 8, no protocols) — 19 bytes.
    const probe = Buffer.from("030000130ee000000000000100080000000000", "hex");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await new Promise<boolean>((res) => {
            let settled = false;
            const done = (v: boolean) => { if (!settled) { settled = true; s.destroy(); res(v); } };
            const s = createConnection({ host: "127.0.0.1", port });
            s.once("connect", () => s.write(probe));
            s.once("data", () => done(true));   // any TPKT response = real RDP server
            s.once("error", () => done(false));
            s.once("close", () => done(false)); // slirp closes when guest refuses
            s.setTimeout(1500, () => done(false));
        });
        if (ok) return true;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}

/** Offer TLS|HYBRID in an X.224 nego request and report whether the server
 *  insists on TLS (selected TLS, or RDP_NEG_FAILURE SSL_REQUIRED). krdp ≥6.5
 *  is TLS-only — forcing /sec:tls skips the doomed CredSSP round-trip. */
export async function rdpTlsOnly(port: number): Promise<boolean> {
    // requestedProtocols = PROTOCOL_TLS(0x1)|PROTOCOL_HYBRID(0x2) = 0x3
    const probe = Buffer.from("030000130ee000000000000100080003000000", "hex");
    const resp = await new Promise<Buffer | null>((res) => {
        const chunks: Buffer[] = [];
        const s = createConnection({ host: "127.0.0.1", port });
        const done = (v: Buffer | null) => { s.destroy(); res(v); };
        s.once("connect", () => s.write(probe));
        s.on("data", (d) => { chunks.push(d); if (Buffer.concat(chunks).length >= 19) done(Buffer.concat(chunks)); });
        s.once("error", () => done(null));
        s.once("close", () => done(chunks.length ? Buffer.concat(chunks) : null));
        s.setTimeout(3000, () => done(null));
    });
    if (!resp || resp.length < 19) return false;
    const type = resp[11];                       // 0x02 NEG_RSP, 0x03 NEG_FAILURE
    const selected = resp.readUInt32LE(15);
    if (type === 0x03) return selected === 0x1;        // SSL_REQUIRED_BY_SERVER
    return selected === 0x1;                     // negotiated plain TLS
}

/** Build the xfreerdp3 argument list for a VM spec. */
export function freerdpArgs(spec: VmSpec, opts: { rdpPort: number; password?: string; tlsOnly?: boolean } ): string[] {
    const d = spec.display;
    const a: string[] = [
        `/v:127.0.0.1:${opts.rdpPort}`,
        `/u:${spec.credentials.username}`,
    ];
    if (opts.password) a.push(`/p:${opts.password}`);
    else a.push("/p:"); // freerdp will prompt/agent-fallback if empty; guest-setup sets it
    a.push("/cert:ignore");
    a.push(`/title:cruiser:${spec.name}`);
    // krdp ≥6.5 negotiates NLA but has no CredSSP credentials — the client dies
    // with ERRCONNECT_LOGON_FAILURE. Retry path (ViewerSession) forces TLS.
    if (opts.tlsOnly) a.push("/sec:tls");
    // krdp (KDE guests) only serves RDPGFX H.264 — AVC420/444 caps required.
    // Gated by freerdpSupportsH264 in launchFreerdp; a binary without
    // WITH_GFX_H264 can't decode what it advertises.
    if (spec.os.desktop === "kde") a.push("/gfx:AVC444:on,AVC420:on");

    if (d.dynamicResolution) a.push("/dynamic-resolution");
    if (d.sound) a.push("/sound");
    if (d.microphone) a.push("/microphone");
    if (d.clipboard) a.push("+clipboard");
    // -grab-keyboard = host WM keeps global shortcuts (escape shortcuts depend on it)
    a.push(d.grabKeyboard ? "+grab-keyboard" : "-grab-keyboard");

    switch (d.headMode) {
        case "fullscreen-monitor":
        case "virtual-desktop":
            a.push("/f");
            if (d.monitors === "all") a.push("/multimon");
            else if (d.monitors.length) a.push(`/monitor:${d.monitors.join(",")}`);
            break;
        case "windowed":
            a.push(`/size:${d.windowSize.w}x${d.windowSize.h}`);
            break;
        case "app":
            throw new Error("headMode 'app' uses waypipe, not freerdp");
    }
    return a;
}

/** Resolve the RDP password from spec.credentials.passwordFile (0600). */
export async function rdpPassword(spec: VmSpec): Promise<string | undefined> {
    const f = spec.credentials.passwordFile;
    if (!f) return undefined;
    try { return (await readFile(f, "utf-8")).trim(); } catch { return undefined; }
}

/** Prefer the toolchain build (opt/freerdp) — distro freerdp3 is built
 *  WITHOUT_GFX_H264, and krdp guests only serve H.264 RDPGFX. */
export async function freerdpBin(): Promise<string | null> {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const names = ["xfreerdp3", "xfreerdp"];
    for (let i = 0; i < names.length; i++) {
        const p = join(root, "opt", "freerdp", "bin", names[i]!);
        if (existsSync(p)) return p;
    }
    return (await which("xfreerdp3")) ?? (await which("xfreerdp"));
}

// /buildconfig is a fixed-shape dump — cache the verdict per binary path.
const h264Cache = new Map<string, Promise<boolean>>();

/** Does this freerdp build have client-side H.264 (WITH_GFX_H264 + a decoder
 *  backend: openh264 or ffmpeg)? krdpserver refuses clients without it. */
export function freerdpSupportsH264(bin: string): Promise<boolean> {
    let p = h264Cache.get(bin);
    if (!p) {
        p = run(bin, ["/buildconfig"], { noThrow: true }).then((r) => {
            const cfg = r.stdout + r.stderr;
            if (!/WITH_GFX_H264=ON/.test(cfg)) return false;
            return /WITH_OPENH264=ON/.test(cfg) || /WITH_FFMPEG=ON/.test(cfg);
        });
        h264Cache.set(bin, p);
    }
    return p;
}

/** Launch the viewer process; returns immediately (caller waits for window).
 *  stdout+stderr append to opts.logFile — a dead viewer with stdio ignored is
 *  otherwise undiagnosable. */
export async function launchFreerdp(spec: VmSpec, opts: { rdpPort: number; logFile?: string; tlsOnly?: boolean }): Promise<ViewerLaunch> {
    const bin = await freerdpBin();
    if (!bin) throw new Error("xfreerdp3 not found — apt install freerdp3-x11 (or set toolchain)");
    if (spec.os.desktop === "kde" && !await freerdpSupportsH264(bin))
        throw new Error(
            `'${spec.name}' is a KDE guest — krdpserver requires client-side H.264 and ${bin} was built without it. ` +
            `Build the toolchain freerdp (bun run toolchain/build.mts build --component freerdp) or set display.viewer="dmabuf".`);
    const password = await rdpPassword(spec);
    const argv = freerdpArgs(spec, { rdpPort: opts.rdpPort, password, tlsOnly: opts.tlsOnly });
    const child = spawnChild(bin, argv, { detached: true, logFile: opts.logFile });
    child.unref();
    return { child, argv };
}
