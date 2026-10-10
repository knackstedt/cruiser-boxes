---
title: QEMU toolchain
description: The pinned build-from-source toolchain — what's pinned, why, and how resolution works.
---

Cruiser doesn't trust the distro QEMU: distro builds can ship a broken GL
module, lack Venus exports in virglrenderer, or simply be too old. Instead
`toolchain/versions.json` pins a set of components that `build.mts` fetches
and builds into `opt/`.

```sh
bun run cli -- toolchain check           # report what resolves (opt/ vs PATH)
bun run cli -- toolchain build           # fetch + build everything pinned
bun run cli -- toolchain adopt-src [dir] # adopt an existing source tree
```

## Pinned components

Build order is fixed (`versions.json.order`) because later components
depend on earlier prefixes:

| Component | Version | Kind | Why it's pinned |
|---|---|---|---|
| meson | 1.12.0 | tool | system meson < 1.5 is too old for QEMU 11 |
| spice-protocol | 0.14.5 | meson | headers for spice-server/QEMU |
| spice-server | 0.16.0 | meson | distro 0.15.1 lacks remote-client GL; QEMU links it |
| virglrenderer | 1.3.0 | meson | distro build has no Venus exports — no Vulkan passthrough |
| qemu | 11.1.1 | qemu | distro 8.2.2 GL module is broken (`qemu_egl_display`) and too old for Venus |
| waypipe | 1.10.4 | meson | optional — app-mode transport; distro package usually suffices |
| freerdp | 3.32.1 | cmake | optional — only built if system `xfreerdp3` < 3.5.0 |

QEMU configures as `--target-list=x86_64-softmmu` with
`--enable-kvm --enable-slirp --enable-gtk --enable-opengl
--enable-virglrenderer --enable-spice --enable-seccomp --enable-capstone`.

## Integrity

sha256 fields are **record-on-download, verify-on-reuse** — the first
verified fetch records the hash into `versions.json`, later runs check it.

## Resolution

`vm-core/src/qemu/resolve.ts` prefers `opt/` prefixes and falls back to
system `PATH` tools (checked against `systemTools` floors — e.g.
`xfreerdp3` must be ≥ 3.5). The resolved `LD_LIBRARY_PATH` is passed to
QEMU via the built argv's env so the pinned spice/virglrenderer libs win.

Adopted source trees live under `src-tarballs/` (gitignored; may be
symlinks into a shared src dir like `~/devvm/src`).
