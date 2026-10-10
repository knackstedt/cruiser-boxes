---
title: VFIO design note
description: PCIe passthrough as a future GPU mode — what it would take and why it's deferred.
---

:::note[Not implemented]
This is a design note. GPU (and eventually other PCIe device) passthrough
is deliberately out of the initial build — it's the highest-risk feature
(can wedge the host GPU driver) and the Venus path covers the perf story
for most workloads.
:::

## Scope

GPU passthrough as a selectable GPU mode alongside venus/virgl/software.

## What it would take

1. **IOMMU groups + binding**: enumerate `/sys/kernel/iommu_groups/*/devices`,
   group the GPU + its audio function, unbind host drivers, `vfio-pci` bind.
   Needs root at bind time — a setuid helper or a one-time udev/driverctl
   config rather than running cruiser as root.
2. **QEMU args**: `-device vfio-pci,host=BB:DD.F` (+ the audio function),
   `-machine q35` already ok, may need `x-vga=on` for boot-display cards,
   ROM bar fixups on some NVIDIA cards. QEMU needs `CAP_SYS_ADMIN` for
   `/dev/vfio` — or file perms via udev rule.
3. **Display**: passthrough means the guest GPU drives a physical output or
   needs looking-glass for host-composited output. RDP still works (guest
   runs gnome-remote-desktop regardless) — Venus mode remains the
   single-monitor host-integrated path; VFIO is for real-display/VR/GPU-work.
4. **UX**: `gpu.mode: "vfio"` + `gpu.vfioPci: "0000:0b:00.0"`; doctor gains
   an IOMMU/`vfio` check; a one-time host setup command (`cruiser vfio
   prepare <pciid>`) writing driverctl overrides.

## Hazards

- Host loses the card while bound (the dev box's display is on it).
- NVIDIA vfio quirks (error 43 workarounds are mostly history, but code
  paths differ per vendor).
- Suspend/resume + reset bugs are card-specific.

Ship it after venus, waypipe, and provisioning are battle-tested.
