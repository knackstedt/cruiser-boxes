import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { rm, writeFile } from "node:fs/promises";
import { defaultSpec, parseVmSpec } from "../libraries/vm-core/src/config/schema";
import { diskPath, VMS_DIR, vmPaths } from "../libraries/vm-core/src/paths";
import { appendVmLog, journalArgs, tailFile, runnerLogFiles } from "../libraries/vm-core/src/logs";
import { join } from "node:path";
import { JsonSocket } from "../libraries/vm-core/src/qmp/socket-json";
import { guestLayoutFromHost } from "../libraries/provision/src/monitors";
import { profileFromSpec, resolvePackages, resolveFlatpaks, DEVTOOLS } from "../libraries/provision/src/packages";
import { guestSetupScript } from "../libraries/provision/src/guest-setup";
import { guestThemeScript } from "../libraries/provision/src/theme";
import { pickImageFromIndex, supportsKrdp, defaultRelease } from "../libraries/provision/src/distros";
import { freerdpArgs } from "../libraries/host-int/src/freerdp";
import { parseEscapeAction } from "../libraries/host-int/src/session";
import { kdeKeys } from "../libraries/host-int/src/kde";

// ── schema ──

describe("VmSpec", () => {
    test("defaults fill in", () => {
        const s = defaultSpec("abc");
        expect(s.version).toBe(1);
        expect(s.resources.cpus).toBe(4);
        expect(s.display.headMode).toBe("virtual-desktop");
        expect(s.persist).toBe("daemonize");
        expect(s.network.vsock).toBe(true);
    });
    test("rejects bad names / values", () => {
        expect(() => parseVmSpec({ name: "Bad Name" })).toThrow();
        expect(() => parseVmSpec({ name: "ok", gpu: { mode: "nvidia" } })).toThrow();
    });
    test("ephemeral persist + imported provision parse", () => {
        const s = parseVmSpec({
            name: "ok",
            persist: "ephemeral",
            provisioned: { method: "imported", source: "/data/img.qcow2" },
        });
        expect(s.persist).toBe("ephemeral");
        expect(s.provisioned.method).toBe("imported");
    });
    test("absolute disk.file survives parsing", () => {
        const s = parseVmSpec({ name: "ok", disk: { file: "/mnt/fast/vm.qcow2" } });
        expect(s.disk.file).toBe("/mnt/fast/vm.qcow2");
    });
    test("os block prefaults to ubuntu/gnome", () => {
        const s = defaultSpec("abc");
        expect(s.os.family).toBe("ubuntu");
        expect(s.os.desktop).toBe("gnome");
        expect(s.os.browser).toBe("none");
        expect(s.os.snap).toBe(false);
        expect(s.os.autologin).toBe(true);
        expect(parseVmSpec({ name: "ok", os: { desktop: "kde", snap: true } }).os.desktop).toBe("kde");
    });
});

// ── guest package manifest ──

