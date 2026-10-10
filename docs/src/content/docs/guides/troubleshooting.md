---
title: Troubleshooting
description: Common failure modes and their fixes — most are one command away.
---

First stop for anything weird: `bun run cli -- doctor`. It checks every
dependency below and prints a concrete fix per failure.

## `vm start` fails or hangs

**`/dev/kvm` permission denied.** `sudo usermod -aG kvm $USER`, relogin.
Doctor checks both the group and writability.

**QEMU fails to initialize GL / venus.** The render node is probably the
NVIDIA one — `gpu/rendernode.ts` auto-picks the mesa node, but you can pin
`gpu.renderNode` in `vm.json`. If you built QEMU yourself it may lack the
GL/virgl bits; use `toolchain build` output in `opt/`.

**Viewer opens into a black/dead session.** The RDP port probe sends an
X.224 negotiation, but grd can still take a moment after that. Close the
viewer and `vm view` again; if it persists, check
`vm logs <vm> --file serial` and
`vm logs <vm> --journal --unit gnome-remote-desktop`.

**`status` stuck on "starting" while the app is open.** QMP/QGA unix
chardevs accept **one** pending client each. Cruiser opens a fresh socket
per op (`VmHandle.withQmp/withQga`) — a held-open connection from another
tool (e.g. `socat` to `run/monitor.sock`) starves the app. Close external
socket clients.

## Provisioning

**`grdctl --system` applied nothing (no :3389 listener).** `grdctl` re-execs
through `pkexec`; on a bare server image it exits 0 without applying.
guest-setup installs `pkexec`/`polkitd` and verifies the listener — if you
hand-rolled a guest, that's the fix.

**RDP connects to a black screen / no session.** grd remote-login needs the
full session stack (`gdm3` + `gnome-shell` + `gnome-session`), which server
cloud images lack — it's why the seed installs them. KDE guests need
`os.autologin` (krdpserver is a user-session service).

**Ubuntu 24.04 + `--desktop kde`.** No `krdp` package exists in 24.04
(Plasma 5.27) — the UI gates this via `supportsKrdp()`; pick 26.04, Debian
trixie, or Fedora.

**Fedora: guest-setup can't touch user files.** SELinux confines qemu-ga
(`virt_qemu_ga_t`) — uid-0 but no usermod/ssh-dir access. `runGuestSetup`
auto-falls back to ssh+sudo using the seeded NOPASSWD key. If you see
permission errors on other QGA operations, the same fallback is the answer.

**qemu-ga wedged (guest-exec timeouts).** The agent can spin when no host
client is attached to its chardev for a long stretch — sometimes unkillable
without SIGKILL. Cruiser's client calls all carry timeouts and reopen the
socket on failed ping; a `vm kill` + `vm start` is the reset of last resort.

## Viewer & window placement

**Escape shortcuts do nothing.** They require freerdp `-grab-keyboard`
(host keeps the combos) — the schema default `grabKeyboard:false` is
load-bearing. `grabKeyboard:true` gives the guest all keys and skips
shortcut install. On GNOME-Wayland there's no placement/shortcut API at all
yet (see the [DE matrix](/internals/de-matrix/)).

**Multi-monitor fullscreen collapses to one monitor.** KWin does this when a
window moves desktops — the adapter re-toggles fullscreen to re-read the
`/multimon` span. If you see it anyway, `host session` + `host monitors`
will show what the adapter detected.

**freerdp window isn't found for placement.** Windows are matched by
wmclass `xfreerdp.xfreerdp` (per-part, case-insensitive) with a
`cruiser:<vm>` title/pid fallback. `wmctrl -lx` shows what the WM sees;
`xdotool`/`wmctrl` missing → install them (doctor flags it).

## Logs to check

| Symptom | Where |
|---|---|
| QEMU won't start | `vm logs <vm> --file qemu` |
| Boot/cloud-init issues | `vm logs <vm> --file serial` |
| Installer issues | `vm logs <vm> --file install-serial` |
| cruiser-side errors | `vm logs <vm>` (cruiser.log) |
| in-guest services | `vm logs <vm> --journal` |
