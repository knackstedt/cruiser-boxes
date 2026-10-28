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
      </UserData>`)}
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
        <RunSynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Path>cmd.exe /c "for %i in (d e f g h i j k l m n o p q r s t u v w) do if exist %i:\\cruiser-setup.cmd call %i:\\cruiser-setup.cmd"</Path>
          <Description>cruiser guest setup</Description>
        </RunSynchronousCommand>
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
          <CommandLine>cmd.exe /c "for %i in (d e f g h i j k l m n o p q r s t u v w) do if exist %i:\\cruiser-done.cmd call %i:\\cruiser-done.cmd"</CommandLine>
          <Description>cruiser install completion</Description>
        </SynchronousCommand>
      </FirstLogonCommands>`)}
  </settings>
</unattend>
`;
}

/** specialize-pass entry — the cmd shim only exists because unattend's
 *  RunSynchronous wants a literal path; it hands off to the ps1 (which is
 *  where anything worth logging/debugging lives). */
function cruiserSetupCmd(): string {
    return `@echo off\r\nrem specialize-pass entry — finds the seed ISO (this file's own drive)\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0cruiser-setup.ps1" "%~d0" >> C:\\cruiser-setup.log 2>&1\r\n`;
}

/**
 * The specialize-pass provisioning script — everything that must be baked
 * into the image before first logon. Runs as SYSTEM in the installed OS.
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
# cert first so pnputil accepts the self-signed driver package; every .inf
# under the payload is registered (the KMD binds virtio-gpu, the mesa DLLs
# land beside it per the release layout).
$yt = Join-Path $seed "yttrium"
if (Test-Path $yt) {
    Write-Output "[cruiser] installing yttrium payload from $yt"
    Get-ChildItem $yt -Recurse -Filter *.cer | ForEach-Object {
        & certutil -addstore -f TrustedPublisher $_.FullName | Out-Null
        & certutil -addstore -f Root $_.FullName | Out-Null }
    Get-ChildItem $yt -Recurse -Filter *.inf | ForEach-Object {
        Write-Output "[cruiser] pnputil $($_.Name)"
        & pnputil /add-driver $_.FullName /install | Out-Null }
    Get-ChildItem $yt -Recurse -Include *.dll,*.json -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'mesa|virtio|vulkan|zink|d3d|opengl' } | ForEach-Object {
            Copy-Item $_.FullName "C:\\Windows\\System32\\" -Force -ErrorAction SilentlyContinue }
    # venus/wddm path: DWM compositing needs the vendor registry hint
    New-Item "HKLM:\\SOFTWARE\\Cruiser" -Force | Out-Null
    Set-ItemProperty "HKLM:\\SOFTWARE\\Cruiser" -Name YttriumInstalled -Value 1
} else { Write-Output "[cruiser] WARN: yttrium payload missing on seed media" }
` : "";
    return `param([string]$seed = "")
$ErrorActionPreference = "Continue"
Write-Output "[cruiser] specialize setup starting (seed=$seed)"

# ── virtio-win guest tools: all virtio drivers (viostor/NetKVM/vioinput/
# balloon/viosock) + qemu-ga + spice agent + virtiofs. Finds the driver CD
# by its marker exe — drive letters aren't stable across boot stages. ──
$virtio = Get-PSDrive -PSProvider FileSystem |
    Where-Object { Test-Path "$($_.Root)virtio-win-guest-tools.exe" } |
    Select-Object -First 1
if ($virtio) {
    Write-Output "[cruiser] virtio-win-guest-tools on $($virtio.Root)"
    & "$($virtio.Root)virtio-win-guest-tools.exe" /install /quiet /norestart | Out-Null
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

New-Item "C:\\cruiser-installed" -ItemType File -Force | Out-Null
Set-Content "C:\\cruiser-installed" -Value (Get-Date -Format o)
Write-Output "[cruiser] specialize setup done"
`;
}

/**
 * FirstLogonCommands hook — runs inside the autologged session once, after
 * the specialize config. The shutdown signals "install complete" to the
 * host: the owned install QEMU exits, and the lifecycle then boots the VM
 * normally (drivers + testsigning take effect on that boot).
 */
function cruiserDoneCmd(): string {
    return `@echo off\r\necho [cruiser] install complete — shutting down for the first real boot\r\nshutdown /s /t 5 /c "cruiser install complete"\r\n`;
}

/** Write autounattend + scripts (+ optional yttrium payload) → Joliet ISO. */
export async function buildUnattendIso(workDir: string, o: UnattendOpts & { yttriumZip?: string }): Promise<string> {
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, "autounattend.xml"), autounattendXml(o));
    await writeFile(join(workDir, "cruiser-setup.cmd"), cruiserSetupCmd());
    await writeFile(join(workDir, "cruiser-setup.ps1"), cruiserSetupPs1(o));
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
    const files = ["autounattend.xml", "cruiser-setup.cmd", "cruiser-setup.ps1", "cruiser-done.cmd"];
    const grafts = files.map((f) => `${f}=${join(workDir, f)}`);
    if (o.yttriumZip) grafts.push(`yttrium=${join(workDir, "yttrium")}`);
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