describe("packages", () => {
    const p = (o: Partial<ReturnType<typeof profileFromSpec>> = {}) =>
        ({ family: "ubuntu", desktop: "gnome", browser: "none", snap: false, extraFonts: false, autologin: true, devtools: [], extraPackages: [], ...o }) as const;
    test("core stack lands on every distro + stage", () => {
        (["ubuntu", "debian", "fedora"] as const).forEach((family) => {
            (["seed", "setup"] as const).forEach((stage) => {
                const pkgs = resolvePackages(p({ family }), stage);
                expect(pkgs).toContain("qemu-guest-agent");
                expect(pkgs).toContain("openssh-server");
                expect(pkgs).toContain("pipewire");
                expect(pkgs).toContain("waypipe");
                expect(pkgs).toContain("flatpak");
            });
        });
    });
    test("per-family package names resolve", () => {
        expect(resolvePackages(p({ family: "debian" }), "setup")).toContain("cloud-guest-utils");
        expect(resolvePackages(p({ family: "fedora" }), "setup")).toContain("cloud-utils-growpart");
        expect(resolvePackages(p({ family: "fedora" }), "setup")).toContain("pipewire-pulseaudio");
        expect(resolvePackages(p({ family: "ubuntu" }), "setup")).not.toContain("pipewire-pulseaudio");
    });
    test("desktop scoping swaps the DE stack", () => {
        const gnome = resolvePackages(p({}), "setup");
        expect(gnome).toContain("gnome-remote-desktop");
        expect(gnome).not.toContain("krdp");
        const kde = resolvePackages(p({ desktop: "kde" }), "setup");
        expect(kde).toContain("krdp");
        expect(kde).toContain("plasma-discover");
        expect(kde).not.toContain("gnome-remote-desktop");
    });
    test("ubuntu gnome gets the ubuntu session baseline", () => {
        const gnome = resolvePackages(p({}), "setup");
        expect(gnome).toContain("ubuntu-session");
        expect(gnome).toContain("gnome-shell-extension-ubuntu-dock");
        expect(resolvePackages(p({ family: "debian" }), "setup")).not.toContain("ubuntu-session");
        expect(resolvePackages(p({ desktop: "kde" }), "setup")).not.toContain("ubuntu-session");
    });
    test("snap + extraFonts + extraPackages are conditional", () => {
        expect(resolvePackages(p({}), "setup")).not.toContain("snapd");
        expect(resolvePackages(p({ snap: true }), "setup")).toContain("snapd");
        expect(resolvePackages(p({}), "setup")).not.toContain("fonts-noto-cjk");
        expect(resolvePackages(p({ extraFonts: true }), "setup")).toContain("fonts-noto-cjk");
        // MS core fonts are setup-only (debconf EULA preseed)
        expect(resolvePackages(p({ extraFonts: true }), "seed")).not.toContain("ttf-mscorefonts-installer");
        expect(resolvePackages(p({ extraFonts: true }), "setup")).toContain("ttf-mscorefonts-installer");
        expect(resolvePackages(p({ extraPackages: ["emacs"] }), "setup")).toContain("emacs");
    });
    test("browser resolves to a flathub id", () => {
        expect(resolveFlatpaks(p({}))).toEqual([]);
        expect(resolveFlatpaks(p({ browser: "firefox" }))).toEqual(["org.mozilla.firefox"]);
        expect(resolveFlatpaks(p({ browser: "brave" }))).toEqual(["com.brave.Browser"]);
    });
    test("devtools groups are opt-in and setup-stage only", () => {
        expect(resolvePackages(p({}), "setup")).not.toContain("build-essential");
        const dev = resolvePackages(p({ devtools: ["toolchain"] }), "setup");
        expect(dev).toContain("build-essential");
        expect(dev).toContain("cmake");
        // devtools never land in the seed — a stale name can't abort cloud-init
        expect(resolvePackages(p({ devtools: ["toolchain"] }), "seed")).not.toContain("build-essential");
    });
    test("devtools resolve per family", () => {
        const deb = resolvePackages(p({ family: "debian", devtools: ["toolchain", "rust"] }), "setup");
        expect(deb).toContain("build-essential");
        expect(deb).toContain("rust-clippy");
        const rpm = resolvePackages(p({ family: "fedora", devtools: ["toolchain", "rust", "linters"] }), "setup");
        expect(rpm).toContain("gcc-c++");
        expect(rpm).toContain("clippy");
        expect(rpm).toContain("ShellCheck");
        expect(rpm).not.toContain("build-essential");
        // every DEVTOOLS id must have a manifest entry — a toggle that
        // installs nothing is a silent bug
        DEVTOOLS.forEach((t) => {
            const withT = resolvePackages(p({ devtools: [t.id] }), "setup");
            const without = resolvePackages(p({}), "setup");
            expect(withT.length).toBeGreaterThan(without.length);
        });
    });
});

// ── guest-setup script ──

