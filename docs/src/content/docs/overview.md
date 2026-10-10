---
title: Overview
description: What Cruiser is, what it does, and how it compares to adjacent tools.
---

Cruiser is a multi-VM QEMU/KVM manager for **Linux guests on Linux hosts** —
the Linux counterpart to [WinBoat](https://github.com/TibixDev/winboat),
minus the container indirection (raw QEMU + QMP/QGA) and minus Electron
(a native winit + wgpu + Blitz UI).

The premise: a Linux VM shouldn't feel like a separate machine. Its desktop
can fill a monitor or a virtual desktop, its individual apps can appear as
host windows, its files are mountable, its theme follows the host's dark/light
preference, and it keeps running after the UI closes.

## Two surfaces, one core

Everything Cruiser does is implemented in runtime-agnostic TypeScript
libraries under `libraries/` and driven by two front ends:

- **The CLI** (`bun run cli -- <args>`) — a headless control surface covering
  every feature: VM lifecycle, provisioning, USB, viewing, app mode, logs,
  host probing, and `doctor`. It also backs `.desktop` files and escape
  shortcuts.
- **The app** (`bun run src/native-entry.ts`) — a native window rendering the
  same operations: VM list, create wizard, per-VM detail with live actions,
  a logs screen, and a settings/doctor screen.

Because both drive the same `VmHandle` state machine, a VM started by the CLI
shows up in the UI and vice versa.

## Feature summary

| Area | Status |
|---|---|
| VM lifecycle | create / start / stop / kill / status, daemonized or app-owned QEMU, reattach after app exit |
| GPU | Venus (Vulkan), virgl (GL), software; auto render-node pick |
| Display | xfreerdp3 viewer: windowed, virtual-desktop, fullscreen-monitor; `app` head mode over waypipe |
| Provisioning | cloudimg + NoCloud and ISO autoinstall; QGA guest-setup (RDP stack, autologin, shares, monitor mirroring, theme) |
| Integration | host dark/light passthrough (baked + live sync), host shares via virtiofs/9p, sshfs mounts, USB hotplug |
| Disk ops | internal snapshots, live/offline backups, qcow2 resize |
| Observability | runner log files (cruiser/qemu/serial/install-serial) + guest journalctl over QGA or ssh |

## Design choices worth knowing

- **Raw QEMU, not libvirt/docker.** QMP and the guest agent give lifecycle,
  hotplug, and in-guest exec without another abstraction layer.
- **vm.json is the source of truth.** Every VM is a zod-validated `VmSpec`
  on disk; the app and CLI are views over it.
- **A pinned QEMU toolchain.** Cruiser builds and runs QEMU 11 + matching
  virglrenderer/spice from source into `opt/` so distro packages can't
  silently break Venus. See [QEMU toolchain](/internals/toolchain/).
- **Linux guests only.** Ubuntu, Debian, and Fedora families, per
  [distro matrix](/reference/distros/). GNOME and KDE Plasma desktops.
- **No NLA.** The in-guest RDP servers (gnome-remote-desktop, KRDP) speak
  TLS/RDP security — freerdp is never invoked with `/sec:nla`.

## How it compares

| | Cruiser | WinBoat | virt-manager / GNOME Boxes |
|---|---|---|---|
| Guest OS | Linux | Windows | any |
| QEMU access | direct QMP/QGA | QEMU in Docker | libvirt daemon |
| Desktop integration | head modes, app mode, theme sync | app mode via RDP | viewer window only |
| Display path | RDP (grd/KRDP) → freerdp | RDP | SPICE/VNC |
