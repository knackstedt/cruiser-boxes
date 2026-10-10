---
title: Environment variables
description: Every CRUISER_*/XDG_* knob the app and CLI honor.
---

## Runtime

| Variable | Default | Effect |
|---|---|---|
| `CRUISER_OPT` | `<repo>/opt` | where the pinned toolchain binaries resolve from |
| `CRUISER_THEME_SYNC` | on | `0` disables both the provision-time theme bake and live host→guest dark/light sync |
| `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` | freedesktop defaults | relocate `~/.config/cruiser`, `~/.local/share/cruiser` (VMs, ISOs, mounts), `~/.cache/cruiser` (cloud images) respectively |

## UI tuning

| Variable | Default | Effect |
|---|---|---|
| `CRUISER_UI_BACKEND` | `worker` | `local` forces the in-process doc backend (worker rasterizes off the main thread so repaints don't starve input) |
| `CRUISER_UI_ZOOM` | `1.25` | UI scale — display px per CSS px |
| `CRUISER_UI_SCALE` | `1` | raster supersample — px per display px (2 = smooth-but-soft) |
| `CRUISER_SMOOTH_WHEEL` | on | `0` disables frame-cadence wheel easing |
| `DD_STARTUP_PROFILE` | off | `1` prints `[startup] label t=Nms` boot timing marks |

## Dev/screenshot harness

Used by the headless-ish UI smoke harness (`src/native-entry.ts`; still
needs a GPU + display — it captures the real window surface):

| Variable | Effect |
|---|---|
| `CRUISER_SMOKE_MS` | auto-exit after N ms (no window close needed) |
| `CRUISER_SCREENSHOT` | capture the surface to this path |
| `CRUISER_SHOT_FRAMES` | frames to wait before the capture (default ~30) |
| `CRUISER_ROUTE` | preselect a route: `create` · `vm` · `settings` · `logs` |
| `CRUISER_VM` | VM selected for `vm`/`logs` routes (default `test1`) |
| `CRUISER_LOG_SOURCE` / `CRUISER_LOG_FILE` | preselect the Logs screen source/file |
| `CRUISER_FAKE_BUSY` | fake a busy-state spinner on the create route (seconds) |

Example:

```sh
CRUISER_SMOKE_MS=8000 CRUISER_SCREENSHOT=/var/tmp/create.png \
  CRUISER_SHOT_FRAMES=20 CRUISER_ROUTE=create \
  bun run src/native-entry.ts
```
