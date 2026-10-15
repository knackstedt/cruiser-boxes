// ============================================================================
// schema.ts — VmSpec: the declarative per-VM contract (vm.json).
// zod-validated; versioned for forward migration.
// ============================================================================

import { z } from "zod";
import { SYNC_CHANNELS } from "./sync-channels";

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

/**
 * Developer tooling checklist — labels/categories/package lists live in
 * provision/packages.ts (DEVTOOLS); installer snippets for tools with no
 * distro package live in provision/devtools.ts. Ids are persisted in
 * vm.json — add new ones freely, never remove/rename (parse would fail).
 */
export const DevTool = z.enum([
    // compilers & build
    "toolchain",       // gcc/g++/clang, make, cmake, ninja, meson, pkg-config, ccache
    "jvmbuild",        // maven + gradle
    "linters",
    "debug",           // gdb/strace/ltrace/valgrind/perf
    // languages & runtimes
    "python",
    "uv",              // uv + pipx
    "node",            // via fnm (user-level), LTS
    "bun",
    "deno",
    "rust",
    "go",
    "ruby",
    "java",            // default-jdk / latest openjdk
    "kotlin",
    "csharp",          // .NET SDK LTS via dotnet-install.sh
    "php",             // php-cli + composer
    "elixir",          // elixir + erlang
    // cli & shell
    "shell",           // the bundle: jq, ripgrep, fd, fzf, tmux, tree, btop…
    "tmux",
    "fzf",
    "yq",              // mikefarah's — upstream binary (distro 'yq' is a different tool)
    "tree",
    "gh",              // github cli (upstream repo)
    // editors & ides
    "neovim",
    "emacs",
    "zed",             // zed.dev installer
    "vscode",          // flatpak
    "vscodium",        // flatpak
    "cursor",          // deb/rpm via cursor.com download api
    "devin-desktop",   // windsurf apt repo — deb-family only
    "android-studio",  // flatpak
    // containers & vms
    "containers",      // podman + buildah + podman-compose + distrobox
    "docker",          // engine + compose + buildx, user → docker group
    "virtmanager",     // libvirt + virt-manager + qemu (pair with nestedVirt)
    "vagrant",         // hashicorp repo
    // kubernetes
    "kubectl",
    "helm",
    "k9s",
    "minikube",
    "kind",
    "k3s",
    // cloud & iac
    "cloudcli",        // awscli + gcloud sdk + azure cli
    "terraform",       // hashicorp repo
    "ansible",
    // databases
    "sqlite",
    "mysql",           // server + client + mycli
    "postgres",        // server + contrib + pgcli
    "redis",           // server + cli
    "mongodb",         // mongodb-org + mongosh (upstream repo)
    "dbeaver",         // flatpak
    // network & misc tools
    "nettools",        // nmap, iperf3, mosh, rclone, dnsutils, netcat…
    "tailscale",
    "adb",             // android platform tools (adb + fastboot)
    // ai
    "ollama",
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

/**
 * Host↔guest file sharing entry. Two transports:
 *
 *   mount — virtiofs (9p fallback) live mount baked into QEMU argv + guest
 *           fstab. direction "both" = rw share, "host-to-guest" = ro mount.
 *           Applies at boot (no fsdev hotplug); the session "shares" channel
 *           reconciles guest fstab/mounts so it's ready on first boot after.
 *   copy  — rsync over the ssh forward, run by FileSyncs for the viewer
 *           session's lifetime (fs.watch push + interval pull). Works for
 *           single files, applies live with no restart.
 */
export const ShareSpec = z.object({
    hostPath: z.string(),
    // mount_tag goes into fstab + qemu -virtfs unquoted — safe charset only.
    tag: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).default("hostshare"),
    /** Guest-side path: mountpoint for mount mode (default /mnt/<tag>),
     *  destination dir/file for copy mode (default ~/cruiser-sync/<base>). */
    guestPath: z.string().optional(),
    mode: z.enum(["mount", "copy"]).default("mount"),
    /** "both" = guest writes propagate back; "host-to-guest" = read-only
     *  mount / push-only copy. */
    direction: z.enum(["both", "host-to-guest"]).optional(),
    /** Legacy alias kept for old vm.json — direction wins when both set. */
    readOnly: z.boolean().default(false),
    enabled: z.boolean().default(true),
    /** copy mode + host-to-guest only: rsync --delete (mirror semantics). */
    deletions: z.boolean().default(false),
}).transform((s) => {
    const direction = s.direction ?? (s.readOnly ? "host-to-guest" : "both");
    return { ...s, direction, readOnly: direction === "host-to-guest" };
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

    /** Free text — shown in the UI and exported with portable configs. */
    description: z.string().default(""),

    /**
     * Where this spec was imported from — set by `vm import`/`vm gist push`
     * so `vm config pull` can refetch and re-apply it. Not set for VMs
     * created locally.
     */
    origin: z.object({
        kind: z.enum(["gist", "file"]),
        /** gist id (kind=gist). */
        id: z.string().optional(),
        /** source reference (gist url / file path) for display + refetch. */
        url: z.string().optional(),
    }).optional(),

    resources: z.object({
        cpus: z.number().int().min(1).max(64).default(4),
        sockets: z.number().int().default(1),
        threads: z.number().int().default(1),
        memoryMiB: z.number().int().min(512).default(8192),
        /** Expose the host's vmx/svm CPUID bit to the guest so it can run
         *  KVM itself (VMs inside the VM). QEMU filters virt flags out of
         *  -cpu host, so this must be requested explicitly; the host's
         *  kvm_intel/kvm_amd nested param must also be on. */
        nestedVirt: z.boolean().default(false),
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
        /**
         * Viewer transport: "rdp" = xfreerdp over the guest's RDP server;
         * "dmabuf" = QEMU D-Bus display backend + viewer-dd (zero-copy
         * dma-buf → EGL present — needs gpu.mode virgl/venus and the QEMU
         * rendernode to match the host display GPU's vendor).
         */
        viewer: z.enum(["rdp", "dmabuf"]).default("rdp"),
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
        /** guest clipboard sync: freerdp +clipboard on the rdp viewer,
         *  qemu-vdagent ↔ viewer-dd D-Bus bridge on the dmabuf viewer. */
        clipboard: z.boolean().default(true),
        grabKeyboard: z.boolean().default(false), // freerdp -grab-keyboard → host shortcuts win
    }).prefault({}),

    usb: z.object({ autoAttach: z.array(UsbDeviceRef).default([]) }).prefault({}),

    /**
     * Host → guest sync channels. All per-VM; every channel also honors
     * env kills (CRUISER_HOST_SYNC=0 master, CRUISER_SYNC_<ID>=0 each).
     * The credential:true channels push host credentials/identity/trust
     * into the guest — opt in deliberately.
     * Keys + defaults come from sync-channels.ts — the single registry
     * that also drives the create form and cli `vm sync`.
     */
    sync: z.object(
        Object.fromEntries(SYNC_CHANNELS.map((c) => [c.id, z.boolean().default(c.def)])) as {
            [C in (typeof SYNC_CHANNELS)[number] as C["id"]]: z.ZodDefault<z.ZodBoolean>;
        },
    ).prefault({}),

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

    /**
     * Automatic qcow2 internal snapshots (offline qemu-img — the disk must
     * be idle, so "clean stop" is the only exit that snapshots; a kill or
     * host power loss can't). auto != "off" fires when the newest auto-*
     * snapshot is older than the cadence. keep bounds the auto-* rotation —
     * manual snapshots are never pruned.
     */
    snapshots: z.object({
        auto: z.enum(["off", "daily", "weekly", "monthly"]).default("off"),
        /** which lifecycle edge auto fires on. */
        trigger: z.enum(["start", "stop", "both"]).default("stop"),
        /** auto-* snapshots retained — oldest pruned past this. */
        keep: z.number().int().min(1).max(50).default(5),
    }).prefault({}),

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
        /** Host path to a private SSH key the gitKey channel installs in
         *  the guest. Unset → ~/.ssh/<git user.email>, then the usual
         *  id_ed25519/id_rsa/id_ecdsa defaults. */
        gitSshKeyPath: z.string().optional(),
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
