---
title: vm.json (VmSpec)
description: The declarative per-VM contract — every field, its default, and what it controls.
---

Each VM is a zod-validated `vm.json` at
`~/.local/share/cruiser/vms/<name>/vm.json` — the single source of truth for
everything about the VM. Schema: `libraries/vm-core/src/config/schema.ts`
(`version: 1`, forward-migratable).

Edit while the VM is stopped; the next `vm start` picks changes up.

## Top level

| Field | Type | Default | Notes |
|---|---|---|---|
| `version` | `1` | `1` | schema version |
| `name` | string | — | `^[a-z0-9][a-z0-9-]*$`; also the dir name and window title prefix |
| `resources` | object | | `cpus` (1–64, dflt 4), `sockets` (1), `threads` (1), `memoryMiB` (≥512, dflt 8192) |
| `disk` | object | | `file` (`disk.qcow2`, relative to the VM dir or absolute), `sizeGiB` (≥4, dflt 100), `format` (`qcow2`) |
| `gpu` | object | | see below |
| `display` | object | | see below |
| `usb` | object | | `autoAttach: UsbDeviceRef[]` |
| `shares` | array | `[]` | `{ hostPath, tag, readOnly }` — see [file sharing](/guides/file-sharing/) |
| `os` | object | | guest OS profile — see below |
| `sync` | object | | host→guest sync channels — see below |
| `network` | object | | `hostfwd[]`, `sshPort`, `rdpPort`, `vsock` (dflt true) |
| `persist` | enum | `daemonize` | `daemonize` · `owned` · `ephemeral` |
| `provisioned` | object | | `method: cloudimg\|iso\|imported`, `source`, `completedAt` — written by provisioning |
| `credentials` | object | | `username` (POSIX name, dflt `cruiser`), `passwordFile` (0600 path — never an inline password) |
| `autostart` | bool | `false` | boot when the app starts |

## gpu

| Field | Default | Notes |
|---|---|---|
| `mode` | `venus` | `venus` (Vulkan) · `virgl` (GL) · `software` |
| `renderNode` | auto | e.g. `/dev/dri/renderD129` — pick the mesa-friendly node; NVIDIA EGL wedges QEMU init |
| `hostmemMiB` | `4096` | Venus blob hostmem region; needs ≳2 GiB for real workloads |

## display

| Field | Default | Notes |
|---|---|---|
| `headMode` | `virtual-desktop` | `fullscreen-monitor` · `windowed` · `virtual-desktop` · `app` |
| `monitors` | `"all"` | `"all"` → `/multimon`; else named monitors for `/monitor:<name>` |
| `sticky` | `false` | fullscreen-monitor only: show on all desktops |
| `virtualDesktop` | `2` | target desktop for virtual-desktop mode |
| `windowSize` | `{w:1600, h:1000}` | windowed mode size |
| `escapeShortcuts` | `[{keys:"ctrl+alt+delete", action:"host-desktop:1"}, {keys:"ctrl+alt+end", action:"command:{cli} vm kill {vm}"}]` | host keybindings while the viewer runs — keys normalized lowercase, action `name` or `name:arg` |
| `dynamicResolution` | `true` | freerdp dynamic-resolution channel |
| `wallpaper` | `{managed:true, position:"bottom-right"}` | cruiser-managed guest wallpaper — watermarked with the VM name + escape hints; `position`: corner/`center`/`off` (no watermark); `managed:false` leaves the guest alone; `source` = host image path (default: generated gradient) |
| `sound` / `microphone` / `clipboard` | `true` | RDP redirection toggles |
| `grabKeyboard` | `false` | `false` → freerdp `-grab-keyboard` (host keeps global shortcuts — required for escape shortcuts); `true` → `+grab-keyboard` (guest gets all keys) |

Escape actions: `host-desktop:<n>` · `desktop-cycle-left` ·
`desktop-cycle-right` · `ungrab` · `none` · `command:<cmdline>` (run via
`sh -c`; `{vm}` expands to the VM name, `{cli}` to the cruiser CLI — `bun
run …/src/cli.ts` in dev trees, `cruiser` when packaged).

## usb.autoAttach

`{ vendorId, productId, serial?, atBoot }` — attach at QEMU launch
(`atBoot`) vs hotplug-on-demand via `usb attach`.

## os (guest profile)

Drives image selection and the in-guest package/desktop setup. On imported
disks the family may be wrong — guest-setup re-detects from
`/etc/os-release` and self-corrects.

