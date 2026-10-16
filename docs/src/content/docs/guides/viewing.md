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

`display.escapeShortcuts` installs *host* keybindings that fire while the
viewer is focused — e.g. the default `ctrl+super+f1 → host-desktop:1`
jumps you back to host desktop 1 instead of sending the combo to the guest.

Actions: `host-desktop:<n>`, `desktop-cycle-left`, `desktop-cycle-right`,
`ungrab`, `none`, `command:<cmdline>` — arbitrary host command via `sh -c`
(`{vm}`/`{cli}` placeholders expand at install). The default
`ctrl+super+end → command:{cli} vm kill {vm}` is the escape hatch for a
hung guest.

The bindings fire anywhere on the host while the viewer runs — in the VM
or in any other app. On the dmabuf viewer, `viewer-dd` itself grabs each
combo globally (X11 passive grabs) and dispatches the action host-side,
so they work regardless of focus or `grabKeyboard`. On freerdp they're
installed as host-WM global shortcuts; under `+grab-keyboard` they're
swallowed while the window is focused but work from anywhere else. Pick
combos the host doesn't bind: if a combo ever leaks through, it hits the
host's own shortcuts.

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
