import { describe, expect, test } from "bun:test";
import { defaultSpec, parseVmSpec } from "../libraries/vm-core/src/config/schema";
import { guestLayoutFromHost } from "../libraries/provision/src/monitors";
import {
    AgentForward, guestAccentScript, guestAgentEnvScript, guestCaCertsScript,
    guestContrastScript, guestGitScript, guestKeyboardScript, guestLocaleScript,
    guestMonitorScript, guestProxyScript, guestSyncScript, guestTimezoneScript,
    nearestGnomeAccent, syncEnabled, SYNC_IDS,
} from "../libraries/provision/src/sync";

const spec = () => defaultSpec("testvm");

describe("sync schema", () => {
    test("defaults: eight true, four security-sensitive false", () => {
        const s = spec().sync;
        (["theme", "accentColor", "contrast", "timezone", "locale", "keyboard", "monitors", "hostWallpaper"] as const)
            .forEach((id) => expect(s[id]).toBe(true));
        (["gitIdentity", "proxy", "caCerts", "sshAgent"] as const)
            .forEach((id) => expect(s[id]).toBe(false));
    });
    test("old vm.json without sync parses with defaults", () => {
        const s = parseVmSpec({ name: "ok" });
        expect(s.sync.theme).toBe(true);
        expect(s.sync.sshAgent).toBe(false);
    });
    test("explicit values survive parsing", () => {
        const s = parseVmSpec({ name: "ok", sync: { sshAgent: true, theme: false } });
        expect(s.sync.sshAgent).toBe(true);
        expect(s.sync.theme).toBe(false);
    });
});

describe("syncEnabled", () => {
    const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
    test("spec flag + env gates", () => {
        const s = spec();
        expect(syncEnabled(s, "theme", {})).toBe(true);
        expect(syncEnabled(s, "theme", env({ CRUISER_HOST_SYNC: "0" }))).toBe(false);
        expect(syncEnabled(s, "theme", env({ CRUISER_SYNC_THEME: "0" }))).toBe(false);
        expect(syncEnabled(s, "timezone", env({ CRUISER_SYNC_TIMEZONE: "0" }))).toBe(false);
    });
    test("CRUISER_THEME_SYNC=0 honored for back-compat", () => {
        expect(syncEnabled(spec(), "theme", env({ CRUISER_THEME_SYNC: "0" }))).toBe(false);
        expect(syncEnabled(spec(), "accentColor", env({ CRUISER_THEME_SYNC: "0" }))).toBe(true);
    });
    test("spec-off channels stay off regardless", () => {
        expect(syncEnabled(spec(), "sshAgent", {})).toBe(false);
    });
    test("SYNC_IDS covers every spec.sync key", () => {
        expect(new Set(SYNC_IDS)).toEqual(new Set(Object.keys(spec().sync)));
    });
});