| Field | Default | Notes |
|---|---|---|
| `family` | `ubuntu` | `ubuntu` · `debian` · `fedora` |
| `release` | `""` | empty = curated default for the family |
| `desktop` | `gnome` | `gnome` · `kde` (kde needs a `krdp`-shipping release) |
| `browser` | `none` | flatpak preinstall: `firefox` · `chrome` · `chromium` · `vivaldi` · `brave` · `none` |
| `snap` | `false` | install snapd; off = flatpak is the only app channel |
| `extraFonts` | `false` | CJK + MS core fonts beyond the base bundle |
| `autologin` | `true` | DM autologin; effectively required for KDE RDP |
| `devtools` | `[]` | `toolchain` · `python` · `node` · `rust` · `go` · `containers` · `linters` · `debug` · `shell` |
| `extraPackages` | `[]` | extra distro packages, strict-validated names |

## sync (host → guest)

Per-channel booleans; old `vm.json` files parse with defaults (no
migration). Channels marked **live** re-push while a viewer session is
open; the rest apply at session start (and provision, where noted),
hash-gated via `run/sync.state` so in-guest drift isn't clobbered unless
the host value actually changed.

| Field | Default | Notes |
|---|---|---|
| `theme` | `true` | dark/light via xdg portal — **live** + provision bake |
| `accentColor` | `true` | portal accent-color → GNOME named accent / KDE `AccentColor` — **live** |
| `contrast` | `true` | portal contrast → high-contrast — **live** |
| `timezone` | `true` | host zone → `timedatectl`; provision default + **live** (watches `/etc/localtime`) |
| `locale` | `true` | host `LANG` → `localectl`; seed + provision + session start |
| `keyboard` | `true` | host X11 keymap → `localectl`/DE input sources; seed + provision + session start |
| `monitors` | `true` | host topology (incl. scale/rate) → `monitors.xml`; provision + session start, GNOME guests |
| `hostWallpaper` | `true` | host's wallpaper as the managed composite's base image (watermark still applied; `display.wallpaper.source` wins) |
| `gitIdentity` | `false` | host `user.name`/`user.email` → guest git config. **Security-sensitive** |
| `proxy` | `false` | host proxy → guest gsettings/kioslaverc + `/etc/profile.d` env. **Security-sensitive** |
| `caCerts` | `false` | host custom CA roots → guest trust store. **Security-sensitive** |
| `sshAgent` | `false` | host `SSH_AUTH_SOCK` → guest via a held `ssh -N -R` forward (session lifetime). **Security-sensitive** |

The last four default off deliberately: they move host identity, trust, or
credentials into the guest — opt in per VM.

Env overrides: `CRUISER_HOST_SYNC=0` disables everything;
`CRUISER_SYNC_<ID>=0` per channel (`CRUISER_SYNC_THEME`, `_ACCENT`,
`_CONTRAST`, `_TIMEZONE`, `_LOCALE`, `_KEYBOARD`, `_MONITORS`,
`_HOST_WALLPAPER`, `_GIT`, `_PROXY`, `_CA_CERTS`, `_SSH_AGENT`);
`CRUISER_THEME_SYNC=0` still honored for `theme`. CLI: `vm create
--sync a,b --no-sync x,y` at create; `vm sync <name>` lists channels,
`vm sync <name> <channel> on|off` persists a toggle (`--apply` re-pushes
immediately on a running VM).

## network

| Field | Default | Notes |
|---|---|---|
| `hostfwd` | `[]` | `{ hostPort, guestPort, proto: tcp\|udp }` extra forwards |
| `sshPort` | allocated | 127.0.0.1 → guest :22; resolved+stored at create |
| `rdpPort` | allocated | 127.0.0.1 → guest :3389 |
| `vsock` | `true` | `vhost-vsock-pci` for the waypipe bridge |

## Example

```json
{
  "version": 1,
  "name": "myvm",
  "resources": { "cpus": 8, "sockets": 1, "threads": 1, "memoryMiB": 16384 },
  "disk": { "file": "disk.qcow2", "sizeGiB": 120, "format": "qcow2" },
  "gpu": { "mode": "venus", "hostmemMiB": 4096 },
  "display": {
    "headMode": "virtual-desktop",
    "monitors": "all",
    "virtualDesktop": 3,
    "escapeShortcuts": [
      { "keys": "ctrl+alt+delete", "action": "host-desktop:1" },
      { "keys": "ctrl+alt+end", "action": "command:{cli} vm kill {vm}" }
    ],
    "grabKeyboard": false
  },
  "shares": [{ "hostPath": "/home/me/code", "tag": "code", "readOnly": false }],
  "os": { "family": "ubuntu", "release": "26.04", "desktop": "gnome",
          "devtools": ["rust", "shell"] },
  "network": { "sshPort": 2223, "rdpPort": 3391, "vsock": true },
  "persist": "daemonize",
  "credentials": { "username": "me", "passwordFile": "secrets/password" },
  "autostart": false
}
```
