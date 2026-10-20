---
title: App mode (waypipe)
description: Single guest applications as host windows — transports, the app catalog, and CLI usage.
---

With `headMode: app`, a VM has no desktop viewer at all — instead,
individual guest applications appear as ordinary host windows. This is the
closest Cruiser gets to WinBoat's signature feature.

```sh
bun run cli -- app list myvm            # guest .desktop catalog (via QGA)
bun run cli -- app run myvm firefox     # launch a guest app
bun run cli -- app run myvm gnome-text-editor /mnt/hostshare/notes.md
```

## Transports

The transport is chosen by host session type:

| Host session | Transport | How |
|---|---|---|
| Wayland + vsock | `waypipe-vsock` | host `socat VSOCK-LISTEN:9922` → host `waypipe client` socket; guest `socat unix→vsock` bridge + `waypipe server` (auto-installed + auto-bridged over QGA) |
| Wayland, no vsock | `waypipe-ssh` | `waypipe ssh -p <sshPort> user@127.0.0.1 CMD` |
| X11 | `ssh-x` | `ssh -X` — waypipe can't display into X11; `GDK_BACKEND=x11 QT_QPA_PLATFORM=xcb` forces wayland-native toolkits through the X forward |

vsock is the default (`network.vsock: true` → `vhost-vsock-pci`); it needs
`/dev/vhost-vsock` on the host and `socat` on both sides. Guest `waypipe` +
`socat` are auto-installed by `ensureGuestServer` over the guest agent.

:::tip[waypipe direction is counterintuitive]
`waypipe client` runs on the **compositor side (host)**: it listens on a
socket and displays whatever a matching `waypipe server` sends into
`$WAYLAND_DISPLAY`. `waypipe server -- CMD` runs on the **app side
(guest)**: a fake compositor for `CMD` that connects back to the host
client. Getting this backwards is the classic waypipe debugging trap.
:::

## The app catalog

`app list` enumerates `.desktop` files in the guest, in XDG precedence
order (later duplicates are dropped): the user's
`~/.local/share/applications` and flatpak user exports, then
`/usr/local/share/applications`, `/usr/share/applications`, flatpak system
exports (`/var/lib/flatpak/exports/share/applications`), and snapd's dir —
skipping `NoDisplay=true`. It returns `id`, `Name=`, and the `Exec=` line
with field codes (`%U` etc.) and flatpak's `@@u … @@` wrappers stripped —
the transports run the raw command.

## Requirements and caveats

- The VM needs `network.sshPort` for the ssh transports (allocated at
  create) and the guest-setup-provided ssh keypair; `authorizeInGuest`
  retries authorization before falling back to existing auth.
- Single-instance apps (Chromium family: Chrome, Vivaldi, Brave…) delegate
  a second launch to the already-running process. If that instance lives in
  the guest's own desktop session, the new window opens *inside the guest*,
  not on the host. The ssh transports watch the first ~2.5s of output and
  report this as a warning ("delegated to an instance already running in
  the guest session"); close the in-guest copy and relaunch to get a host
  window.
- App windows carry the guest's own toolkit rendering — theme sync affects
  them the same as the desktop.
- waypipe is optimized for single apps; multi-window session forwarding
  hits edge cases. Cruiser deliberately keeps it scoped to app mode rather
  than stretching it into a desktop transport (see
  [rendering futures](/internals/rendering-futures/)).
