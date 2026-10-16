---
title: Installation
description: Host requirements, dependencies, the pinned QEMU toolchain, and doctor.
---

## Requirements

- A Linux host with **KVM** (`/dev/kvm`) and a Vulkan-capable GPU for the
  accelerated display paths.
- [Bun](https://bun.sh) for running the app and CLI (libraries are
  runtime-agnostic and also work under Node).
- A desktop environment. Window *placement* is fully supported on KDE/X11,
  partial on KDE-Wayland and GNOME-X11, and falls back to the viewer placing
  itself elsewhere — see the [DE matrix](/internals/de-matrix/).

## Clone and install

```sh
git clone https://github.com/knackstedt/cruiser-boxes
cd cruiser-boxes
bun install
```

`@downdraft/*` packages install from npm. To hack on the engine too, clone it
next to this repo (`../downdraft-engine` or `../downdraft`) — the postinstall
(`scripts/link-engine.mjs`, `bun run engine:link`) then symlinks the checkout
into `node_modules` as an override. `CRUISER_ENGINE_DIR` points at a checkout
anywhere else.

## Host packages

```sh
sudo apt install freerdp3-x11 ovmf cloud-image-utils waypipe socat \
                 wmctrl xdotool qdbus sshfs
sudo apt install virtiofsd   # preferred host-share backend (9p fallback)
```

| Tool | Used for |
|---|---|
| `xfreerdp3` (≥ 3.5) | the viewer for all desktop head modes |
| `ovmf` | UEFI firmware (`OVMF_CODE_4M.fd`) |
| `cloud-localds` | NoCloud seed images for cloudimg provisioning |
| `genisoimage` / `xorriso` | seed ISO fallback |
| `waypipe` + `socat` | app-mode transport |
| `wmctrl`, `xdotool` | X11 window find/move/fullscreen |
| `qdbus` | KDE desktop/shortcut integration |
| `sshfs` | `vm mount` (guest dirs on the host) |
| `virtiofsd` | high-performance host shares (often in `/usr/libexec`) |

## KVM access

Your user needs read/write on `/dev/kvm`:

```sh
sudo usermod -aG kvm $USER   # then log out and back in
```

## QEMU toolchain

Cruiser runs a **pinned, source-built QEMU** (currently QEMU 11.1.1 with
virglrenderer 1.3 + spice 0.16) because distro builds lack Venus exports or
ship broken GL modules. The pins live in `toolchain/versions.json`.

```sh
bun run cli -- toolchain check    # what resolves on this host
bun run cli -- toolchain build    # fetch + build into opt/ (record-on-download sha256)
```

A system QEMU is used as a fallback if `opt/` is empty. See
[QEMU toolchain](/internals/toolchain/) for how components are pinned.

## USB passthrough permissions

`usb-host` needs rw on `/dev/bus/usb` nodes, which most distros ship
root-only. A one-time udev rule fixes it:

```udev
# /etc/udev/rules.d/99-cruiser-usb.rules
SUBSYSTEM=="usb", GROUP="plugdev", MODE="0660"
```

then `sudo udevadm control --reload && sudo udevadm trigger` (and make sure
your user is in `plugdev`).

## Verify with doctor

```sh
bun run cli -- doctor
```

Doctor checks `/dev/kvm` access, kvm group membership, every required tool,
the QEMU toolchain (including a `--version` smoke run), OVMF firmware, and
USB device permissions — printing a concrete fix for each failure:

```
 ok  /dev/kvm writable (kvm group)
 ok  tool: xfreerdp3
FAIL  usb passthrough (8/12 devices lack rw)  → udev rule: SUBSYSTEM=="usb", GROUP="plugdev", MODE="0660" → /etc/udev/rules.d/99-cruiser-usb.rules
```

The app's Settings screen runs the same checks.
