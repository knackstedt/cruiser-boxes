# cruiser — agent notes

WinBoat-style QEMU/KVM VM manager for **Linux guests plus a Windows target**
(`os.family=windows` — unattend ISO install + virtio-win/yttrium drivers;
linux-only features are schema- and UI-gated), on the DownDraft
native runtime (winit + wgpu + Blitz html-ui — no Electron/Chromium).

## Commands

- `bun install` — installs deps; `@downdraft/*` resolve to the published npm
  packages, then the postinstall (`scripts/link-engine.mjs`, also runnable as
  `bun run engine:link`) symlinks them into a sibling engine checkout when one
  exists: `$CRUISER_ENGINE_DIR`, `../downdraft-engine`, or `../downdraft`.
  Missing checkout = plain npm packages; removed checkout = the preinstall
  prunes the dead links so npm versions come back. Engine changes land in the
  engine repo, not here.
- `bun run cli -- <args>` — headless CLI (`src/cli.ts`). Also `bun run src/cli.ts`.
- `bun test tests/` — unit tests. **Always scope to `tests/`** — bare
  `bun test` recurses into `src-tarballs/` (symlinked QEMU/dep sources) and
  finds their js test files.
- `bunx tsc --noEmit` — typecheck (`bun run typecheck`).
- `bunx oxlint` — lint (`bun run lint`).
- `bun run toolchain/build.mts check|build|adopt-src` — pinned source toolchain.
- `bun run term:bundle` — rebuild the xterm.js page bundle
  (`term-bundle.gen.ts`) used by the embedded terminal.
- `bun run term-dd:stage` / `viewer-dd:stage` — cargo release build +
  `native/dist/` staging for the Rust helpers.
- `CRUISER_SMOKE_MS=N CRUISER_SCREENSHOT=/path.png CRUISER_SHOT_FRAMES=N
  CRUISER_ROUTE=create|vm|settings bun run src/native-entry.ts` — headless-ish
  UI smoke/screenshot harness (still needs a GPU + display; captures the real
  window surface). Add `WINIT_X11_SCALE_FACTOR=1` for screenshots: winit's
  LogicalSize intermittently picks up a sub-1 Xft.dpi (~82dpi via XSETTINGS)
  and shrinks the window ~15% (e.g. 1280x800 → 1097x686).
- `DD_STARTUP_PROFILE=1` — boot timing marks (`[startup] label t=Nms` since
  process start): entry/host/shell/service stages in `startup-profile.ts`
  plus per-stage marks inside `createNativeHost` (engine).

## CI / releases

