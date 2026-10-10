---
title: Distro matrix
description: Supported distro families, curated releases, image resolution, and KDE/RDP support.
---

The curated matrix lives in `libraries/provision/src/distros.ts` and feeds
the create wizard's Release picker plus cloudimg URL resolution.

## Families and releases

| Family | Release | Label | `krdp` (KDE over RDP) |
|---|---|---|---|
| ubuntu | `26.04` | 26.04 LTS | ✅ |
| ubuntu | `24.04` | 24.04 LTS | ❌ — Plasma 5.27, no krdp package |
| debian | `trixie` | 13 (trixie) | ✅ |
| fedora | `44` | 44 | ✅ |
| fedora | `43` | 43 | ✅ |

The first release listed is the default when `os.release` is empty.

`supportsKrdp(family, release)` gates the KDE desktop option — a KDE guest
needs the distro's `krdp` package (Plasma 6's KRDP server) because
gnome-remote-desktop isn't present there.

## Cloud image resolution

- **Ubuntu** — deterministic:
  `https://cloud-images.ubuntu.com/releases/<release>/release/ubuntu-<release>-server-cloudimg-amd64.img`
- **Debian** — filenames embed a build serial; resolved by scraping
  `https://cloud.debian.org/images/cloud/<release>/latest/` for the newest
  `debian-N-genericcloud-amd64.qcow2`.
- **Fedora** — same index-scrape against
  `https://dl.fedoraproject.org/pub/fedora/linux/releases/<release>/Cloud/x86_64/images/`
  for `Fedora-Cloud-Base-Generic-*`.

Base images download once into `~/.cache/cruiser/cloudimg/` and are shared
by every VM via qcow2 overlays.

## Other provisioning inputs

- **ISO install** (`provision iso`) accepts a local path or URL for any
  supported family's desktop ISO — autoinstall seeds handle Ubuntu; the
  same guest-setup runs afterwards regardless of install path.
- **Imported disks** mark `provisioned.method: imported`; guest-setup
  re-detects the distro from `/etc/os-release`, so an `os.family` guess
  that was wrong self-corrects.

## Guest package names

Per-family package name mapping (incl. Fedora's versioned `nodejsXX`
provides, which resolve via provides rather than `dnf list`) lives in the
single manifest `libraries/provision/src/packages.ts` — see
[provisioning](/guides/provisioning/#package-manifest).
