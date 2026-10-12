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

import type { DevTool, DistroFamily, GuestBrowser, GuestDesktop, VmSpec } from "../../vm-core/src/config/schema";

export type PkgStage = "seed" | "setup";

/** The guest-side knobs a spec resolves into. */
export interface GuestProfile {
    family: DistroFamily;
    desktop: GuestDesktop;
    browser: GuestBrowser;
    snap: boolean;
    extraFonts: boolean;
    autologin: boolean;
    devtools: DevTool[];
    extraPackages: string[];
}

export function profileFromSpec(spec: VmSpec): GuestProfile {
    const o = spec.os;
    return {
        family: o.family, desktop: o.desktop, browser: o.browser,
        snap: o.snap, extraFonts: o.extraFonts, autologin: o.autologin,
        devtools: [...o.devtools],
        extraPackages: [...o.extraPackages],
    };
}

/** The "Developer" preset menu — id/label/desc shown as toggles in the UI. */
export const DEVTOOLS: readonly { id: DevTool; label: string; desc: string }[] = [
    { id: "toolchain",  label: "Compilers & build", desc: "gcc/g++/clang, make, cmake, ninja, meson, pkg-config, ccache" },
    { id: "python",     label: "Python",            desc: "python3 + pip, venv, dev headers" },
    { id: "node",       label: "Node.js",           desc: "nodejs + npm (distro release)" },
    { id: "rust",       label: "Rust",              desc: "rustc, cargo, rustfmt, clippy" },
    { id: "go",         label: "Go",                desc: "golang toolchain" },
    { id: "containers", label: "Containers",        desc: "podman, buildah, distrobox — distrobox shells into other distros" },
    { id: "linters",    label: "Linters",           desc: "shellcheck, yamllint, clang-format/tidy" },
    { id: "debug",      label: "Debug tools",       desc: "gdb, strace, ltrace, valgrind, perf" },
    { id: "shell",      label: "Shell extras",      desc: "jq, ripgrep, fd, fzf, tmux, tree, btop" },
];

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