- `.github/workflows/ci.yml` — typecheck + lint + `bun test tests/` on push/PR;
  reused by `release.yml` (tag `v*` → `draft release --target=linux` →
  deb + AppImage + flatpak + rpm uploaded to a GitHub release; `-` in the
  tag = prerelease). Formats come from package.json build.linux.target
  (the packager's KNOWN_FORMATS are dir/deb/appimage/flatpak/rpm — dir is
  left out as it produces no uploadable artifact). The flatpak/rpm formats
  need extra tooling the runner doesn't have — release.yml apt-installs
  `flatpak flatpak-builder rpm cpio` and pulls
  org.freedesktop.{Platform,Sdk}//25.08 from flathub before packaging.
  build.flatpak.finishArgs replaces the packager defaults wholesale —
  the set is defaults + `--device=all` (kvm + /dev/bus/usb passthrough),
  `--socket=session-bus` (kglobalaccel/gsd shortcut registration, KDE
  window rules via qdbus, `systemctl --user` for the autostart unit),
  keeping wayland/x11/ipc/pulseaudio/home/network. build.rpm mirrors the
  deb dep set under Fedora names (libusb1, libusbredir).
  ci.yml also runs `cargo check --locked` + `cargo clippy --locked` on
  `viewer-dd/` and `term-dd/`; release.yml runs `bun run viewer-dd:stage`,
  `bun run term-dd:stage` (same `cargo build --release --locked` →
  `native/dist/<plat>-<arch>/` flow) and `bun run term:bundle` before
  packaging — the packager's game-native convention copies that dir into
  `<appdir>/native/`, where `dirname(process.execPath)` anchors
  `ddViewerPath()`/`termDdPath()`'s probe
  (PATH → packaged appdir → repo `<name>-dd/target/{release,debug}`).
  release.yml also builds the opt/ toolchain from source
  (`bun run toolchain build` — QEMU 11 + pinned virglrenderer/spice, the
  aptBuildDeps from versions.json are apt-installed first) and stages it via
  `bun run opt:stage` → `release/opt/` (x86-only firmware prune, stripped,
  ~60M, license texts under licenses/ + THIRD_PARTY_NOTICES.md);
  package.json `build.files` copies it to `<appdir>/opt/` — the same
  `dirname(process.execPath)` anchor `optDir()` probes before falling back
  to `<repo>/opt` (CRUISER_OPT overrides both). The packaged binary is also
  the CLI: native-entry.ts dispatches argv to src/cli.ts when arg1 is a cli
  area (`cruiser vm start x`, `cruiser doctor`), so OVMF_CODE/OVMF_VARS
  resolve system-first then opt's edk2 fds, and {cli} shortcuts expand to
  the appdir launcher. `cruiser` on PATH: deb/rpm ship /usr/bin/cruiser via
  the packager; flatpak can't touch host PATH, so service.init (and `host
  install-cli`) drops marker-checked wrappers exec'ing `flatpak run
  dev.cruiser.app` into ~/.local/share/flatpak/exports/bin + ~/.local/bin
  (host-cli.ts — also used for AppImage/dev via ~/.local/bin). Every
  host-EXECUTED cli expansion checks FLATPAK_ID first and routes through
  `flatpak run <id>` — session.ts cruiserCliArgv (escape shortcuts,
  app-mode .desktop Exec lines) and autostart.ts cliArgv (the systemd
  --user unit's ExecStart) — the in-sandbox launcher path is dead on the
  host.
- CI does NOT use the sibling engine checkout — deps are already npm specs;
  `.github/actions/downdraft-deps` can still pin `@downdraft/*` to a chosen
  published version (`downdraft-version` input — empty default = keep
  package.json's specs; never a stale hard default — the old `^0.5.0`
  shipped engine 0.5.2 in releases and broke shifted key input). Engine
  changes must be **published to npm** before cruiser CI can see them;
  typecheck fails on unreleased APIs (e.g. `PanelSpec.smoothWheel` existed
  locally long before npm had it).

## Layout

- `src/native-entry.ts` — DownDraft app entry (bare `createNativeHost` +
  `HtmlUiHost`; no GameModule/sim worker). The env-gated dev/screenshot
  harness (fake VM, route forcing, input script) lives in
  `libraries/app-shell/src/dev-harness.ts` — the entry only calls
  `initDevHarness`/`screenshotHostOpts`.
- `src/cli.ts` — headless control surface (vm/usb/provision/host/doctor).
- `ddproto/` — shared Rust protocol crate: QMP getfd/add_client channel
  helper, qemu.pid watchdog, and the zbus skeleton structs for QEMU's
  org.qemu.Display1 listener + clipboard peer interfaces (generic over
  ConsoleEvents/ClipEvents sinks). Reused by viewer-dd and ddproxy.
- `ddproxy/` — Rust per-VM display broker. QEMU's @dbus-display p2p auth
  keeps effectively one client and can wedge permanently on viewer churn
  (`REJECTED EXTERNAL`); ddproxy attaches ONCE per VM boot (control conn +
  per-console RegisterListener + input conn LAST — QEMU binds its object
  tree to the final add_client conn) and re-exports the same object tree
  on run/ddproxy.sock. viewer-dd takes `--proxy <sock>` (spawned detached
  by vm.ts at start for display.viewer=dmabuf — default-on — with
  pidfile-sweep + probe()-time throttled respawn in
  lifecycle/ddproxy.ts) and falls back to the direct QMP channel when the
  socket is dead. The broker replies to QEMU listener calls instantly
  (QEMU gl-blocks the guest on UpdateDMABUF, so a hung viewer can't stall
  the guest), caches each console's last scanout/cursor/mouse for instant
  replay on RegisterListener, and fans out to N concurrent viewers.
  SCM_RIGHTS pass-through — never imports dmabufs, no GL dep. Clipboard
  rides the stable proxy↔QEMU peer (Register serial resets relay to the
  last-registered viewer conn; QEMU blocks on Request replies so that one
  call is relayed synchronously).
- `libraries/vm-core` — VmSpec schema, QEMU argv builder, QMP/QGA clients
  (pure TS over unix sockets), lifecycle + reattach, disk ops, USB, rendernode.
  vm-core is a LEAF: it never imports host-int/provision — guest monitor
  topology is computed by the caller
  (`provision/src/monitors.ts`'s `hostMirroredGuestMonitors`, gated on
  `spec.display.monitors`) and passed to `start()`/`buildArgv()` via
  `BuildOpts.guestMonitors`; headless/cli builds never touch the display
  stack. `config/shares.ts` (`makeShare`) is the single share-entry builder
  for the UI's shareAdd and the cli's --share/`vm share add`;
  `config/portable.ts` owns `loadPortableRef` + `pullConfigFromOrigin`
  (shared by import/`config pull` on both surfaces).
  `config/boot-diff.ts` (`bootRelevantChanges`) is the single
  argv-relevant spec diff — it powers mergePulledSpec's needsRestart AND
  `VmHandle.pendingRestart`: start() snapshots the launched spec to
  run/launch-spec.json, and the UI diffs it against the saved spec for the
  "restart pending" marker (vm row/detail) + the edit form's
  "needs restart"/"applies live" field tags. persist/headMode/sync/
  copy-shares are LIVE (session-level), resources/gpu/display-viewer/
  network/usb/mount-shares are boot-frozen. display.viewer defaults to
  dmabuf — a create/edit "Viewer" row on both surfaces; software gpu has
  no GL scanouts to export, so the UI coerces rdp on pick + guards on
  save and the cli falls back (explicit --viewer dmabuf --gpu software
  is a create error). Guests provision their RDP server either way, so
  an rdp flip needs no re-provision.
  resources.limits {cpuQuota,memoryMax,ioWeight} wraps QEMU in a
  `systemd-run --user --scope cruiser-<name>` cgroup; resources.sched
  {nice,ioClass,ioPrio} prepends nice(1)/ionice(1) wrappers INSIDE that
  scope (start() builds inner argv first); the io fields also wrap each
  virtiofsd spawn (it does the real share I/O — nice stays QEMU-only).
  Priority-raising values
  (nice<0, io realtime, be prio<4) need CAP_SYS_NICE/SYS_ADMIN. ionice
  EXITS WITHOUT EXEC on a denied ioprio_set (nice(1) warns + continues),
  so the io wrap is `sh -c 'ionice … "$@" || exec "$@"'` (schedIoArgv) —
  denied or missing ionice falls back to default io class + a log line;
  nice is which()-gated. Both surfaces expose it — create/edit
  "QEMU nice"/"QEMU I/O class"/"I/O priority" rows ("" = unset) and the
  cli's --nice/--io-class/--io-prio.
  `vm hibernate` is suspend-to-disk via QMP `migrate "exec:cat >
  run/suspend.mig"` — NOT snapshot-save/internal snapshots (that path
  tagged every disk, needed qcow2, and a mid-load kill rolled disk vs RAM
  inconsistently → guest fs corruption). start() detects the file, adds
  `-incoming "exec:cat …"`, polls query-migrate → cont → deletes it.
  virtio-gpu's `conf.max_outputs` is VMSTATE_UINT32_EQUAL — the resume
  argv MUST carry the save-time guestMonitors or the element load fails
  ("1 != 3"); hibernate() stashes launch-monitors.json as
  run/suspend-mons.json for exactly this. Gates: gpu.mode=software (virgl/
  venus host GL state isn't serializable) and no mount-mode shares
  (vhost-user-fs state lives in virtiofsd). A boot-frozen spec drift vs
  run/launch-spec.json refuses resume with the diff named; `--discard-state`
  cold-boots (discardHibernate also sweeps the legacy
  run/hibernate.vmstate + "hibernate" disk tags — start() still resumes
  that older format via -S + snapshot-load). waitJob() polls query-jobs
  once after listener registration — a concluded JOB_STATUS_CHANGE event
  emitted pre-registration is otherwise missed to the 10min timeout.
  `logs.ts` — the Logs screen's backends: run/ file tails (cruiser.log is
  tee'd from lifecycle + provision via `appendVmLog`; serial.log is attached
  on every boot) and guest journalctl with filters over QGA, falling back to
  ssh+sudo when `guestAgentContext` reports a confined agent (also used by
  guest-setup).
  virtiofsd (vm.ts): shares get one `--socket-path` daemon each, spawned
  DETACHED like QEMU's -daemonize — a non-detached daemon dies with the
  launcher's process group and leaves every guest mount I/O-hung in
  D-state. virtiofsd writes `<sock>.pid` itself — MULTI-LINE (supervisor
  pid on line 1, sandbox internals after): `Number(wholeFile)` is NaN and
  once made vfsdAlive/killVfsd read every live daemon as dead → an
  endless 20s respawn loop of children that die on the pidfile flock
  (EAGAIN). Always read line 1 via vfsdPid(). `killVfsd` reaps both
  children and pidfile-discovered strays (also on start(), before
  spawning — a crashed launcher leaves orphans, and QEMU's vhost-user
  device does its one handshake at machine init so a stale listener
  breaks the boot with "Failed to set msg fds"). `watchVfsd` polls the
  pidfiles every 10s and respawns dead daemons — QEMU 11 does NOT re-pair
  a fresh daemon on the existing chardev (reconnect-ms is broken for
  vhost-user: the eager parse-time connect exhausts virtiofsd's
  single-shot listener), so a mid-run crash still needs a VM restart;
  the respawn only keeps the backend present for cleanup + logging.
  --sandbox=namespace makes each daemon a supervisor+worker pair —
  two procs per socket is normal.
  `lifecycle/autosnap.ts` (`runAutoSnapshot`) is the spec.snapshots
  {auto,trigger,keep} policy — offline qemu-img internal snaps only, so it
  fires on the "start"/"stop" edges (never on kill/crash). auto-* prefixed
  names rotate to keep-N; space preflight wants headroom ≈ the file
  doubling (pinned-cluster worst case), sacrifices oldest auto-* first,
  and reports `shortfall{need,free,remaining}` so the UI can park a start
  on a delete-or-skip prompt (CLI just warns and proceeds).
  `registry.clone(name,new)` duplicates a stopped VM: fresh ports via
  create()'s realloc path, disk reflinked (cp --reflink=always) or
  qemu-img convert'd — internal snapshots never survive (convert drops
  them; reflink copies then strips them); OVMF_VARS + secrets/ copied,
  spec.origin cleared (a config pull must not rewrite both VMs).
  `registry.relocate(name, dir)` ("VM location" row / `vm move` /
  create's --vm-dir via linkVmDir) puts the real dir at <dir>/<name>
  behind a vms/<name> symlink — every vmPaths() consumer resolves
  through the link, scan() picks it up via existsSync. Moving back to
  VMS_DIR drops the link. The move is `mv` (rename or copy+delete —
  fs.cp chokes on run/'s stale unix sockets); absolute spec paths under
  the old real dir get repointed. remove(--disk) + rename resolve the
  link — a bare rm on a linked dir would drop only the link and orphan
  the real one. vmRealDir() reports the link-resolved path (summary's
  vmDir/detail-page location); a missing mount shows as "not found".
  Disk encryption (spec.disk.encrypt): qcow2 LUKS — QEMU/qemu-img unlock
  the image via `-object secret,id=diskkey,file=<key>` + the drive's
  `encrypt.key-secret=diskkey`. "full" = the system image itself is LUKS;
  "home" = plaintext root + a second LUKS image <stem>-home.qcow2 attached
  as virtio-blk serial=cruiser-home (/dev/disk/by-id/virtio-cruiser-home —
  guest-setup formats ext4, migrates /home, writes the fstab entry).
  keyStorage "store" keeps the passphrase at secrets/disk-key (0600);
  "prompt" persists nothing — callers write a transient run/disk-key
  (h.provideDiskKey) which start()/provision delete after QEMU consumes
  it (h.clearDiskKey). qemu-img ops thread the key through imgTarget/
  imgJsonTarget (`json:` pseudo-filenames) — `info` reads LUKS headers
  keyless, every MUTATION (create/convert/snapshot/resize/backup) fails
  without encrypt.key-secret. All encryption fields are create-time +
  boot-diff'd; portable export carries the config but never the key;
  mergePulledSpec preserves local encryption (can't re-flip an existing
  image). UI parks keyed ops on an unlock banner (store.unlockPrompt →
  svc.unlockGo re-dispatches); CLI resolves via --disk-password /
  CRUISER_DISK_PASSWORD / tty prompt (ensureDiskKey).
- `libraries/host-int` — WmAdapter impls (kde-x11 full; kde-wayland partial;
  gnome-x11; gnome-wayland — shortcuts via gsettings work there since gsd is
  session-level; only window ops are stubbed), xfreerdp viewer + ViewerSession.
  stdout/stderr lands in `run/freerdp.log` / `run/viewer-dd.log` — a dead
  viewer with stdio ignored is undiagnosable; open() throws the log path.
  `x11MoveToDesktop` verify-retries `_NET_WM_DESKTOP` — KWin applies initial
  placement after map and silently overwrites an early `-t`. Post-map moves
  are the FALLBACK: on KDE adapters `installWindowRule` writes a
  kwinrulesrc group (title regex + wmclass match, `desktops=<vd-uuid>`,
  desktopsrule=3 "apply at initial mapping" — KWin enums: match 1=exact
  2=substr 3=regex; policy 2=force 3=apply 4=remember) before the viewer
  spawns, so the window maps straight onto the target VD with no flash —
  and it works on Wayland clients too. Rules register in `[General]
  rules=`/`count` + `qdbus org.kde.KWin /KWin reconfigure`; kwriteconfig5
  has no --delete-group so uninstall drops the ini section by rewrite.
  `desktops=` accepts ONLY a VD UUID — never a numeric index: the kde-x11
  `desktops()` x11 fallback reports `id=String(idx)` which once wrote a dead
  `desktops=1` rule (the window mapped on the current VD anyway). Guards:
  `kdeDesktops` falls back to kwinrc `[Desktops] Id_N=` when the dbus probe
  flakes, session.ts requires `KWIN_VD_UUID` before passing `desktopId`, and
  the installer throws on non-UUID ids. The group hash keys on
  (title,class,desktop) so a changed VD target would orphan a stale rule —
  install sweeps same-window `cruiser-*` groups. Window finding: the dmabuf
  window is minifb — the toolkit sets neither WM_CLASS nor _NET_WM_PID
  (viewer-dd sets both via FFI after create), so the session matches the
  anchored title regex `^cruiser:<vm>$`, not pid.
  headMode/virtualDesktop are LIVE spec fields: saveVm pushes an edited
  display slice into a running session via `applyDisplaySpec` — re-installs
  the VD rule (the sweep drops the stale target) and re-runs placeWindow,
  so a VD switch moves the open viewer immediately (kde-wayland can only
  re-rule — rules bind at next map; its moveToDesktop is a stub).
  viewer-dd (dmabuf): QEMU's @dbus-display keeps effectively ONE client
  channel — the enumeration conn dies after RegisterListener and extra
  add_client channels EPIPE at the p2p handshake, so all per-console
  Keyboard/Mouse calls share a single conn opened after listener
  registration. QMP `getfd` fdnames are global-namespace — unique per
  channel or concurrent opens collide onto a stale fd. KNOWN WEDGE: a
  long-running QEMU can start REJECTING all new p2p clients at the auth
  layer (`REJECTED EXTERNAL DBUS_COOKIE_SHA1` — reproducible with a raw
  socketpair probe, so it's QEMU/GLib in-process state, not client code;
  observed after the previous viewer was SIGTERM'd ~months into uptime).
  A `-M none -display dbus,p2p=on` scratch QEMU accepts the same
  handshake fine. REMEDIATED BY DEFAULT via ddproxy: the broker (below)
  owns the QEMU-side conns for the VM's lifetime, so viewer churn never
  reaches the auth surface — a VM already wedged before the proxy ran
  still needs its restart (prevention, not cure). Dead-QEMU watchdog =
  qemu.pid pid + /proc starttime beside monitor.sock (detects restart too);
  don't ping the control conn, QEMU closes it by design. Multi-head is
  ONE window now (freerdp /multimon semantics): every console's Listener
  feeds a single GL worker that draws each console's texture into its
  monitor rect. `--rects "x,y,w,h …"` (absolute host px, console order =
  virtio outputs[] order = adapter.monitors() pick order) makes the
  viewer self-position the window over the union via XMoveResizeWindow
  and carry `_NET_WM_FULLSCREEN_MONITORS` (EWMH monitor indices are
  Xinerama order — viewer-dd dlopens libXinerama and matches rects to
  screens by geometry). CRITICAL: the hint is written only AFTER WM_STATE
  exists and the viewer NEVER requests _NET_WM_STATE_FULLSCREEN itself —
  a window born/adopted with hint+fullscreen state crashes KWin 5.27 in
  Workspace::xineramaIndexToOutput during manage() (4x SIGSEGV restart
  loop observed, kwin recovered only after the window died). The
  session's setFullscreen (wmctrl path) evaluates the dormant hint —
  same timing as freerdp /multimon. Two later KWin gotchas: (a) KWin
  DELETES _NET_WM_FULLSCREEN_MONITORS when it consumes a fullscreen
  transition, so the viewer re-arms it from PropertyNotify(type 28) —
  without that the first toggle lost the span and shrank to one monitor;
  (b) KWin clips an over-screen window to one output during manage(), so
  the union XMoveResizeWindow is re-asserted ~1.5s after map (the pre-map
  placement doesn't stick).
  head_rects() only uses the span layout while the drawable is union-sized
  (±2px) — a WM that collapsed the span gets the composite-letterbox
  fallback instead of a crop; windowed mode letterboxes the whole
  composite and single-head tracks guest res via XResizeWindow. Input hits
  the same map: window px → nearest head rect → console-local px →
  composite fraction × console dims (the virtio tablet's range covers the
  whole composite; --offsets carries the normalized composite layout).
  Consoles with no scanout yet draw black (HeadSlot.img None is skipped).
  Damage plumbing: QEMU emits ONE UpdateDMABUF call per damage rect,
  serialized by its guest-side gl-block (vendored dbus-listener.c has a
  TODO for a batched UpdateList) — the listener must reply fast and the
  GL worker coalesces the burst into a single paced (~166Hz) present via
  eglSwapBuffersWithDamageKHR (rects are BOTTOM-left surface coords per
  the KHR spec — flip y) + EGL_EXT_buffer_age-scissored partial repaints.
  Presents are ONLY damage-driven — the GL worker parks on the job
  channel, so a VD switch/iconify that unmaps the window would leave the
  remapped (fresh, BLACK) pixmap up forever while the guest is idle:
  the xdpy drain selects Exposure|VisibilityChange|StructureNotify on
  xwin (0x38003) and turns Expose/VisibilityNotify/MapNotify into
  XJob::Repaint — a forced full-path repaint off the held EGLImages,
  no QEMU traffic needed.
  ScanoutDMABUF2's y0_top is COUNTERINTUITIVE: buffers arriving
  y0_top=false sample upright ONLY with the v-flip (v_bottom=(y+h)/bh);
  treating the flag literally renders every head upside-down (observed on
  NVIDIA EGL). Imports dedupe on fstat (dev,ino) + full attrib tuple.
  Non-dmabuf scanouts (any guest without GL exports — stock virtio-win
  viogpudo, WinPE, unaccelerated Linux): the listener also implements
  `Scanout`/`Update` (inline pixels) and `ScanoutMAP`/`UpdateMAP`
  (`Listener.Unix.Map` memfd → mmap), uploading into per-head GL textures
  with damage-scissored `glTexSubImage2D`. Each head carries a live
  kind (Dmabuf|Cpu|Mapped) and the worker holds ONE latest-job slot per
  console, so a scanout-kind flip can't reorder a stale dma-buf over a
  newer CPU frame; presents switch shader program/texture target per
  head. One extra copy vs. dmabuf — the fallback keeps windows guests
  and the installer visible on the same viewer.
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
  On `register` (QEMU's serial-reset signal) viewer-dd also clears the
  parked text — the guest's clipboard state dies with the port bounce, and
  a live echo guard would block re-pushing it.
  Host side = arboard (x11rb/wl-clipboard-rs) polled 300ms — no change
  watcher exists; a parked `host_text` echo guard stops guest→host writes
  re-grabbing back. Text only (text/plain;charset=utf-8) — QEMU's dbus
  clipboard knows no other MIME. Guest caveat: spice-vdagent is X11-only,
  so on Wayland sessions host→guest reaches native apps (KWin bridges the
  X11 selection) but guest→host only sees X11/XWayland copies. KWin also
  internally bridges REAL wayland-app copies into the X11 selection — but
  it rejects set_selection from unfocused clients, so `wl-copy` injected
  over ssh is silently dropped and misleading for testing (use `xclip`
  with the session's XAUTHORITY, detached so it outlives the channel —
  a dead selection owner shows up as QEMU "Cancelled clipboard request").
  `guestClipBridgeScript` (sync.ts, auto-pushed when display.clipboard is
  on for dmabuf viewers) additionally installs an autostart
  `wl-paste --watch`→`xclip` mirror for compositors that expose
  data-control (wlroots) — on KWin it exits instantly since data-control
  is trusted-client-only.
  Input (dmabuf): the viewer bypasses minifb's input path entirely — a
  second X11 conn (xdpy) selects KeyPress|KeyRelease|ButtonPress|
  ButtonRelease on the minifb window and converts RAW KEYCODES to QEMU
  qnums positionally (X keycode = evdev+8 = XT scancode for the base
  block; the e0 block maps through a fixed table). Never map through
  keysyms — minifb's Key enum had no Backquote entry, silently dropping
  `/~ forever. Pointer position comes from XQueryPointer (a request —
  minifb's event-fed mouse state stalls under a pointer grab since
  motion isn't in the grab mask); buttons/wheel come from the raw
  events (X btn 4/5 = wheel pulses → guest btns 3/4; 8/9 → side/extra).
  `--grab` (spec.display.grabKeyboard) holds XGrabKeyboard +
  XGrabPointer on the focused window (retries 500ms — loses to transient
  server grabs like KWin's tabbox), ungrabs on FocusOut. Grab modes are
  load-bearing and easy to get backwards: XGrabKeyboard must be
  Async/Async — an ACTIVE Sync-mode grab queues every event without
  delivering until an XAllowEvents nobody sends → keyboard dead while
  focused, pointer still flowing (this bug once ate all host input).
  Same for XGrabPointer — Async pointer mode (a Sync one froze the
  whole mouse, clicks and cursor both dead). An active grab still
  shadows KWin's passive Mod4+Button window-move (super+drag);
  in-window clicks are forwarded to the guest, and an outside click
  drops the grab + re-injects the press via XTestFakeButtonEvent —
  a real device event, so focus moves and WM passive grabs fire as
  if we'd never grabbed (wheel buttons 4-7 get a press+release pair
  since they're transient pulses). Safety net:
  abort-gen/ungrab-gen are AtomicU64 generation counters (a swap() flag
  races the multiple producers), SIGUSR1 bumps abort_gen
  (pkill -USR1 -x viewer-dd — no keyboard needed), ctrl+alt+shift+
  right-click aborts via the pointer-grab path, holding CapsLock ≥5s
  while a grab/capture is live fires the ungrab path (xwin-key-stream
  hold timing — needs no combo and no keyboard grab, only focus;
  cleared on unfocus, same-timestamp peek eats autorepeat), and any
  grab held >60s force-releases as a heartbeat so a wedged grab can't
  strand the host. Focus loss
  replays key-ups for every qnum the guest still sees held plus button
  releases — the release half of a WM-consumed combo otherwise leaves
  modifiers stuck down guest-side. The drain is UNCONDITIONAL while
  !active, not edge-triggered: a focus cycle that opens and closes
  inside one win.update() batch never shows a true→false transition,
  but a press delivered in that window (autorepeat of a held Super
  mid VD-switch pass-through) still lands on xdpy → edge-triggering
  left it in `pressed` forever, guest-side stuck Super until a later
  full focus cycle. Escape combos fire three ways:
  daemon-installed `command:` actions (kglobalaccel/gsettings — the
  only kind installed host-side for dmabuf; the others are viewer
  dispatches), root-window XGrabKey passive grabs (Async modes, 4
  lock-state variants, console-0's conn — BadAccess to a WM-owned
  combo is eaten by a custom XSetErrorHandler), and in-grab dispatch
  on the xwin key stream. `--escape "<mods+key>=<action>"` actions:
  host-desktop/desktop-cycle via kglobalaccel `invokeShortcut`
  (qdbus6→qdbus→gdbus, then xdotool EWMH fallback), `kwin:<name>` =
  same invokeShortcut on a named action (session.ts mirrors the host's
  OWN VD-switch bindings — kde [kwin] kglobalshortcutsrc rows via
  kwinDesktopBindings, GNOME switch-to-workspace-* via gsettings — so
  the user's real VD keys keep working under the grab; the mirror
  never rewrites the host's config), `command:` via sh -c, `ungrab`
  holds the grab off until refocus, `abort` releases grabs +
  XIconifyWindow on the viewer window (one shared EscState; the loop
  watches abort_gen), `none` swallows. A combo already passively
  grabbed by the WM loses our XGrabKey (BadAccess, logged) — but its
  events then go to the WM's grab, never to us, so no double-fire.
  300ms per-combo debounce + same-timestamp release/press peek eats X
  autorepeat. NumLock: host XKB "Num Lock" indicator vs QEMU Keyboard
  .Modifiers bit 1, polled 500ms on console 0 only; a forwarded
  NumLock press suppresses the poll for 900ms and a mismatch must
  persist 2 polls before we pulse — the guest LED lags the host XKB
  flip and a poll in that window injected a permanent anti-phase
  toggle. Keep default escape combos host-inert (ctrl+super+fN):
  a combo that slips through anywhere hits the host's own bindings
  (ctrl+alt+delete did exactly that → ksmserver logout → dead
  session). `[grab]`/`[esc]` lines carry a `+Ns` elapsed prefix.
  Pointer capture (dmabuf, spec.display.pointerLock = auto|always|off):
  QEMU keeps ONE active pointer handler per console — the virtio tablet
  (ABS) owns it normally, so D-Bus RelMotion errors "Mouse is not
  relative" and SetAbsPosition errors "Mouse is not absolute" when the
  PS/2 mouse is head (e.g. while BIOS owns the console). Guest
  pointer-lock apps (games via pointer-constraints/XInput) need EV_REL
  deltas the tablet can't produce. Capture mode flips the handler via
  HMP `mouse_set <idx>` over QMP human-monitor-command (query-mice →
  first REL vs first ABS index; QMP has no mouse-set command — HMP
  only), feeds RelMotion, and confines the host pointer
  (XGrabPointer confine_to=xwin — a held grab can't be amended, so it's
  ungrab+regrab). `mouse_set` is the input worker's job — In::Mode rides
  the shared channel so the flip lands before the deltas that follow;
  a mode-mismatch call error re-asserts the wanted mode (≥400ms apart —
  a virtio-input activation during guest boot can steal the head
  handler back mid-capture). Host side: deltas are XQueryPointer
  samples minus last sample; our own XWarpPointer calls rebase the
  baseline where they're issued so they never count as motion. While
  the guest keeps a cursor, each listener MouseSet(x,y,on) report is
  warped to (console px → window px through the same head_rects +
  fit_viewport the abs map inverts) so the guest-sprite X cursor sits
  where the guest thinks the pointer is — but ONLY while pgrabbed:
  captured-but-unconfined means the confine grab lost a race and the
  host pointer is roaming, so warping then teleports the user's cursor
  into window coords on every report (offscreen window included);
  hidden-cursor reports don't
  warp — the pointer re-parks at window center when it drifts >35% out
  (confined at an edge = no delta room). 'auto' engages only on a seen-visible → now-
  hidden cursor transition while focused AND once the hidden cursor has
  accrued ≥160 host-px of in-window pointer motion (hide_travel) — a
  never-cursored boot (firmware/splash has no cursor plane) must not
  capture, and a terminal's hide-while-typing episode un-hides on the
  first motion delta so it never reaches the gate (without the gate,
  typing in a guest terminal reads as a pointer-lock and the host
  pointer blanks+confines mid-sentence); visibility =
  ANY console's slot on (virtio-gpu parks the pointer on one output's
  cursor plane, the others legitimately report off). Apps that lock
  without hiding the cursor are invisible to 'auto' — the `relgrab`
  escape action (default ctrl+super+m) force-toggles, ungrab/abort and
  focus loss release. `[rel]` log lines mark transitions.
  `[fps]` lines log
  `/proc/self/fd` count + system `file-nr`: dma-buf/sync_file objects
  pinned in-kernel (nvidia EGL/venus fences) never appear in a process's
  fd table, so file-nr is the only signal when the global file table
  fills (fs.file-max sysctl — was 100000 here, ENOFILE → nvidia_drm
  nv_drm_create_sync_file NULL-deref killed qemu + plasmashell's
  QSGRenderThread, 2026-10-13/15).
  `appearance.ts` — xdg-desktop-portal settings: `color-scheme`/`accent-color`/
  `contrast` reads (busctl, gdbus fallback) + one dbus-monitor SettingChanged
  watcher shared by all portal channels. `hoststate.ts` — the non-portal
  probes: timezone, LANG, X11 keymap, host wallpaper path, git user.name/
  email, gsettings/kioslaverc proxy, custom CA roots, SSH_AUTH_SOCK.
- `libraries/provision` — cloudimg+NoCloud, ISO autoinstall, guest-setup driver
  (QGA), monitors.xml generation. `packages.ts` is the single scoped package
  manifest (entries carry `stages: seed|setup`, `desktops`, `distros`, `when`).
  `os.devtools` is a grouped checklist (DevTool enum ids — add-only, they're
  persisted in vm.json) rendered under the "Developer" preset; DEVTOOLS in
  packages.ts carries cat/label/desc/flatpak and DEVTOOLS_PRESET is the
  pre-checked subset. Items install three ways: a `when: dev(id)` manifest
  entry (distro pkgs), a flatpak id on the catalog entry, or a
  `devtools.ts` `guestDevtoolsScript` block (upstream installers/repos —
  each wrapped `( set -e; … ) || echo skipped` so a dead upstream can't
  sink the provision). Fedora pkg names resolve via provides
  (`--skip-unavailable`, no `dnf list`);
  `distros.ts` holds the curated release matrix + cloud-image URL resolvers
  (Debian/Fedora resolve filenames by scraping mirror indexes).
  `theme.ts` — the dark/light channel's guest script + applyColorScheme;
  `guestThemeScript` bakes into guest-setup (gsettings `color-scheme` /
  `plasma-apply-colorscheme`, both `command -v`-gated so the spec's desktop
  guess can't misfire). plasma-apply-colorscheme REQUIRES
  `QT_QPA_PLATFORM=offscreen` in the QGA/ssh context — no DISPLAY/
  WAYLAND_DISPLAY means the Qt xcb plugin aborts and the `|| true` eats it,
  silently leaving the guest on BreezeLight.
  `sync.ts` — the host→guest sync engine. `spec.sync` gates fifteen channels
  declared in the single-definition registry
  `vm-core/src/config/sync-channels.ts` (id/env kill/spec default/create-form
  key — schema.ts, store.ts, service.ts, and the cli all derive from it):
  ten default-on (theme, accentColor, contrast, timezone, locale, keyboard,
  monitors, scale, hostWallpaper, shares) and five default-off
  security-sensitive ones
  (gitIdentity, proxy, caCerts, sshAgent, gitKey). `SessionSyncs` (viewer lifetime,
  wired by provision/session.ts's `openVmSession` — the shared
  viewer+syncs+wallpaper kit used by service.ensureViewer AND cli
  `vm start|view`) runs one shared portal
  watcher for theme/accent/contrast, an /etc/localtime fs.watch for timezone,
  session-start one-shots hash-gated via run/sync.state (locale/keyboard/
  monitors/git/proxy/ca — in-guest drift isn't clobbered unless host input
  changed), and an `AgentForward` (ssh -N -R agent socket, respawn with
  backoff) for sshAgent. With `credentials.sshAgentKeys` set (the form's
  detected-~/.ssh picker, `vm agent-keys` on the cli) the forwarded socket
  is a dedicated ssh-agent spawned under run/ and ssh-add'd with just the
  picks — the session agent is never touched; empty list = the host's
  SSH_AUTH_SOCK as before. `syncEnabled` = spec flag AND env: `CRUISER_HOST_
  SYNC=0` kills all, `CRUISER_SYNC_<ID>=0` per channel, `CRUISER_THEME_SYNC=0`
  still honored. The `scale` channel carries host display scale + font DPI:
  `hostDisplayScale` probes gsettings scaling-factor/text-scaling-factor
  (last-token parse — "uint32 2" is two tokens, stripping non-digits reads
  "32"), KDE kdeglobals KScreen/kcmfonts, xrdb Xft.dpi; `applyHostScale`
  fills xrandr's missing MonitorInfo.scale so it lands in monitors.xml +
  kscreen args, and `guestScaleScript` pushes text-scaling-factor /
  integer scaling-factor / kcmfonts forceFontDPI. Guest scripts all follow
  the guestThemeScript mold (runuser
  for user-context, command -v gates, never abort provision). The `shares`
  channel runs `guestSharesScript` — a managed `# >>> cruiser-shares >>>`
  fstab block reconciled against spec.shares (stale virtfs mounts unmounted,
  `ro` written for direction:"host-to-guest") — the same script guest-setup
  bakes at provision, so editing shares converges the guest on the next pass.
  The `gitKey` channel pushes a host private key into the guest —
  `credentials.gitSshKeyPath` if set, else `hostGitSshKey` (hoststate.ts)
  falls back to `~/.ssh/<git email>` / the github/gitlab-suffixed names —
  installed as `~/.ssh/cruiser-git-key` (0600) + a
  `# >>> cruiser-git-key >>>` ssh config block (IdentityFile+IdentitiesOnly
  for github/gitlab/bitbucket). This is the reliable git path: the
  sshAgent channel only works while a session is open AND (with no
  sshAgentKeys picks) the host agent actually holds a key.
  `filesync.ts` — copy-mode shares (`mode:"copy"`): rsync over the ssh hostfwd
  + `ensureKeypair` key. direction "both" = `--update` push+pull (newest wins,
  no deletes); "host-to-guest" = authoritative push (+`--delete` when
  `deletions`). `FileSyncs` runs fs.watch pushes + a 30s pull interval for the
  viewer session (openVmSession); `vm filesync <name>` is one-shot,
  `--watch` holds it. Guest target = guestPath or ~/cruiser-sync/<basename>;
  prep script mkdirs targets and lazily installs guest rsync (cli-tools also
  ships it). Env: `CRUISER_FILESYNC=0` kills, `CRUISER_FILESYNC_{PUSH,PULL}_MS`
  tune the intervals.
  `session.ts` — `openVmSession(h, opts)`: the shared session kit both
  surfaces call (UI's ensureViewer + cli's start/view) — opens the
  ViewerSession, starts SessionSyncs + FileSyncs + NotifyBridge bound to
  the "closed" hook, and fires the managed-wallpaper pass.
  `disposeSyncs()` drops the engines without closing the window.
  `notify.ts` (`NotifyBridge`, gated on `display.notifications` +
  `CRUISER_NOTIFICATIONS`) — guest → host notifications: a held ssh runs
  `busctl --user monitor --json=short` in the guest, snooping
  org.freedesktop.Notifications (unprivileged monitor peer on the user bus
  — nothing installed in the guest, in-guest popups still show). Three
  matches: method_call (Notify), method_return from the daemon (carries
  the assigned id — an app's replaces_id refers to it, so the call's
  sender:cookie → reply's destination:reply_cookie correlation is what
  maps guest ids to the host ids `notify-send -p` prints), and
  NotificationClosed signals (→ `busctl --user call` CloseNotification on
  the host). The remote exits 0 fast on missing busctl so it doesn't
  respawn-loop, and waits on /run/user/$UID/bus for pre-login. Actions
  aren't forwardable (a host click can't reach back). `vm notify <name>
  on|off` toggles; id maps reset per respawn since the daemon's ids are
  per-boot.
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
  `wallpaperTarget` cover-crops the composite to the guest's mirrored
  monitor aspect BEFORE watermarking — GNOME `zoom`/Plasma `crop`
  fill-modes otherwise re-crop a mismatched-aspect source and park edge
  watermarks in dead space. `shortcutsDoc` is viewer-aware (`display.viewer`
  rdp→freerdp text, dmabuf→viewer-dd) and drops the escape list when the
  host adapter can't bind shortcuts.
  `windows/` — the `os.family=windows` pipeline
  (`provision windows <vm> [iso]` / create-form "Windows" method):
  `isos.ts` resolves three artifacts — the Windows ISO (Microsoft's
  software-download-connector API: session-id'd tags→SKU→link flow with a
  `Referer`, IP-sentinel-blocked on some networks → manual ISO path/URL
  override), the virtio-win ISO (Fedora mirror, versioned dir → latest
  fallback; CHECKSUM sidecar when published), and the yttrium release zip
  (arehnman/yttrium-virtio-gpu GitHub releases) — all through
  `ensureDownload`'s atomic cache. `unattend.ts` generates
  autounattend.xml (EFI/MSR/Primary partition table, WinPE DriverPaths,
  specialize RunSynchronous → cruiser-setup.ps1, OOBE autologon →
  cruiser-done.cmd's shutdown = the host's install-complete signal) and
  packs it + scripts + the yttrium payload into a Joliet seed ISO
  (`buildSeedIso`). `install.ts` runs an OWNED QEMU with
  `install.sata` — the three CDs on native AHCI so driverless WinPE sees
  the media, while the system disk stays REAL virtio: the seed ISO's
  WinPE DriverPaths supplies viostor, so the install runs on the same
  storage path the production boot uses (no IDE→virtio 0x7B transition).
  Completion = FirstLogonCommands' shutdown (QMP SHUTDOWN,guest=true) +
  a marker on the serial log (COM1 echo — works for LUKS'd disks) or the
  qcow2 MFT `strings` scan when unencrypted. `provision.ts` orchestrates: downloads →
  seed ISO → install run → normal boot → QGA wait → `setup.ts`
  PowerShell-over-`guestPs` (virtiofs→drive-letter mapping, vdagent
  clipboard service, wallpaper, RDP) → `provisioned.method=windows-iso`.
  Schema: `os.winDriver=yttrium|virtio2d` (yttrium needs
  `gpu.mode=venus` + Secure Boot OFF — test-signed driver; virtio2d is
  the stock signed fallback), `os.winEdition` selects the /IMAGE/NAME.
  Multi-monitor = ONE virtio-gpu DEVICE per monitor (args.ts `winMulti`) —
  viogpudo/viogpu3d are single-head drivers so max_outputs>1 leaves the
  extra consoles dark. QEMU allows only one virtio-gpu-GL device, so
  secondary monitors get plain virtio-gpu-pci (CPU Scanout path; viewer-dd
  draws both). Each device head exports as its own D-Bus console in PCI
  creation order, matching outs[].
  Pointer agent (windows): virtio tablets enumerate as absolute HID MICE
  and Windows pins them to the primary display — wisp's Digimon registry
  association is digitizer-only (verified no-op) — so multi-monitor input
  rides an in-guest agent: agent.ps1 dials the slirp guestfwd
  (`guestfwd=tcp:10.0.2.250:28090-chardev:agfwd` — a QEMU-owned unix
  server at run/agent.sock; guestfwd -unix: fails the launch since QEMU
  connects at parse time, viewer-dd `--inject unix:` connects as the
  client + re-dials on drop, CRUISER_VD_INJECT
  overrides with a host:port connect-out for dev bridges) and injects
  SendInput with MOUSEEVENTF_ABSOLUTE|VIRTUALDESK — spans the guest's
  REAL display layout for any arrangement ("m <console> <x> <y>" lines,
  DISPLAY<ci+1> → console ci; "b <btn> <down>", wheel on 3/4; "info"
  logs the real layout). Dead/absent agent → viewer falls back to the
  D-Bus tablet path (primary-confined but alive). Installed by setup.ts:
  ProgramData\cruiser\agent.ps1 + INTERACTIVE-group logon task AND
  HKLM\Run (Task Scheduler denies registration 0x80070005 even
  user-context on hardened images; the agent's Local\ mutex makes the
  double launch benign). Two shell caveats seen on win10 eval images:
  powershell.exe via ShellExecute (Run dialog/Win+X) can fail "cannot
  access the specified device, path, or file" while cmd→powershell
  (CreateProcess) works fine — diagnose through a cmd /k window, not
  the Run dialog; and `vm screenshot`/screendump never shows UAC or the
  cursor (software cursor, no cursor plane — verify clicks by side
  effects like menus, not pointer position).
  The unattend password lives only in the transient seed ISO — never
  the spec. QGA-on-windows is SYSTEM session 0: `guestPs` exec works but
  `vm screenshot --guest` can't see the interactive desktop (schema/
  screen.ts guard). CPU flags: windows specs get the hv_* enlightenment
  set on -cpu host.
- `libraries/app-mode` — waypipe over vsock (socat bridge) / ssh fallback.
  guestAppCatalog also scans flatpak export dirs (system+user), /usr/local,
  and snapd's, deduped by desktop id in XDG precedence order (user first);
  flatpak `@@u %U @@` exec wrappers are stripped with the bare field codes.
  The ssh transports spawn with piped stdio + a ~2.5s earlyWatch window:
  an app that exits inside it gets judged — Chromium-family singleton
  delegation ("Opening in existing browser session" → the window went to a
  copy already running in the guest's own session, NOT the host) becomes
  AppLaunch.warning (cli warn: / UI done-status); a nonzero exit throws
  WaypipeError. Survivors get drain-noop'd pipes + unref (a full pipe
  buffer would stall the ssh channel's flow control).
- `libraries/app-shell` — UI: zustand store, CruiserService, screens markup.
  Screen split: the vm detail screen owns everything that acts IMMEDIATELY
  (lifecycle buttons, shares add/remove/toggle, portable-config
  export/push/pull, snapshots — all call saveSpec directly); the create
  wizard's edit mode owns only fields buffered into Save (description,
  resources, display, persist, sync channels, usb). Don't render
  instant-effect widgets inside the Save-gated form.
  Every `<input data-field="x">` gets a ✕ clear chip via
  `withClearButtons` in screens.ts — a regex wrap applied in
  renderRouteParts to BOTH content markup and the regions/rowGroup patch
  surface (one without the other strips chips on the first same-route
  patch). The shell's `clear-field` action routes by field name exactly
  like wireInputs (log-*/share-*/fwd-*/vm-desc/vm-filter/unlock-pw/
  memInput/create) then attr-mutates value="" so the box empties even
  while the press gate holds the notify render; numeric fields clear to
  0 like keyboard-clearing does.
  `metrics.ts` — the running-VM sparklines (cpu/mem %; disk iops via QMP
  query-blockstats — no agent needed; net bytes/s via QGA /proc/net/dev;
  gpu util+mem via host `/proc/<qemu>/fdinfo` DRM client stats, absent in
  software mode). Rate sparks (disk/net) auto-scale bars to the window max.
  CruiserService.run() locks per-VM (`busyVms`) when opts.vm is set — ops on
  different VMs overlap; the global `busy` flag only covers VM-agnostic
  actions (create/import/doctor).
  The detail screen's `login` row shows the password masked until "show"
  (`vm-pw` action → `svc.togglePassword` → `rdpPassword()`) — the plaintext
  sits in `store.pwReveal` (VM-keyed, cleared on setRoute), never in
  VmSummary where it'd be re-read every 3s poll.
  `ansi.ts` — the log pane's escape renderer: `store.logs.text` keeps the
  RAW bytes (no stripping in service.refreshLogs — serial + journal text
  both carry ANSI), `logPaneInner` converts at render time. Full SGR —
  16/256/truecolor, bold→bright incl. default-fg→bright-white, italic,
  underline styles via 4:n (+58 color), strike, overline, inverse (swaps
  the defaults too), conceal, framed, faint (flattened toward bg, no
  opacity — same subpixel reason as .opt.dim); blink accepted but static.
  OSC 8 → spans with data-action="log-url" → svc.openUrl (http(s)-only —
  log text is guest-influenced, same posture as the guest urlopen shim).
  DEC charset "0" maps to box-drawing Unicode (G0–G3 + SO/SI/LS/SS); all
  other CSI/OSC/DCS and C0s drop. The palette borrows app colors and the
  defaults key off .logpre's #c8d2e0/#0b0e13 — if the pane theme changes,
  re-key FG/BG.
  `term/` — the embedded guest terminal (Term button / `vm-term` action,
  route "term"). Chain: `term-dd` (Rust PTY proxy, `ssh -tt` over the
  hostfwd + cruiser key) ↔ length-prefixed stdio frames
  (`term/framing.ts` ⇄ `term-dd/src/framing.rs` — tags shared by
  direction: 0x01 DATA, 0x02 RESIZE/EXIT, 0x03 KILL/ERR) ↔ `TermSession`
  ↔ the webui JSON bridge ↔ an xterm.js page
  (`term-bundle.gen.ts`, regenerated by `bun run term:bundle` from
  `page-entry.ts`; the committed stub leaves TERM_JS empty so
  termBundleReady() fails closed). The bridge comes from
  `createWebUiHost()` (`@downdraft/platform-native/webui/webui-host`)
  directly — cruiser never sets createNativeHost's top-level `appId`, so
  `globalThis.downdraft` is NEVER installed here (window.appId is only the
  X11/Wayland app-id; appId gates the whole bridge incl. MCP/saves/
  single-instance — enabling it is a deliberate choice, not free).
  `TermView` composites the view via
  WebUiTextureSource+PanelBlitPass over the `#termbox` rect (doc px ×
  CRUISER_UI_ZOOM → buffer px) and grabs input on the bus at −20 (below
  html-ui's −10). The composite rect MUST be integer buffer px (snapRect
  in term-view.ts + the same edge-rounding in termRect) — PanelBlitPass
  samples linearly, so a fractional origin/span puts every screen pixel
  between texels and smears all text (the "blurry terminal" bug); the
  view rasters at scale=1 so texel:pixel must be exactly 1:1. The page's
  fontSize is passed as 13×zoom physical px so term text tracks the
  doc's zoomed type size. `TermManager` keeps per-VM {session, view} alive across
  routes; `svc.term()` falls back to `openHostTerm` (host-int's
  `termemu.ts` DE-aware emulator probe) when the webui backend or term-dd
  is missing. The session spawns term-dd with TERM=xterm-256color
  (inherited into the PTY child — portable-pty starts env-empty; ssh
  forwards TERM to the guest — without it readline degrades to
  dumb-terminal behavior, e.g. Ctrl+L emits a bare \x0c).
  `CRUISER_TERM_LOCAL=1` makes the session spawn `bash -l`
  instead of ssh (dev-harness/screenshot path; works with CRUISER_FAKE_VM
  + CRUISER_ROUTE=term). `vm ssh`/`vm term` in the CLI share the same
  `vm-core/src/ssh.ts` sshArgv builder.
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
- `term-dd/` — Rust PTY-proxy helper (portable-pty): framed mode for the
  embedded terminal, `--raw-tty` mode for a controlling-terminal bridge.
  `bun run term-dd:stage` (toolchain/stage-term-dd.mts) →
  `cargo build --release --locked` + `native/dist/<plat>-<arch>/term-dd`;
  host-int's `termDdPath()` probes PATH → packaged `<appdir>/native/` →
  repo `term-dd/target/{release,debug}` — same convention as viewer-dd.
