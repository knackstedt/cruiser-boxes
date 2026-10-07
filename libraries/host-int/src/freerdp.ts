// ============================================================================
// freerdp.ts — xfreerdp3 argv construction + launch + RDP port wait.
// ============================================================================

import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { spawnChild, which } from "../../sys/src/exec";
import type { VmSpec } from "../../vm-core/src/config/schema";

export interface ViewerLaunch {
    child: ChildProcess;
    argv: string[];
}

/** Wait for the guest's forwarded RDP port to accept connections. */
export async function waitRdpPort(port: number, timeoutMs = 90_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await new Promise<boolean>((res) => {
            const s = createConnection({ host: "127.0.0.1", port });
            s.once("connect", () => { s.destroy(); res(true); });
            s.once("error", () => res(false));
            s.setTimeout(1500, () => { s.destroy(); res(false); });
        });
        if (ok) return true;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}

/** Build the xfreerdp3 argument list for a VM spec. */
export function freerdpArgs(spec: VmSpec, opts: { rdpPort: number; password?: string } ): string[] {
    const d = spec.display;
    const a: string[] = [
        `/v:127.0.0.1:${opts.rdpPort}`,
        `/u:${spec.credentials.username}`,
    ];
    if (opts.password) a.push(`/p:${opts.password}`);
    else a.push("/p:"); // freerdp will prompt/agent-fallback if empty; guest-setup sets it
    a.push("/cert:ignore");
    a.push(`/title:cruiser:${spec.name}`);

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

/** Launch the viewer process; returns immediately (caller waits for window). */
export async function launchFreerdp(spec: VmSpec, opts: { rdpPort: number; logFile?: string }): Promise<ViewerLaunch> {
    const bin = (await which("xfreerdp3")) ?? (await which("xfreerdp"));
    if (!bin) throw new Error("xfreerdp3 not found — apt install freerdp3-x11 (or set toolchain)");
    const password = await rdpPassword(spec);
    const argv = freerdpArgs(spec, { rdpPort: opts.rdpPort, password });
    const child = spawnChild(bin, argv, { detached: true, stdio: "ignore" });
    child.unref();
    return { child, argv };
}
