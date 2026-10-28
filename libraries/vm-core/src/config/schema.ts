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

export const DistroFamily = z.enum(["ubuntu", "debian", "fedora", "windows"]);
export type DistroFamily = z.infer<typeof DistroFamily>;

export const GuestDesktop = z.enum(["gnome", "kde", "windows"]);
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
    "abort",               // release grab + minimize the viewer window
    "relgrab",             // toggle relative pointer capture (viewer-dd only)
    "kwin",                // kwin:<action name> — invoke a named KWin global shortcut
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

/** POSIX username constraint — exported so provision can re-validate
 *  CLI/UI input without reaching into VmSpec internals. */
export const Username = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/);

const VmSpecObject = z.object({
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
        /** Host-side cgroup caps on the QEMU process — when any are set the
         *  VM launches inside a `systemd-run --user --scope cruiser-<name>`
         *  scope (boot-frozen: edit → restart pending). A missing user bus
         *  or systemd-run falls back to an uncapped spawn with a log line.
         *  Delegated user cgroups only support a subset of knobs — CPU,
         *  memory and IO weight are the useful ones. */
        limits: z.object({
            /** CPUQuota — "50%" (half a core) or "200%" (two cores). */
            cpuQuota: z.string().optional(),
            /** MemoryMax — hard cap on QEMU's RSS incl. guest RAM, e.g. "8G". */
            memoryMax: z.string().optional(),
            /** IOWeight — blkio scheduling weight 1..10000 (default 100). */
            ioWeight: z.number().int().min(1).max(10000).optional(),
        }).prefault({}),
    }).prefault({}),

    disk: z.object({
        file: z.string().default("disk.qcow2"),   // relative to vm dir, or absolute
        sizeGiB: z.number().int().min(4).default(100),
        format: z.string().default("qcow2"),      // qemu-img format (qcow2|raw|vmdk|vdi|qed|vhdx)
        /**
         * qcow2 LUKS at-rest encryption (host-side — QEMU holds the key,
         * the guest sees a plain disk). "full" encrypts the system image
         * itself; "home" leaves it plaintext and adds a second LUKS image
         * (<stem>-home.qcow2 beside disk.file) attached as virtio-blk
         * serial cruiser-home — guest setup formats it ext4 and mounts it
         * at /home. Create-time only: LUKS is baked into the image header,
         * flipping this on an existing disk just breaks boot.
         */
        encrypt: z.enum(["off", "full", "home"]).default("off"),
        /**
         * Where the LUKS passphrase lives. "store" keeps it at
         * secrets/disk-key (0600 — same protection as the rdp password)
         * so QEMU unlocks unattended on every boot; "prompt" never
         * persists it — callers hand the passphrase to the VM before
         * start()/disk ops and a transient run/disk-key file exists only
         * for the duration of each qemu invocation.
         */
        keyStorage: z.enum(["store", "prompt"]).default("store"),
        /** home mode only: size of the encrypted /home image. */
        homeGiB: z.number().int().min(4).default(50),
    }).prefault({}),

    gpu: z.object({
        mode: GpuMode.default("venus"),
        /** e.g. /dev/dri/renderD129 — pick the mesa-friendly node (not NVIDIA EGL). */
        renderNode: z.string().optional(),
        /** Venus blob hostmem region MiB (needs >= ~2G for real workloads). */
        hostmemMiB: z.number().int().default(4096),
        /** Venus only: also expose the host's software Vulkan device
         *  (lavapipe) to the guest. Off hides it from ICD enumeration so a
         *  guest app requesting a fallback adapter can't rasterize on host
         *  CPU — the guest's own lavapipe ICD still covers that case. */
        softwareVk: z.boolean().default(false),
    }).prefault({}),

    display: z.object({
        /**
         * Viewer transport: "dmabuf" = QEMU D-Bus display backend + viewer-dd
         * (zero-copy dma-buf → EGL present — needs gpu.mode virgl/venus and the
         * QEMU rendernode to match the host display GPU's vendor); "rdp" =
         * xfreerdp over the guest's RDP server (the software-gpu fallback —
         * the guest still provisions its RDP server either way).
         */
        viewer: z.enum(["rdp", "dmabuf"]).default("dmabuf"),
        headMode: HeadMode.default("virtual-desktop"),
        /** "all" = /multimon; else named monitors for /monitor:<name>. */
        monitors: z.union([z.literal("all"), z.array(z.string())]).default("all"),
        sticky: z.boolean().default(false),       // fullscreen-monitor only: all desktops
        virtualDesktop: z.number().int().min(1).default(2),  // virtual-desktop mode
        windowSize: z.object({ w: z.number().int(), h: z.number().int() }).default({ w: 1600, h: 1000 }),
        /**
         * Host keybindings while the viewer runs. action: "<name>" or
         * "<name>:<arg>" — host-desktop:<n>, desktop-cycle-left|right,
         * ungrab, abort, relgrab, command:<cmdline> (sh -c; {vm} → vm
         * name, {cli} → the cruiser cli invocation). The default kill
         * binding is the guest-hung escape hatch.
         */
        escapeShortcuts: z.array(EscapeShortcut).default([
            // ctrl+super+FN are unbound in KDE — an escape combo that ever
            // leaks to the host (grab gap, viewer not focused) is a no-op
            // there; ctrl+alt+delete collides with ksmserver's logout.
            { keys: "ctrl+super+f1", action: "host-desktop:1" },
            { keys: "ctrl+super+f2", action: "host-desktop:2" },
            { keys: "ctrl+super+f3", action: "host-desktop:3" },
            { keys: "ctrl+super+f4", action: "host-desktop:4" },
            { keys: "ctrl+super+f5", action: "command:{cli} vm reboot {vm}" },
            { keys: "ctrl+super+f6", action: "command:{cli} vm suspend {vm}" },
            { keys: "ctrl+super+f7", action: "command:{cli} vm resume {vm}" },
            { keys: "ctrl+super+f8", action: "command:{cli} vm stop {vm}" },
            // the panic combo: release every grab and minimize the viewer —
            // works even while the keyboard is grabbed (viewer-side dispatch)
            { keys: "ctrl+super+escape", action: "abort" },
            { keys: "ctrl+super+end", action: "command:{cli} vm kill {vm}" },
            // manual pointer-capture toggle for apps that lock without
            // hiding the guest cursor (auto mode can't see them)
            { keys: "ctrl+super+m", action: "relgrab" },
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
        /** guest → host URL forwarding: a virtserialport
         *  (org.cruiser.urlopen.0) a guest-side xdg-open shim writes http(s)
         *  URLs into; a host listener runs real xdg-open on them. */
        urlOpen: z.boolean().default(true),
        /** guest → host notification forwarding: a busctl --user monitor over
         *  the ssh forward snoops org.freedesktop.Notifications (session-bus
         *  eavesdrop needs no guest-side install); host pops them via
         *  notify-send. Session-lifetime — runs while a viewer session is
         *  open, like the filesync/agent bridges. */
        notifications: z.boolean().default(true),
        /** freerdp -grab-keyboard / viewer-dd XGrabKeyboard — true gives the
         *  guest all keys (alt-tab included), false lets host shortcuts win
         *  (required for escape shortcuts). */
        grabKeyboard: z.boolean().default(false),
        /**
         * Guest pointer-lock support (dmabuf viewer only). QEMU's console
         * keeps one active pointer handler — the absolute virtio tablet —
         * so a guest app that grabs the pointer (games, 3D tools) gets no
         * relative deltas. Capture mode flips the handler to the PS/2
         * mouse, confines the host pointer to the window, and feeds
         * RelMotion. "auto" engages when the guest hides its cursor while
         * the viewer is focused (the pointer-lock signature), "always"
         * captures whenever focused (dedicated gaming VMs), "off" never.
         * The `relgrab` escape action toggles capture manually.
         */
        pointerLock: z.enum(["auto", "always", "off"]).default("auto"),
    }).prefault({}),

    usb: z.object({ autoAttach: z.array(UsbDeviceRef).default([]) }).prefault({}),

    /** Firmware security stack — create-time (the TPM state dir and the
     *  firmware config are bound to the booted image's expectations). */
    security: z.object({
        /** swtpm emulator (TPM 2.0) on a unix socket — state persists at
         *  <vm>/tpm/. Enables TPM-bound LUKS and measured boot. */
        tpm: z.boolean().default(false),
        /** edk2 secure-boot firmware + SMM (q35,smm=on + secure pflash).
         *  Fresh VMs get the MS-keys vars template; toggling on an existing
         *  VM boots in setup mode until keys are enrolled in the vars UI. */
        secureBoot: z.boolean().default(false),
    }).prefault({}),

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
        /** host path to a shell script run at the END of guest-setup —
         *  as root, with $U/$UHOME/$UUID already in scope (use `runuser
         *  -u "$U"` for user-context steps). Re-runs on re-provision, so
         *  the script should be idempotent. */
        provisionScript: z.string().default(""),
        /**
         * family=windows only: which display driver the guest provisions.
         * "yttrium" = the viogpu3d/WDDM alpha (Venus → blob scanouts → the
         * zero-copy dmabuf viewer path); requires testsigning + Secure Boot
         * off, so it conflicts with security.secureBoot (enforced in the
         * spec refinement below). "virtio2d" = stock virtio-win viogpudo —
         * 2D scanouts reach viewer-dd via the memfd Map path (one copy).
         */
        winDriver: z.enum(["yttrium", "virtio2d"]).default("yttrium"),
        /**
         * family=windows only: /IMAGE/NAME inside a multi-edition install
         * ISO (e.g. "Windows 11 Pro"). Unset = the catalog default for
         * os.release; set "" to let setup pick its only image (eval ISOs).
         */
        winEdition: z.string().optional(),
    }).prefault({}),

    network: z.object({
        /** nat = slirp outbound+hostfwd; restricted = slirp restrict=on
         *  (guest↔host only — no internet/LAN egress, hostfwd still works:
         *  the sandbox mode); isolated = no netdev at all (QGA/serial/
         *  vsock channels still reach the guest); vmnet = nat PLUS a
         *  second NIC on a multicast L2 shared by every vmnet VM on this
         *  host (no DHCP — link-local or manual static IPs). */
        mode: z.enum(["nat", "restricted", "isolated", "vmnet"]).default("nat"),
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
        method: z.enum(["cloudimg", "iso", "imported", "windows-iso"]).optional(),
        source: z.string().optional(),
        completedAt: z.string().optional(),
    }).prefault({}),

    credentials: z.object({
        // POSIX username — interpolated into shell scripts and ini files.
        // (Also fine as a Windows local account name.)
        username: Username.default("cruiser"),
        /** Path to a 0600 file holding the RDP/SSH password (never inline). */
        passwordFile: z.string().optional(),
        /** Host path to a private SSH key the gitKey channel installs in
         *  the guest. Unset → ~/.ssh/<git user.email>, then the usual
         *  id_ed25519/id_rsa/id_ecdsa defaults. */
        gitSshKeyPath: z.string().optional(),
        /** Host private key paths the sshAgent channel loads into a
         *  dedicated ssh-agent forwarded into the guest — the VM gets
         *  exactly this set, the session agent stays untouched. Empty =
         *  forward the host's SSH_AUTH_SOCK as-is (legacy behavior). */
        sshAgentKeys: z.array(z.string()).default([]),
    }).prefault({}),

    autostart: z.boolean().default(false),
});

