// ============================================================================
// packages.ts — the guest package manifest. Single source of truth for what
// gets installed into a VM, resolved per distro family + install stage:
//
//   "seed"  — cloud-init `packages:` / autoinstall late-commands (first boot)
//   "setup" — post-boot guest-setup script (also runs on reattach, so
//             additions here retrofit already-provisioned VMs)
//
// Each entry maps a logical id to per-family package names. Entries can be
// scoped to stages, desktops, families, or a profile predicate. Browsers are
// flatpaks (flatpak uniform across distros) — see BROWSER_FLATPAK.
// ============================================================================

import type { DistroFamily, GuestBrowser, GuestDesktop, VmSpec } from "../../vm-core/src/config/schema";

export type PkgStage = "seed" | "setup";

/** The guest-side knobs a spec resolves into. */
export interface GuestProfile {
    family: DistroFamily;
    desktop: GuestDesktop;
    browser: GuestBrowser;
    snap: boolean;
    extraFonts: boolean;
    extraPackages: string[];
}

export function profileFromSpec(spec: VmSpec): GuestProfile {
    const o = spec.os;
    return {
        family: o.family, desktop: o.desktop, browser: o.browser,
        snap: o.snap, extraFonts: o.extraFonts, extraPackages: [...o.extraPackages],
    };
}

type Names = string | string[] | Partial<Record<DistroFamily, string | string[] | null>>;

export interface PkgEntry {
    /** logical id — used in logs/tests, not a package name */
    id: string;
    /** package name(s) per family; string|string[] = same on all; null/undefined = unavailable */
    pkgs: Names;
    /** stages this entry applies to (default: both) */
    stages?: readonly PkgStage[];
    /** restrict to a desktop (default: both) */
    desktops?: readonly GuestDesktop[];
    /** restrict to distro families (default: all) */
    distros?: readonly DistroFamily[];
    /** extra profile predicate (default: always) */
    when?: (p: GuestProfile) => boolean;
}

/** Shorthand: same package name(s) on both deb families. */
const deb = (pkgs: string | string[]) => ({ ubuntu: pkgs, debian: pkgs });

