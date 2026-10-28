// ============================================================================
// windows/setup.ts — post-install in-guest provisioning over QGA
// (PowerShell via guestPs — the linux guestSh analogue; runs as SYSTEM).
//
// The specialize pass already installed virtio-win guest tools + the
// display driver + RDP + testsigning. What remains here is everything that
// needs a LIVE guest or live spec: share mounts, sanity reports, and the
// RDP-listener verification for the freerdp fallback path.
// ============================================================================

import type { VmHandle } from "../../../vm-core/src/lifecycle/vm";

export interface WindowsSetupOpts {
    onLog?: (msg: string) => void;
    timeoutMs?: number;
}

/** Exec a ps snippet; throw with stderr context on nonzero exit. */
async function ps(h: VmHandle, script: string, timeoutMs = 60_000) {
    const r = await h.guestPs(script, timeoutMs);
    if (r.exitcode !== 0)
        throw new Error(`guest ps failed (${r.exitcode}): ${r.stderr.toString().trim() || r.stdout.toString().trim()}`);
    return r.stdout.toString().trim();
}

/** Fire-and-log variant — a best-effort step must never fail provisioning. */
async function psBest(h: VmHandle, script: string, say: (m: string) => void, what: string) {
    const r = await h.guestPs(script, 60_000);
    const out = (r.stdout.toString() + r.stderr.toString()).trim();
    if (r.exitcode !== 0) say(`${what}: FAILED (${r.exitcode}) ${out}`.slice(0, 500));
    else if (out) say(`${what}: ${out.slice(0, 500)}`);
}

/**
 * First-boot provisioning. The agent is already answering (caller waited);
 * nothing here may block longer than its own timeout — a hung step means
 * the VM is still bootable and connectable, just under-configured.
 */
export async function runWindowsSetup(h: VmHandle, o: WindowsSetupOpts = {}): Promise<void> {
    const spec = h.spec;
    const say = o.onLog ?? (() => {});

    // What did the display stack actually bind? The adapter name is the
    // ground truth for whether yttrium took (viogpu3d) or we fell back to
    // the stock 2D driver — it's the first thing a bug report needs.
    const gpu = await ps(h,
        `(Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,DriverVersion | ConvertTo-Json -Compress)`,
        30_000).catch((e) => `unreadable (${e.message})`);
    say(`display adapter: ${gpu}`);

    const os = await ps(h,
        `(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version | ConvertTo-Json -Compress)`,
        30_000).catch(() => "");
    if (os) say(`guest os: ${os}`);

    // virtiofs shares → one WinFsp service instance per share tag, drive
    // letters descending from Z. virtio-win's VirtIO-FS service only mounts
    // one tag, so per-share mounts get their own services. Best-effort —
    // a missing WinFsp/virtiofs install must not fail the whole setup.
    const shares = spec.shares.filter((s) => s.enabled !== false && s.mode !== "copy");
    for (const [i, s] of shares.entries()) {
        const letter = String.fromCharCode(90 - i); // Z, Y, X, …
        const tag = s.tag.replace(/'/g, "");
        await psBest(h, `
$exe = @("C:\\Program Files\\Virtio-FS Service\\virtiofs.exe",
         "C:\\Program Files\\Virtio-FS\\virtiofs.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$svc = "cruiserfs_${tag}"
if (-not $exe) { Write-Error "virtiofs.exe not installed"; exit 1 }
sc.exe stop $svc 2>$null | Out-Null
sc.exe delete $svc 2>$null | Out-Null
sc.exe create $svc binPath= "\`"$exe\`" -t ${tag} -m ${letter}:" start= auto DisplayName= "cruiser share ${tag}" | Out-Null
sc.exe start $svc | Out-Null
Start-Sleep -Seconds 1
if (Test-Path "${letter}:\\") { Write-Output "${tag} → ${letter}: mounted" }
else { Write-Output "${tag} → ${letter}: service started, mount pending" }
`, say, `share ${s.tag}`);
    }

    // RDP listener — the freerdp fallback depends on it; a dead listener
    // here means the specialize pass didn't finish its config half.
    await psBest(h, `
$l = Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue
if ($l) { Write-Output "RDP listening on 3389" } else { Write-Output "RDP NOT listening — check Terminal Server service" }
`, say, "rdp");

    // QGA clock sync — slirp-blocked NTP leaves the guest drifting. The
    // w32time service defaults to Manual and isn't started yet this early
    // post-OOBE, so set it up before resyncing (0x80070426 without it).
    await psBest(h, `
Set-Service w32time -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service w32time -ErrorAction SilentlyContinue
w32tm /resync /force 2>&1 | Out-String`, say, "timesync");
}
