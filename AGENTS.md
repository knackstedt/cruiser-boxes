# cruiser — agent notes

WinBoat-style QEMU/KVM VM manager for **Linux guests only**, on the DownDraft
native runtime (winit + wgpu + Blitz html-ui — no Electron/Chromium).

## Commands

- `bun install` — installs deps; `@downdraft/*` resolve via `file:` to the
  sibling `../downdraft-engine` checkout. Engine changes land there, not here.
- `bun run cli -- <args>` — headless CLI (`src/cli.ts`). Also `bun run src/cli.ts`.
- `bun test tests/` — unit tests. **Always scope to `tests/`** — bare
  `bun test` recurses into `src-tarballs/` (symlinked QEMU/dep sources) and
  finds their js test files.
- `bunx tsc --noEmit` — typecheck (`bun run typecheck`).
- `bunx oxlint` — lint (`bun run lint`).
- `bun run toolchain/build.mts check|build|adopt-src` — pinned source toolchain.
- `CRUISER_SMOKE_MS=N CRUISER_SCREENSHOT=/path.png CRUISER_SHOT_FRAMES=N
  CRUISER_ROUTE=create|vm|settings bun run src/native-entry.ts` — headless-ish
  UI smoke/screenshot harness (still needs a GPU + display; captures the real
  window surface).
- `DD_STARTUP_PROFILE=1` — boot timing marks (`[startup] label t=Nms` since
  process start): entry/host/shell/service stages in `startup-profile.ts`
  plus per-stage marks inside `createNativeHost` (engine).

## Layout

- `src/native-entry.ts` — DownDraft app entry (bare `createNativeHost` +
  `HtmlUiHost`; no GameModule/sim worker).
- `src/cli.ts` — headless control surface (vm/usb/provision/host/doctor).
- `libraries/vm-core` — VmSpec schema, QEMU argv builder, QMP/QGA clients
  (pure TS over unix sockets), lifecycle + reattach, disk ops, USB, rendernode.
- `libraries/host-int` — WmAdapter impls (kde-x11 full; kde-wayland partial;
  gnome-x11; gnome-wayland stub), xfreerdp viewer + ViewerSession.
- `libraries/provision` — cloudimg+NoCloud, ISO autoinstall, guest-setup driver
  (QGA), monitors.xml generation.
- `libraries/app-mode` — waypipe over vsock (socat bridge) / ssh fallback.
- `libraries/app-shell` — UI: zustand store, CruiserService, screens markup.
- `libraries/sys` — exec helpers (node:child_process — runs under bun AND node).
- `toolchain/` — versions.json pins + build.mts (fetch/build into `opt/`).
- `src-tarballs/` — adopted/downloaded source trees (gitignored, may be
  symlinks into ~/devvm/src).

## Rules

- Libraries must be **runtime-agnostic** (`node:*` APIs only — no `Bun.*`,
  `bun:ffi`, `bun:test` outside `tests/`). The engine is tri-runtime.
- Use `/var/tmp`, not `/tmp`.
- QEMU argv is structured arrays only — never assemble shell strings for qemu.
- Passwords live in 0600 files under `<vm>/secrets/`; never in vm.json or logs.
- DownDraft fixes go to `../downdraft-engine` and are committed there.
- `downdraft.config.json` sets `"runtime": "node"` — the `draft dev` shell's
  Vite ModuleRunner is ~5× slower under Bun's node:vm (≈2.2s vs ≈11.8s to
  first frame). Game code stays runtime-agnostic; `--runtime bun` overrides.
- Import **leaf subpaths** (`@downdraft/engine/util/logger`,
  `@downdraft/platform-native/native-host`), never the package barrels, in
  startup-path code — each bare `@downdraft/engine` value-import pulls ~340
  core modules into the dev transform graph. Type-only imports are erased
  and don't count.
- Blitz quirks learned: `.content` blocks over-constrained with
  `position:absolute; top:X; bottom:Y` paint nothing — use flow + fixed height.
- Escape shortcuts require `-grab-keyboard` (host keeps combos) — the schema
  default `grabKeyboard:false` is load-bearing.
