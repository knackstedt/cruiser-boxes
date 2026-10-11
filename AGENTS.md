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

## CI / releases

- `.github/workflows/ci.yml` — typecheck + lint + `bun test tests/` on push/PR;
  reused by `release.yml` (tag `v*` → `draft release --target=linux` →
  deb + AppImage uploaded to a GitHub release; `-` in the tag = prerelease).
- CI does NOT use the sibling `file:` engine checkout —
  `.github/actions/downdraft-deps` rewrites `@downdraft/*` to the published
  npm version (`^0.3.0` by default). Engine changes must be **published to
  npm** before cruiser CI can see them; typecheck fails on unreleased APIs
  (e.g. `PanelSpec.smoothWheel` existed locally long before npm had it, and
  `NativeWindowConfig.appId/iconPath` are currently behind a cast in
  native-entry.ts until the next release).

## Layout

- `src/native-entry.ts` — DownDraft app entry (bare `createNativeHost` +
  `HtmlUiHost`; no GameModule/sim worker).
- `src/cli.ts` — headless control surface (vm/usb/provision/host/doctor).
- `libraries/vm-core` — VmSpec schema, QEMU argv builder, QMP/QGA clients
  (pure TS over unix sockets), lifecycle + reattach, disk ops, USB, rendernode.
  `logs.ts` — the Logs screen's backends: run/ file tails (cruiser.log is
  tee'd from lifecycle + provision via `appendVmLog`; serial.log is attached
  on every boot) and guest journalctl with filters over QGA, falling back to
  ssh+sudo when `guestAgentContext` reports a confined agent (also used by
  guest-setup).
- `libraries/host-int` — WmAdapter impls (kde-x11 full; kde-wayland partial;
  gnome-x11; gnome-wayland stub), xfreerdp viewer + ViewerSession.
  `appearance.ts` — xdg-desktop-portal settings: `color-scheme`/`accent-color`/
  `contrast` reads (busctl, gdbus fallback) + one dbus-monitor SettingChanged
  watcher shared by all portal channels. `hoststate.ts` — the non-portal
  probes: timezone, LANG, X11 keymap, host wallpaper path, git user.name/
  email, gsettings/kioslaverc proxy, custom CA roots, SSH_AUTH_SOCK.
