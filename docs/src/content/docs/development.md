---
title: Hacking on cruiser
description: Dev commands, layout, test/lint/typecheck, the screenshot harness, and house rules.
---

## Commands

```sh
bun install                            # deps — npm @downdraft/*, auto-linked to a sibling engine checkout
bun run engine:link                    # re-run the engine link manually (or set CRUISER_ENGINE_DIR)
bun run cli -- <args>                  # headless CLI (src/cli.ts)
bun test tests/                        # unit tests — ALWAYS scope to tests/…
bunx tsc --noEmit                      # typecheck  (bun run typecheck)
bunx oxlint                            # lint       (bun run lint)
bun run toolchain/build.mts check      # pinned toolchain resolution
bun run src/native-entry.ts            # the UI
```

:::caution
Bare `bun test` recurses into `src-tarballs/` (symlinked QEMU/dep source
trees) and finds their js test files — always `bun test tests/`.
:::

## Screenshot / smoke harness

Drive the real window surface headless-ish (still needs GPU + display):

```sh
CRUISER_SMOKE_MS=8000 CRUISER_SCREENSHOT=/var/tmp/shot.png \
  CRUISER_SHOT_FRAMES=20 CRUISER_ROUTE=create \
  bun run src/native-entry.ts
```

`CRUISER_ROUTE` preselects `create|vm|settings|logs`; `CRUISER_VM` picks the
VM for vm/logs routes. `DD_STARTUP_PROFILE=1` prints boot timing marks.
See [environment variables](/reference/env/).

## Layout

| Path | What |
|---|---|
| `src/native-entry.ts` | app entry — bare `createNativeHost` + `HtmlUiHost` |
| `src/cli.ts` | headless control surface (the UI's actions call the same libs) |
| `libraries/vm-core` | VmSpec schema, QEMU argv builder, QMP/QGA clients, lifecycle + reattach, disk, USB, rendernode, logs |
| `libraries/host-int` | WmAdapter impls (kde-x11 · kde-wayland · gnome-x11 · gnome-wayland), freerdp ViewerSession, appearance, mounts |
| `libraries/provision` | cloudimg+NoCloud, ISO autoinstall, guest-setup driver, packages manifest, distro matrix, theme |
| `libraries/app-mode` | waypipe over vsock (socat bridge) / ssh fallback |
| `libraries/app-shell` | UI: zustand store, CruiserService, screen markup |
| `libraries/sys` | exec helpers (node:child_process — runs under bun AND node) |
| `toolchain/` | `versions.json` pins + `build.mts` (fetch/build into `opt/`) |
| `docs/` | this site (Astro Starlight → GitHub Pages) |

## House rules

- **Runtime-agnostic libraries.** `node:*` APIs only — no `Bun.*`,
  `bun:ffi`, `bun:test` outside `tests/`. The engine is tri-runtime.
- **Structured argv only.** Never assemble shell strings for QEMU.
- **Secrets on disk, not in spec.** Passwords live in `0600` files under
  `<vm>/secrets/` — never in `vm.json` or logs.
- **Fresh sockets per op.** QMP/QGA chardevs accept one pending client;
  never cache a connection (see [architecture](/internals/architecture/)).
- **Use `/var/tmp`, not `/tmp`.**
- DownDraft engine fixes belong in the sibling engine checkout
  (`../downdraft-engine`/`../downdraft`), not here.
