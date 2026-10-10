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

These are **qcow2 internal snapshots** (`qemu-img snapshot -c/-a/-d`).
`qemu-img` needs the disk offline, so snapshot and restore refuse to run
while the VM is running — `vm stop` first.

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
