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
  (e.g. `PanelSpec.smoothWheel` existed locally long before npm had it).

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
  gnome-x11; gnome-wayland stub), xfreerdp viewer + ViewerSession. Viewer
  stdout/stderr lands in `run/freerdp.log` / `run/viewer-dd.log` — a dead
  viewer with stdio ignored is undiagnosable; open() throws the log path.
  `x11MoveToDesktop` verify-retries `_NET_WM_DESKTOP` — KWin applies initial
  placement after map and silently overwrites an early `-t`.
  viewer-dd (dmabuf): QEMU's @dbus-display keeps effectively ONE client
  channel — the enumeration conn dies after RegisterListener and extra
  add_client channels EPIPE at the p2p handshake, so all per-console
  Keyboard/Mouse calls share a single conn opened after listener
  registration. QMP `getfd` fdnames are global-namespace — unique per
  channel or concurrent opens collide onto a stale fd. Dead-QEMU watchdog =
  qemu.pid pid + /proc starttime beside monitor.sock (detects restart too);
  don't ping the control conn, QEMU closes it by design. Multi-head:
  virtio `outputs[]` mirrors adapter.monitors() order (window title
  `cruiser:<vm>:<i>` ↔ guest output i ↔ host monitor i); guest scanouts are
  per-console dims — letterbox fit_viewport math is shared by render AND
  input (SetAbsPosition wants scanout px).
  Clipboard (dmabuf): `-chardev qemu-vdagent,clipboard=on,mouse=off` +
  virtserialport `com.redhat.spice.0` (args.ts, gated on display.clipboard +
  a `-chardev help` probe — backend needs CONFIG_SPICE_PROTOCOL). Guest side
  needs nothing extra: udev (70-spice-vdagentd.rules) auto-starts
  spice-vdagentd when the port appears, spice-vdagent autostarts in the
  session (needs a VM RESTART — the port can't hotplug into a running
  virtio-serial spec). viewer-dd serves org.qemu.Display1.Clipboard ON the
  input conn — QEMU binds its object tree to the LAST add_client conn, and
  proxies Clipboard calls back to whatever conn called Register, so the
  input conn is the only place it works. Protocol is symmetric
  Register/Grab/Release/Request. Grab serials are a SHARED sequence
  starting at 0 (NOT 1): QEMU resets it via our own Register call, and
  spice-vdagentd silently drops any grab whose serial != its counter —
  off-by-one = every grab discarded forever. fetch_max() incoming guest
  serials so the next outgoing stays ahead of the guest's stream. QEMU
  also BOUNCES the virtio port once per guest caps re-announce
  (vdagent.c reset_serial → CHR_EVENT_CLOSED; settles after one
  reconnect — "AIIEEE lost spice client connection" in the daemon log is
  this, not a real failure). Our Request handler answers QEMU's SYNC
  main-loop call — read parked state only, never block on the worker.
  Host side = arboard (x11rb/wl-clipboard-rs) polled 300ms — no change
  watcher exists; a parked `host_text` echo guard stops guest→host writes
  re-grabbing back. Text only (text/plain;charset=utf-8) — QEMU's dbus
  clipboard knows no other MIME. Guest caveat: spice-vdagent is X11-only,
  so on Wayland sessions host→guest reaches native apps (KWin bridges the
  X11 selection) but guest→host only sees X11/XWayland copies.
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
  `sync.ts` — the host→guest sync engine. `spec.sync` gates thirteen channels:
  nine default-on (theme, accentColor, contrast, timezone, locale, keyboard,
  monitors, hostWallpaper, shares) and four default-off security-sensitive ones
  (gitIdentity, proxy, caCerts, sshAgent). `SessionSyncs` (viewer lifetime,
  wired in service.ensureViewer + cli `vm start|view`) runs one shared portal
  watcher for theme/accent/contrast, an /etc/localtime fs.watch for timezone,
  session-start one-shots hash-gated via run/sync.state (locale/keyboard/
  monitors/git/proxy/ca — in-guest drift isn't clobbered unless host input
  changed), and an `AgentForward` (ssh -N -R host agent socket, respawn with
  backoff) for sshAgent. `syncEnabled` = spec flag AND env: `CRUISER_HOST_
  SYNC=0` kills all, `CRUISER_SYNC_<ID>=0` per channel, `CRUISER_THEME_SYNC=0`
  still honored. Guest scripts all follow the guestThemeScript mold (runuser
  for user-context, command -v gates, never abort provision). The `shares`
  channel runs `guestSharesScript` — a managed `# >>> cruiser-shares >>>`
  fstab block reconciled against spec.shares (stale virtfs mounts unmounted,
  `ro` written for direction:"host-to-guest") — the same script guest-setup
  bakes at provision, so editing shares converges the guest on the next pass.
  `filesync.ts` — copy-mode shares (`mode:"copy"`): rsync over the ssh hostfwd
  + `ensureKeypair` key. direction "both" = `--update` push+pull (newest wins,
  no deletes); "host-to-guest" = authoritative push (+`--delete` when
  `deletions`). `FileSyncs` runs fs.watch pushes + a 30s pull interval for the
  viewer session (service.ensureViewer); `vm filesync <name>` is one-shot,
  `--watch` holds it. Guest target = guestPath or ~/cruiser-sync/<basename>;
  prep script mkdirs targets and lazily installs guest rsync (cli-tools also
  ships it). Env: `CRUISER_FILESYNC=0` kills, `CRUISER_FILESYNC_{PUSH,PULL}_MS`
  tune the intervals.
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
  `shellInsets` adds a per-guest-DE edge reserve (KDE bottom panel ~5% of
  image height, GNOME top bar ~3%) so the watermark isn't parked under the
  shell's bar — heuristic only, a moved/resized panel isn't tracked.