describe("guest scripts", () => {
    test("timezone: timedatectl + zoneinfo fallback", () => {
        const sh = guestTimezoneScript("Europe/Berlin");
        expect(sh).toContain("timedatectl set-timezone 'Europe/Berlin'");
        expect(sh).toContain("/usr/share/zoneinfo/Europe/Berlin");
    });
    test("timezone sanitizes path traversal", () => {
        const sh = guestTimezoneScript("../etc/evil");
        expect(sh).not.toContain("../etc/evil");
    });
    test("locale: localectl + /etc/default/locale, sanitized", () => {
        const sh = guestLocaleScript("de_DE.UTF-8");
        expect(sh).toContain("localectl set-locale LANG='de_DE.UTF-8'");
        expect(sh).toContain("/etc/default/locale");
        expect(sh).not.toContain("$(");  // nothing dynamic injected
    });
    test("keyboard: localectl + DE input paths, variant folds into xkb id", () => {
        const sh = guestKeyboardScript(spec(), { layout: "de", variant: "neo", options: "ctrl:nocaps" });
        expect(sh).toContain("localectl set-keymap 'de'");
        expect(sh).toContain("set-x11-keymap 'de' '' 'neo' 'ctrl:nocaps'");
        expect(sh).toContain("('xkb', 'de+neo')");
        expect(sh).toContain("kxkbrc");
    });
    test("accent: quantizes to a GNOME enum and writes KDE rgb", () => {
        const sh = guestAccentScript(spec(), { r: 0.9, g: 0.1, b: 0.2 });
        expect(sh).toContain("accent-color 'red'");
        expect(sh).toContain(`AccentColor '${Math.round(0.9 * 255)},${Math.round(0.1 * 255)},${Math.round(0.2 * 255)}'`);
    });
    test("nearestGnomeAccent sanity", () => {
        expect(nearestGnomeAccent({ r: 0.2, g: 0.5, b: 0.9 })).toBe("blue");
        expect(nearestGnomeAccent({ r: 0.9, g: 0.9, b: 0.9 })).toBe("slate");
    });
    test("contrast: gnome a11y key + kde colorscheme both ways", () => {
        const hi = guestContrastScript(spec(), true, "dark");
        expect(hi).toContain("high-contrast true");
        expect(hi).toContain("BreezeHighContrast");
        const lo = guestContrastScript(spec(), false, "dark");
        expect(lo).toContain("high-contrast false");
        expect(lo).toContain("BreezeDark");
    });
    test("git identity: runuser git config, only set fields", () => {
        const sh = guestGitScript(spec(), { name: "Ada Lovelace", email: "ada@example.com" });
        expect(sh).toContain("git config --global user.name 'Ada Lovelace'");
        expect(sh).toContain("git config --global user.email 'ada@example.com'");
        const partial = guestGitScript(spec(), { name: "Ada" });
        expect(partial).not.toContain("user.email");
    });
    test("proxy manual: gsettings + kioslaverc + env block", () => {
        const sh = guestProxyScript(spec(), {
            mode: "manual", http: "proxy.local:8080", https: "proxy.local:8443",
            noProxy: ["localhost", "*.lan"],
        });
        expect(sh).toContain("org.gnome.system.proxy mode 'manual'");
        expect(sh).toContain("proxy.local:8080");
        expect(sh).toContain("kioslaverc");
        expect(sh).toContain("cruiser-proxy.sh");
        expect(sh).toContain("no_proxy=localhost,*.lan");
    });
    test("proxy none: strips previous env", () => {
        const sh = guestProxyScript(spec(), { mode: "none", noProxy: [] });
        expect(sh).toContain("rm -f /etc/profile.d/cruiser-proxy.sh");
        expect(sh).toContain("ProxyType 0");
    });
    test("ca certs: both trust families gated", () => {
        const sh = guestCaCertsScript();
        expect(sh).toContain("/usr/local/share/ca-certificates/cruiser");
        expect(sh).toContain("update-ca-certificates");
        expect(sh).toContain("/etc/pki/ca-trust/source/anchors/cruiser");
        expect(sh).toContain("update-ca-trust");
    });
    test("monitors: xml lands under the user's .config", () => {
        const sh = guestMonitorScript(spec());
        expect(sh).toContain(".config/monitors.xml");
        expect(sh).toContain("/tmp/cruiser-monitors.xml");
    });
    test("agent env: SSH_AUTH_SOCK into /etc/environment + profile.d", () => {
        const sh = guestAgentEnvScript(spec());
        expect(sh).toContain("SSH_AUTH_SOCK");
        expect(sh).toContain("cruiser-agent.sock");
        expect(sh).toContain("/etc/profile.d/cruiser-agent.sh");
    });
    test("guestSyncScript composes only resolved channels", () => {
        const all = guestSyncScript(spec(), {
            timezone: "UTC", locale: "en_US.UTF-8",
            keyboard: { layout: "us" }, scheme: "dark",
            accent: { r: 0, g: 0, b: 1 }, contrast: false,
        });
        ["timedatectl", "localectl set-locale", "set-x11-keymap", "color-scheme", "accent-color", "high-contrast"]
            .forEach((frag) => expect(all).toContain(frag));
        const sparse = guestSyncScript(spec(), { timezone: "UTC" });
        expect(sparse).toContain("timedatectl");
        expect(sparse).not.toContain("localectl");
    });
});

describe("AgentForward argv", () => {
    test("builds -N -R forward with keepalive + forward-failure exit", () => {
        const s = spec();
        s.network.sshPort = 2222;
        s.credentials.username = "cruiser";
        const a = AgentForward.argv(s, "/home/cruiser/.ssh/cruiser-agent.sock", "/run/user/1000/agent.sock", "/k");
        expect(a).toContain("-N");
        expect(a).toContain("-R");
        expect(a[a.indexOf("-R") + 1]).toBe("/home/cruiser/.ssh/cruiser-agent.sock:/run/user/1000/agent.sock");
        expect(a).toContain("ExitOnForwardFailure=yes");
        expect(a).toContain("ServerAliveInterval=15");
        expect(a).toContain("cruiser@127.0.0.1");
        expect(a).toContain("2222");
    });
    test("throws without an ssh port", () => {
        const s = spec();
        s.network.sshPort = undefined;
        expect(() => AgentForward.argv(s, "/a", "/b", "/k")).toThrow();
    });
});

describe("monitors.xml scale/rate", () => {
    test("emits probed scale + refresh, falls back to 1/60", () => {
        const { xml } = guestLayoutFromHost("vm", [
            { name: "DP-1", x: 0, y: 0, w: 3840, h: 2160, primary: true, scale: 2, refresh: 144 },
            { name: "DP-2", x: 3840, y: 0, w: 1920, h: 1080, primary: false },
        ]);
        expect(xml).toContain("<scale>2</scale>");
        expect(xml).toContain("<rate>144.000</rate>");
        expect(xml).toContain("<scale>1</scale>");
        expect(xml).toContain("<rate>60.000</rate>");
    });
});
