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

/**
 * The devtools checklist — grouped by `cat` (category headers render in
 * first-seen order, so keep the array category-sorted). Install route per
 * item: a PACKAGES entry (distro pkgs), a `flatpak` here (Flathub via
 * resolveFlatpaks), and/or a snippet in devtools.ts (upstream installers,
 * third-party repos, /usr/local/bin drops — anything the distro won't do).
 */
export interface DevToolDef {
    id: DevTool;
    cat: string;
    label: string;
    desc: string;
    flatpak?: string;
}

export const DEVTOOLS: readonly DevToolDef[] = [
    // ── compilers & build ──
    { id: "toolchain",      cat: "Compilers & build", label: "gcc + clang",     desc: "make, cmake, ninja, meson, pkg-config, ccache" },
    { id: "jvmbuild",       cat: "Compilers & build", label: "maven + gradle",  desc: "java build tools — pair with the JDK item" },
    { id: "linters",        cat: "Compilers & build", label: "linters",         desc: "shellcheck, yamllint, clang-format/tidy" },
    { id: "debug",          cat: "Compilers & build", label: "debug tools",     desc: "gdb, strace, ltrace, valgrind, perf" },
    // ── languages & runtimes ──
    { id: "python",         cat: "Languages", label: "python",      desc: "python3 + pip, venv, dev headers" },
    { id: "uv",             cat: "Languages", label: "uv + pipx",   desc: "fast python pkg/env tooling — uv falls back to the astral installer" },
    { id: "node",           cat: "Languages", label: "node (fnm)",  desc: "node LTS via fnm — user-level, easy version switching" },
    { id: "bun",            cat: "Languages", label: "bun",         desc: "bun.sh installer → ~/.bun" },
    { id: "deno",           cat: "Languages", label: "deno",        desc: "deno.land installer → ~/.deno" },
    { id: "rust",           cat: "Languages", label: "rust",        desc: "rustc, cargo, rustfmt, clippy (distro)" },
    { id: "go",             cat: "Languages", label: "go",          desc: "golang toolchain (distro)" },
    { id: "ruby",           cat: "Languages", label: "ruby",        desc: "interpreter + dev headers for native gems" },
    { id: "java",           cat: "Languages", label: "java (jdk)",  desc: "default-jdk / latest openjdk" },
    { id: "kotlin",         cat: "Languages", label: "kotlin",      desc: "kotlin compiler (distro)" },
    { id: "csharp",         cat: "Languages", label: "c# (.NET)",   desc: "dotnet SDK LTS via the official installer → ~/.dotnet" },
    { id: "php",            cat: "Languages", label: "php",         desc: "php-cli + composer" },
    { id: "elixir",         cat: "Languages", label: "elixir",      desc: "elixir + erlang runtime" },
    // ── cli & shell ──
    { id: "shell",          cat: "CLI & shell", label: "shell extras", desc: "the bundle: jq, ripgrep, fd, fzf, tmux, tree, btop, bat, eza, zoxide, delta, hyperfine, ncdu, xh, direnv, zellij, lazygit, glab" },
    { id: "tmux",           cat: "CLI & shell", label: "tmux",         desc: "terminal multiplexer (in the bundle too)" },
    { id: "fzf",            cat: "CLI & shell", label: "fzf",          desc: "fuzzy finder (in the bundle too)" },
    { id: "yq",             cat: "CLI & shell", label: "yq",           desc: "yaml processor — upstream binary (the distro 'yq' is a different tool)" },
    { id: "tree",           cat: "CLI & shell", label: "tree",         desc: "dir tree listing (in the bundle too)" },
    { id: "gh",             cat: "CLI & shell", label: "github cli",   desc: "gh via github's own apt/dnf repo" },
    // ── editors & ides ──
    { id: "neovim",         cat: "Editors", label: "neovim",        desc: "nvim (distro)" },
    { id: "emacs",          cat: "Editors", label: "emacs",         desc: "gnu emacs (distro)" },
    { id: "zed",            cat: "Editors", label: "zed",           desc: "zed.dev installer → ~/.local — wants gpu accel (venus)" },
    { id: "vscode",         cat: "Editors", label: "vscode",        desc: "flatpak com.visualstudio.code" , flatpak: "com.visualstudio.code" },
    { id: "vscodium",       cat: "Editors", label: "vscodium",      desc: "telemetry-free vscode build (flatpak)", flatpak: "com.vscodium.codium" },
    { id: "cursor",         cat: "Editors", label: "cursor",        desc: "deb/rpm resolved from cursor.com's download api" },
    { id: "devin-desktop",  cat: "Editors", label: "devin desktop", desc: "windsurf apt repo — deb-family guests only" },
    { id: "android-studio", cat: "Editors", label: "android studio", desc: "flatpak com.google.AndroidStudio — pair with adb", flatpak: "com.google.AndroidStudio" },
    // ── containers & vms ──
    { id: "containers",     cat: "Containers & VMs", label: "podman",       desc: "podman, buildah, podman-compose, distrobox — distrobox shells into other distros" },
    { id: "docker",         cat: "Containers & VMs", label: "docker",       desc: "engine + compose v2 + buildx; user joins the docker group" },
    { id: "virtmanager",    cat: "Containers & VMs", label: "virt-manager", desc: "libvirt + qemu + virt-manager — vms in the vm (pair with nested virt)" },
    { id: "vagrant",        cat: "Containers & VMs", label: "vagrant",      desc: "hashicorp repo build" },
    // ── kubernetes ──
    { id: "kubectl",        cat: "Kubernetes", label: "kubectl",   desc: "latest stable binary from dl.k8s.io" },
    { id: "helm",           cat: "Kubernetes", label: "helm",      desc: "distro pkg, falls back to the get-helm-3 script" },
    { id: "k9s",            cat: "Kubernetes", label: "k9s",       desc: "terminal k8s ui (upstream binary)" },
    { id: "minikube",       cat: "Kubernetes", label: "minikube",  desc: "local cluster — needs a docker/podman/kvm2 driver" },
    { id: "kind",           cat: "Kubernetes", label: "kind",      desc: "k8s-in-docker — needs docker or podman" },
    { id: "k3s",            cat: "Kubernetes", label: "k3s",       desc: "lightweight cluster, installs + starts a systemd service" },
    // ── cloud & iac ──
    { id: "cloudcli",       cat: "Cloud & IaC", label: "cloud clis", desc: "awscli (distro) + gcloud sdk + azure cli" },
    { id: "terraform",      cat: "Cloud & IaC", label: "terraform",  desc: "hashicorp repo build" },
    { id: "ansible",        cat: "Cloud & IaC", label: "ansible",    desc: "ansible core (distro)" },
    // ── databases ──
    { id: "sqlite",         cat: "Databases", label: "sqlite",     desc: "sqlite3 + litecli" },
    { id: "mysql",          cat: "Databases", label: "mysql",      desc: "server + client + mycli; service enabled" },
    { id: "postgres",       cat: "Databases", label: "postgresql", desc: "server + contrib + pgcli; initdb + enabled" },
    { id: "redis",          cat: "Databases", label: "redis",      desc: "redis server + cli; service enabled" },
    { id: "mongodb",        cat: "Databases", label: "mongodb",    desc: "mongodb-org + mongosh via upstream repo" },
    { id: "dbeaver",        cat: "Databases", label: "dbeaver",    desc: "universal db gui (flatpak)", flatpak: "io.dbeaver.DBeaverCommunity" },
    // ── network & misc tools ──
    { id: "nettools",       cat: "Network & tools", label: "net tools", desc: "nmap, iperf3, mosh, rclone, dnsutils, netcat, traceroute, tcpdump, whois, wireguard-tools" },
    { id: "tailscale",      cat: "Network & tools", label: "tailscale", desc: "tailscale.com installer — run `tailscale up` inside the guest after" },
    { id: "adb",            cat: "Network & tools", label: "adb",       desc: "android platform tools (adb + fastboot)" },
    // ── ai ──
    { id: "ollama",         cat: "AI", label: "ollama", desc: "ollama.com installer — local llm runner + systemd service" },
];

