---
title: Logs
description: Runner log files and the guest journalctl backend.
---

Two log surfaces: **runner logs** (files on the host, written by QEMU and
cruiser itself) and the **guest journal** (systemd journal inside the VM).

## Runner logs

```sh
bun run cli -- vm logs myvm                        # cruiser.log, last 300 lines
bun run cli -- vm logs myvm --file qemu --lines 100
bun run cli -- vm logs myvm --file serial
bun run cli -- vm logs myvm --file install-serial
```

| File | Contents |
|---|---|
| `cruiser` | the runner journal — lifecycle + provisioning output tee'd via `appendVmLog` |
| `qemu` | QEMU's own stderr (`-D` log) |
| `serial` | guest serial console, attached on every boot |
| `install-serial` | serial log of the ISO autoinstall boot |

All live under `<vm>/run/`. The app's Logs screen tails the same files.

## Guest journal

```sh
bun run cli -- vm logs myvm --journal --lines 200
bun run cli -- vm logs myvm --journal --unit gnome-remote-desktop --priority err
bun run cli -- vm logs myvm --journal --boot -1 --since "10 min ago"
bun run cli -- vm logs myvm --journal --grep "rdp"
bun run cli -- vm logs myvm --units                # list unit names
```

Filters map to `journalctl` flags: `--unit`, `--priority`, `--boot`,
`--since`, `--grep`. Output ends with `— via <transport>` so you can see
which path was used.

**Transports.** Default is QGA `guest-exec` running `journalctl` in the
guest. When `guestAgentContext` reports a confined agent (Fedora SELinux —
the agent can't read the journal), it falls back to `ssh + sudo` over the
provisioned keypair automatically.

## Provisioning progress

`provision cloudimg|iso` streams its log to the CLI live; the same lines
land in `cruiser.log`, and the install boot's kernel output lands in
`install-serial`. If a provision looks stuck, `vm logs <vm> --file serial`
shows what the guest is actually doing.
