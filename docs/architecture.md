# cruiser architecture

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

## Storage layout

`~/.local/share/cruiser/vms/<name>/` — `vm.json` (source of truth, zod
schema), `disk.qcow2`, `OVMF_VARS.fd`, `run/` (sockets, pid, logs),
`secrets/` (0600 password files), `snapshots/`, `backups/`.
`~/.cache/cruiser/cloudimg/` — shared base images.

## Display path

`virtio-vga-gl` + Venus (Vulkan-in-guest via virglrenderer) or virgl or
plain virtio-vga. The guest runs **gnome-remote-desktop in system
(headless) mode** — the only path that exposes all virtio-gpu outputs as
RDP monitors. QEMU still exposes a SPICE unix socket as an emergency
console. Render node must be the mesa one (`rendernode=/dev/dri/renderD*`);
NVIDIA EGL wedges QEMU init — `gpu/rendernode.ts` auto-picks.

RDP reaches the host via QEMU `hostfwd` (allocated ports, bind-probed —
the devvm prototype may already hold 2222/3389).

## Head modes

| mode | transport | placement |
|---|---|---|
| `fullscreen-monitor` | freerdp `/f` (+`/multimon` or `/monitor:name`) | WmAdapter.moveToMonitor + fullscreen; `sticky` → all desktops |
| `virtual-desktop` | freerdp `/f` | moveToDesktop(n) + fullscreen |
| `windowed` | freerdp `/size:WxH` | none |
| `app` | **waypipe** (vsock → ssh fallback) | guest app windows appear as host windows |

Escape shortcuts (schema `display.escapeShortcuts`) are installed as *host*
keybindings (KDE `kglobalshortcutsrc` / GNOME gsettings) and only work when
freerdp runs `-grab-keyboard` — the default.

## Provisioning

- **cloudimg**: ubuntu cloud img → per-VM qcow2 overlay → NoCloud seed →
  first boot runs cloud-init → QGA guest-setup (grd, autologin, fstab
  shares, no-lock, monitors.xml mirrored from host topology).
- **iso**: desktop ISO + autoinstall seed, casper kernel direct-booted with
  serial log → poweroff → normal boot → same guest-setup.

## Lifecycle persistence

`persist: daemonize` (default) — QEMU detaches, app exit leaves the VM up;
next app start re-adopts via sockets. `persist: owned` — QEMU is a child
process and dies with the app.

## DownDraft integration

Bare `createNativeHost` + `HtmlUiHost` (worker Blitz backend, gpu-direct
compositing). No GameModule. Input via a small `InputBus` implementing
`RendererInputBus`. `file:` deps to the sibling engine checkout so fixes
land upstream.
