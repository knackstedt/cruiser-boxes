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
  (QGA), monitors.xml generation. `packages.ts` is the single scoped package
  manifest (entries carry `stages: seed|setup`, `desktops`, `distros`, `when`).
  `os.devtools` groups (DevTool enum, DEVTOOLS catalog) power the "Developer"
  preset — setup-stage only so a stale name can't abort cloud-init. Fedora's
  nodejs/npm resolve via provides (versioned nodejsXX pkgs), not `dnf list`;
  `distros.ts` holds the curated release matrix + cloud-image URL resolvers
  (Debian/Fedora resolve filenames by scraping mirror indexes).
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
- Guest OS profile lives in `VmSpec.os` (family/release/desktop/browser/snap/
  extraFonts). KDE guests use krdpserver (user-session, plasma-workspace.target)
  — Ubuntu 24.04 has no krdp; `supportsKrdp()` gates the UI. guest-setup
  re-detects the distro via /etc/os-release, so imported disks self-correct.
  KRDP offers TLS/RDP security but NOT NLA — don't pass `/sec:nla` to freerdp.
- Fedora confines qemu-ga under SELinux (`virt_qemu_ga_t`): guest-exec is
  uid-0 but can't usermod/write /var/lib/daemon-reload — even reading
  ~user/.ssh fails. `runGuestSetup` probes /proc/self/attr/current and falls
  back to ssh+sudo (NOPASSWD from seed). Anything else needing real root
  inside a Fedora guest needs the ssh path too.
- cloud-init `ssh_authorized_keys` must sit INSIDE the users: entry —
  top-level applies to the distro default user (fedora/ubuntu), not ours.
  rpm seeds install via `runcmd dnf --skip-unavailable`, not `packages:`
  (one unresolvable name aborts cloud-init's whole dnf transaction).
- QMP/QGA unix chardevs accept ONE pending client each — never cache a
  connection. `VmHandle.withQmp/withQga` open a fresh socket per op and
  serialize in-process; a held socket starves the CLI while the UI runs
  (probe → "starting" forever) and vice versa.
- `wmctrl -x` wmclass is "instance.class" (e.g. `xfreerdp.xfreerdp`) — match
  per-part, case-insensitive. freerdp titles are `cruiser:<vm>` (not
  "FreeRDP"), which is the pid-match fallback in `ViewerSession`.
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
- Scrollbars: Blitz overlay thumbs are gated behind the `scrollbars` cargo
  feature (enabled on `blitz-paint` in `native-osr/Cargo.toml`); style with
  CSS `scrollbar-color` (transparent track works). Thumbs only paint during/
  after scroll activity and fade ~700ms after — `shell.ts` flashes the thumb
  on route change via a clamped `scrollTo` nudge so scrollability reads.
  `PanelSpec.smoothWheel` (html-ui) eases wheel deltas at frame cadence;
  `CRUISER_SMOOTH_WHEEL=0` disables.
- Doc backend: default resolution is the **worker** backend (raster off the
  main thread) — a full-page vello repaint is ~20ms, so in-process raster
  starves input during scroll/fade animations. `CRUISER_UI_BACKEND=local`
  forces the in-process backend; the settings page shows the live kind.
- Escape shortcuts require `-grab-keyboard` (host keeps combos) — the schema
  default `grabKeyboard:false` is load-bearing.
- HMR (`draft dev`): `native-entry.ts` is a "blocking entry" — its
  close-wait must release via `__ddSession.onDispose(() => resolve())` and
  skip `host.destroy()` on session end (the host is persistent-layer; the
  supervisor owns it). Without this the entry import never settles, the
  supervisor's reimport queue jams after the first Tier-3 restart, and the
  window stays open with dead rendering.
- Text quality: `PanelSpec.scale` = raster px per display px (supersample;
  1 = hard edges, 2 = smooth-but-soft). `PanelSpec.zoom` (added in
  ../downdraft-engine) = display px per CSS px — the UI scale knob; pointer
  input is converted automatically. Cruiser mounts zoom≈1.25 + scale=1
  (native-res raster, CRUISER_UI_ZOOM/CRUISER_UI_SCALE env knobs). The OSR
  cdylib embeds only DejaVu Sans; real system fonts are bound via
  `registerResource` (ui:// blobs) + `@font-face` — see
  `libraries/app-shell/src/fonts.ts`. Call before mount so the first doc
  resolve sees them.