/** Predicate shorthand: entry applies when the profile has this devtool on. */
const dev = (t: DevTool) => (p: GuestProfile) => p.devtools.includes(t);

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
    { id: "cli-tools",     pkgs: { ...deb(["curl", "wget", "git", "htop", "rsync"]), fedora: ["curl", "wget2", "git", "htop", "rsync"] } },
    // rsync ^ drives copy-mode shares (filesync.ts); the guest prep script
    // keeps a lazy install as backstop for guests provisioned before this.
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
    // fedora's hw va/vdpau drivers moved to rpmfusion — null = skip on fedora;
    // irrelevant for virtio-gpu anyway (vainfo still installed for checks)
    { id: "va-drivers",    pkgs: { ...deb("va-driver-all"), fedora: null } },

    // ── audio — RDP audio redirection needs pipewire + wireplumber ──
    { id: "audio",         pkgs: { ...deb(["pipewire", "pipewire-pulse", "pipewire-alsa", "wireplumber", "rtkit", "libspa-0.2-bluetooth"]),
                                   fedora: ["pipewire", "pipewire-pulseaudio", "pipewire-alsa", "wireplumber", "rtkit"] } },

    // ── fonts: base bundle always; CJK/MS-core behind extraFonts ──
    { id: "fonts-base",    pkgs: { ubuntu: ["fonts-ubuntu", "fonts-cantarell", "fonts-liberation", "fonts-noto-core", "fonts-noto-color-emoji"],
                                   debian: ["fonts-dejavu", "fonts-cantarell", "fonts-liberation", "fonts-noto-core", "fonts-noto-color-emoji"],
                                   fedora: ["dejavu-sans-fonts", "abattis-cantarell-vf-fonts",
                                            "liberation-sans-fonts", "liberation-serif-fonts", "liberation-mono-fonts",
                                            "google-noto-sans-fonts", "google-noto-emoji-fonts"] } },
    { id: "fonts-cjk",     pkgs: { ...deb("fonts-noto-cjk"), fedora: "google-noto-sans-cjk-fonts" },
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

    // ── Ubuntu GNOME baseline — ubuntu-session pulls ubuntu-settings, whose
    //    gschema overrides point picture-uri at ubuntu-wallpapers (a hard dep
    //    of gnome-shell, already installed). Without it the URI defaults to
    //    the gnome-backgrounds adwaita files (only a Suggests → absent) and
    //    GNOME renders the solid primary-color fallback = the blue desktop.
    //    Plus the stock UX extensions: dock, tray, desktop icons, tiling. ──
    { id: "ubuntu-flavor", desktops: ["gnome"], distros: ["ubuntu"],
                           pkgs: { ubuntu: ["ubuntu-session", "ubuntu-settings",
                                            "yaru-theme-gtk", "yaru-theme-icon", "yaru-theme-gnome-shell",
                                            "gnome-shell-extension-ubuntu-dock",
                                            "gnome-shell-extension-appindicator",
                                            "gnome-shell-extension-desktop-icons-ng",
                                            "gnome-shell-extension-ubuntu-tiling-assistant",
                                            "xdg-user-dirs", "xdg-user-dirs-gtk"] } },

    // ── KDE desktop — only on releases shipping krdp (see distros.ts) ──
    { id: "kde-core",      desktops: ["kde"],
                           // plasma-workspace-wayland was merged into plasma-workspace
                           // (ubuntu ≥25.10, debian trixie, fedora) — wayland is the
                           // default kwin session; kwin-x11 stays as fallback.
                           pkgs: { ubuntu: ["sddm", "plasma-desktop", "plasma-workspace", "krdp",
                                            "xdg-desktop-portal-kde", "kwin-wayland", "kwin-x11"],
                                   debian: ["sddm", "plasma-desktop", "plasma-workspace", "krdp",
                                            "xdg-desktop-portal-kde", "kwin-wayland", "kwin-x11"],
                                   // fedora folds the wayland session into plasma-workspace
                                   fedora: ["sddm", "plasma-workspace", "krdp",
                                            "xdg-desktop-portal-kde"] } },
    { id: "kde-applets",   desktops: ["kde"], pkgs: ["plasma-nm", "plasma-pa", "powerdevil", "kinfocenter"] },
    { id: "kde-apps",      desktops: ["kde"],
                           pkgs: { ...deb(["dolphin", "konsole", "systemsettings", "ark", "kwrite"]),
                                   fedora: ["dolphin", "konsole", "plasma-systemsettings", "ark", "kwrite"] } },
    { id: "kde-store",     desktops: ["kde"],
                           pkgs: { ...deb(["plasma-discover", "plasma-discover-backend-flatpak"]),
                                   fedora: ["plasma-discover", "plasma-discover-flatpak"] } },

    // ── app channels: flatpak always (store backends above plug into it),
    //    snapd only when explicitly enabled; libfuse* for AppImages ──
    { id: "flatpak",       pkgs: "flatpak" },
    { id: "appimage",      pkgs: { ...deb("libfuse2t64"), fedora: "fuse-libs" } },
    { id: "snapd",         pkgs: "snapd", when: (p) => p.snap },

    // ── developer tooling (the "Developer" preset) — setup stage only: keeps
    //    the seed small and routes deb names through the candidate-filtered
    //    install, so a stale name on one release can't abort cloud-init's
    //    whole package transaction. ──
    { id: "dev-toolchain", stages: ["setup"], when: dev("toolchain"),
                           pkgs: { ...deb(["build-essential", "clang", "cmake", "ninja-build", "meson",
                                           "pkg-config", "ccache"]),
                                   fedora: ["gcc", "gcc-c++", "clang", "cmake", "ninja-build", "meson",
                                            "pkgconf-pkg-config", "ccache"] } },
    { id: "dev-python",    stages: ["setup"], when: dev("python"),
                           pkgs: { ...deb(["python3", "python3-pip", "python3-venv", "python3-dev"]),
                                   fedora: ["python3", "python3-pip", "python3-devel"] } },
    { id: "dev-node",      stages: ["setup"], when: dev("node"), pkgs: ["nodejs", "npm"] },
    { id: "dev-rust",      stages: ["setup"], when: dev("rust"),
                           pkgs: { ...deb(["rustc", "cargo", "rustfmt", "rust-clippy"]),
                                   fedora: ["rust", "cargo", "rustfmt", "clippy"] } },
    { id: "dev-go",        stages: ["setup"], when: dev("go"), pkgs: "golang" },
    { id: "dev-containers", stages: ["setup"], when: dev("containers"),
                           pkgs: ["podman", "buildah", "distrobox"] },
    { id: "dev-linters",   stages: ["setup"], when: dev("linters"),
                           pkgs: { ...deb(["shellcheck", "yamllint", "clang-format", "clang-tidy"]),
                                   fedora: ["ShellCheck", "yamllint", "clang-tools-extra"] } },
    { id: "dev-debug",     stages: ["setup"], when: dev("debug"),
                           pkgs: { ubuntu: ["gdb", "strace", "ltrace", "valgrind", "linux-tools-generic"],
                                   debian: ["gdb", "strace", "ltrace", "valgrind", "linux-perf"],
                                   fedora: ["gdb", "strace", "ltrace", "valgrind", "perf"] } },
    { id: "dev-shell",     stages: ["setup"], when: dev("shell"),
                           pkgs: ["jq", "ripgrep", "fd-find", "fzf", "tmux", "tree", "btop"] },
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
