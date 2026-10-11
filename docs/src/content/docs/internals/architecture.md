---
title: Architecture
description: Process model, storage, display path, head modes, and lifecycle — the design doc.
---

## Process model

```
cruiser app (DownDraft native, bun/node)
├── src/native-entry.ts          winit window + wgpu surface + frame loop
├── libraries/app-shell          zustand store ↔ HtmlUiHost (Blitz) ↔ CruiserService
├── libraries/vm-core            VmSpec · args builder · QMP/QGA · VmHandle · disk · usb
├── libraries/host-int           WmAdapter (per DE/session) · freerdp viewer sessions
├── libraries/provision          cloudimg/NoCloud · ISO autoinstall · guest-setup (QGA)
├── libraries/app-mode           waypipe vsock/ssh transport + guest app catalog
└── libraries/sys                exec helpers (node:child_process)
        │
        ▼  unix sockets (QMP monitor.sock · QGA qga.sock · SPICE spice.sock · vsock)
qemu-system-x86_64  (pinned build, opt/qemu-11 — see toolchain/)
        │  KVM, virtio-gpu (venus/virgl), user-net hostfwd
        ▼
Linux guest: gnome-remote-desktop (system daemon) → hostfwd RDP → xfreerdp3
             waypipe server → vsock bridge → host `waypipe client`
```

## Why raw QEMU (not libvirt/docker)

WinBoat wraps QEMU in Docker because Windows needs an appliance boundary.
Linux guests need none of that — QEMU's QMP/QGA sockets give us lifecycle,
hotplug, snapshots, and in-guest exec directly. `VmHandle` is the state
machine: `probe()` = pidfile + socket + `query-status`; daemonized VMs
persist past app exit and are re-adopted by reattaching to the sockets.

QMP/QGA unix chardevs accept **one** pending client each — connections are
never cached. `VmHandle.withQmp/withQga` open a fresh socket per op and
serialize in-process; a held socket starves the other surface (a probe that
never returns shows as "starting" forever).

## Storage layout

`~/.local/share/cruiser/vms/<name>/` — `vm.json` (source of truth, zod
schema), `disk.qcow2`, `OVMF_VARS.fd`, `run/` (sockets, pid, logs),
`secrets/` (0600 password files), `snapshots/`, `backups/`.
`~/.cache/cruiser/cloudimg/` — shared base images.
See [storage layout](/reference/storage/).

## Display path

`virtio-vga-gl` + Venus (Vulkan-in-guest via virglrenderer) or virgl or
plain virtio-vga. The guest runs **gnome-remote-desktop in system
(headless) mode** — the only path that exposes all virtio-gpu outputs as
RDP monitors. QEMU still exposes a SPICE unix socket as an emergency
console. Render node must be the mesa one (`rendernode=/dev/dri/renderD*`);
NVIDIA EGL wedges QEMU init — `gpu/rendernode.ts` auto-picks.

RDP reaches the host via QEMU `hostfwd` (allocated ports, bind-probed).
Guest-side gotchas learned the hard way (all handled in `provision/`):

- `grdctl --system` re-execs through `pkexec`; on a bare server image it
  exits 0 while applying **nothing** — `pkexec`/`polkitd` must be installed
  and the `:3389` listener verified rather than trusting exit codes.
- grd remote-login needs a real session stack: `gdm3` + `gnome-shell` +
  `gnome-session`, which a server cloudimg does not have.
- `guest-setup` runs as root over QGA; user-context steps (`gsettings`,
  `monitors.xml`) are explicitly `runuser`'d to the provisioned account.
- `qemu-ga` can wedge (poll spin, unkillable without SIGKILL) when no host
  client is attached to the QGA chardev for a long stretch; all client
  calls carry timeouts and a failed ping drops + reopens the socket.

## Head modes

| mode | transport | placement |
|---|---|---|
| `fullscreen-monitor` | freerdp `/f` (+`/multimon` or `/monitor:name`) | WmAdapter.moveToMonitor + fullscreen; `sticky` → all desktops |
| `virtual-desktop` | freerdp `/f` | moveToDesktop(n) + fullscreen |
| `windowed` | freerdp `/size:WxH` | none |
| `app` | **waypipe** (vsock → ssh fallback) | guest app windows appear as host windows |

Escape shortcuts (schema `display.escapeShortcuts`) are installed as *host*
keybindings (KDE `kglobalshortcutsrc` / GNOME gsettings) and only work when
freerdp runs `-grab-keyboard` — the default (`grabKeyboard:false` is
load-bearing). `command:<cmdline>` actions ride KDE's khotkeys
`SIMPLE_ACTION_DATA` entries on Plasma 5 (the `[services]` launcher binds
but never dispatches there) or the `[services]` desktop-launcher binding on
Plasma 6 / GNOME's media-keys `custom-keybinding` slot; `{vm}` and `{cli}`
expand at install time.

