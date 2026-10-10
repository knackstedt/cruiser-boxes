---
title: Provisioning
description: Cloud-image and ISO install paths, what guest-setup does, distros, and developer tooling.
---

Provisioning turns an empty `vm.json` into a bootable, desktop-integrated
guest. There are two install paths plus a re-run command:

```sh
bun run cli -- provision cloudimg <vm> [release] [--user u] [--password p]
bun run cli -- provision iso <vm> <iso-or-url>      [--user u] [--password p]
bun run cli -- provision guest-setup <vm>            # re-run in-guest setup
```

`--user`/`--password` set the guest account (defaults: `cruiser`, generated).
Passwords are written to a `0600` file under `<vm>/secrets/` — never into
`vm.json` or logs. `--timezone` and `--no-monitor-mirror` are also accepted.

## Path 1: cloudimg (recommended)

```sh
bun run cli -- provision cloudimg myvm 26.04
```

1. Download the distro's generic cloud image into
   `~/.cache/cruiser/cloudimg/` (shared across VMs; Debian/Fedora filenames
   are resolved by scraping the mirror index since they embed a build number).
2. Create a qcow2 overlay backed by that base image.
3. Build a **NoCloud seed** (`cloud-localds`): user-data installs the guest
   agent, ssh, the session stack, and your account — with the SSH
   authorized key *inside* the `users:` entry (top-level keys land on the
   distro default user, not yours).
4. First boot runs cloud-init, then Cruiser drives **guest-setup** over QGA.

On rpm-family guests, packages install via `runcmd` + `dnf
--skip-unavailable` rather than cloud-init `packages:` — one unresolvable
name would otherwise abort the whole dnf transaction.

## Path 2: ISO autoinstall

```sh
bun run cli -- provision iso myvm ubuntu-26.04-desktop-amd64.iso
# or a URL — downloaded to ~/.local/share/cruiser/iso/
```

The desktop ISO is booted with an autoinstall seed; the casper kernel is
direct-booted with serial logging (`install-serial` log file), the machine
powers off when the installer finishes, then boots normally into the same
guest-setup stage. Useful when you want a stock desktop install rather than
a cloud image.

## guest-setup: what runs inside the guest

Driven over QGA `guest-exec` as root (user-context steps are `runuser`'d to
the provisioned account):

- **RDP server** — GNOME guests get `gnome-remote-desktop` in *system
  headless* mode (the only mode exposing all virtio-gpu outputs as RDP
  monitors) plus `gdm3` + `gnome-shell`/`gnome-session`. KDE guests get
  `krdpserver` as a user-session service under `plasma-workspace.target`.
- **Autologin** — gdm3/SDDM config when `os.autologin` (default on; required
  in practice for KDE, since krdpserver only exists once a user session is up).
- **Shares** — fstab entries at `/mnt/<tag>`, virtiofs when a virtio-fs
  device is bound, 9p otherwise.
- **Monitors** — `monitors.xml` generated from the host's monitor topology
  (`--no-monitor-mirror` opts out) so the guest desktop layout matches.
- **Theme** — the host dark/light hint is baked in (`gsettings color-scheme`
  for GNOME/GTK, `plasma-apply-colorscheme` for Plasma, both
  `command -v`-gated).
- **SSH** — server + the cruiser keypair authorized, with NOPASSWD sudo so
  the ssh+sudo fallback path works when the guest agent is confined.
- **No-lock niceties** — disables screen lock/blanking that would strand an
  RDP session.

`provision guest-setup <vm>` re-runs this stage on an already-provisioned
VM — it's idempotent and is how new package-manifest entries (e.g. a devtool
group) retrofit running VMs. It re-detects the distro via `/etc/os-release`,
so it also repairs imported disks whose `os.family` guess was wrong.

:::caution[Fedora's confined guest agent]
Fedora runs qemu-ga under SELinux (`virt_qemu_ga_t`): guest-exec is uid-0
but can't `usermod`, write `/var/lib/daemon-reload`, or even read
`~user/.ssh`. `runGuestSetup` probes `/proc/self/attr/current` and falls
back to **ssh + sudo** automatically. Anything else needing real root in a
Fedora guest takes the ssh path too.
:::

## Distro matrix

| Family | Releases | KDE guest over RDP |
|---|---|---|
| Ubuntu | 26.04 LTS, 24.04 LTS | 26.04 only — 24.04 ships Plasma 5.27, no `krdp` |
| Debian | 13 (trixie) | yes |
| Fedora | 44, 43 | yes |

KDE support is gated on the distro shipping `krdp` (Plasma 6's KRDP server);
`supportsKrdp()` in `provision/distros.ts` powers the UI gate. See
[distro matrix](/reference/distros/).

## Developer tooling

`os.devtools` selects package groups installed at guest-setup time (the UI's
"Developer" preset). Because they're setup-stage only, a stale name can't
abort cloud-init:

| Group | Contents |
|---|---|
| `toolchain` | gcc/g++/clang, make, cmake, ninja, meson, pkg-config, ccache |
| `python` | python3 + pip, venv, dev headers |
| `node` | nodejs + npm (distro release; Fedora resolves via versioned provides) |
| `rust` | rustc, cargo, rustfmt, clippy |
| `go` | golang toolchain |
| `containers` | podman, buildah, distrobox |
| `linters` | shellcheck, yamllint, clang-format/tidy |
| `debug` | gdb, strace, ltrace, valgrind, perf |
| `shell` | jq, ripgrep, fd, fzf, tmux, tree, btop |

`os.extraPackages` is the escape hatch for arbitrary distro packages
(strict name validation — they're expanded unquoted into the package
manager line).

## Package manifest

`libraries/provision/src/packages.ts` is the single source of truth for what
gets installed. Each entry maps a logical id to per-family package names and
carries `stages` (`seed` = cloud-init/autoinstall, `setup` = guest-setup),
`desktops`, `distros`, and a `when` predicate. Browsers are flatpaks
regardless of family.
