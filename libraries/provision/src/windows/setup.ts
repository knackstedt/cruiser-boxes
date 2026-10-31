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

    // Cruiser pointer agent — virtio tablets enumerate as absolute HID
    // mice and Windows pins them to the primary display (wisp's Digimon
    // association is digitizer-only, verified no-op), so multi-monitor
    // input rides a per-logon agent: it dials QEMU's slirp guestfwd
    // (10.0.2.250:28090 → run/agent.sock chardev → viewer-dd --inject) and
    // injects SendInput with MOUSEEVENTF_VIRTUALDESK, which spans the
    // guest's real display layout for ANY arrangement. Runs as the
    // interactive user — a SYSTEM service can't SendInput into a session.
    //
    // Two launchers: an INTERACTIVE-group logon task (nice when the
    // scheduler takes it — some images deny even user-context
    // registration, 0x80070005) plus HKLM\Run as the floor that always
    // works. The agent's per-session mutex makes a double launch benign.
    await psBest(h, `
$dir = "C:\\ProgramData\\cruiser"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Set-Content -Path "$dir\\agent.ps1" -Encoding UTF8 -Value @'
${POINTER_AGENT_PS1}
'@
$cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$dir\\agent.ps1\`""
$taskOk = $false
try {
  $act = New-ScheduledTaskAction -Execute "powershell.exe" \`
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$dir\\agent.ps1\`""
  $trg = New-ScheduledTaskTrigger -AtLogOn
  $pri = New-ScheduledTaskPrincipal -GroupId "INTERACTIVE" -RunLevel Limited
  Register-ScheduledTask -TaskName "CruiserPointerAgent" -Action $act -Trigger $trg -Principal $pri -Force -ErrorAction Stop | Out-Null
  Start-ScheduledTask -TaskName "CruiserPointerAgent" -ErrorAction SilentlyContinue
  $taskOk = $true
} catch { Write-Output "task registration denied ($($_.Exception.Message))" }
Set-ItemProperty -Path "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "CruiserPointerAgent" -Value $cmd
Write-Output ("pointer agent installed (HKLM Run" + $(if ($taskOk) { " + logon task" } else { "" }) + ")")
`, say, "pointer agent");
}

/** In-guest pointer agent — line protocol over the guestfwd channel:
 *  "m <ci> <x> <y>" console-local px → SendInput ABSOLUTE|VIRTUALDESK,
 *  "b <btn> <down>" (0=L 1=M 2=R; 3/4 = wheel up/down pulses),
 *  "a <x> <y>" desktop-absolute, "info" → log the real display layout,
 *  "q" quit. DISPLAY1..N maps to console N — QEMU binds consoles in PCI
 *  order, matching win-pnp enumeration. */
const POINTER_AGENT_PS1 = String.raw`
$ErrorActionPreference = 'Continue'
$log = "$env:LOCALAPPDATA\cruiser-agent.log"
function W($m) { try { Add-Content -Path $log -Value "$(Get-Date -Format o) $m" } catch {} }
# One agent per session — both the logon task and HKLM\Run may fire.
$mtx = New-Object System.Threading.Mutex($false, 'Local\CruiserPointerAgent')
if (-not $mtx.WaitOne(0)) { exit }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class Inj {
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inp, int cb);
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public int type; public MOUSEINPUT mi; }
 public static void Mouse(int dx,int dy,uint flags,uint data){
   INPUT[] a = new INPUT[1]; a[0].type=0; a[0].mi.dx=dx; a[0].mi.dy=dy; a[0].mi.dwFlags=flags; a[0].mi.mouseData=data;
   SendInput(1,a,Marshal.SizeOf(typeof(INPUT)));
 }
}
'@
function Connect {
  # 10.0.2.250 = QEMU guestfwd → run/agent.sock chardev (viewer-dd connects).
  # 10.0.2.2   = raw slirp host address — a host-side bridge, if any.
  foreach ($h in @('10.0.2.250','10.0.2.2')) {
    try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect($h, 28090); return $c } catch {}
  }
  throw "no cruiser pointer channel"
}
$cli = $null
while ($true) {
  try {
    if (-not $cli) { $cli = Connect; $rd = New-Object System.IO.StreamReader($cli.GetStream()); W "connected" }
    $l = $rd.ReadLine()
    if ($null -eq $l) { $cli=$null; continue }
    $p = $l -split ' '
    $scr = [System.Windows.Forms.Screen]::AllScreens
    $minx=($scr|ForEach-Object{$_.Bounds.X}|Measure-Object -Minimum).Minimum
    $miny=($scr|ForEach-Object{$_.Bounds.Y}|Measure-Object -Minimum).Minimum
    $maxx=($scr|ForEach-Object{$_.Bounds.X+$_.Bounds.Width}|Measure-Object -Maximum).Maximum
    $maxy=($scr|ForEach-Object{$_.Bounds.Y+$_.Bounds.Height}|Measure-Object -Maximum).Maximum
    if ($p[0] -eq 'm') {
      $id=[int]$p[1]; $x=[int]$p[2]; $y=[int]$p[3]
      $s = $scr | Where-Object { $_.DeviceName -eq ('\\.\DISPLAY' + ($id+1)) } | Select-Object -First 1
      if (-not $s) { $s = $scr[[Math]::Min($id,$scr.Count-1)] }
      $vx=$s.Bounds.X+$x; $vy=$s.Bounds.Y+$y
      $nx=[int](($vx-$minx)*65535.0/($maxx-$minx))
      $ny=[int](($vy-$miny)*65535.0/($maxy-$miny))
      [Inj]::Mouse($nx,$ny,0xC001,0)
    } elseif ($p[0] -eq 'b') {
      $btn=[int]$p[1]; $down=[int]$p[2]
      if ($btn -ge 3) {
        if ($down) { [Inj]::Mouse(0,0,0x0800,$(if($btn -eq 3){120}else{-120})) }
      } else {
        $flags = if ($down) { @(0x0002,0x0020,0x0008)[$btn] } else { @(0x0004,0x0040,0x0010)[$btn] }
        [Inj]::Mouse(0,0,$flags,0)
      }
    } elseif ($p[0] -eq 'a') {
      $vx=[int]$p[1]; $vy=[int]$p[2]
      $nx=[int](($vx-$minx)*65535.0/($maxx-$minx))
      $ny=[int](($vy-$miny)*65535.0/($maxy-$miny))
      [Inj]::Mouse($nx,$ny,0xC001,0)
    } elseif ($p[0] -eq 'info') {
      $o = @(); $i=0
      foreach($s in $scr){ $o += "$i $($s.DeviceName) $($s.Bounds.X),$($s.Bounds.Y) $($s.Bounds.Width)x$($s.Bounds.Height) primary=$($s.Primary)"; $i++ }
      $o += "desk $minx,$miny .. $maxx,$maxy"
      W ($o -join "|")
    } elseif ($p[0] -eq 'q') { break }
  } catch { W "loop err: $_"; Start-Sleep 1; $cli=$null }
}
if ($cli) { $cli.Close() }
`;
