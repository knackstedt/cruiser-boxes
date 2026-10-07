// ============================================================================
// schema.ts — VmSpec: the declarative per-VM contract (vm.json).
// zod-validated; versioned for forward migration.
// ============================================================================

import { z } from "zod";

export const HeadMode = z.enum(["fullscreen-monitor", "windowed", "virtual-desktop", "app"]);
export type HeadMode = z.infer<typeof HeadMode>;

export const GpuMode = z.enum(["venus", "virgl", "software"]);
export type GpuMode = z.infer<typeof GpuMode>;

export const EscapeAction = z.enum([
    "host-desktop",        // host-desktop:<n> — jump host to desktop n
    "desktop-cycle-left",
    "desktop-cycle-right",
    "ungrab",              // release viewer grab (freerdp ctrl+alt style)
    "none",
]);
export type EscapeAction = z.infer<typeof EscapeAction>;

export const EscapeShortcut = z.object({
    keys: z.string(),                    // "ctrl+alt+delete" — normalized lowercase
    action: z.string(),                  // "<action>" or "<action>:<arg>"
});
export type EscapeShortcut = z.infer<typeof EscapeShortcut>;

export const UsbDeviceRef = z.object({
    vendorId: z.string(),                // "046d"
    productId: z.string(),               // "c52b"
    serial: z.string().optional(),
    /** Attach at QEMU launch (vs hotplug-on-demand). */
    atBoot: z.boolean().default(false),
});
export type UsbDeviceRef = z.infer<typeof UsbDeviceRef>;

export const ShareSpec = z.object({
    hostPath: z.string(),
    tag: z.string().default("hostshare"),
    readOnly: z.boolean().default(false),
});
export type ShareSpec = z.infer<typeof ShareSpec>;

export const HostFwd = z.object({
    hostPort: z.number().int(),
    guestPort: z.number().int(),
    proto: z.enum(["tcp", "udp"]).default("tcp"),
});
export type HostFwd = z.infer<typeof HostFwd>;

export const VmSpec = z.object({
    version: z.literal(1).default(1),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),

    resources: z.object({
        cpus: z.number().int().min(1).max(64).default(4),
        sockets: z.number().int().default(1),
        threads: z.number().int().default(1),
        memoryMiB: z.number().int().min(512).default(8192),
    }).prefault({}),

    disk: z.object({
        file: z.string().default("disk.qcow2"),   // relative to vm dir
        sizeGiB: z.number().int().min(4).default(100),
    }).prefault({}),

    gpu: z.object({
        mode: GpuMode.default("venus"),
        /** e.g. /dev/dri/renderD129 — pick the mesa-friendly node (not NVIDIA EGL). */
        renderNode: z.string().optional(),
        /** Venus blob hostmem region MiB (needs >= ~2G for real workloads). */
        hostmemMiB: z.number().int().default(4096),
    }).prefault({}),

    display: z.object({
        headMode: HeadMode.default("virtual-desktop"),
        /** "all" = /multimon; else named monitors for /monitor:<name>. */
        monitors: z.union([z.literal("all"), z.array(z.string())]).default("all"),
        sticky: z.boolean().default(false),       // fullscreen-monitor only: all desktops
        virtualDesktop: z.number().int().min(1).default(2),  // virtual-desktop mode
        windowSize: z.object({ w: z.number().int(), h: z.number().int() }).default({ w: 1600, h: 1000 }),
        escapeShortcuts: z.array(EscapeShortcut).default([
            { keys: "ctrl+alt+delete", action: "host-desktop:1" },
        ]),
        dynamicResolution: z.boolean().default(true),
        sound: z.boolean().default(true),
        microphone: z.boolean().default(true),
        clipboard: z.boolean().default(true),
        grabKeyboard: z.boolean().default(false), // freerdp -grab-keyboard → host shortcuts win
    }).prefault({}),

    usb: z.object({ autoAttach: z.array(UsbDeviceRef).default([]) }).prefault({}),

    shares: z.array(ShareSpec).default([]),

    network: z.object({
        hostfwd: z.array(HostFwd).default([]),
        sshPort: z.number().int().optional(),     // resolved+stored at create
        rdpPort: z.number().int().optional(),
        vsock: z.boolean().default(true),         // vhost-vsock-pci for waypipe
    }).prefault({}),

    /** daemonize = QEMU survives app exit; owned = child of app process. */
    persist: z.enum(["daemonize", "owned"]).default("daemonize"),

    provisioned: z.object({
        method: z.enum(["cloudimg", "iso", "imported"]).optional(),
        source: z.string().optional(),
        completedAt: z.string().optional(),
    }).prefault({}),

    credentials: z.object({
        username: z.string().default("cruiser"),
        /** Path to a 0600 file holding the RDP/SSH password (never inline). */
        passwordFile: z.string().optional(),
    }).prefault({}),

    autostart: z.boolean().default(false),
});
export type VmSpec = z.infer<typeof VmSpec>;

export function parseVmSpec(json: unknown): VmSpec {
    return VmSpec.parse(json);
}

/** Defaults for a fresh VM. */
export function defaultSpec(name: string): VmSpec {
    return VmSpec.parse({ name });
}
