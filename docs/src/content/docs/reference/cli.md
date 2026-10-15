---
title: CLI reference
description: Full command surface of src/cli.ts — vm, usb, provision, host, app, toolchain, doctor.
---

Invoke via `bun run cli -- <args>` (the package script) or
`bun run src/cli.ts <args>` directly.

```
cruiser <area> <command> [args]
```

## vm

| Command | Description |
|---|---|
| `vm list` | all registered VMs: name, probed state, gpu, head mode, ssh/rdp ports |
| `vm create <name> [flags]` | write `vm.json` — see [creating VMs](/guides/creating-vms/) for the full flag table |
| `vm start <name> [--mode M] [--no-view]` | boot QEMU (creates a sparse disk if absent), wait for RDP, open + place the viewer; holds until the viewer closes unless `--no-view` |
| `vm stop <name>` | ACPI/QMP shutdown; reports "still running" if the guest ignores it |
| `vm kill <name>` | force terminate QEMU |
| `vm status <name>` | probe state: pidfile + socket + `query-status` |
| `vm args <name>` | print the assembled QEMU argv (structured array, quoted for the shell) |
| `vm snapshots <name>` | list internal qcow2 snapshots |
| `vm snapshot <name> <snap>` | create (VM must be stopped) |
| `vm restore <name> <snap>` | apply (VM must be stopped) |
| `vm snapshot-rm <name> <snap>` | delete |
| `vm clone <name> <new>` | clone a stopped VM — fresh ports, disk reflinked/converted without snapshots |
| `vm backup <name> <dest.qcow2>` | live blockdev-backup if running, offline convert if stopped |
| `vm resize <name> <newGiB>` | `qemu-img resize` (grow only) |
| `vm rm <name> [--disk]` | unregister; `--disk` also deletes `disk.qcow2` |
| `vm view <name>` | launch + place the freerdp viewer on a running VM; holds until closed |
| `vm mount <name> [guestPath] [mp]` | sshfs-mount a guest dir (default `~`, mountpoint `~/.local/share/cruiser/mounts/<vm>`) |
| `vm umount <name> [mp]` | unmount |
| `vm logs <name> [flags]` | runner log tail or guest journal — see below |

### vm logs flags

| Flag | Effect |
|---|---|
| `--file cruiser\|qemu\|serial\|install-serial` | which `run/` file to tail (default `cruiser`) |
| `--lines N` | tail length (default 300) |
| `--journal` | guest `journalctl` instead of a file |
| `--unit U --priority P --boot N --since X --grep PAT` | journalctl filters (with `--journal`) |
| `--units` | list journal unit names |

## provision

| Command | Description |
|---|---|
| `provision cloudimg <vm> [release]` | cloud-image download → qcow2 overlay → NoCloud seed → cloud-init → guest-setup |
| `provision iso <vm> <iso-or-url>` | desktop ISO + autoinstall seed → install boot → normal boot → guest-setup |
| `provision guest-setup <vm>` | re-run the in-guest setup stage (idempotent; retrofits + repairs) |

Common options: `--user`, `--password`, `--timezone`, `--no-monitor-mirror`.

## app

| Command | Description |
|---|---|
| `app list <vm>` | guest `.desktop` catalog via QGA (id, name, exec) |
| `app run <vm> <command…>` | launch a guest app as a host window — waypipe over vsock → waypipe over ssh → `ssh -X`, chosen by host session |

## usb

| Command | Description |
|---|---|
| `usb ls` | enumerate host USB: `vid:pid`, bus/dev, label, rw-permission flag |
| `usb attach <vm> <vid:pid>` | QMP `device_add usb-host` hotplug |
| `usb detach <vm> <id>` | remove by the id returned at attach |

## host

| Command | Description |
|---|---|
| `host session` | detected session type + active WmAdapter id and its capabilities |
| `host monitors` | monitor topology probe (xrandr / kscreen) |
| `host desktops` | virtual desktop list (qdbus UUIDs on KDE, wmctrl elsewhere) |

## toolchain

| Command | Description |
|---|---|
| `toolchain check` | report which components resolve (opt/ vs system PATH) |
| `toolchain build` | fetch + build pinned sources into `opt/` per `versions.json` |
| `toolchain adopt-src [dir]` | adopt an existing source tree instead of downloading |

## doctor

Host dependency + permission report: `/dev/kvm` access, kvm group, every
required tool, QEMU toolchain `--version` smoke test, OVMF firmware, USB
device rw coverage. Exits 1 if any check fails; prints the fix for each.
