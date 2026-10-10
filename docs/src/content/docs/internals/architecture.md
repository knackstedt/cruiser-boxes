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
load-bearing).

## Provisioning

- **cloudimg**: distro cloud img → per-VM qcow2 overlay → NoCloud seed →
  first boot runs cloud-init → QGA guest-setup (grd/krdp, autologin, fstab
  shares, no-lock, monitors.xml mirrored from host topology, host
  dark/light hint baked into the guest DE).
- **iso**: desktop ISO + autoinstall seed, casper kernel direct-booted with
  serial log → poweroff → normal boot → same guest-setup.

## Host theme passthrough

`host-int/appearance.ts` reads the host's dark/light preference from the
xdg-desktop-portal `org.freedesktop.appearance` `color-scheme` key (busctl,
gdbus fallback — 0 = no preference, 1 = dark, 2 = light) and watches the
portal's `SettingChanged` signal via `dbus-monitor`. `provision/theme.ts`
applies it in-guest over `guestRun` (QGA, ssh+sudo fallback for confined
agents): `gsettings … color-scheme prefer-dark|default` for GNOME/GTK —
the `dbus-run-session` fallback makes the dconf write land pre-login —
and `plasma-apply-colorscheme BreezeDark|BreezeLight` for Plasma, with a
bare `kdeglobals` write as fallback. Both paths are `command -v`-gated so
a wrong `spec.os.desktop` on an imported disk can't misfire.

The hint is baked during guest-setup (`syncHostTheme` provision opt) so
the first login is already themed, then `ThemeSync` re-pushes on host
changes for a viewer session's lifetime — wired in `ensureViewer` and
cli `vm start|view`. Light maps to `default` rather than `prefer-light`
for older gsettings schemas, and host "no preference" is never pushed.
`CRUISER_THEME_SYNC=0` opts out.

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
