// ============================================================================
// monitors.ts — host monitor topology → guest GPU outputs + monitors.xml.
//
// The guest sees virtio-gpu "Virtual-N" connectors; we mirror the HOST's
// physical layout (same x/y/w/h) so gnome-remote-desktop multi-monitor RDP
// maps 1:1 onto the host screens. Ported from devvm's hand-written xml.
// ============================================================================

import type { MonitorInfo } from "../../host-int/src/types";
import type { GuestMonitor } from "../../vm-core/src/qemu/args";

export interface GuestLayout {
    /** gpu outputs[] entries for the QEMU argv builder. */
    monitors: GuestMonitor[];
    /** monitors.xml content for ~/.config/monitors.xml in the guest. */
    xml: string;
}

/** Escape xml attr text. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * Build the guest layout mirroring `host` monitors (in xrandr order).
 * Caps count at maxOutputs (virtio-gpu limit ~4 on the paths we use).
 */
export function guestLayoutFromHost(vmName: string, host: MonitorInfo[], maxOutputs = 4): GuestLayout {
    const mons = host.slice(0, maxOutputs);
    if (!mons.length) mons.push({ name: "Virtual-1", x: 0, y: 0, w: 1920, h: 1080, primary: true });

    const monitors: GuestMonitor[] = mons.map((m, i) => ({
        name: `${vmName}-${i + 1}`,
        xres: m.w,
        yres: m.h,
    }));

    const logical = mons.map((m, i) => `    <logicalmonitor>
      <x>${m.x}</x>
      <y>${m.y}</y>
      <scale>1</scale>${m.primary ? "\n      <primary>yes</primary>" : ""}
      <monitor>
        <monitorspec>
          <connector>Virtual-${i + 1}</connector>
          <vendor>RHT</vendor>
          <product>${esc(vmName)}-${i + 1}</product>
          <serial>0x00000000</serial>
        </monitorspec>
        <mode>
          <width>${m.w}</width>
          <height>${m.h}</height>
          <rate>60.000</rate>
        </mode>
      </monitor>
    </logicalmonitor>`).join("\n");

    return {
        monitors,
        xml: `<monitors version="2">
  <configuration>
    <layoutmode>physical</layoutmode>
${logical}
  </configuration>
</monitors>
`,
    };
}