describe("guestSetupScript", () => {
    const spec = (mut: (s: ReturnType<typeof defaultSpec>) => void = () => {}) => {
        const s = defaultSpec("t1"); s.credentials.username = "u"; mut(s); return s;
    };
    test("gnome emits the grd system-daemon path", () => {
        const sh = guestSetupScript(spec(), { rdpPassword: "pw" });
        expect(sh).toContain("gnome-remote-desktop");
        expect(sh).toContain("grdctl --system rdp enable");
        expect(sh).toContain("gnome-remote-desktop.service.d/after-dm.conf");
        expect(sh).toContain("After=display-manager.service");
        expect(sh).toContain("apt-get install -y $PKGS");
        expect(sh).toContain("dnf install -y --skip-unavailable $WANTED"); // imported-disk detect
        expect(sh).not.toContain("krdpserverrc");
        expect(sh).toContain("CRUISER_GUEST_SETUP_OK");
    });
    test("kde emits krdp + sddm autologin instead", () => {
        const sh = guestSetupScript(spec((s) => { s.os.desktop = "kde"; }), { rdpPassword: "pw" });
        expect(sh).toContain("krdpserverrc");
        expect(sh).toContain("SystemUserEnabled true");
        expect(sh).toContain("sddm.conf.d");
        expect(sh).not.toContain("gnome-remote-desktop.service");
    });
    test("autologin defaults on and writes the DM config", () => {
        const sh = guestSetupScript(spec(), { rdpPassword: "pw" });
        expect(sh).toContain("AutomaticLoginEnable=true");
        expect(sh).toContain("AutomaticLogin=u");
    });
    test("autologin off flips gdm off and drops the sddm conf", () => {
        const g = guestSetupScript(spec((s) => { s.os.autologin = false; }), { rdpPassword: "pw" });
        expect(g).toContain("AutomaticLoginEnable=false");
        expect(g).not.toContain("AutomaticLoginEnable=true");
        const k = guestSetupScript(spec((s) => { s.os.desktop = "kde"; s.os.autologin = false; }), { rdpPassword: "pw" });
        expect(k).toContain("rm -f /etc/sddm.conf.d/cruiser.conf");
        expect(k).not.toContain("AutomaticLogin");
        // no console login means no Plasma session — warn, don't fail the run
        expect(k).toContain("autologin is off");
        expect(k).not.toContain("systemctl restart sddm");
    });
    test("browser + snap get their own sections", () => {
        const sh = guestSetupScript(spec((s) => { s.os.browser = "vivaldi"; s.os.snap = true; }), { rdpPassword: "pw" });
        expect(sh).toContain("com.vivaldi.Vivaldi");
        expect(sh).toContain("flathub.flatpakrepo");
        expect(sh).toContain("snapd.socket");
    });
    test("host colorScheme bakes a theme section; absent by default", () => {
        const dark = guestSetupScript(spec(), { rdpPassword: "pw", colorScheme: "dark" });
        expect(dark).toContain("org.gnome.desktop.interface color-scheme 'prefer-dark'");
        expect(dark).toContain("plasma-apply-colorscheme BreezeDark");
        const light = guestSetupScript(spec(), { rdpPassword: "pw", colorScheme: "light" });
        expect(light).toContain("color-scheme 'default'");
        expect(light).toContain("plasma-apply-colorscheme BreezeLight");
        const none = guestSetupScript(spec(), { rdpPassword: "pw" });
        expect(none).not.toContain("color-scheme");
        expect(none).not.toContain("plasma-apply-colorscheme");
    });
});

// ── guest theme script ──

describe("guestThemeScript", () => {
    test("guarded both-DE script, per-scheme values", () => {
        const s = defaultSpec("t1"); s.credentials.username = "u";
        const dark = guestThemeScript(s, "dark");
        expect(dark).toContain("'prefer-dark'");
        expect(dark).toContain("BreezeDark");
        expect(dark).toContain("dbus-run-session");     // pre-login fallback
        expect(dark).toContain("|| true");              // set -eu safe
        const light = guestThemeScript(s, "light");
        expect(light).toContain("'default'");
        expect(light).toContain("BreezeLight");
    });
});

// ── distro matrix ──

describe("distros", () => {
    test("krdp support is release-gated", () => {
        expect(supportsKrdp("ubuntu", "26.04")).toBe(true);
        expect(supportsKrdp("ubuntu", "24.04")).toBe(false);
        expect(supportsKrdp("fedora", "44")).toBe(true);
        expect(defaultRelease("ubuntu")).toBe("26.04");
    });
    test("pickImageFromIndex grabs the newest match", () => {
        const idx = `<a href="Fedora-Cloud-Base-Generic-43-1.2.x86_64.qcow2">x</a>
                     <a href="Fedora-Cloud-Base-Generic-43-1.10.x86_64.qcow2">y</a>
                     <a href="../">up</a>`;
        expect(pickImageFromIndex(idx, /^Fedora-Cloud-Base-Generic-\d+-[\d.]+\.x86_64\.qcow2$/))
            .toBe("Fedora-Cloud-Base-Generic-43-1.10.x86_64.qcow2");
        const dIdx = `<a href="debian-13-genericcloud-amd64.qcow2">x</a>
                      <a href="debian-13-nocloud-amd64.qcow2">y</a>`;
        expect(pickImageFromIndex(dIdx, /^debian-\d+-genericcloud-amd64\.qcow2$/))
            .toBe("debian-13-genericcloud-amd64.qcow2");
        expect(pickImageFromIndex("<a href=\"nothing\">", /^debian/)).toBeNull();
    });
});

