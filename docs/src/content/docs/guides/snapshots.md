---
title: Snapshots, backups & resize
description: Disk-level snapshots, live/offline backups, qcow2 resize, and VM removal.
---

Disk operations all run through the pinned `qemu-img` from the toolchain.

## Snapshots

```sh
bun run cli -- vm snapshot myvm before-upgrade
bun run cli -- vm snapshots myvm
bun run cli -- vm restore myvm before-upgrade
bun run cli -- vm snapshot-rm myvm before-upgrade
```

These are **qcow2 internal snapshots** (`qemu-img snapshot -c/-a/-d`) —
creation is effectively instant. `qemu-img` needs the disk offline, so
snapshot, restore, and delete all refuse to run while the VM is running —
`vm stop` first. In the UI, click a snapshot chip to restore it (two-click
confirm) and use its `✕` to delete it.

## Auto snapshots

The VM settings (`snapshots.auto`, also on the create form and
`vm create --autosnap`) take an `auto-*` snapshot on a cadence:

- **frequency** — `daily` · `weekly` · `monthly`: a snapshot is taken when
  the newest `auto-*` one is older than the period.
- **trigger** — `stop` (after a clean shutdown), `start` (before booting),
  or `both`.
- **keep** — how many `auto-*` snapshots are retained; the oldest rotate
  out. Manual `snap-*` snapshots are never pruned.

Only clean edges can snapshot — `qemu-img` needs the disk offline, so a
kill, a QEMU crash, or a host power loss leaves no snapshot behind.

Before creating one, cruiser checks the host filesystem has room for the
worst case (the disk file doubling while the snapshot pins clusters). When
it's short, the oldest `auto-*` snapshots are deleted first; if that's
still not enough the UI asks whether to delete the remaining snapshots or
start without one (the CLI warns and proceeds).

## Cloning a VM

```sh
bun run cli -- vm clone myvm myvm-copy
```

Copies the spec (new name, freshly allocated ssh/rdp ports), the disk, the
OVMF vars, and `secrets/`. **Snapshots are not carried over** — the disk
is reflinked when the filesystem supports it (`cp --reflink`), falling
back to `qemu-img convert`; either way internal snapshots are stripped.
The source VM must be stopped. The clone's `origin` is cleared so a config
pull can't rewrite both VMs from one source.

## Backups

```sh
bun run cli -- vm backup myvm /mnt/backups/myvm-2026-10-10.qcow2
```

- **Running VM** → live backup via QMP `blockdev-backup` into the
  destination (guest keeps running; the copy is crash-consistent).
- **Stopped VM** → offline `qemu-img convert` copy.

Backups default into `<vm>/backups/` when you point at that directory; any
writable path works.

## Resize

```sh
bun run cli -- vm resize myvm 160
```

`qemu-img resize` grows the qcow2 virtual size (grow only). The guest then
needs its partition/filesystem expanded — on cloud images `growpart` +
`resize2fs`/`xfs_growfs` typically run automatically via cloud-init's
growpart module on next boot; otherwise do it manually inside the guest.

## Removing a VM

```sh
bun run cli -- vm rm myvm           # unregister; disk stays on disk
bun run cli -- vm rm myvm --disk    # unregister + delete disk.qcow2
```

Without `--disk` the directory keeps `disk.qcow2`, `secrets/`, `run/` logs,
snapshots, and backups — re-create a VM with the same name or point
`disk.file` at it to reuse.
