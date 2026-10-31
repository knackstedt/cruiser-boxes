// ============================================================================
// windows/unattend.ts — autounattend.xml + on-ISO setup scripts → unattend.iso.
//
// Layout of the generated ISO (Joliet — WinPE scans every removable volume
// for autounattend.xml at the root, letter assignment doesn't matter):
//   autounattend.xml    — the answer file
//   cruiser-setup.cmd   — specialize-pass entry (drive-letter scan → ps1)
//   cruiser-setup.ps1   — drivers, RDP, testsigning, yttrium, power, EMS
//   cruiser-done.cmd    — FirstLogonCommands hook: marker + clean shutdown
//                         (QEMU exit = "install finished" for the host)
//   yttrium/            — optional viogpu3d payload extracted from the zip
//
// The disk/answer-file pass needs NO storage drivers — the install runs the
// disk+CDs on the q35's native AHCI (buildArgs install.sata), and production
// boots switch to virtio-blk once virtio-win-guest-tools has put viostor in.
// ============================================================================

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run, which } from "../../../sys/src/exec";

export interface UnattendOpts {
    hostname: string;
    username: string;
    /** plaintext — only ever lands inside the generated ISO (transient). */
    password: string;
    /** /IMAGE/NAME value for InstallFrom, e.g. "Windows 11 Pro". Empty =
     *  single-image media (eval ISOs) — InstallFrom is omitted entirely. */
    edition?: string;
    /** Windows timezone ID ("UTC", "W. Europe Standard Time", …). */
    timezone?: string;
    /** Windows locale name, e.g. "en-US" — host locale mapped IANA→BCP47. */
    locale?: string;
    /** Public KMS-client setup key (GVLK) — empty = no key (eval ISOs). */
    productKey?: string;
    /** bcdedit testsigning + nointegritychecks — the yttrium driver path. */
    testsigning?: boolean;
    /** extracted yttrium payload dir placed at \yttrium on the ISO. */
    yttriumDir?: string;
    /** virtio-win os dir convention — "w11" | "w10"; picks the matching
     *  Win1x driver subtree (drivers + the yttrium inf). */
    winDir?: string;
}

const xesc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** NetBIOS-safe hostname: ≤15 chars, [a-z0-9-], no leading/trailing dash. */
export function windowsHostname(name: string): string {
    const h = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 15);
    return h || "cruiser-vm";
}

/** IANA tz → Windows timezone ID for the common cases; anything unmapped
 *  falls back to UTC (the guest can still syncclock via QGA). */
export function windowsTimezone(iana?: string): string | undefined {
    if (!iana) return undefined;
    const M: Record<string, string> = {
        "Etc/UTC": "UTC", "UTC": "UTC",
        "America/New_York": "Eastern Standard Time",
        "America/Chicago": "Central Standard Time",
        "America/Denver": "Mountain Standard Time",
        "America/Los_Angeles": "Pacific Standard Time",
        "America/Phoenix": "US Mountain Standard Time",
        "America/Anchorage": "Alaskan Standard Time",
        "Pacific/Honolulu": "Hawaiian Standard Time",
        "America/Toronto": "Eastern Standard Time",
        "America/Vancouver": "Pacific Standard Time",
        "America/Sao_Paulo": "E. South America Standard Time",
        "Europe/London": "GMT Standard Time",
        "Europe/Dublin": "GMT Standard Time",
        "Europe/Lisbon": "GMT Standard Time",
        "Europe/Paris": "Romance Standard Time",
        "Europe/Berlin": "W. Europe Standard Time",
        "Europe/Madrid": "Romance Standard Time",
        "Europe/Rome": "W. Europe Standard Time",
        "Europe/Amsterdam": "W. Europe Standard Time",
        "Europe/Brussels": "Romance Standard Time",
        "Europe/Vienna": "W. Europe Standard Time",
        "Europe/Zurich": "W. Europe Standard Time",
        "Europe/Stockholm": "W. Europe Standard Time",
        "Europe/Oslo": "W. Europe Standard Time",
        "Europe/Copenhagen": "W. Europe Standard Time",
        "Europe/Helsinki": "GTB Standard Time",
        "Europe/Athens": "GTB Standard Time",
        "Europe/Warsaw": "Central European Standard Time",
        "Europe/Prague": "Central Europe Standard Time",
        "Europe/Budapest": "Central Europe Standard Time",
        "Europe/Bucharest": "GTB Standard Time",
        "Europe/Istanbul": "Turkey Standard Time",
        "Europe/Moscow": "Russian Standard Time",
        "Asia/Dubai": "Arabian Standard Time",
        "Asia/Jerusalem": "Israel Standard Time",
        "Asia/Kolkata": "India Standard Time",
        "Asia/Calcutta": "India Standard Time",
        "Asia/Shanghai": "China Standard Time",
        "Asia/Singapore": "Singapore Standard Time",
        "Asia/Hong_Kong": "China Standard Time",
        "Asia/Taipei": "Taipei Standard Time",
        "Asia/Tokyo": "Tokyo Standard Time",
        "Asia/Seoul": "Korea Standard Time",
        "Australia/Sydney": "AUS Eastern Standard Time",
        "Australia/Melbourne": "AUS Eastern Standard Time",
        "Australia/Brisbane": "E. Australia Standard Time",
        "Australia/Perth": "W. Australia Standard Time",
        "Pacific/Auckland": "New Zealand Standard Time",
    };
    return M[iana] ?? "UTC";
}