describe("diskPath", () => {
    test("relative file resolves under the vm dir; absolute passes through", () => {
        const rel = defaultSpec("t1");
        expect(diskPath(rel)).toBe(join(VMS_DIR, "t1", "disk.qcow2"));
        const abs = parseVmSpec({ name: "t2", disk: { file: "/mnt/fast/d.qcow2" } });
        expect(diskPath(abs)).toBe("/mnt/fast/d.qcow2");
    });
});

// ── JsonSocket (QMP/QGA framing) ──

describe("JsonSocket", () => {
    test("request/response round-trip over unix socket", async () => {
        const path = `/var/tmp/cruiser-test-${process.pid}.sock`;
        const srv = createServer((c: Socket) => {
            // delay the greeting a beat so expectFirst() is registered first
            setTimeout(() => c.write(JSON.stringify({ QMP: { version: {} } }) + "\n"), 30);
            let buf = "";
            c.on("data", (d) => {
                buf += d.toString();
                if (!buf.includes("\n")) return;
                const req = JSON.parse(buf.trim()); buf = "";
                const rid = req.id;
                if (req.execute === "qmp_capabilities") c.write(JSON.stringify({ return: {}, id: rid }) + "\n");
                else if (req.execute === "query-status") c.write(JSON.stringify({ return: { status: "running", running: true }, id: rid }) + "\n");
                else if (req.execute === "bad") c.write(JSON.stringify({ error: { class: "X", desc: "boom" }, id: rid }) + "\n");
            });
        });
        await new Promise((r) => srv.listen(path, r));
        try {
            // greet + handshake like QmpClient does
            const sock = await JsonSocket.open(path);
            const greeting = await sock.expectFirst();
            expect(greeting.QMP).toBeTruthy();
            await sock.send("qmp_capabilities");
            const st = await sock.send("query-status");
            expect(st.status).toBe("running");
            await expect(sock.send("bad")).rejects.toThrow("boom");
            sock.close();
        } finally {
            srv.close();
            await rm(path, { force: true });
        }
    });
});

// ── monitors ──

describe("guestLayoutFromHost", () => {
    const host = [
        { name: "HDMI-1", x: 0, y: 1080, w: 3440, h: 1440, primary: true },
        { name: "DP-0", x: 1782, y: 0, w: 1920, h: 1080, primary: false },
    ];
    test("mirrors host count/coords to Virtual-N connectors", () => {
        const l = guestLayoutFromHost("t1", host);
        expect(l.monitors).toHaveLength(2);
        expect(l.monitors[0]).toEqual({ name: "t1-1", xres: 3440, yres: 1440 });
        expect(l.xml).toContain("<connector>Virtual-1</connector>");
        expect(l.xml).toContain("<x>1782</x>");
        expect(l.xml).toContain("<primary>yes</primary>");
    });
    test("caps at maxOutputs and falls back to 1920x1080", () => {
        expect(guestLayoutFromHost("t1", [...host, ...host], 2).monitors).toHaveLength(2);
        const l = guestLayoutFromHost("t1", []);
        expect(l.monitors[0].xres).toBe(1920);
    });
});

// ── freerdp argv ──

describe("freerdpArgs", () => {
    const spec = (m: string) => {
        const s = defaultSpec("t1");
        s.display.headMode = m as never;
        s.credentials.username = "u";
        return s;
    };
    test("virtual-desktop: /f + multimon + no grab", () => {
        const a = freerdpArgs(spec("virtual-desktop"), { rdpPort: 3390, password: "pw" });
        expect(a).toContain("/v:127.0.0.1:3390");
        expect(a).toContain("/u:u");
        expect(a).toContain("/p:pw");
        expect(a).toContain("/f");
        expect(a).toContain("/multimon");
        expect(a).toContain("-grab-keyboard");
    });
    test("windowed uses /size, no /f", () => {
        const a = freerdpArgs(spec("windowed"), { rdpPort: 1 });
        expect(a).toContain("/size:1600x1000");
        expect(a).not.toContain("/f");
    });
    test("named monitor → /monitor:name", () => {
        const s = spec("fullscreen-monitor");
        s.display.monitors = ["DP-4"];
        expect(freerdpArgs(s, { rdpPort: 1 })).toContain("/monitor:DP-4");
    });
    test("app mode throws (waypipe handles it)", () => {
        expect(() => freerdpArgs(spec("app"), { rdpPort: 1 })).toThrow("waypipe");
    });
    test("+grab-keyboard when grab enabled", () => {
        const s = spec("windowed"); s.display.grabKeyboard = true;
        expect(freerdpArgs(s, { rdpPort: 1 })).toContain("+grab-keyboard");
    });
});

