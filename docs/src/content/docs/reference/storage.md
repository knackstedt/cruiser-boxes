---
title: Storage layout
description: Where cruiser keeps VMs, images, sockets, logs, and secrets on disk.
---

All paths honor the XDG base directory spec (`XDG_CONFIG_HOME`,
`XDG_DATA_HOME`, `XDG_CACHE_HOME`). Implementation:
`libraries/vm-core/src/paths.ts`.

## Tree

```
~/.config/cruiser/                    settings, escape-shortcut defs
~/.local/share/cruiser/
├── vms/<name>/
│   ├── vm.json                       VmSpec — the source of truth
│   ├── disk.qcow2                    system disk
│   ├── OVMF_VARS.fd                  per-VM UEFI variables
│   ├── secrets/                      0600 password files (never in vm.json)
│   ├── snapshots/                    external snapshot files, if used
│   ├── backups/                      default backup destination
│   └── run/                          live state (sockets are recreated per boot)
│       ├── monitor.sock              QMP control socket
│       ├── qga.sock                  QEMU guest agent socket
│       ├── spice.sock                SPICE emergency console
│       ├── virtiofs.sock             virtiofsd socket(s)
│       ├── waypipe.sock              host waypipe client socket
│       ├── qemu.pid                  pidfile (probe/reattach)
│       ├── qemu.log                  QEMU stderr
│       ├── serial.log                guest serial console
│       └── cruiser.log               runner journal (lifecycle + provision)
├── iso/                              downloaded install ISOs
└── mounts/<name>/                    default sshfs mountpoints
~/.cache/cruiser/cloudimg/            shared base cloud images (across VMs)
<repo>/opt/                           toolchain binaries (CRUISER_OPT override)
```

## Notes

- **`vm.json` is authoritative.** The CLI and app both scan `vms/` and read
  specs from disk; daemonized QEMU keeps running with stale args until the
  next `vm start`.
- **`run/` is ephemeral.** Sockets and the pidfile describe the *running*
  instance; they're how `probe()` reattaches after an app restart.
- **Secrets stay out of the spec.** `credentials.passwordFile` points at a
  `0600` file under `secrets/`; the password itself never appears in
  `vm.json`, argv, or logs.
- **Base images are shared.** Deleting a VM never touches
  `~/.cache/cruiser/cloudimg/` — overlays in each VM dir just stop
  referencing it.
