---
title: Creating VMs
description: Every vm create flag, what it writes into vm.json, and how to import an existing disk.
---

`vm create` writes a `vm.json` (a zod-validated [VmSpec](/reference/vm-spec/))
into `~/.local/share/cruiser/vms/<name>/`. Nothing boots and no disk exists
until `vm start` (which auto-creates a sparse qcow2) or provisioning.

```sh
bun run cli -- vm create myvm [flags]
```

## Flags

| Flag | Spec field | Default | Notes |
|---|---|---|---|
| `--cpus N` | `resources.cpus` | `4` | 1–64 |
| `--mem MiB` | `resources.memoryMiB` | `8192` | min 512 |
| `--disk GiB` | `disk.sizeGiB` | `100` | sparse qcow2, min 4 |
| `--gpu MODE` | `gpu.mode` | `venus` | `venus` · `virgl` · `software` |
| `--head-mode M` | `display.headMode` | `virtual-desktop` | `fullscreen-monitor` · `windowed` · `virtual-desktop` · `app` |
| `--persist M` | `persist` | `daemonize` | `daemonize` · `owned` · `ephemeral` |
| `--share PATH[:tag]` | `shares[]` | — | repeatable; mounts in-guest at `/mnt/<tag>` |
| `--distro F` | `os.family` | `ubuntu` | `ubuntu` · `debian` · `fedora` |
| `--desktop D` | `os.desktop` | `gnome` | `gnome` · `kde` |
| `--browser B` | `os.browser` | `none` | `firefox` · `chrome` · `chromium` · `vivaldi` · `brave` (flatpaks) |
| `--snap` | `os.snap` | `false` | also install snapd |
| `--xfonts` | `os.extraFonts` | `false` | CJK + MS core fonts |
| `--no-autologin` | `os.autologin` | `true`→`false` | KDE guests effectively need autologin (krdpserver is a user-session service) |
| `--devtools a,b,…` | `os.devtools` | `[]` | see [provisioning → devtools](/guides/provisioning/#developer-tooling) |
| `--autosnap F` | `snapshots.auto` | `off` | `daily` · `weekly` · `monthly` auto snapshots |
| `--snap-trigger T` | `snapshots.trigger` | `stop` | `start` · `stop` · `both` — which edge fires the auto snapshot |
| `--snap-keep N` | `snapshots.keep` | `5` | auto-* snapshots retained; oldest auto-pruned |

Flag values are re-validated against the schema after parsing, so a typo
(`--distro ubntu`) fails at create time rather than poisoning `vm.json`.

## Naming

VM names must match `^[a-z0-9][a-z0-9-]*$` — they become directory names,
hostfwd port anchors, and window title prefixes (`cruiser:<name>`).

## GPU modes

- **`venus`** — Vulkan inside the guest, mapped to host Vulkan through
  virglrenderer. Needs `gpu.hostmemMiB` (default 4 GiB of blob hostmem) and a
  mesa-friendly render node. Best performance; the default.
- **`virgl`** — OpenGL in the guest. More compatible, less capable.
- **`software`** — llvmpipe. Works everywhere, slow; useful for servers or
  hosts with no usable GPU.

`gpu/rendernode.ts` picks `/dev/dri/renderD*` automatically, preferring mesa
nodes — NVIDIA EGL wedges QEMU init, so it's skipped. Override with
`gpu.renderNode` in `vm.json`.

## Head modes (preview)

`display.headMode` decides how the desktop is presented when you `vm start`
or `vm view`:

| Mode | Result |
|---|---|
| `fullscreen-monitor` | freerdp fullscreen on a chosen monitor (or `/multimon` for all) |
| `virtual-desktop` | freerdp fullscreened onto virtual desktop N |
| `windowed` | freerdp at `display.windowSize` (default 1600×1000) |
| `app` | no desktop viewer — launch individual guest apps via waypipe |

Full details in [viewing & head modes](/guides/viewing/) and
[app mode](/guides/app-mode/).

## Persistence modes

- **`daemonize`** (default) — QEMU detaches; closing the app leaves the VM
  running and the next launch re-adopts it via its sockets.
- **`owned`** — QEMU is a child of the app and stops when the app exits.
- **`ephemeral`** — `owned`, plus the entire VM directory (including the
  disk) is deleted on exit. Scratch VMs only.

## Importing an existing disk

Create the VM, then drop a disk into place before first start:

```sh
bun run cli -- vm create imported-vm --persist daemonize
cp /path/to/existing.qcow2 ~/.local/share/cruiser/vms/imported-vm/disk.qcow2
bun run cli -- vm start imported-vm --no-view
bun run cli -- provision guest-setup imported-vm   # wire RDP/agent/etc.
```

Or point `disk.file` at an absolute path in `vm.json`. Guest-setup
re-detects the real distro from `/etc/os-release`, so a wrong `os.family`
on an imported disk self-corrects during setup.

## Editing after creation

`vm.json` is the source of truth — edit it while the VM is stopped and the
next `vm start` picks it up (port changes, head mode, memory, shares…). The
UI's VM detail screen edits the same fields through the create wizard.
