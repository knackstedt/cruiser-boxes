# cruiser

A multi-VM QEMU/KVM manager for **Linux guests**, built on the DownDraft
native runtime — the Linux counterpart to WinBoat, minus the container
indirection (raw QEMU + QMP/QGA) and minus Electron (winit + wgpu + Blitz UI).

## Status

Working today (verified on KDE/X11, QEMU 11.1.1):

- VM lifecycle: create/start/status/stop/kill, daemonized or app-owned QEMU
- GPU modes: Venus (Vulkan), virgl (GL), software — auto render-node pick
- Viewer: xfreerdp3 in windowed / virtual-desktop / fullscreen-monitor modes,
  with window placement verified live
- Provisioning pipeline: cloudimg+NoCloud and ISO autoinstall code paths,
  QGA guest-setup driver (gnome-remote-desktop system daemon, autologin,
  share mounts, monitors.xml generated from host topology)
- USB enumeration + QMP hotplug plumbing, snapshots/backup/resize ops
- Waypipe app-mode scaffolding (vsock primary, ssh fallback)
- DownDraft UI: VM list, create wizard, VM detail, settings+doctor —
  all rendering live through the html-ui worker → wgpu compositor

## Quickstart

```sh
bun install
bun run src/cli.ts doctor                    # what's missing on this host
bun run src/cli.ts toolchain check           # qemu/dep resolution
bun run src/cli.ts vm create myvm --cpus 8 --mem 16384 --disk 120
bun run src/cli.ts provision cloudimg myvm 26.04 --user me --password secret
bun run src/cli.ts vm start myvm
bun run src/cli.ts vm view myvm              # freerdp, placed per head mode
bun run src/native-entry.ts                  # the UI
```

Host deps: `apt install freerdp3-x11 ovmf cloud-image-utils waypipe socat
wmctrl xdotool qdbus` (+ `virtiofsd` for the preferred share backend).

Docs: `docs/architecture.md`, `docs/de-matrix.md`, `docs/vfio.md`,
`docs/rendering-futures.md`. Agent notes: `AGENTS.md`.
