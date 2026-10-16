---
title: Viewing & head modes
description: The xfreerdp viewer, the four head modes, window placement, escape shortcuts, and theme sync.
---

Cruiser's viewer is `xfreerdp3` against the guest's own RDP server
(gnome-remote-desktop in system mode, or KRDP on Plasma 6), reached through
a QEMU `hostfwd` TCP forward — the guest never needs a real network
identity.

```sh
bun run cli -- vm start myvm          # boot + wait for RDP + open viewer (held)
bun run cli -- vm start myvm --no-view
bun run cli -- vm view myvm           # viewer only, VM already running
```

`vm start`/`vm view` **hold the process until the viewer closes** — the
escape-shortcut uninstallers only run in-process, so exiting after `open()`
would orphan the host keybinding edits. `ctrl+c` closes the viewer cleanly.

The RDP wait isn't a bare TCP connect: slirp's hostfwd completes the
handshake host-side even when nothing listens in the guest, so the viewer
probes with an X.224 negotiation request — otherwise a cold boot launches
freerdp into a dead forward.

## Head modes

`display.headMode` (set at create, overridable per-run with `--mode`):

| Mode | freerdp flags | Placement |
|---|---|---|
| `fullscreen-monitor` | `/f` + `/multimon` (or `/monitor:name`) | `WmAdapter.moveToMonitor` + fullscreen; `display.sticky` shows it on all desktops |
| `virtual-desktop` | `/f` | moved to `display.virtualDesktop`, then fullscreened |
| `windowed` | `/size:WxH` from `display.windowSize` | none — normal window |
| `app` | — | no viewer; see [app mode](/guides/app-mode/) |

Related spec fields: `display.monitors` (`"all"` = `/multimon`, else a list
of monitor names for `/monitor:`), `display.sticky`,
`display.virtualDesktop`, `display.windowSize`, `display.dynamicResolution`,
`display.sound`, `display.microphone`, `display.clipboard`.

## Window placement (WmAdapter)

`host-int` ships per-DE adapters — `host session` reports which is active:

- **kde-x11** — full: xrandr monitor probe, qdbus virtual desktops,
  wmctrl/xdotool find/move/fullscreen, kglobalshortcutsrc escape shortcuts.
- **kde-wayland** — partial: desktops/shortcuts over dbus; window ops go
  through temporary KWin scripts.
- **gnome-x11** — wmctrl/xdotool placement, gsettings escape shortcuts.
- **gnome-wayland** — stub (mutter exposes no placement API; a companion
  GNOME Shell extension is the planned path). `windowed` mode still works.

Anything else gets generic EWMH (wmctrl/xdotool) where available. See the
[capability matrix](/internals/de-matrix/).

:::note[KWin fullscreen quirk]
KWin collapses multi-monitor fullscreen to the single containing monitor
when a window moves desktops. The adapter re-toggles fullscreen (off/on,
off-screen) whenever `_NET_WM_FULLSCREEN_MONITORS` is set so the freerdp
`/multimon` span is re-read — and `x11SetFullscreen` is ensure-only because
a redundant `add,fullscreen` triggers the same collapse.
:::

## Escape shortcuts

`display.escapeShortcuts` defines combos that fire while the viewer runs —
e.g. the default `ctrl+super+f1 → host-desktop:1` jumps you back to host
desktop 1 instead of sending the combo to the guest.

