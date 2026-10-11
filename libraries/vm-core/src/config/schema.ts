// ============================================================================
// schema.ts — VmSpec: the declarative per-VM contract (vm.json).
// zod-validated; versioned for forward migration.
// ============================================================================

import { z } from "zod";

export const HeadMode = z.enum(["fullscreen-monitor", "windowed", "virtual-desktop", "app"]);
export type HeadMode = z.infer<typeof HeadMode>;

export const GpuMode = z.enum(["venus", "virgl", "software"]);
export type GpuMode = z.infer<typeof GpuMode>;

export const DistroFamily = z.enum(["ubuntu", "debian", "fedora"]);
export type DistroFamily = z.infer<typeof DistroFamily>;

export const GuestDesktop = z.enum(["gnome", "kde"]);
export type GuestDesktop = z.infer<typeof GuestDesktop>;

export const GuestBrowser = z.enum(["none", "firefox", "chrome", "chromium", "vivaldi", "brave"]);
export type GuestBrowser = z.infer<typeof GuestBrowser>;

/** Developer tooling groups — labels/package lists live in provision/packages.ts. */
export const DevTool = z.enum([
    "toolchain",   // compilers + build systems (gcc/clang, make, cmake, ninja, meson)
    "python",
    "node",
    "rust",
    "go",
    "containers",  // podman + buildah + distrobox
    "linters",
    "debug",       // gdb/strace/ltrace/valgrind/perf
    "shell",       // jq, ripgrep, fd, fzf, tmux…
]);
export type DevTool = z.infer<typeof DevTool>;

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
    // mount_tag goes into fstab + qemu -virtfs unquoted — safe charset only.
    tag: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).default("hostshare"),
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
        file: z.string().default("disk.qcow2"),   // relative to vm dir, or absolute
        sizeGiB: z.number().int().min(4).default(100),
        format: z.string().default("qcow2"),      // qemu-img format (qcow2|raw|vmdk|vdi|qed|vhdx)
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
        /**
         * Host keybindings while the viewer runs. action: "<name>" or
         * "<name>:<arg>" — host-desktop:<n>, desktop-cycle-left|right,
         * ungrab, command:<cmdline> (sh -c; {vm} → vm name, {cli} → the
         * cruiser cli invocation). The default kill binding is the
         * guest-hung escape hatch.
         */
        escapeShortcuts: z.array(EscapeShortcut).default([
            { keys: "ctrl+alt+delete", action: "host-desktop:1" },
            { keys: "ctrl+alt+end", action: "command:{cli} vm kill {vm}" },
        ]),
        dynamicResolution: z.boolean().default(true),
        /**
         * cruiser-managed guest wallpaper — composited host-side with a
         * watermark (vm name + escape/kill hints) and pushed into the guest.
         * managed:false → never touch the guest wallpaper. position:"off"
         * applies the image without the watermark.
         */
        wallpaper: z.object({
            managed: z.boolean().default(true),
            /** host image path; absent → generated cruiser gradient. */
            source: z.string().optional(),
            position: z.enum(["top-left", "top-right", "bottom-left", "bottom-right", "center", "off"]).default("bottom-right"),
        }).prefault({}),
        sound: z.boolean().default(true),
        microphone: z.boolean().default(true),
        clipboard: z.boolean().default(true),
        grabKeyboard: z.boolean().default(false), // freerdp -grab-keyboard → host shortcuts win
    }).prefault({}),

    usb: z.object({ autoAttach: z.array(UsbDeviceRef).default([]) }).prefault({}),

    /**
     * Host → guest sync channels. All per-VM; every channel also honors
     * env kills (CRUISER_HOST_SYNC=0 master, CRUISER_SYNC_<ID>=0 each).
     * The default-off four push host credentials/identity/trust into the
     * guest — opt in deliberately.
     */
    sync: z.object({
        /** dark/light hint via the xdg portal (provision bake + live watcher). */
        theme: z.boolean().default(true),
        /** portal accent-color → GNOME named accent / KDE AccentColor. */
        accentColor: z.boolean().default(true),
        /** portal contrast → high-contrast. */
        contrast: z.boolean().default(true),
        /** host timezone → timedatectl (provision default + live watcher). */
        timezone: z.boolean().default(true),
        /** host LANG → localectl (seed + guest-setup + session re-push). */
        locale: z.boolean().default(true),
        /** host X11 keymap → guest layout (seed + guest-setup + session re-push). */
        keyboard: z.boolean().default(true),
        /** host monitor topology → monitors.xml (GNOME guests; provision + session re-push). */
        monitors: z.boolean().default(true),
        /** host's own wallpaper as the managed composite's source image. */
        hostWallpaper: z.boolean().default(true),
        /** ~/.gitconfig user.name/email → guest git config. */
        gitIdentity: z.boolean().default(false),
        /** host proxy config → guest gsettings/kioslaverc + /etc/environment. */
        proxy: z.boolean().default(false),
        /** host custom CA roots → guest trust store. */
        caCerts: z.boolean().default(false),
        /** host SSH agent socket → guest via a held ssh -R forward. */
        sshAgent: z.boolean().default(false),
    }).prefault({}),

    shares: z.array(ShareSpec).default([]),

    /**
     * Guest OS profile — drives image selection (cloudimg) and the in-guest
     * package/desktop setup. release "" = curated default for the family.
     * For imported disks the family may be wrong — the setup script re-detects
     * the real distro from /etc/os-release and picks the matching pkg names.
     */
    os: z.object({
        family: DistroFamily.default("ubuntu"),
        release: z.string().default(""),
        desktop: GuestDesktop.default("gnome"),
        /** flatpak app to preinstall; "none" = no browser. */
        browser: GuestBrowser.default("none"),
        /** install snapd — off means flatpak is the only app channel. */
        snap: z.boolean().default(false),
        /** extended font sets (CJK + MS core fonts) beyond the base bundle. */
        extraFonts: z.boolean().default(false),
        /** DM autologin into the desktop session at boot. KDE: effectively
         *  required for RDP — krdpserver is a user-session service. */
        autologin: z.boolean().default(true),
        /** developer tooling groups (the "Developer" preset) — installed at
         *  guest-setup; retrofits running VMs on re-provision. */
        devtools: z.array(DevTool).default([]),
        /** escape hatch: extra distro packages, installed at setup —
         *  expanded unquoted into the pkg manager line, hence strict names. */
        extraPackages: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.+:~_=-]*$/)).default([]),
    }).prefault({}),

    network: z.object({
        hostfwd: z.array(HostFwd).default([]),
        sshPort: z.number().int().optional(),     // resolved+stored at create
        rdpPort: z.number().int().optional(),
        vsock: z.boolean().default(true),         // vhost-vsock-pci for waypipe
    }).prefault({}),

    /**
     * daemonize = QEMU survives app exit; owned = QEMU stops with the app;
     * ephemeral = owned + the VM dir (incl. disk) is deleted when the app exits.
     */
    persist: z.enum(["daemonize", "owned", "ephemeral"]).default("daemonize"),

    provisioned: z.object({
        method: z.enum(["cloudimg", "iso", "imported"]).optional(),
        source: z.string().optional(),
        completedAt: z.string().optional(),
    }).prefault({}),

    credentials: z.object({
        // POSIX username — interpolated into shell scripts and ini files.
        username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).default("cruiser"),
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
