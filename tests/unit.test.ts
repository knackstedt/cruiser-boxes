import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { rm } from "node:fs/promises";
import { defaultSpec, parseVmSpec } from "../libraries/vm-core/src/config/schema";
import { diskPath, VMS_DIR } from "../libraries/vm-core/src/paths";
import { join } from "node:path";
import { JsonSocket } from "../libraries/vm-core/src/qmp/socket-json";
import { guestLayoutFromHost } from "../libraries/provision/src/monitors";
import { profileFromSpec, resolvePackages, resolveFlatpaks } from "../libraries/provision/src/packages";
import { guestSetupScript } from "../libraries/provision/src/guest-setup";
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
        expect(parseVmSpec({ name: "ok", os: { desktop: "kde", snap: true } }).os.desktop).toBe("kde");
    });
});

// ── guest package manifest ──

describe("packages", () => {
    const p = (o: Partial<ReturnType<typeof profileFromSpec>> = {}) =>
        ({ family: "ubuntu", desktop: "gnome", browser: "none", snap: false, extraFonts: false, extraPackages: [], ...o }) as const;
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
        expect(sh).toContain("apt-get install -y $WANTED");
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
    test("browser + snap get their own sections", () => {
        const sh = guestSetupScript(spec((s) => { s.os.browser = "vivaldi"; s.os.snap = true; }), { rdpPassword: "pw" });
        expect(sh).toContain("com.vivaldi.Vivaldi");
        expect(sh).toContain("flathub.flatpakrepo");
        expect(sh).toContain("snapd.socket");
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
