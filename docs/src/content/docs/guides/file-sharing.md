---
title: File sharing
description: Host→guest shares via virtiofs/9p, and guest→host sshfs mounts.
---

Cruiser has file sharing in both directions: declarative host→guest shares
in the spec, and ad-hoc guest→host sshfs mounts.

## Host → guest: `shares`

Declare shares at create time or by editing `vm.json`:

```sh
bun run cli -- vm create myvm --share ~/code:code --share ~/data --share /srv/assets:assets
```

Each entry is `{ hostPath, tag, readOnly }`. The tag must match
`^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (it lands unquoted in fstab and QEMU's
`-virtfs`-style args) and defaults to `hostshare`.

At boot, each share is bound into the guest in one of two ways:

- **virtiofs** (preferred) — a `virtiofsd` daemon per share (spawned before
  QEMU opens its sockets) + a `virtio-fs` device. virtiofsd ships off-PATH
  on Debian/Ubuntu; `/usr/libexec`, `/usr/lib/qemu`, and
  `/usr/lib/virtiofsd` are probed automatically.
- **9p** (fallback) — `local` fsdev + `virtio-9p-pci` when virtiofsd is
  absent. Slower but dependency-free.

Guest-side, guest-setup writes fstab entries mounting each tag at
`/mnt/<tag>` — it detects which backend is bound (virtiofs devices have no
`mount_tag` sysfs attr; driver binding is the test) and mounts with
`nofail` + automount so a missing share never blocks boot.

## Guest → host: `vm mount`

sshfs-mount a guest directory onto the host:

```sh
bun run cli -- vm mount myvm /home/cruiser/projects
# mounted myvm:/home/cruiser/projects -> ~/.local/share/cruiser/mounts/myvm

bun run cli -- vm mount myvm / /tmp/myvm-root   # custom guest path + mountpoint
bun run cli -- vm umount myvm                    # default mountpoint
bun run cli -- vm umount myvm /tmp/myvm-root
```

Requires `sshfs` on the host and the provisioned ssh keypair (guest-setup
authorizes it). The default mountpoint is
`~/.local/share/cruiser/mounts/<vm>`.

:::note
virtiofs covers host→guest; sshfs covers guest→host. Neither replaces the
other — virtiofs can't expose guest paths outward and sshfs can't expose
host paths inward.
:::
