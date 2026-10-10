---
title: Quickstart
description: From zero to a running, viewed VM in five commands.
---

This walks the shortest path from a checkout to a provisioned Linux VM
viewed on your desktop. Prerequisites: [installation](/installation/) done,
`doctor` green.

## 1. Create the VM

```sh
bun run cli -- vm create myvm --cpus 8 --mem 16384 --disk 120
```

This writes `~/.local/share/cruiser/vms/myvm/vm.json` with defaults
(Venus GPU, `virtual-desktop` head mode, auto-allocated ssh/rdp hostfwd
ports) plus your overrides. No disk or OS yet.

## 2. Provision it

```sh
bun run cli -- provision cloudimg myvm --user me --password secret
```

Cruiser downloads the distro's cloud image (cached in
`~/.cache/cruiser/cloudimg` for future VMs), creates a qcow2 overlay, builds
a NoCloud seed, boots the VM so cloud-init runs, then drives **guest-setup**
over the guest agent: RDP server, session stack, autologin, share mounts,
monitor mirroring, theme. First provision takes a few minutes; watch progress
on the command line or `vm logs myvm`.

Omit the release to get the distro default (e.g. Ubuntu 26.04), or pass one:
`provision cloudimg myvm 24.04`. See [provisioning](/guides/provisioning/)
for the ISO path and the distro matrix.

## 3. Start and view

```sh
bun run cli -- vm start myvm
```

`vm start` launches QEMU, waits for the guest's RDP service to actually
answer (not just the forwarded TCP handshake), opens the xfreerdp viewer,
and places its window per the VM's head mode. The command holds until the
viewer closes — `ctrl+c` or closing the window ends the session. The VM
keeps running (default `persist: daemonize`).

Pass `--no-view` to just boot, or `--mode windowed` to override the head
mode for this run.

## 4. Or use the UI

```sh
bun run src/native-entry.ts
```

The app shows the same VM, with buttons for start/stop/view/snapshot and a
create wizard equivalent to `vm create`.

## Where things live

```
~/.local/share/cruiser/vms/myvm/
├── vm.json          spec — edit + restart to change most settings
├── disk.qcow2       system disk
├── OVMF_VARS.fd     per-VM UEFI variables
├── secrets/         0600 password file
└── run/             sockets, pid, qemu.log, serial.log, cruiser.log
```

Next: [creating VMs](/guides/creating-vms/) for every create flag, or
[viewing & head modes](/guides/viewing/) for how the desktop integration works.