- `libraries/app-mode` — waypipe over vsock (socat bridge) / ssh fallback.
- `libraries/app-shell` — UI: zustand store, CruiserService, screens markup.
  Screen split: the vm detail screen owns everything that acts IMMEDIATELY
  (lifecycle buttons, shares add/remove/toggle, portable-config
  export/push/pull, snapshots — all call saveSpec directly); the create
  wizard's edit mode owns only fields buffered into Save (description,
  resources, display, persist, sync channels, usb). Don't render
  instant-effect widgets inside the Save-gated form.
  `metrics.ts` — the running-VM sparklines (cpu/mem %; disk iops via QMP
  query-blockstats — no agent needed; net bytes/s via QGA /proc/net/dev;
  gpu util+mem via host `/proc/<qemu>/fdinfo` DRM client stats, absent in
  software mode). Rate sparks (disk/net) auto-scale bars to the window max.
- `libraries/sys` — exec helpers (node:child_process — runs under bun AND node).
  `gist.ts` — GitHub Gist client over plain fetch: `readGist` accepts a bare
  id / gist URL / user/id (unauth read for public; token unlocks secret),
  `pushGist` creates or PATCHes. Token order: CRUISER_GITHUB_TOKEN →
  GITHUB_TOKEN → GH_TOKEN → `gh auth token`; never stored or logged.
  `CRUISER_GITHUB_API` overrides the API base (GHES + tests).
  Portable configs: `vm-core/src/config/portable.ts` wraps VmSpec in
  `{format:"cruiser-vm", version:1, description?, spec}` — serializes
  JSON/YAML (`yaml` pkg) / TOML (`smol-toml` pkg), sniffs by `*.cruiser.*`
  filename then content. Export scrubs host-local state (allocated
  ssh/rdp ports + their auto hostfwd, provisioned, passwordFile, origin);
  import goes through `registry.create` so ports re-allocate; `vm config
  pull` re-merges over an existing spec preserving name/network/
  provisioned/credentials and reports which sections need a reboot.
  `spec.origin` {kind:"gist"|"file", id?, url?} records the pull source.
