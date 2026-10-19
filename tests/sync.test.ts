import { describe, expect, test } from "bun:test";
import { defaultSpec, parseVmSpec } from "../libraries/vm-core/src/config/schema";
import { guestLayoutFromHost } from "../libraries/provision/src/monitors";
import {
    AgentForward, guestAccentScript, guestAgentEnvScript, guestCaCertsScript,
    guestClipBridgeScript, guestContrastScript, guestGitKeyScript, guestGitScript,
    guestKeyboardScript, guestLocaleScript, guestMonitorScript, guestProxyScript,
    guestSyncScript, guestTimezoneScript, nearestGnomeAccent, syncEnabled, SYNC_IDS,
} from "../libraries/provision/src/sync";

const spec = () => defaultSpec("testvm");

describe("sync schema", () => {
    test("defaults: ten true, five security-sensitive false", () => {
        const s = spec().sync;
        (["theme", "accentColor", "contrast", "timezone", "locale", "keyboard", "monitors", "hostWallpaper", "scale", "shares"] as const)
            .forEach((id) => expect(s[id]).toBe(true));
        (["gitIdentity", "proxy", "caCerts", "sshAgent", "gitKey"] as const)
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
    test("credentials.sshAgentKeys defaults empty + survives parsing", () => {
        expect(spec().credentials.sshAgentKeys).toEqual([]);
        const s = parseVmSpec({ name: "ok", credentials: { sshAgentKeys: ["/k/a", "/k/b"] } });
        expect(s.credentials.sshAgentKeys).toEqual(["/k/a", "/k/b"]);
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
    test("git key: installs a 0600 key + managed ssh config block", () => {
        const sh = guestGitKeyScript(spec(), {
            priv: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
            pub: "ssh-ed25519 AAAA test@x",
        });
        expect(sh).toContain("cruiser-git-key");
        expect(sh).toContain("chmod 600 \"$UHOME/.ssh/cruiser-git-key\"");
        expect(sh).toContain("# >>> cruiser-git-key >>>");
        expect(sh).toContain("Host github.com gitlab.com bitbucket.org");
        expect(sh).toContain("IdentitiesOnly yes");
        expect(sh).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    });
    test("clip bridge: wl-paste→xclip autostart + mid-session launcher", () => {
        const sh = guestClipBridgeScript(spec());
        expect(sh).toContain("cruiser-clipbridge.desktop");
        expect(sh).toContain("wl-paste --type text --watch");
        expect(sh).toContain("xclip -selection clipboard -i");
        expect(sh).toContain("cruiser-clip-launch");
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

describe("hostSshKeys detection", () => {
    test("lists private keys only — pubs, config, and junk files are skipped", async () => {
        const { mkdir, writeFile, rm } = await import("node:fs/promises");
        const { hostSshKeys } = await import("../libraries/host-int/src/hoststate");
        const dir = `/var/tmp/cruiser-test-keys-${process.pid}`;
        try {
            await mkdir(dir, { recursive: true });
            await writeFile(`${dir}/id_ed25519`, "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n");
            await writeFile(`${dir}/id_ed25519.pub`, "ssh-ed25519 AAAA me@host\n");
            await writeFile(`${dir}/deploy`, "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n");
            await writeFile(`${dir}/config`, "Host *\n  AddKeysToAgent yes\n");
            await writeFile(`${dir}/known_hosts`, "github.com ssh-ed25519 AAAA\n");
            await writeFile(`${dir}/notes.txt`, "not a key\n");
            const ks = await hostSshKeys(dir);
            expect(ks.map((k) => k.path)).toEqual([`${dir}/deploy`, `${dir}/id_ed25519`]);
            expect(ks.find((k) => k.path.endsWith("id_ed25519"))!.label).toBe("id_ed25519 — me@host");
            expect(ks.find((k) => k.path.endsWith("/deploy"))!.label).toBe("deploy");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
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
