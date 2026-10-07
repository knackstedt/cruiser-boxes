# DE / session capability matrix

| capability | kde-x11 | kde-wayland | gnome-x11 | gnome-wayland | other X11 (EWMH) |
|---|---|---|---|---|---|
| monitor probe | xrandr ✅ | ⚠️ kscreen dbus (TODO) | xrandr ✅ | ❌ | xrandr ✅ |
| virtual desktops | qdbus VirtualDesktopManager ✅ (UUIDs+names+current) | same ✅ | wmctrl -d ✅ | ❌ | wmctrl -d ✅ |
| find window | xdotool/wmctrl by pid ✅ | ⚠️ KWin script (partial) | xdotool ✅ | ❌ | xdotool ✅ |
| move to desktop | wmctrl -t ✅ | ⚠️ KWin script | wmctrl -t ✅ | ❌ | wmctrl -t ✅ |
| fullscreen | wmctrl -b ✅ | ⚠️ KWin script | wmctrl -b ✅ | ❌ | wmctrl -b ✅ |
| escape shortcuts | kglobalshortcutsrc + KWin reconfigure ✅ | same ✅ | gsettings wm.keybindings ✅ | ❌ needs extension | ❌ |

## Verified live (this host: KDE/X11, KWin X11, 4 desktops, 3 monitors)

- `host monitors` → xrandr parses DP-4/DP-0/HDMI-1 with exact geometry
- `host desktops` → qdbus returns real UUIDs (matches devvm kwinrulesrc)
- freerdp window found by pid, moved to desktop 3, fullscreened

## Gaps & plan

- **kde-wayland**: desktops+shortcuts work over dbus; window find/move needs
  the temporary-KWin-script path finished (currently partial — window ops
  are stubs that delegate to KWin scripts). Practically: `virtual-desktop`
  mode works if a KWin rule places the window (rules fire at map time).
- **gnome-wayland**: mutter exposes no placement API. The planned path is a
  tiny companion GNOME Shell extension (`org.cruiser.dbus` exposing
  list/move/fullscreen/current-desktop) — install once per user. Until
  then, `windowed` mode still works (the viewer places itself).
- **escape shortcuts** only function when the viewer runs `-grab-keyboard`
  (host keeps the combos). With `+grab-keyboard` set, install is skipped.