- `toolchain/` — versions.json pins + build.mts (fetch/build into `opt/`).
- `src-tarballs/` — adopted/downloaded source trees (gitignored, may be
  symlinks into ~/devvm/src).
  **Local QEMU patch**: `ui/dbus-listener.c` calls
  `qemu_console_listener_set_refresh(&ddl->dcl, 10)` after
  `qemu_console_register_listener` — upstream dbus listeners are pinned to
  GUI_REFRESH_INTERVAL_DEFAULT (30ms ≈ 33fps), which caps the dmabuf viewer
  at ~33fps; 10ms lifts the cap to ~100fps. Rebuild: `ninja -C
  ~/devvm/src/qemu-11.1.1/build qemu-system-x86_64 && ninja -C ... install`.
  Keep this patch when refreshing the QEMU tree — a plain tarball re-extract
  silently drops it.

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
  KRDP ≥6.5 (Plasma PAM-auth rework) is TLS-security-only — `User`/`Password`/
  `Port` in krdpserverrc are dead keys; auth is `Users`+KWallet or
  `SystemUserEnabled`→PAM against the unix password. krdp still *negotiates*
  NLA with no CredSSP creds (client dies `ERRCONNECT_LOGON_FAILURE`) —
  `rdpTlsOnly()` probes the nego response and `freerdpArgs` passes `/sec:tls`.
  KRDP also requires client-side H.264 (RDPGFX AVC420/444): distro freerdp3
  builds `WITH_GFX_H264=OFF` — use `opt/freerdp` (toolchain cmake build,
  ffmpeg backend); `freerdpSupportsH264` gates and `launchFreerdp` throws a
  clear error for KDE guests without it.
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
  Node-runtime workers (packaged builds): pre-0.3.1 `worker-bootstrap.mjs`
  dropped host→worker messages posted before `self.onmessage` was assigned
  (the mount-time doc "create" → blank window); fixed upstream in
  @downdraft/platform-native 0.3.1 — bump the downdraft-deps pin if the
  worker backend ever goes blank again.
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
  explicitly). kglobalaccel keeps the FIRST grab registered — install must
  steal the key (`kdeStealKey`): clear conflicting entries in other
  components to `none,none,<desc>` (ksmserver "Log Out" owns Ctrl+Alt+Del
  out of the box; restored on uninstall) and `unregister` [khotkeys] grabs
  outright. kglobalshortcutsrc rows are `<current>,<default>,<friendly>`
  with multi-binding slots joined by an ESCAPED `\t`, and khotkeys
  CommandURL executes the line itself — a `sh -c` argv wrapper must be
  unwrapped first or the outer shell eats only the first word. `{vm}`/`{cli}`
  placeholders expand in ViewerSession.open (`{cli}` → `bun run src/cli.ts`
  in dev, `cruiser` packaged). Default:
  `ctrl+alt+end → command:{cli} vm kill {vm}`.
- HMR (`draft dev`): `native-entry.ts` is a "blocking entry" — its
  close-wait must release via `__ddSession.onDispose(() => resolve())` and
  skip `host.destroy()` on session end (the host is persistent-layer; the
  supervisor owns it). Without this the entry import never settles, the
  supervisor's reimport queue jams after the first Tier-3 restart, and the
  window stays open with dead rendering. `svc.dispose()` NEVER kills viewer
  children — they're detached/unref'd processes that outlive the app
  (closing the manager must not close the console); `ViewerSession.detach()`
  drops ownership and still runs the escape-shortcut uninstallers, and the
  stale-viewer reaper in `open()` cleans orphans on the next launch. On a
  session restart the entry calls `svc.dispose({ sessionRestart: true })`,
  which additionally skips VM stops — an HMR swap must not take down
  running guests.
- Text quality: `PanelSpec.scale` = raster px per display px (supersample;
  1 = hard edges, 2 = smooth-but-soft). `PanelSpec.zoom` (added in
  ../downdraft-engine) = display px per CSS px — the UI scale knob; pointer
  input is converted automatically. Cruiser mounts zoom≈1.25 + scale=1
  (native-res raster, CRUISER_UI_ZOOM/CRUISER_UI_SCALE env knobs). The OSR
  cdylib embeds only DejaVu Sans; real system fonts are bound via
  `registerResource` (ui:// blobs) + `@font-face` — see
  `libraries/app-shell/src/fonts.ts`. Call before mount so the first doc
  resolve sees them.