## Provisioning

- **cloudimg**: distro cloud img → per-VM qcow2 overlay → NoCloud seed →
  first boot runs cloud-init → QGA guest-setup (grd/krdp, autologin, fstab
  shares, no-lock, monitors.xml mirrored from host topology, host
  dark/light hint baked into the guest DE).
- **iso**: desktop ISO + autoinstall seed, casper kernel direct-booted with
  serial log → poweroff → normal boot → same guest-setup.

## Host → guest sync

`spec.sync` gates twelve channels — see [vm.json](/reference/vm-spec/#sync-host--guest)
for the table. Eight default on (appearance/convenience); the four that
move host identity, trust, or credentials into the guest (`gitIdentity`,
`proxy`, `caCerts`, `sshAgent`) default off.

Host side, `host-int/appearance.ts` reads portal keys
(`color-scheme`/`accent-color`/`contrast`; busctl, gdbus fallback) and
runs one shared `dbus-monitor` on the portal's `SettingChanged` signal.
`host-int/hoststate.ts` probes everything non-portal: timezone, `LANG`,
X11 keymap, the host's wallpaper path, git `user.name`/`user.email`,
gsettings/kioslaverc proxy, custom CA roots, `SSH_AUTH_SOCK`.

Guest side, `provision/sync.ts` (`SessionSyncs`, viewer-session lifetime —
wired in `ensureViewer` + cli `vm start|view`) applies them in three
classes:

- **Live** — theme/accent/contrast ride the shared portal watcher;
  timezone rides an `fs.watch` on `/etc/localtime` + `/etc/timezone`
  (system-bus monitoring needs root; inotify doesn't). All live pushes are
  serialized with a queued rerun so host-change bursts can't drop a
  channel, and a per-channel hash skips no-change pushes (a failed apply
  doesn't advance the hash, so the next change retries).
- **Session one-shots** — locale, keyboard, monitors (GNOME guests —
  `monitors.xml` incl. probed scale/refresh), git identity, proxy, CA
  certs. Hash-gated via `run/sync.state` like `wallpaper.state`: in-guest
  drift is never clobbered unless the host value actually changed.
- **Held process** — `sshAgent` holds an `ssh -N -R` remote-forward of the
  host agent socket for the session (`ExitOnForwardFailure`, keepalives,
  respawn with backoff), and wires `SSH_AUTH_SOCK` into the guest's
  `/etc/environment`. No keys are ever copied — opt-in only.

Every channel's guest script follows the `guestThemeScript` mold: run via
`guestRun` as root (QGA, ssh+sudo fallback for SELinux-confined agents),
`runuser` for user-context steps, `command -v` gates so a wrong
`spec.os.desktop` on an imported disk can't misfire, and never a nonzero
exit that could abort a provision bake. Theme applies as
`gsettings … color-scheme prefer-dark|default` (the `dbus-run-session`
fallback makes the dconf write land pre-login) or
`plasma-apply-colorscheme BreezeDark|BreezeLight` with a bare `kdeglobals`
fallback; light maps to `default` rather than `prefer-light` for older
gsettings schemas, and host "no preference" is never pushed.

Provision bakes the same values so first login is already right: the
NoCloud/autoinstall seeds take the host timezone/locale/keymap instead of
the old `UTC`/`en_US.UTF-8`/`us` hardcodes, and guest-setup re-applies the
appearance channels.

`hostWallpaper` doesn't bypass the managed-wallpaper system — the host's
current wallpaper becomes the *base image* of the jimp composite, and the
VM watermark is still rendered on top. `display.wallpaper.source` wins
when set.

Env kills: `CRUISER_HOST_SYNC=0` disables all channels,
`CRUISER_SYNC_<ID>=0` per channel, `CRUISER_THEME_SYNC=0` and
`CRUISER_WALLPAPER=0` still honored.

## Lifecycle persistence

`persist: daemonize` (default) — QEMU detaches, app exit leaves the VM up;
next app start re-adopts via sockets. `persist: owned` — QEMU is a child
process and dies with the app. `persist: ephemeral` — owned + the VM dir
(including the disk) is deleted on exit.

## App runtime

Bare `createNativeHost` + `HtmlUiHost` (worker Blitz backend, gpu-direct
compositing) on the DownDraft native runtime — no Chromium anywhere. Input
via a small `InputBus`. `file:` deps to the sibling engine checkout so
fixes land upstream.