- `libraries/provision` — cloudimg+NoCloud, ISO autoinstall, guest-setup driver
  (QGA), monitors.xml generation. `packages.ts` is the single scoped package
  manifest (entries carry `stages: seed|setup`, `desktops`, `distros`, `when`).
  `os.devtools` groups (DevTool enum, DEVTOOLS catalog) power the "Developer"
  preset — setup-stage only so a stale name can't abort cloud-init. Fedora's
  nodejs/npm resolve via provides (versioned nodejsXX pkgs), not `dnf list`;
  `distros.ts` holds the curated release matrix + cloud-image URL resolvers
  (Debian/Fedora resolve filenames by scraping mirror indexes).
  `theme.ts` — the dark/light channel's guest script + applyColorScheme;
  `guestThemeScript` bakes into guest-setup (gsettings `color-scheme` /
  `plasma-apply-colorscheme`, both `command -v`-gated so the spec's desktop
  guess can't misfire).
  `sync.ts` — the host→guest sync engine. `spec.sync` gates twelve channels:
  eight default-on (theme, accentColor, contrast, timezone, locale, keyboard,
  monitors, hostWallpaper) and four default-off security-sensitive ones
  (gitIdentity, proxy, caCerts, sshAgent). `SessionSyncs` (viewer lifetime,
  wired in service.ensureViewer + cli `vm start|view`) runs one shared portal
  watcher for theme/accent/contrast, an /etc/localtime fs.watch for timezone,
  session-start one-shots hash-gated via run/sync.state (locale/keyboard/
  monitors/git/proxy/ca — in-guest drift isn't clobbered unless host input
  changed), and an `AgentForward` (ssh -N -R host agent socket, respawn with
  backoff) for sshAgent. `syncEnabled` = spec flag AND env: `CRUISER_HOST_
  SYNC=0` kills all, `CRUISER_SYNC_<ID>=0` per channel, `CRUISER_THEME_SYNC=0`
  still honored. Guest scripts all follow the guestThemeScript mold (runuser
  for user-context, command -v gates, never abort provision).
  `stage.ts` — shared QGA-writeFile/ssh-scp guest staging extracted from
  wallpaper (pushFileToGuest).
  `wallpaper.ts` — managed guest wallpaper: jimp composite (lazy `importJimp`
  — its `isWebWorker` misfires under Bun, so `self` is shadowed during the
  import) with luminance-picked light/dark watermark ink, pushed via QGA
  writeFile (scp fallback for confined agents), applied by a
  `guestThemeScript`-style script (plasma tools win over gsettings when both
  exist) + `~/Desktop/VM Shortcuts.md`. `ensureGuestWallpaper` hashes inputs
  to `run/wallpaper.state` (`applied`/`staged`) so in-guest changes aren't
  clobbered and pre-login `staged` retries at the next session.
  `CRUISER_WALLPAPER=0` opts out. Composite source: `display.wallpaper.source`
  always wins; else `sync.hostWallpaper` feeds the host's current wallpaper
  in as the base image (watermark still applied — never the raw host file).
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
- KWin collapses multi-monitor fullscreen to the single containing monitor
  when a window moves desktops — `x11MoveToDesktop` re-toggles fullscreen
  (off/on, off-screen) whenever `_NET_WM_FULLSCREEN_MONITORS` is set so the
  freerdp /multimon span is re-read. Likewise `x11SetFullscreen` is
  ensure-only: a redundant add,fullscreen triggers the same collapse.
- `vm start`/`vm view` auto-open the viewer and HOLD the process until it
  closes (`--no-view` opts out) — `ViewerSession.exited()` exists because the
  escape-shortcut uninstallers only run in-process; exiting after `open()`
  orphans the kglobalshortcutsrc/khotkeysrc/gsettings edits.
- QEMU slirp hostfwd completes the TCP handshake host-side even when nothing
  is listening in the guest — `waitRdpPort` sends an X.224 negotiation probe
  instead of a bare connect, or a cold boot launches freerdp into a dead
  forward.
- `kwriteconfig5` can't read (value arg is mandatory — it prints usage, which
  then gets captured as the "previous" value and written back). Read via
  `kreadconfig` first; `kwriteconfig6` reads fine.
- gdm3 ships `# AutomaticLoginEnable = true` as a comment in custom.conf —
  idempotency greps for appended config must anchor to `^Key=` or they
  match the stock comment and never write.
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
  Node-runtime workers (packaged builds): pre-fix `worker-bootstrap.mjs`
  drops host→worker messages posted before `self.onmessage` is assigned —
  the mount-time doc "create" lands in that window → blank window. The
  engine fix (queue until assignment) is committed in ../downdraft-engine;
  until it ships on npm, `CruiserShell` defers initPanel until the worker's
  ready handshake flips `host.docCaps` (2s failsafe). Bun/Deno unaffected —
  their native Workers queue per spec.
- Escape shortcuts require `-grab-keyboard` (host keeps combos) — the schema
  default `grabKeyboard:false` is load-bearing. `command:<cmd>` actions bind
  via KDE khotkeys (Plasma 5 — a `SIMPLE_ACTION_DATA` entry in khotkeysrc +
  `kded5 /modules/khotkeys reread_configuration`) or the `[services]`
  desktop-launcher (Plasma 6 — khotkeys was removed), plus GNOME
  custom-keybinding slots. Plasma-5 gotchas learned live: `[services]`
  launchers bind but never dispatch on kglobalaccel5; a daemon restart
  flushes in-memory config over pending file edits; trigger `Uuid`s must be
  stable per command because khotkeys registers the grab under them and does
  NOT release it on reread (uninstall calls `KGlobalAccel.unregister`
  explicitly). `{vm}`/`{cli}` placeholders expand in ViewerSession.open
  (`{cli}` → `bun run src/cli.ts` in dev, `cruiser` packaged). Default:
  `ctrl+alt+end → command:{cli} vm kill {vm}`.
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