/**
 * The "Developer" preset pre-checks this subset — sensible defaults for a
 * dev box, keeping the heavy/optional stuff (db servers, k3s, editors,
 * cloud sdks) opt-in.
 */
export const DEVTOOLS_PRESET: readonly DevTool[] = [
    "toolchain", "linters", "debug",
    "python", "uv", "node", "bun", "rust", "go", "java",
    "shell", "gh",
    "containers", "docker",
    "nettools",
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
    { id: "cli-tools",     pkgs: { ...deb(["curl", "wget", "git", "htop", "rsync", "unzip", "zip", "xz-utils",
                                           "ca-certificates", "gnupg"]),
                                   fedora: ["curl", "wget2", "git", "htop", "rsync", "unzip", "zip", "xz",
                                            "ca-certificates", "gnupg2"] } },
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
                           // spectacle doubles as the headless screenshot path
                           // for `vm screenshot --guest` (KWin blesses it —
                           // its ScreenShot2 dbus iface denies other callers).
                           pkgs: { ...deb(["dolphin", "konsole", "systemsettings", "ark", "kwrite", "kde-spectacle"]),
                                   fedora: ["dolphin", "konsole", "plasma-systemsettings", "ark", "kwrite", "spectacle"] } },
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
    { id: "dev-uv",        stages: ["setup"], when: dev("uv"), pkgs: ["uv", "pipx"] },
    { id: "dev-rust",      stages: ["setup"], when: dev("rust"),
                           pkgs: { ...deb(["rustc", "cargo", "rustfmt", "rust-clippy"]),
                                   fedora: ["rust", "cargo", "rustfmt", "clippy"] } },
    { id: "dev-go",        stages: ["setup"], when: dev("go"), pkgs: "golang" },
    { id: "dev-ruby",      stages: ["setup"], when: dev("ruby"),
                           pkgs: { ...deb(["ruby-full", "ruby-dev"]), fedora: ["ruby", "ruby-devel", "rubygems"] } },
    { id: "dev-java",      stages: ["setup"], when: dev("java"),
                           pkgs: { ...deb("default-jdk"), fedora: "java-latest-openjdk-devel" } },
    { id: "dev-jvmbuild",  stages: ["setup"], when: dev("jvmbuild"), pkgs: ["maven", "gradle"] },
    { id: "dev-kotlin",    stages: ["setup"], when: dev("kotlin"), pkgs: "kotlin" },
    { id: "dev-php",       stages: ["setup"], when: dev("php"),
                           pkgs: { ...deb(["php-cli", "php-xml", "php-mbstring", "php-curl", "composer"]),
                                   fedora: ["php-cli", "php-xml", "php-mbstring", "composer"] } },
    { id: "dev-elixir",    stages: ["setup"], when: dev("elixir"), pkgs: ["elixir", "erlang"] },
    { id: "dev-containers", stages: ["setup"], when: dev("containers"),
                           pkgs: ["podman", "buildah", "distrobox", "podman-compose"] },
    { id: "dev-docker",    stages: ["setup"], when: dev("docker"),
                           pkgs: { ...deb(["docker.io", "docker-compose-v2", "docker-buildx"]),
                                   fedora: ["moby-engine", "docker-compose", "docker-buildx"] } },
    { id: "dev-virtman",   stages: ["setup"], when: dev("virtmanager"),
                           pkgs: { ...deb(["libvirt-daemon-system", "virt-manager", "virtinst",
                                           "libvirt-clients", "qemu-kvm", "qemu-utils"]),
                                   fedora: ["libvirt", "virt-manager", "virt-install", "qemu-kvm",
                                            "qemu-img", "virt-viewer"] } },
    { id: "dev-helm",      stages: ["setup"], when: dev("helm"), pkgs: "helm" },
    { id: "dev-cloudcli",  stages: ["setup"], when: dev("cloudcli"), pkgs: "awscli" },
    { id: "dev-terraform", stages: ["setup"], when: dev("terraform"), pkgs: "terraform" },   // upstream repo adds it anyway; distro name is the cheap path
    { id: "dev-vagrant",   stages: ["setup"], when: dev("vagrant"), pkgs: "vagrant" },       // same — hashicorp repo covers releases the distro doesn't
    { id: "dev-ansible",   stages: ["setup"], when: dev("ansible"), pkgs: "ansible" },
    { id: "dev-sqlite",    stages: ["setup"], when: dev("sqlite"), pkgs: ["sqlite3", "litecli"] },
    { id: "dev-mysql",     stages: ["setup"], when: dev("mysql"),
                           pkgs: { ...deb(["mysql-server", "mysql-client", "mycli"]),
                                   fedora: ["community-mysql-server", "community-mysql", "mycli"] } },
    { id: "dev-postgres",  stages: ["setup"], when: dev("postgres"),
                           pkgs: { ...deb(["postgresql", "postgresql-contrib", "pgcli"]),
                                   fedora: ["postgresql-server", "postgresql-contrib", "pgcli"] } },
    { id: "dev-redis",     stages: ["setup"], when: dev("redis"),
                           pkgs: { ...deb(["redis-server", "redis-tools"]), fedora: "redis" } },
    { id: "dev-neovim",    stages: ["setup"], when: dev("neovim"), pkgs: "neovim" },
    { id: "dev-emacs",     stages: ["setup"], when: dev("emacs"), pkgs: "emacs" },
    { id: "dev-adb",       stages: ["setup"], when: dev("adb"),
                           // both naming eras — the candidate filter picks whichever ships
                           pkgs: { ...deb(["adb", "fastboot", "android-tools-adb", "android-tools-fastboot",
                                           "android-sdk-platform-tools-common"]),
                                   fedora: "android-tools" } },
    { id: "dev-nettools",  stages: ["setup"], when: dev("nettools"),
                           pkgs: { ...deb(["nmap", "iperf3", "mosh", "rclone", "dnsutils", "netcat-openbsd",
                                           "traceroute", "whois", "tcpdump", "wireguard-tools", "net-tools",
                                           "iputils-ping", "iputils-arping"]),
                                   fedora: ["nmap", "iperf3", "mosh", "rclone", "bind-utils", "nmap-ncat",
                                            "traceroute", "whois", "tcpdump", "wireguard-tools", "net-tools"] } },
    { id: "dev-fzf",       stages: ["setup"], when: dev("fzf"), pkgs: "fzf" },
    { id: "dev-tmux",      stages: ["setup"], when: dev("tmux"), pkgs: "tmux" },
    { id: "dev-tree",      stages: ["setup"], when: dev("tree"), pkgs: "tree" },
    { id: "dev-linters",   stages: ["setup"], when: dev("linters"),
                           pkgs: { ...deb(["shellcheck", "yamllint", "clang-format", "clang-tidy"]),
                                   fedora: ["ShellCheck", "yamllint", "clang-tools-extra"] } },
    { id: "dev-debug",     stages: ["setup"], when: dev("debug"),
                           pkgs: { ubuntu: ["gdb", "strace", "ltrace", "valgrind", "linux-tools-generic"],
                                   debian: ["gdb", "strace", "ltrace", "valgrind", "linux-perf"],
                                   fedora: ["gdb", "strace", "ltrace", "valgrind", "perf"] } },
    { id: "dev-shell",     stages: ["setup"], when: dev("shell"),
                           pkgs: { ...deb(["jq", "ripgrep", "fd-find", "fzf", "tmux", "tree", "btop",
                                           "bat", "eza", "zoxide", "git-delta", "hyperfine", "ncdu",
                                           "direnv", "zellij", "lazygit", "glab", "xh"]),
                                   fedora: ["jq", "ripgrep", "fd-find", "fzf", "tmux", "tree", "btop",
                                            "bat", "eza", "zoxide", "git-delta", "hyperfine", "ncdu",
                                            "direnv", "zellij", "lazygit", "glab", "xh"] } },
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

/** Flathub app ids to install (browser dropdown + flatpak devtools). */
export function resolveFlatpaks(p: GuestProfile): string[] {
    const out = p.browser === "none" ? [] : [BROWSER_FLATPAK[p.browser]];
    DEVTOOLS.forEach((t) => {
        if (t.flatpak && p.devtools.includes(t.id)) out.push(t.flatpak);
    });
    return [...new Set(out)];
}