/**
 * Cross-field rules — currently all the windows-guest constraints:
 *   - os.winDriver=yttrium needs testsigning, which Secure Boot forbids.
 *   - disk.encrypt="home" is Linux-shaped (guest ext4 + /home migration).
 *   - headMode "app" is waypipe — no Windows equivalent (RDP RAIL someday).
 * Field schemas stay on the object so .shape survives for callers that
 * introspect (create form); refinements run on parse/safeParse.
 */
export const VmSpec = VmSpecObject.superRefine((s, ctx) => {
    if (s.os.family !== "windows") return;
    if (s.os.winDriver === "yttrium" && s.security.secureBoot)
        ctx.addIssue({ code: "custom", path: ["security", "secureBoot"],
            message: "os.winDriver=yttrium needs testsigning — Secure Boot must be off" });
    if (s.os.winDriver === "yttrium" && s.gpu.mode !== "venus")
        ctx.addIssue({ code: "custom", path: ["gpu", "mode"],
            message: "os.winDriver=yttrium needs gpu.mode=venus (blob scanouts → dmabuf viewer)" });
    // note: software gpu is still virtio-vga (2D scanouts flow over the
    // Map path) — a valid no-rendernode fallback for winDriver=virtio2d.
    if (s.disk.encrypt === "home")
        ctx.addIssue({ code: "custom", path: ["disk", "encrypt"],
            message: "encrypt=home is a Linux guest feature — windows guests support off|full only" });
    if (s.display.headMode === "app")
        ctx.addIssue({ code: "custom", path: ["display", "headMode"],
            message: "headMode=app is waypipe (Linux only) — use virtual-desktop/windowed/fullscreen-monitor" });
});
export type VmSpec = z.infer<typeof VmSpec>;

export function parseVmSpec(json: unknown): VmSpec {
    return VmSpec.parse(json);
}

/** Defaults for a fresh VM. */
export function defaultSpec(name: string): VmSpec {
    return VmSpec.parse({ name });
}
