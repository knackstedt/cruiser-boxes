import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { rm } from "node:fs/promises";
import { defaultSpec, parseVmSpec } from "../libraries/vm-core/src/config/schema";
import { JsonSocket } from "../libraries/vm-core/src/qmp/socket-json";
import { guestLayoutFromHost } from "../libraries/provision/src/monitors";
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
