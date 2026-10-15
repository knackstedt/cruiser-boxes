// ============================================================================
// monitors.ts — host monitor topology → guest GPU outputs + monitors.xml.
//
// The guest sees virtio-gpu "Virtual-N" connectors; we mirror the HOST's
// physical layout (same x/y/w/h) so gnome-remote-desktop multi-monitor RDP
// maps 1:1 onto the host screens. Ported from devvm's hand-written xml.
// ============================================================================

import type { MonitorInfo } from "../../host-int/src/types";
import type { GuestMonitor } from "../../vm-core/src/qemu/args";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { detectAdapter } from "../../host-int/src/detect";

export interface GuestLayout {
    /** gpu outputs[] entries for the QEMU argv builder. */
    monitors: GuestMonitor[];
    /** monitors.xml content for ~/.config/monitors.xml in the guest. */
    xml: string;
}

/** Escape xml attr text. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * Guest virtio-gpu outputs[] for a spec — the host monitors selected by
 * spec.display.monitors ("all" or a name list), mirrored into the guest so
 * it gets one head per selected host display (dmabuf spawns one window per
 * console; RDP viewers use them via /multimon). Best-effort: headless hosts
 * or a failed probe yield undefined → buildArgs' single 1920x1080 output.
 *
 * This lives in provision (not vm-core's args builder) deliberately: the
 * argv builder stays free of host-int so headless/CLI use never touches the
 * display stack. Callers of h.start()/buildArgv() pass it via guestMonitors.
 */
export async function hostMirroredGuestMonitors(spec: VmSpec): Promise<GuestMonitor[] | undefined> {
    const host = await detectAdapter().monitors().catch(() => [] as MonitorInfo[]);
    const sel = spec.display.monitors;
    const picked = sel === "all" ? host : host.filter((m) => sel.includes(m.name));
    return picked.length ? guestLayoutFromHost(spec.name, picked).monitors : undefined;
}

/**
 * Build the guest layout mirroring `host` monitors (in xrandr order).
 * Caps count at maxOutputs (virtio-gpu limit ~4 on the paths we use).
 */
export function guestLayoutFromHost(vmName: string, host: MonitorInfo[], maxOutputs = 4): GuestLayout {
    const mons = host.slice(0, maxOutputs);
    if (!mons.length) mons.push({ name: "Virtual-1", x: 0, y: 0, w: 1920, h: 1080, primary: true });

    const monitors: GuestMonitor[] = mons.map((m, i) => {
        // QEMU rejects virtio output names > 12 chars — truncate the vm
        // part to fit the -N suffix. Cosmetic label only: guest connectors
        // stay Virtual-N and nothing keys on this string.
        const suffix = `-${i + 1}`;
        return { name: `${vmName.slice(0, 12 - suffix.length)}${suffix}`, xres: m.w, yres: m.h };
    });

    const logical = mons.map((m, i) => `    <logicalmonitor>
      <x>${m.x}</x>
      <y>${m.y}</y>
      <scale>${m.scale ?? 1}</scale>${m.primary ? "\n      <primary>yes</primary>" : ""}
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
          <rate>${(m.refresh ?? 60).toFixed(3)}</rate>
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