// ── logs ──

describe("logs", () => {
    test("journalArgs builds the filtered command", () => {
        expect(journalArgs()).toEqual(["/usr/bin/journalctl", "--no-pager", "-o", "short-iso", "-n", "300"]);
        expect(journalArgs({ lines: 500, unit: "sshd.service", priority: "err", boot: -1, since: "1 hour ago", grep: "fail" }))
            .toEqual(["/usr/bin/journalctl", "--no-pager", "-o", "short-iso", "-n", "500",
                "-u", "sshd.service", "-p", "err", "-b", "-1", "--since", "1 hour ago", "-g", "fail"]);
    });
    test("journalArgs drops bogus priorities and clamps lines", () => {
        const a = journalArgs({ lines: 99999, priority: "bogus" });
        expect(a).toContain("5000");
        expect(a).not.toContain("bogus");
        expect(a).not.toContain("-p");
    });
    test("tailFile reads the last N lines", async () => {
        const p = `/var/tmp/cruiser-test-tail-${process.pid}.log`;
        await writeFile(p, Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n");
        try {
            const t = await tailFile(p, 5);
            const got = t.trim().split("\n");
            expect(got).toHaveLength(5);
            expect(got[4]).toBe("line 49");
        } finally {
            await rm(p, { force: true });
        }
    });
    test("tailFile bounds the read to the tail of a large file", async () => {
        const p = `/var/tmp/cruiser-test-tail-big-${process.pid}.log`;
        await writeFile(p, Array.from({ length: 20000 }, (_, i) => `${"x".repeat(60)} ${i}`).join("\n"));
        try {
            const t = await tailFile(p, 10, 5000);
            const got = t.trim().split("\n");
            expect(got).toHaveLength(10);
            expect(got[9]).toContain("19999");
        } finally {
            await rm(p, { force: true });
        }
    });
    test("runnerLogFiles lists the run-dir sources", () => {
        const files = runnerLogFiles(vmPaths("cruiser-test-no-such-vm"));
        expect(files.map((f) => f.id)).toEqual(["cruiser", "qemu", "serial", "install-serial"]);
        expect(files.every((f) => !f.exists)).toBe(true);
    });
    test("appendVmLog trims cruiser.log once it passes the cap", async () => {
        const dir = `/var/tmp/cruiser-test-vmlog-${process.pid}`;
        const runDir = join(dir, "run");
        const file = join(runDir, "cruiser.log");
        try {
            // ~300 KiB of numbered lines, well past the 256 KiB cap
            const lines = Array.from({ length: 6000 }, (_, i) => `old line ${i} ${"y".repeat(40)}`);
            const { mkdir } = await import("node:fs/promises");
            await mkdir(runDir, { recursive: true });
            await writeFile(file, lines.join("\n") + "\n");
            await appendVmLog({ run: runDir } as ReturnType<typeof vmPaths>, "latest event");
            const { stat, readFile } = await import("node:fs/promises");
            const { size } = await stat(file);
            expect(size).toBeLessThan(256 * 1024);
            const text = (await readFile(file, "utf-8"));
            expect(text.startsWith("… older log trimmed …\n")).toBe(true);
            expect(text.trimEnd().endsWith("latest event")).toBe(true);
            expect(text).not.toContain("old line 0 ");
            expect(text).toContain("old line 5999 ");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

// ── escape actions / keymaps ──

describe("escape shortcuts", () => {
    test("parseEscapeAction", () => {
        expect(parseEscapeAction("host-desktop:1")).toEqual({ kind: "host-desktop", index: 1 });
        expect(parseEscapeAction("desktop-cycle-left")).toEqual({ kind: "desktop-cycle", dir: -1 });
        expect(parseEscapeAction("ungrab")).toEqual({ kind: "ungrab" });
        expect(parseEscapeAction("bogus")).toBeNull();
    });
    test("kdeKeys normalizes", () => {
        expect(kdeKeys("ctrl+alt+delete")).toBe("Ctrl+Alt+Del");
        expect(kdeKeys("meta+ctrl+left")).toBe("Meta+Ctrl+Left");
    });
});