- `toolchain/` — versions.json pins + build.mts (fetch/build into `opt/`).
- `src-tarballs/` — adopted/downloaded source trees (gitignored, may be
  symlinks into ~/devvm/src).
  **Local QEMU patch**: tracked at
  `toolchain/patches/qemu-11.1.1-dbus-refresh-10ms.patch` and applied
  idempotently by `build.mts` (versions.json `patches:` per component;
  forward-applies, detects already-applied, hard-fails on drift so a tarball
  re-extract can't silently drop it). It calls
  `qemu_console_listener_set_refresh(&ddl->dcl, 10)` in `ui/dbus-listener.c`
  after `qemu_console_register_listener` — upstream dbus listeners are
  pinned to GUI_REFRESH_INTERVAL_DEFAULT (30ms ≈ 33fps), which caps the
  dmabuf viewer at ~33fps; 10ms lifts the cap to ~100fps. Rebuild:
  `ninja -C ~/devvm/src/qemu-11.1.1/build qemu-system-x86_64 && ninja -C ...
  install`.

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
  `probeRdp()` reads the nego response during the liveness wait and
  `freerdpArgs` passes `/sec:tls`. KRDP is also fragile to connection
  churn: a probe/failed attempt's session teardown ("Unable to check file
  descriptor" → "Closing session") can race the NEXT connection's portal
  start — xdg-desktop-portal-kde closes the RemoteDesktop session and the
  client dies `ERRINFO_LOGOFF_BY_USER` (exit 12). So: ONE merged
  liveness+TLS probe (no separate `rdpTlsOnly`), and `ViewerSession` retries
  a pre-window exit up to 3 attempts with a 1.5s settle delay.
  KRDP also requires client-side H.264 (RDPGFX AVC420/444): distro freerdp3
  builds `WITH_GFX_H264=OFF` — use `opt/freerdp` (toolchain cmake build,
  ffmpeg backend); `freerdpSupportsH264` gates and `launchFreerdp` throws a
  clear error for KDE guests without it.
  KWallet on Plasma ≥6.5: `ksecretd` is the daemon — it owns
  org.freedesktop.secrets + secretservicecompat + the kwallet portal backend,
  and stores wallets under `~/.local/share/kwalletd/` (NOT kwallets/).
  "Cannot create wallet save location!" = it can't mkpath that dir —
  check ~{,.local,.local/share} ownership: any `mkdir -p` under $UHOME run
  as root (krdpserver dir, share mountpoints, clipbridge, wallpaper) strands
  intermediates root-owned. All such mkdirs must `runuser -u "$U" --`.
  Autologin: pam_kwallet5 gets an empty authtok and does NOTHING
  ("Empty or missing password, doing nothing" → no wallet, first access
  pops the new-wallet wizard). Fix = wallet created with EMPTY password —
  ksecretd's internalOpen tries `open("")` before prompting, so it then
  auto-unlocks silently forever. `provision/src/keyrings.ts` seeds it at
  guest-setup (KDE+autologin only): dbus pamOpen is a no-op on running
  daemons, so the script replays the real handshake — 56 random bytes to
  `kwalletd/kdewallet.salt`, spawn `ksecretd --pam-login <pipefd>
  <sockfd>` with PAM_KWALLET5_LOGIN set, write
  `pbkdf2_hmac("sha512", b"", salt, 50000, 56)` to the pipe, dump `env`
  to the unix socket (that's all pam_kwallet_init does). pamOpen hash
  MUST be 56 bytes (PBKDF2) — it rejects other sizes silently.
  GNOME equivalent (autologin): gkr-pam can't unlock either, and
  `gnome-keyring-daemon --login/--unlock` refuse an empty stdin password
  while CreateCollection goes through gcr-prompter — but a blank-password
  keyring is a plaintext GKeyFile (`[keyring]` group, display-name/
  ctime/mtime/lock-* keys — gkm-secret-textual.c), so keyrings.ts seeds an
  empty `~/.local/share/keyrings/login.keyring` and restarts the daemon.
  NOTE: blank password = secrets stored in plaintext on disk — inherent
  to zero-touch autologin on both desktops (the KDE empty-password wallet
  is equivalent).
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
  is listening in the guest — `probeRdp` sends an X.224 negotiation probe
  instead of a bare connect, or a cold boot launches freerdp into a dead
  forward. The same probe offers TLS|HYBRID and parses the response, so the
  security layer comes free on the same connection.
- `kwriteconfig5` can't read (value arg is mandatory — it prints usage, which
  then gets captured as the "previous" value and written back). Read via
  `kreadconfig` first; `kwriteconfig6` reads fine.
- gdm3 ships `# AutomaticLoginEnable = true` as a comment in custom.conf —
  idempotency greps for appended config must anchor to `^Key=` or they
  match the stock comment and never write.
- DownDraft fixes go to the sibling engine checkout (`../downdraft-engine`/
  `../downdraft`, linked by `scripts/link-engine.mjs`) and are committed there.
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
  `ctrl+super+end → command:{cli} vm kill {vm}`.
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
  the engine repo) = display px per CSS px — the UI scale knob; pointer
  input is converted automatically. Cruiser mounts zoom≈1.25 + scale=1
  (native-res raster, CRUISER_UI_ZOOM/CRUISER_UI_SCALE env knobs). The OSR
  cdylib embeds only DejaVu Sans; real system fonts are bound via
  `registerResource` (ui:// blobs) + `@font-face` — see
  `libraries/app-shell/src/fonts.ts`. Call before mount so the first doc
  resolve sees them.

## Host GPU / driver pitfalls

Observed on a hybrid Intel Iris Xe (i915) + NVIDIA MX550 laptop (KDE neon /
Ubuntu 24.04) — applies to any dual-GPU host:

- Debug order for "graphics problem": `nvidia-smi` FIRST — a
  "Driver/library version mismatch" means apt bumped NVIDIA userspace
  without a reboot (kernel still runs the old module): Vulkan/EGL can't
  touch the dGPU at all and wgpu silently lands on the iGPU. DKMS already
  builds for the running kernel, so a reboot is the whole fix. Then
  `vulkaninfo --summary`, `vkcube --gpu_number N` per adapter, and
  `dmesg | grep "GPU HANG"` for i915.
- i915/ANV hard hang: kernel 6.11.0-29 + Mesa 25.2.8 (noble HWE) GPU-hangs
  on ANY Vulkan submit (`i915 GPU HANG: ecode 12:1:e75ffefe` + context
  reset) — vulkaninfo, vkcube, even Vivaldi/Chrome trip it, so it is never
  our app. `i915.enable_guc=0` does NOT fix it. Mesa GL/EGL is unaffected:
  virgl guests (`virtio-vga-gl` + `-spice gl=on,rendernode=…`) still work —
  look for `egl_dmabuf_export_texture` in run/qemu.log. Only Vulkan is
  toxic: the wgpu host app when it picks Intel, and `venus` guests.
  Mitigate: let `power_preference:high-performance` pick the dGPU, pin Mesa
  back to 25.0.x, or boot the 6.8 GA kernel.
- There is NO software fallback: lavapipe
  (`VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json`) creates a wgpu
  adapter+device but the window surface reports zero usable formats on
  BOTH Wayland and X11. `MESA_VK_DEVICE_SELECT` doesn't filter either, and
  the engine's wgpu shim only exposes `power_preference` — no adapter-name
  env override exists.
- `pickRenderNode` intentionally routes virgl guests to the i915 rendernode
  (NVIDIA's EGL dmabuf path is excluded by design). So on a broken-i915
  hybrid box the split is: dGPU for the app window's Vulkan, i915 GL for
  guest display — both have to be healthy for their own API.
- Venus exposes EVERY host VkPhysicalDevice to the guest — including
  lavapipe. A guest app asking wgpu for the fallback adapter
  (`DOWNDRAFT_GPU=swiftshader` on the dd native runtime) rasterizes on host
  CPU inside a `virgl-<ctx>-gpu_re` fork of virgl_render_server (llvmpip*
  threads, ~1-2 cores each). spec.gpu.softwareVk controls it: off
  (default) → buildArgs sets `VK_LOADER_DRIVERS_DISABLE=*lvp*` so host
  lvp is hidden; the guest's own lavapipe ICD still exists as a fallback.
  Diagnose from the host: `top -H` on the render server — busy llvmpip*
  threads = lavapipe, `[vkps]`/`[vkrt]` = NVIDIA driver threads. Guest
  override without a VM restart: relaunch the app without DOWNDRAFT_GPU /
  with `DOWNDRAFT_GPU=hardware` (+ `MESA_VK_DEVICE_SELECT=<ven:dev>` to pin).
- NVIDIA Venus CAN kill QEMU: devinbox (RTX 3090 + Raphael iGPU host)
  SEGV'd QEMU 11.1.1 after a guest wgpu app flooded `ctrl 0x208 error
  0x1200` submit failures — ~15k `virtio_gpu_virgl_process_cmd` rejects
  then a hard SEGV (coredumpctl). A lighter guest app ran clean on the
  same NVIDIA context, so it's load/pattern-dependent — treat
  NVIDIA-under-venus as flaky, RADV (renderD129) as the reliable device.
  The matching pre-crash symptom in run/qemu.log is a repeating
  `vkr: failed to look up object → vkFreeMemory CS error → fatal decoder
  state → destroying context N (wgpu)` loop (the 0x1200 = ERR_UNSPEC and
  also fires on lavapipe contexts — the destroy loop predates this).
- Qt6-only hosts: noble has no `qdbus` binary — `qt6-tools-dev-tools`
  ships `qdbus6`. Doctor and `host-int/kde.ts` probe `qdbus6` first, then
  `qdbus`; don't gate on the Qt5 name.
- Shipping the `opt/` toolchain to a same-family host works (34M tar), but
  watch runtime deps: `libcapstone.so.4` and versioned
  `SPICE_SERVER_0.16` symbols were missing on noble. `resolve.ts`'s
  `ldLibraryPath` already covers `opt/{virglrenderer,spice}/lib/
  x86_64-linux-gnu` — drop stray .so's in there rather than installing
  system packages.
- GNOME Remote Desktop severs clients every time the session idles/locks.
  Headless unlock: `gdbus call --session -d org.gnome.ScreenSaver
  -o /org/gnome/ScreenSaver -m org.gnome.ScreenSaver.SetActive false`
  with `XDG_RUNTIME_DIR`+`DBUS_SESSION_BUS_ADDRESS` set. Xwayland windows
  need `XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth*` to be
  wmctrl-visible from ssh.