Actions: `host-desktop:<n>`, `desktop-cycle-left`, `desktop-cycle-right`,
`ungrab` (release the input grab until refocus), `abort` (release grabs +
minimize every viewer head — the panic combo), `kwin:<action name>`
(invoke a named kglobalaccel action on the kwin component — the same entry
point the host's own binding calls), `none` (swallow), and
`command:<cmdline>` — arbitrary host command via `sh -c` (`{vm}`/`{cli}`
placeholders expand at install).

The defaults keep every combo host-inert (`ctrl+super+FN` is unbound in
KDE — a leaked combo is a no-op, unlike `ctrl+alt+delete` which hits
ksmserver's logout):

| keys | action |
| --- | --- |
| `ctrl+super+f1…f4` | `host-desktop:1…4` |
| `ctrl+super+f5` | `command:{cli} vm reboot {vm}` |
| `ctrl+super+f6` | `command:{cli} vm suspend {vm}` |
| `ctrl+super+f7` | `command:{cli} vm resume {vm}` |
| `ctrl+super+f8` | `command:{cli} vm stop {vm}` |
| `ctrl+super+escape` | `abort` |
| `ctrl+super+end` | `command:{cli} vm kill {vm}` — escape hatch for a hung guest |

How they fire depends on the viewer:

- **dmabuf (`viewer-dd`)** — the viewer X11-passive-grabs each combo on the
  root window itself (with lock-state variants) and dispatches the action
  in-process, so they work while unfocused, focused-but-ungrabbed, *and*
  under `--grab`. `command:` actions are *additionally* installed into the
  host's real shortcut daemon (kglobalaccel `[services]`/khotkeys on KDE,
  gsettings media-keys on GNOME) so they appear in the host's shortcut UI.
  Only `command:` goes daemon-side for dmabuf — VD nav mirrors your own
  bindings (below) and `ungrab`/`abort`/`kwin:` are viewer-internal
  dispatches.
- **freerdp** — the whole list installs as host-WM global shortcuts
  (kglobalshortcutsrc / gsettings); under `+grab-keyboard` they're
  swallowed while the window is focused but work from anywhere else.

**Your real VD-switch keys keep working.** Before launching a dmabuf
session Cruiser reads the host's *existing* desktop-switch bindings —
`[kwin]` rows out of `kglobalshortcutsrc` on KDE, `org.gnome.desktop
.wm.keybindings` `switch-to-workspace-*` on GNOME — and hands them to
viewer-dd as `kwin:<action name>` escapes. While the viewer's grab blinds
kglobalaccel, the viewer invokes the same `invokeShortcut` entry point the
dead binding would have hit. Spec entries win on a key conflict; the
mirror never rewrites your bindings (kglobalacceld flushes in-memory state
over file edits anyway).

**Input grabs are focus-scoped.** viewer-dd only holds the keyboard
(XGrabKeyboard) and pointer (XGrabPointer) while a head is focused —
unfocus and both release, so the VM never eats host input. The pointer
grab is what defeats KWin's Super+drag window-move: that's a passive
*button* grab, which a keyboard grab alone can't shadow — an *active*
pointer grab beats every passive grab on the device. Both grabs run
Async device modes: an active Sync grab freezes the device on the first
event and queues it undelivered (the frozen-delivery contract exists
only for passive grab activation). An in-window click is forwarded to
the guest; a click outside drops the pointer grab and re-injects the
press through XTEST, so the host sees a normal click — focus moves and
WM passive grabs fire as usual.

**Panic exits** — if input ever wedges, in order of escalation: click
another window (grabs release on FocusOut); the `abort` escape
(`ctrl+super+escape` by default); `ctrl+alt+shift+right-click` anywhere
(button events still arrive under the pointer grab even if keys are dead);
`pkill -USR1 -x viewer-dd` from any shell (needs no keys at all); and as
the last resort a VT switch — `Ctrl+Alt+F3` runs below any X grab.
Independently of all that, a continuously held grab self-releases after
60 seconds, so a wedged grab can't strand the host keyboard.

**NumLock** is reconciled between host XKB state and the guest's reported
LED (`Keyboard.Modifiers`) — toggles made while unfocused are caught up by
a poll that debounces around forwarded presses so a host↔guest state lag
can't double-toggle.

## Theme sync

With a viewer session open, Cruiser mirrors the host's dark/light
preference into the guest live:

- Host side: `host-int/appearance.ts` reads `org.freedesktop.appearance
  color-scheme` via the xdg-desktop-portal (busctl, gdbus fallback) and
  watches `SettingChanged` over dbus-monitor.
- Guest side: `ThemeSync` pushes changes via `guestRun` — gsettings
  `color-scheme` for GNOME/GTK, `plasma-apply-colorscheme` for Plasma — for
  the session's lifetime.

The same hint is baked during provisioning so first login is already
themed. Host "no preference" is never pushed; `CRUISER_THEME_SYNC=0`
disables both bake and sync.

## Managed wallpaper + shortcuts cheat sheet

`display.wallpaper` (default `managed: true`) composites a wallpaper
host-side — your `source` image or a generated gradient — with a faint
watermark: the VM name, the live escape shortcuts, and the
`cruiser vm kill <name>` fallback. Watermark ink is picked from the
luminance of the region it lands in (`position`: a corner, `center`, or
`off` to drop the watermark). It's pushed into the guest after provisioning
and re-checked when a viewer session opens — changed inputs re-push, an
in-guest wallpaper change is left alone. The same step writes
`~/Desktop/VM Shortcuts.md` in the guest: every shortcut plus the
host-terminal and TTY escape hatches. `CRUISER_WALLPAPER=0` disables it;
`cruiser vm wallpaper <name> --source PATH --position POS` reconfigures.

## Emergency console

Every VM also exposes a **SPICE unix socket** (`run/spice.sock`) — a
last-resort console if RDP is broken:

```sh
remote-viewer spice+unix://$HOME/.local/share/cruiser/vms/myvm/run/spice.sock
```

## KRDP security note

KRDP offers TLS/RDP security but **not NLA** — never pass `/sec:nla` to
freerdp. Cruiser always uses `/cert:ignore` against the forwarded socket.
