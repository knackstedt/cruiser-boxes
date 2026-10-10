---
title: Rendering futures
description: Design note — candidate paths to fewer copies than FreeRDP.
---

## Today's path (baseline)

guest virtio-gpu → gnome-remote-desktop (grd) encodes RDP → QEMU user-net
hostfwd TCP → xfreerdp3 client → X11 window.

Copies/cost: grd captures the guest framebuffer → encodes (H.264/RFX) →
tcp → freerdp decodes → XImage/GL upload → X11 composite. Works, but it's
a video stream: encode/decode latency + artifacts + CPU burn on both sides.

## Candidate directions (ordered by payoff/effort)

### 1. IronRDP → napi-rs → wgpu (the planned investigation)

Replace xfreerdp's X11 window with an in-process RDP client rendered
straight into the app surface:

- `IronRDP` (Rust, maintained) does the RPD decode; exposes pixel buffers.
- napi-rs binding → an `RdpClient` node addon living in this repo
  (`native/rdp-client/`) — no C/C++, consistent with house rules.
- Upload decoded frames as wgpu textures → the app composites into its own
  surface (fullscreen-monitor mode becomes a real app window, chrome and
  RDP in one compositor).

Saves the X11 round-trip, gives us control of frame pacing vsync-aligned
with the host, and unlocks per-region updates. Still a video codec on the
wire — the encode copy remains.

### 2. virtio-gpu shared texture (the "zero-copy" endgame)

Venus already maps guest Vulkan onto host Vulkan via virglrenderer. A
custom display channel (not RDP, not SPICE's display) could export guest
dmabufs directly: QEMU virtio-gpu blob resources are already host-accessible
GL/Vulkan objects. A SPICE-display-channel client or bespoke QMP-driven
path could hand those fds to our wgpu surface — true zero-copy fullscreen.

Requires: either a Rust SPICE display client (no good crate exists —
`spice-client` is C/gtk), or a custom virtserialport protocol +
gnome-shell/mutter cooperation in the guest. Research-grade, but it's the
right end-state for "virtual desktop" mode.

### 3. waypipe for desktops

waypipe already gives per-app zero-ish-copy via dmabuf when the guest and
host share a compatible GPU/driver. A whole-session waypipe (weston-headless
or cage in the guest forwarding the full session) is possible but waypipe
is optimized for single apps; multi-window session forwarding hits edge
cases. Keep for app-mode, don't stretch it into a desktop transport.

## Short-term wins available now

- `xfreerdp3 /gfx:avc444` or `/gfx-h264` — H.264 on the wire if the guest
  grd build supports it (needs `libx264`/openh264 in guest).
- `/network:lan` + `-grab-keyboard` tuning.
- RDP8GFX progressive codec settings in grd.