/** "en_US.UTF-8" → "en-US" (BCP47 for the unattend locale fields). */
export function windowsLocale(iana?: string): string | undefined {
    return iana?.split(".")[0]?.replace("_", "-") || undefined;
}

/**
 * The answer file. Only interpolated with XML-escaped spec values + the
 * caller's scripts — the heavy lifting lives in cruiser-setup.ps1 (kept
 * out of XML so it stays readable/debuggable).
 */
export function autounattendXml(o: UnattendOpts): string {
    const loc = o.locale ?? "en-US";
    const host = xesc(windowsHostname(o.hostname));
    const user = xesc(o.username);
    const pw = xesc(o.password);
    const arch = "amd64";
    const pk = "31bf3856ad364e35";
    const comp = (name: string, inner: string) =>
        `<component name="${name}" processorArchitecture="${arch}" publicKeyToken="${pk}" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${inner}</component>`;

    return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    ${comp("Microsoft-Windows-PnpCustomizationsWinPE", `
      <DriverPaths>
        ${["E:\\drivers", "F:\\drivers", "D:\\drivers"]
            .map((p, i) => `<PathAndCredentials wcm:key="${i + 1}" wcm:action="add"><Path>${p}</Path></PathAndCredentials>`).join("\n        ")}
      </DriverPaths>`)}
    ${comp("Microsoft-Windows-International-Core-WinPE", `
      <SetupUILanguage><UILanguage>${loc}</UILanguage></SetupUILanguage>
      <InputLocale>${loc}</InputLocale>
      <SystemLocale>${loc}</SystemLocale>
      <UILanguage>${loc}</UILanguage>
      <UserLocale>${loc}</UserLocale>`)}
    ${comp("Microsoft-Windows-Setup", `
      <DiskConfiguration>
        <WillShowUI>OnError</WillShowUI>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          ${o.edition ? `<InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/NAME</Key><Value>${xesc(o.edition)}</Value></MetaData></InstallFrom>` : ""}
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
        </OSImage>
      </ImageInstall>
      <UserData>
        <AcceptEula>true</AcceptEula>
        <FullName>${user}</FullName>
        <Organization>cruiser</Organization>
        ${o.productKey ? `<ProductKey><Key>${xesc(o.productKey)}</Key><WillShowUI>Never</WillShowUI></ProductKey>` : ""}
      </UserData>
      <RunSynchronous>
        ${["BypassTPMCheck", "BypassSecureBootCheck", "BypassRAMCheck", "BypassCPUCheck"]
            .map((v, i) => `<RunSynchronousCommand wcm:action="add">
          <Order>${i + 1}</Order>
          <Path>reg.exe add HKLM\\SYSTEM\\Setup\\LabConfig /v ${v} /t REG_DWORD /d 1 /f</Path>
          ${i === 0 ? "<Description>cruiser: relax windows 11 hardware gates</Description>" : ""}
        </RunSynchronousCommand>`).join("\n        ")}
      </RunSynchronous>`)}
  </settings>
  <settings pass="specialize">
    ${comp("Microsoft-Windows-International-Core", `
      <InputLocale>${loc}</InputLocale>
      <SystemLocale>${loc}</SystemLocale>
      <UILanguage>${loc}</UILanguage>
      <UserLocale>${loc}</UserLocale>`)}
    ${comp("Microsoft-Windows-Shell-Setup", `
      <ComputerName>${host}</ComputerName>
      ${o.timezone ? `<TimeZone>${xesc(o.timezone)}</TimeZone>` : ""}
      <RegisteredOwner>${user}</RegisteredOwner>
      <RegisteredOrganization>cruiser</RegisteredOrganization>`)}
    ${comp("Microsoft-Windows-Deployment", `
      <RunSynchronous>
        ${["bcdedit /ems {current} on", "bcdedit /emssettings EMSPORT:2 EMSBAUDRATE:115200",
           // {current} in specialize resolves to the setup boot object, not
           // the installed OS entry — stamp EMS on {default} too.
           "bcdedit /ems {default} on",
           // Win10 eval first-logon can stall 30-60min inside App Readiness
           // UWP provisioning before FirstLogonCommands ever run — disable it.
           "reg add \"HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppReadiness\" /v DisableAppReadiness /t REG_DWORD /d 1 /f",
           // Fallback for the same stall: task-scheduler at-logon firing is
           // independent of the FLC queue — the shim self-guards against
           // double-runs (C:\\cruiser-installed marker).
           `schtasks /create /tn cruiser-setup /sc onlogon /ru SYSTEM /rl HIGHEST /f /tr "cmd /c for %i in (d e f g h i j k l m n o p q r s t u v w) do if exist %i:\\cruiser-setup.cmd call %i:\\cruiser-setup.cmd"`,
           // And the bits the whole install is dead without — qemu-ga +
           // testsigning + the yttrium driver — land HERE in specialize,
           // session-0, before OOBE can stall them. The FLC ps1 stays for
           // desktop-side extras (RDP, power, hostname, vdagent).
           `cmd /c "for %i in (d e f g h i j k l m n o p q r s t u v w) do if exist %i:\\cruiser-preinstall.cmd call %i:\\cruiser-preinstall.cmd"`]
            .map((c, i) => `<RunSynchronousCommand wcm:action="add">
          <Order>${i + 1}</Order>
          <Path>${c}</Path>
          ${i === 0 ? "<Description>cruiser: EMS on COM2 + serial observability</Description>" : ""}
        </RunSynchronousCommand>`).join("\n        ")}
      </RunSynchronous>`)}
  </settings>
  <settings pass="oobeSystem">
    ${comp("Microsoft-Windows-Shell-Setup", `
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
        <SkipMachineOOBE>true</SkipMachineOOBE>
        <SkipUserOOBE>true</SkipUserOOBE>
      </OOBE>
      <AutoLogon>
        <Enabled>true</Enabled>
        <LogonCount>9999999</LogonCount>
        <Username>${user}</Username>
        <Password><Value>${pw}</Value><PlainText>true</PlainText></Password>
      </AutoLogon>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>${user}</Name>
            <DisplayName>${user}</DisplayName>
            <Group>Administrators</Group>
            <Password><Value>${pw}</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add">
          <Order>1</Order>
          <CommandLine>cmd.exe /c "for %i in (d e f g h i j k l m n o p q r s t u v w) do if exist %i:\\cruiser-setup.cmd call %i:\\cruiser-setup.cmd"</CommandLine>
          <Description>cruiser guest setup (drivers, rdp, ems — first real logon, not specialize)</Description>
        </SynchronousCommand>
        <SynchronousCommand wcm:action="add">
          <Order>2</Order>
          <CommandLine>cmd.exe /c "for %i in (d e f g h i j k l m n o p q r s t u v w) do if exist %i:\\cruiser-done.cmd call %i:\\cruiser-done.cmd"</CommandLine>
          <Description>cruiser install completion</Description>
        </SynchronousCommand>
      </FirstLogonCommands>`)}
  </settings>
</unattend>
`;
}

/** FirstLogon entry — the cmd shim only exists because unattend's
 *  SynchronousCommand wants a literal path; it hands off to the ps1 (which
 *  is where anything worth logging/debugging lives). Driver installs run
 *  HERE, not in specialize: session-0 specialize wedges real installers
 *  (virtio-win-guest-tools' burn chain spins silently for an hour). */
function cruiserSetupCmd(): string {
    // Win10's FirstLogonCommands can stall ~an hour behind AppReadiness
    // provisioning (and may never fire on some eval images) — specialize
    // also registers a scheduled task that invokes this same shim at the
    // first logon, so the marker makes the setup run once under either.
    return `@echo off\r\nrem first-logon entry — finds the seed ISO (this file's own drive)\r\nif exist C:\\cruiser-installed exit /b 0\r\necho started > C:\\cruiser-setup.started\r\necho [cruiser] first-logon cmd shim fired %date% %time% >> C:\\cruiser-setup.log\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0cruiser-setup.ps1" "%~d0" >> C:\\cruiser-setup.log 2>&1\r\nfor %%i in (d e f g h i j k l m n o p q r s t u v w) do if exist %%i:\\cruiser-done.cmd call %%i:\\cruiser-done.cmd\r\n`;
}

/**
 * The first-logon provisioning script — drivers + features baked before
 * the completion shutdown. Runs in the autologged admin session.
 * `args[0]` = the seed ISO's drive letter (from the cmd shim).
 */
export function cruiserSetupPs1(o: UnattendOpts): string {
    const testSign = o.testsigning ? `
Write-Output "[cruiser] enabling testsigning (yttrium driver path)"
& bcdedit /set "{current}" testsigning on | Out-Null
& bcdedit /set "{current}" nointegritychecks on | Out-Null
` : "";
    const yttrium = o.yttriumDir ? `
# ── yttrium viogpu3d — test-signed alpha WDDM + Mesa userspace ──
# cert first so pnputil accepts the package. Only the matching OS dir's
# inf is installed — the inf's CopyFiles/AddReg stages the mesa/venus
# usermode DLLs (d3d10umd, wgl ICD, libvulkan_virtio + icd json) itself;
# copying them by hand would fight the driver store.
$yt = Join-Path $seed "yttrium"
$ytInf = Get-ChildItem $yt -Recurse -Filter viogpu3d.inf |
    Where-Object { $_.FullName -match 'Install_Debug\\\\Win1[01]\\\\amd64' } |
    Sort-Object { [bool]($_.FullName -match '${o.winDir === "w10" ? "Win10" : "Win11"}') } -Descending |
    Select-Object -First 1
if (Test-Path $yt) {
    Write-Output "[cruiser] installing yttrium payload from $yt"
    Get-ChildItem $yt -Recurse -Filter *.cer | ForEach-Object {
        & certutil -addstore -f TrustedPublisher $_.FullName | Out-Null
        & certutil -addstore -f Root $_.FullName | Out-Null }
    if ($ytInf) {
        Write-Output "[cruiser] pnputil $($ytInf.FullName)"
        & pnputil /add-driver $ytInf.FullName /install | Out-Null
    } else { Write-Output "[cruiser] WARN: no Win11/Win10 amd64 viogpu3d.inf in payload" }
    # Upstream issue #21: dwmredir.dll spawns the DWM LPC Port Thread with a
    # 128KiB stack; viogpu_d3d10's ~100KiB single-frame prologue overflows it
    # and DWM crash-loops. One-byte patch: mov edx,0x20000 -> mov edx,0x400000
    # (4MiB) at the DwmInitializePort call site. Pattern-verified so it no-ops
    # on builds where the sequence moved or the fix already shipped.
    $dwmredir = "C:\\Windows\\System32\\dwmredir.dll"
    if (Test-Path $dwmredir) {
        try {
            $b = [IO.File]::ReadAllBytes($dwmredir)
            $pat = [byte[]](0xC7,0x44,0x24,0x20,0x00,0x00,0x01,0x00)
            $hit = -1
            for ($i = 0; $i -lt $b.Length - 64 -and $hit -lt 0; $i++) {
                $ok = $true
                for ($j = 0; $j -lt 8; $j++) { if ($b[$i+$j] -ne $pat[$j]) { $ok = $false; break } }
                if (-not $ok) { continue }
                for ($k = $i + 8; $k -lt $i + 48; $k++) {
                    if ($b[$k] -eq 0xBA -and $b[$k+1] -eq 0 -and $b[$k+2] -eq 0 -and
                        $b[$k+3] -eq 0x02 -and $b[$k+4] -eq 0) { $hit = $k + 3; break }
                }
            }
            if ($hit -ge 0) {
                if (-not (Test-Path "$dwmredir.cruiser-bak")) { Copy-Item $dwmredir "$dwmredir.cruiser-bak" -Force }
                & takeown /f $dwmredir /a | Out-Null
                & icacls $dwmredir /grant '*S-1-5-32-544:F' | Out-Null
                $b[$hit] = 0x40
                [IO.File]::WriteAllBytes("$dwmredir.patched", $b)
                Rename-Item $dwmredir 'dwmredir.orig.dll' -Force
                Rename-Item "$dwmredir.patched" 'dwmredir.dll' -Force
                Write-Output "[cruiser] patched dwmredir.dll LPC thread stack 128KiB -> 4MiB (yttrium#21)"
            } else { Write-Output "[cruiser] dwmredir.dll: yttrium#21 pattern not found — left unpatched" }
        } catch { Write-Output "[cruiser] WARN: dwmredir patch failed: $_" }
    }
    New-Item "HKLM:\\SOFTWARE\\Cruiser" -Force | Out-Null
    Set-ItemProperty "HKLM:\\SOFTWARE\\Cruiser" -Name YttriumInstalled -Value 1
} else { Write-Output "[cruiser] WARN: yttrium payload missing on seed media" }
` : "";
    return `param([string]$seed = "")
$ErrorActionPreference = "Continue"
Write-Output "[cruiser] first-logon setup starting (seed=$seed)"

# ── virtio drivers + qemu-ga via the plain MSIs. The burn bundle
# (virtio-win-guest-tools.exe) has a documented spin-hang mode in quiet
# installs (observed: ~1h at full CPU with no I/O, in both specialize and
# first-logon sessions) — never let it gate provisioning. MSIs first so
# qemu-ga lands early and the VM is observable; the bundle runs LAST under
# a hard timeout, only for the bits that ship nowhere else (spice-vdagent
# for the dmabuf clipboard, WinFsp for virtiofs). ──
$virtio = Get-PSDrive -PSProvider FileSystem |
    Where-Object { Test-Path "$($_.Root)virtio-win-gt-x64.msi" } |
    Select-Object -First 1
if ($virtio) {
    $vroot = $virtio.Root
    Write-Output "[cruiser] installing virtio drivers (msi) from $vroot"
    & msiexec /i "\${vroot}virtio-win-gt-x64.msi" /qn /norestart | Out-Null
    Write-Output "[cruiser] drivers done, installing qemu guest agent"
    & msiexec /i "\${vroot}guest-agent\\qemu-ga-x86_64.msi" /qn /norestart | Out-Null
} else { Write-Output "[cruiser] WARN: no virtio-win media found" }
${testSign}${yttrium}
# ── RDP server (the freerdp fallback viewer path) ──
Set-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" -Name fDenyTSConnections -Value 0
Enable-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue

# ── EMS on COM1 → serial.log captures the windows console ──
& bcdedit /ems "{current}" on | Out-Null
& bcdedit /emssettings EMSPORT:1 EMSBAUDRATE:115200 | Out-Null

# ── performance: no fast startup (hibernation breaks the venus/yttrium
# resume path + the qemu snapshot story), high-performance scheme ──
& powercfg /h off | Out-Null
& powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c | Out-Null
& powercfg /change standby-timeout-ac 0 | Out-Null
& powercfg /change monitor-timeout-ac 0 | Out-Null

# ── hostname: unattend ComputerName is honored only some of the time on
# eval media (it can keep the DESKTOP-/ORG- random name) — Rename-Computer
# queues a rename that applies on the post-install boot. ──
if ($env:COMPUTERNAME -ine "${windowsHostname(o.hostname)}") {
    Rename-Computer -NewName "${windowsHostname(o.hostname)}" -Force -ErrorAction SilentlyContinue
}

# ── burn bundle LAST, 5min cap: everything critical is already installed,
# this only fetches spice-vdagent + WinFsp/virtiofs. If it wedges the VM
# still provisions fully — clipboard/shares degrade, nothing else does. ──
if ($virtio) {
    $bundle = "\${vroot}virtio-win-guest-tools.exe"
    if (Test-Path $bundle) {
        Write-Output "[cruiser] tools bundle for vdagent/winfsp (5min cap)"
        $bp = Start-Process $bundle -ArgumentList "/install","/quiet","/norestart" -PassThru
        if (Wait-Process -Id $bp.Id -Timeout 300 -ErrorAction SilentlyContinue) {
            Write-Output "[cruiser] tools bundle done"
        } else {
            Write-Output "[cruiser] WARN: tools bundle exceeded 5min — killed (drivers+qga unaffected)"
            Stop-Process -Id $bp.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

New-Item "C:\\cruiser-installed" -ItemType File -Force | Out-Null
Set-Content "C:\\cruiser-installed" -Value (Get-Date -Format o)
Write-Output "[cruiser] first-logon setup done"
`;
}

/**
 * FirstLogonCommands hook — runs inside the autologged session once, after
 * the specialize config. The shutdown signals "install complete" to the
 * host: the owned install QEMU exits, and the lifecycle then boots the VM
 * normally (drivers + testsigning take effect on that boot).
 */
/** Specialize RunSynchronous payload — session-0, pre-OOBE, pre-first-logon.
 *  Lands the pieces the install cannot complete without (guest agent,
 *  testsigning, the yttrium driver), because Win10's first-logon path can
 *  stall an hour+ or never fire. The FLC ps1 redoes them harmlessly and
 *  keeps the desktop-side extras. Marker file tells the host-side install
 *  loop the image is viable even if first logon never happens. */
function cruiserPreinstallCmd(o: UnattendOpts): string {
    const winDirName = o.winDir === "w10" ? "Win10" : "Win11";
    return `@echo off\r\nrem specialize payload — drive letter comes from %~dp0 (this script's own drive)\r\nfor %%i in (d e f g h i j k l m n o p q r s t u v w) do if exist %%i:\\guest-agent\\qemu-ga-x86_64.msi msiexec /i %%i:\\guest-agent\\qemu-ga-x86_64.msi /qn /norestart\r\n${o.testsigning
        ? "bcdedit /set {current} testsigning on & bcdedit /set {current} nointegritychecks on & bcdedit /set {default} testsigning on & bcdedit /set {default} nointegritychecks on\r\n"
        : ""}${o.yttriumDir
        ? `for /r "%~dp0yttrium" %%j in (*.cer) do (certutil -addstore -f TrustedPublisher "%%j" & certutil -addstore -f Root "%%j")\r\nif exist "%~dp0yttrium\\Install_Debug\\${winDirName}\\amd64\\viogpu3d.inf" pnputil /add-driver "%~dp0yttrium\\Install_Debug\\${winDirName}\\amd64\\viogpu3d.inf" /install\r\n`
        : ""}echo specialize installs done > C:\\cruiser-preinstall-done\r\n`;
}

function cruiserDoneCmd(): string {
    return `@echo off\r\necho [cruiser] install complete — shutting down for the first real boot\r\nschtasks /delete /tn cruiser-setup /f >nul 2>&1\r\necho done > C:\\cruiser-installed\r\nshutdown /s /t 5 /c "cruiser install complete"\r\n`;
}

/** Write autounattend + scripts (+ optional yttrium payload) → Joliet ISO. */
/** Virtio drivers copied onto the seed ISO for the windowsPE
 *  PnpCustomizationsWinPE DriverPaths — WinPE loads viostor from these
 *  so the install disk can be REAL virtio (the production path), and the
 *  staged drivers carry into the installed image's store as boot drivers.
 *  Without this a windows install done on IDE dies 0x7B on the first
 *  virtio boot; installing the drivers post-boot doesn't retro-fix the
 *  CriticalDeviceDatabase. */
const WINPE_DRIVER_DIRS = [
    "viostor", "vioscsi", "NetKVM", "Balloon", "vioinput", "viorng",
    "vioserial", "viosock", "pvpanic", "viofs", "viogpudo",
];

export async function buildUnattendIso(workDir: string, o: UnattendOpts & { yttriumZip?: string; driverIso?: string; winDir?: string }): Promise<string> {
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, "autounattend.xml"), autounattendXml(o));
    await writeFile(join(workDir, "cruiser-setup.cmd"), cruiserSetupCmd());
    await writeFile(join(workDir, "cruiser-preinstall.cmd"), cruiserPreinstallCmd(o));
    await writeFile(join(workDir, "cruiser-setup.ps1"),
        cruiserSetupPs1({ ...o, yttriumDir: o.yttriumZip ? "yttrium" : undefined }));
    await writeFile(join(workDir, "cruiser-done.cmd"), cruiserDoneCmd());
    if (o.yttriumZip) {
        const yt = join(workDir, "yttrium");
        await mkdir(yt, { recursive: true });
        if (await which("unzip")) await run("unzip", ["-o", "-q", o.yttriumZip, "-d", yt]);
        else if (await which("bsdtar")) await run("bsdtar", ["-xf", o.yttriumZip, "-C", yt]);
        else throw new Error("need unzip or bsdtar to unpack the yttrium driver bundle");
    }
    const iso = join(workDir, "unattend.iso");
    // graft-points: explicit ISO-root names (and keeps unattend.iso itself
    // out on rebuilds — passing workDir raw would self-include it).
    const files = ["autounattend.xml", "cruiser-setup.cmd", "cruiser-setup.ps1", "cruiser-done.cmd", "cruiser-preinstall.cmd"];
    const grafts = files.map((f) => `${f}=${join(workDir, f)}`);
    if (o.yttriumZip) grafts.push(`yttrium=${join(workDir, "yttrium")}`);
    // extract the boot-critical virtio drivers off the virtio-win ISO into
    // /drivers so the answer file's DriverPaths can load viostor in WinPE.
    // isoinfo reads ISO9660 without a mount; each dir flattens to inf+sys+cat.
    if (o.driverIso && await which("isoinfo")) {
        const winVer = o.winDir ?? "w11";
        const list = await run("isoinfo", ["-f", "-i", o.driverIso]).then((r) => r.stdout).catch(() => "");
        const wanted = new Set(WINPE_DRIVER_DIRS.map((d) => d.toLowerCase()));
        for (const line of list.split("\n")) {
            const m = line.trim().match(/^\/([^/]+)\/(w1[01])\/(amd64)\/([^/]+)$/i);
            if (!m || !wanted.has(m[1].toLowerCase()) || m[2].toLowerCase() !== winVer) continue;
            const dst = join(workDir, "drivers", m[1].toLowerCase());
            await mkdir(dst, { recursive: true });
            await run("sh", ["-c", `isoinfo -i "$1" -x "$2" > "$3"`, "--",
                o.driverIso, line.trim(), join(dst, m[4])]).catch(() => {});
        }
        grafts.push(`drivers=${join(workDir, "drivers")}`);
    }
    if (await which("genisoimage")) {
        await run("genisoimage", ["-output", iso, "-volid", "CRUISER", "-joliet", "-rock",
            "-graft-points", ...grafts]);
    } else if (await which("xorriso")) {
        await run("xorriso", ["-as", "mkisofs", "-o", iso, "-V", "CRUISER", "-J", "-R",
            "-graft-points", ...grafts]);
    } else {
        throw new Error("need genisoimage or xorriso for unattend.iso");
    }
    return iso;
}