export const PACKAGES: PkgEntry[] = [
    // ── agent & integration — must land before guest-setup can run ──
    { id: "guest-agent",   pkgs: "qemu-guest-agent" },
    { id: "spice-agent",   pkgs: "spice-vdagent" },
    { id: "ssh",           pkgs: "openssh-server" },
    { id: "polkit",        pkgs: { ...deb(["pkexec", "polkitd"]), fedora: "polkit" } },
    { id: "x-auth",        pkgs: { ...deb("xauth"), fedora: "xorg-x11-xauth" } },
    { id: "xwayland",      pkgs: { ...deb("xwayland"), fedora: "xorg-x11-server-Xwayland" } },
    // growpart so `vm resize` actually expands the guest rootfs
    { id: "growfs",        pkgs: { ...deb("cloud-guest-utils"), fedora: "cloud-utils-growpart" } },

    // ── tools ──
    { id: "cli-tools",     pkgs: ["curl", "wget", "git", "htop"] },
    { id: "bus-tools",     pkgs: ["usbutils", "pciutils"] },
    { id: "clipboard",     pkgs: ["wl-clipboard", "xclip"] },
    { id: "xdotool",       pkgs: "xdotool" },
    // waypipe+socat power app-mode — preinstalled so first launch isn't a
    // silent apt round-trip (waypipe.ts keeps a lazy install as backstop)
    { id: "waypipe",       pkgs: ["waypipe", "socat"] },

    // ── GPU accel + diagnostics (all FOSS — legal anywhere; note Fedora's
    //    stock mesa lacks patent-encumbered codecs, that's a user opt-in) ──
    { id: "vk-drivers",    pkgs: "mesa-vulkan-drivers" },
    { id: "gl-tools",      pkgs: { ...deb("mesa-utils"), fedora: "mesa-demos" } },
    { id: "vk-tools",      pkgs: "vulkan-tools" },
    { id: "va-tools",      pkgs: { ...deb("vainfo"), fedora: "libva-utils" } },
    { id: "va-drivers",    pkgs: { ...deb("va-driver-all"), fedora: ["libva-intel-driver", "intel-media-driver", "libva-vdpau-driver"] } },

    // ── audio — RDP audio redirection needs pipewire + wireplumber ──
    { id: "audio",         pkgs: { ...deb(["pipewire", "pipewire-pulse", "pipewire-alsa", "wireplumber", "rtkit", "libspa-0.2-bluetooth"]),
                                   fedora: ["pipewire", "pipewire-pulseaudio", "pipewire-alsa", "wireplumber", "rtkit"] } },

    // ── fonts: base bundle always; CJK/MS-core behind extraFonts ──
    { id: "fonts-base",    pkgs: { ubuntu: ["fonts-ubuntu", "fonts-cantarell", "fonts-liberation", "fonts-noto-core", "fonts-noto-color-emoji"],
                                   debian: ["fonts-dejavu", "fonts-cantarell", "fonts-liberation", "fonts-noto-core", "fonts-noto-color-emoji"],
                                   fedora: ["dejavu-sans-fonts", "abattis-cantarell-vf-fonts", "liberation-fonts", "google-noto-sans-fonts", "google-noto-emoji-color-fonts"] } },
    { id: "fonts-cjk",     pkgs: { ...deb("fonts-noto-cjk"), fedora: "google-noto-sans-cjk-ttc-fonts" },
                           when: (p) => p.extraFonts },
    { id: "fonts-extra",   pkgs: { ...deb("fonts-noto-extra"), fedora: "google-noto-fonts-all" },
                           when: (p) => p.extraFonts },
    // MS core fonts need a debconf EULA preseed → setup stage only, deb only
    { id: "fonts-ms",      pkgs: { ...deb("ttf-mscorefonts-installer"), fedora: null },
                           stages: ["setup"], when: (p) => p.extraFonts },

    // ── GNOME desktop ──
    { id: "gnome-core",    desktops: ["gnome"],
                           pkgs: { ...deb(["gdm3", "gnome-shell", "gnome-session", "gnome-remote-desktop"]),
                                   fedora: ["gdm", "gnome-shell", "gnome-session", "gnome-remote-desktop"] } },
    { id: "gnome-apps",    desktops: ["gnome"],
                           pkgs: { ...deb(["gnome-terminal", "nautilus", "gnome-control-center", "gnome-system-monitor",
                                           "gnome-text-editor", "file-roller", "baobab", "seahorse",
                                           "gvfs", "gvfs-backends", "xdg-desktop-portal-gnome", "xdg-desktop-portal-gtk"]),
                                   fedora: ["ptyxis", "nautilus", "gnome-control-center", "gnome-system-monitor",
                                            "gnome-text-editor", "file-roller", "baobab", "seahorse",
                                            "gvfs", "gvfs-smb", "xdg-desktop-portal-gnome", "xdg-desktop-portal-gtk"] } },
    { id: "gnome-store",   desktops: ["gnome"],
                           pkgs: { ...deb(["gnome-software", "gnome-software-plugin-flatpak"]), fedora: "gnome-software" } },

    // ── KDE desktop — only on releases shipping krdp (see distros.ts) ──
    { id: "kde-core",      desktops: ["kde"],
                           pkgs: { ...deb(["sddm", "plasma-desktop", "plasma-workspace-wayland", "krdp",
                                           "xdg-desktop-portal-kde", "kwin-x11"]),
                                   fedora: ["sddm", "plasma-workspace", "plasma-workspace-wayland", "krdp",
                                            "xdg-desktop-portal-kde"] } },
    { id: "kde-applets",   desktops: ["kde"], pkgs: ["plasma-nm", "plasma-pa", "powerdevil", "kinfocenter"] },
    { id: "kde-apps",      desktops: ["kde"], pkgs: ["dolphin", "konsole", "systemsettings", "ark", "kwrite"] },
    { id: "kde-store",     desktops: ["kde"],
                           pkgs: { ...deb(["plasma-discover", "plasma-discover-backend-flatpak"]),
                                   fedora: ["plasma-discover", "plasma-discover-flatpak"] } },

    // ── app channels: flatpak always (store backends above plug into it),
    //    snapd only when explicitly enabled; libfuse* for AppImages ──
    { id: "flatpak",       pkgs: "flatpak" },
    { id: "appimage",      pkgs: { ...deb("libfuse2t64"), fedora: "fuse-libs" } },
    { id: "snapd",         pkgs: "snapd", when: (p) => p.snap },
];

/** Flathub app ids for the browser dropdown — uniform across all distros. */
export const BROWSER_FLATPAK: Record<Exclude<GuestBrowser, "none">, string> = {
    firefox: "org.mozilla.firefox",
    chrome: "com.google.Chrome",
    chromium: "org.chromium.Chromium",
    vivaldi: "com.vivaldi.Vivaldi",
    brave: "com.brave.Browser",
};

function namesFor(pkgs: Names, family: DistroFamily): string[] {
    const v = typeof pkgs === "object" && !Array.isArray(pkgs) ? pkgs[family] : pkgs;
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
}

/** Resolve the manifest to a flat package list for a profile + stage. */
export function resolvePackages(p: GuestProfile, stage: PkgStage): string[] {
    const out: string[] = [];
    PACKAGES.forEach((e) => {
        if (e.stages && !e.stages.includes(stage)) return;
        if (e.desktops && !e.desktops.includes(p.desktop)) return;
        if (e.distros && !e.distros.includes(p.family)) return;
        if (e.when && !e.when(p)) return;
        out.push(...namesFor(e.pkgs, p.family));
    });
    out.push(...p.extraPackages);
    return [...new Set(out)];
}

/** Flathub app ids to install (browser dropdown). */
export function resolveFlatpaks(p: GuestProfile): string[] {
    return p.browser === "none" ? [] : [BROWSER_FLATPAK[p.browser]];
}
