// ============================================================================
// hoststate.ts — host → guest sync probes: the non-portal host state that
// mirror channels read. Every probe is best-effort (null/[] on failure) —
// a missing tool or an unreadable config must degrade the channel, never
// throw into a provision or a viewer-session start.
// ============================================================================

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { glob } from "node:fs/promises";
import { run, which } from "../../sys/src/exec";
import { hostColorScheme } from "./appearance";

/** Host timezone ("Europe/Berlin"). timedatectl first, /etc/localtime
 *  symlink as the no-systemd fallback. */
export async function hostTimezone(): Promise<string | null> {
    if (await which("timedatectl")) {
        const r = await run("timedatectl", ["show", "-p", "Timezone", "--value"], { noThrow: true, timeoutMs: 5_000 });
        const v = r.stdout.trim();
        if (r.code === 0 && /^[A-Za-z_]+\/[A-Za-z_+-]+/.test(v)) return v;
    }
    const r = await run("readlink", ["-f", "/etc/localtime"], { noThrow: true, timeoutMs: 5_000 });
    const m = r.stdout.trim().match(/zoneinfo\/(.+)$/);
    return m?.[1] ?? null;
}

/** Host system locale ("en_US.UTF-8"). localectl, then $LANG. */
export async function hostLocale(): Promise<string | null> {
    if (await which("localectl")) {
        const r = await run("localectl", ["status"], { noThrow: true, timeoutMs: 5_000 });
        const m = r.stdout.match(/System Locale:\s*LANG=([^\s]+)/);
        if (r.code === 0 && m?.[1]) return m[1];
    }
    const env = process.env.LANG;
    return env && env !== "C" && env !== "POSIX" ? env : null;
}

export interface HostKeymap {
    layout: string;
    variant?: string;
    model?: string;
    options?: string;
}

/** Host X11 keymap. localectl reports the system keymap; setxkbmap reflects
 *  the live session (they can differ — localectl is the durable answer and
 *  what a guest would run anyway, so it wins). */
export async function hostKeyboard(): Promise<HostKeymap | null> {
    if (await which("localectl")) {
        const r = await run("localectl", ["status"], { noThrow: true, timeoutMs: 5_000 });
        if (r.code === 0) {
            const pick = (k: string) => r.stdout.match(new RegExp(`${k}:\\s*(\\S+)`))?.[1];
            const layout = pick("X11 Layout") ?? pick("VC Keymap");
            if (layout) {
                return {
                    layout,
                    variant: pick("X11 Variant"),
                    model: pick("X11 Model"),
                    options: pick("X11 Options"),
                };
            }
        }
    }
    if (await which("setxkbmap")) {
        const r = await run("setxkbmap", ["-query"], { noThrow: true, timeoutMs: 5_000 });
        if (r.code === 0) {
            const pick = (k: string) => r.stdout.match(new RegExp(`^${k}:\\s+(.+)$`, "m"))?.[1]?.trim();
            const layout = pick("layout");
            if (layout) {
                return {
                    layout,
                    variant: pick("variant"),
                    model: pick("model"),
                    options: pick("options"),
                };
            }
        }
    }
    return null;
}

/**
 * The host's current wallpaper as a filesystem path (null when it can't be
 * resolved — solid-color backgrounds, slideshows and unknown DEs all land
 * here). GNOME reads picture-uri-dark when the host is dark, matching what
 * the user actually sees; KDE parses plasma-appletsrc Image= entries
 * (kreadconfig can't address the per-containment keys).
 */
export async function hostWallpaperPath(): Promise<string | null> {
    if (await which("gsettings")) {
        const dark = (await hostColorScheme()) === "dark";
        const keys = dark ? ["picture-uri-dark", "picture-uri"] : ["picture-uri", "picture-uri-dark"];
        for (let i = 0; i < keys.length; i++) {
            const r = await run("gsettings", ["get", "org.gnome.desktop.background", keys[i]!],
                { noThrow: true, timeoutMs: 5_000 });
            const uri = r.stdout.trim().replace(/^'|'$/g, "");
            if (r.code === 0 && uri.startsWith("file://")) {
                const p = decodeURIComponent(uri.slice(7));
                try { return await readFile(p).then(() => p); } catch { /* fall through */ }
            }
        }
    }
    const rc = join(homedir(), ".config", "plasma-org.kde.plasma.desktop-appletsrc");
    try {
        const txt = await readFile(rc, "utf-8");
        const m = txt.match(/^Image=file:\/\/(.+)$/m);
        if (m?.[1]) {
            const p = decodeURIComponent(m[1]);
            await readFile(p);
            return p;
        }
    } catch { /* no readable plasma image */ }
    return null;
}

export interface GitIdentity { name?: string; email?: string }

/** Host git identity (~/.gitconfig user.name/user.email). Empty when unset
 *  or git is absent — an empty identity must skip the channel, not push. */
export async function hostGitIdentity(): Promise<GitIdentity | null> {
    const read = async (key: string): Promise<string | undefined> => {
        if (await which("git")) {
            const r = await run("git", ["config", "--global", "--get", key],
                { noThrow: true, timeoutMs: 5_000 });
            const v = r.stdout.trim();
            if (r.code === 0 && v) return v;
        }
        return undefined;
    };
    let [name, email] = await Promise.all([read("user.name"), read("user.email")]);
    if (!name && !email) {
        // no git binary / not configured via git — parse ~/.gitconfig directly
        try {
            const txt = await readFile(join(homedir(), ".gitconfig"), "utf-8");
            const user = txt.match(/\[user\]([^[]*)/)?.[1] ?? "";
            name ??= user.match(/^\s*name\s*=\s*(.+)$/m)?.[1]?.trim();
            email ??= user.match(/^\s*email\s*=\s*(.+)$/m)?.[1]?.trim();
        } catch { /* no file */ }
    }
    return name || email ? { name, email } : null;
}

export interface HostProxy {
    mode: "none" | "manual" | "auto";
    http?: string;          // "host:port"
    https?: string;
    noProxy: string[];
    pacUrl?: string;
}

/**
 * Host proxy config. GNOME org.gnome.system.proxy, KDE kioslaverc
 * (ProxyType: 0=none 1=manual 2=script/pac 4=env), env vars as the
 * DE-less fallback. mode "none" is still a value — it actively turns a
 * previous guest-side push back off.
 */
export async function hostProxy(): Promise<HostProxy | null> {
    if (await which("gsettings")) {
        const r = await run("gsettings", ["get", "org.gnome.system.proxy", "mode"],
            { noThrow: true, timeoutMs: 5_000 });
        const mode = r.stdout.trim().replace(/^'|'$/g, "");
        if (r.code === 0 && ["none", "manual", "auto"].includes(mode)) {
            const get = async (k: string, key: string) => {
                const v = await run("gsettings", ["get", `org.gnome.system.proxy.${k}`, key],
                    { noThrow: true, timeoutMs: 5_000 });
                return v.code === 0 ? v.stdout.trim().replace(/^'|'$/g, "") : "";
            };
            const hostPort = async (k: string) => {
                const host = await get(k, "host");
                const port = await get(k, "port");
                return host ? `${host}${port && port !== "0" ? `:${port}` : ""}` : undefined;
            };
            const getRoot = async (key: string) => {
                const v = await run("gsettings", ["get", "org.gnome.system.proxy", key],
                    { noThrow: true, timeoutMs: 5_000 });
                return v.code === 0 ? v.stdout.trim().replace(/^'|'$/g, "") : "";
            };
            const noProxy = [...(await getRoot("ignore-hosts")).matchAll(/'([^']+)'/g)]
                .map((m) => m[1]!).filter(Boolean);
            const pacUrl = mode === "auto" ? (await getRoot("autoconfig-url") || undefined) : undefined;
            return {
                mode: mode as HostProxy["mode"],
                http: mode === "manual" ? await hostPort("http") : undefined,
                https: mode === "manual" ? await hostPort("https") : undefined,
                pacUrl,
                noProxy,
            };
        }
    }
    if (await which("kreadconfig6")) {
        const get = async (key: string) => {
            const r = await run("kreadconfig6", ["--file", "kioslaverc", "--group", "Proxy Settings", "--key", key],
                { noThrow: true, timeoutMs: 5_000 });
            return r.code === 0 ? r.stdout.trim() : "";
        };
        const t = await get("ProxyType");
        if (t !== "") {
            const mode = t === "1" ? "manual" : t === "2" || t === "3" ? "auto" : "none";
            const strip = (v: string) => v.replace(/^https?:\/\//, "").replace(/\/$/, "") || undefined;
            return {
                mode: mode as HostProxy["mode"],
                http: mode === "manual" ? strip(await get("httpProxy")) : undefined,
                https: mode === "manual" ? strip(await get("httpsProxy")) : undefined,
                pacUrl: mode === "auto" ? (await get("Proxy Config Script") || undefined) : undefined,
                noProxy: (await get("NoProxyFor")).split(",").map((s) => s.trim()).filter(Boolean),
            };
        }
    }
    const http = process.env.http_proxy ?? process.env.HTTP_PROXY;
    const https = process.env.https_proxy ?? process.env.HTTPS_PROXY;
    if (http || https) {
        const strip = (v?: string) => v?.replace(/^https?:\/\//, "").replace(/\/$/, "") || undefined;
        return {
            mode: "manual",
            http: strip(http),
            https: strip(https),
            noProxy: (process.env.no_proxy ?? process.env.NO_PROXY ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        };
    }
    return null;
}

/** Host custom CA roots to mirror: /usr/local/share/ca-certificates (deb
 *  hosts) + /etc/pki/ca-trust/source/anchors (rpm hosts). Returns fs paths
 *  of .crt/.pem files; the guest side owns the trust-store update. */
export async function hostCaCerts(): Promise<string[]> {
    const out: string[] = [];
    const dirs = ["/usr/local/share/ca-certificates", "/etc/pki/ca-trust/source/anchors"];
    for (let i = 0; i < dirs.length; i++) {
        try {
            for await (const p of glob(join(dirs[i]!, "**", "*.{crt,pem}"))) out.push(p);
        } catch { /* dir absent or unreadable */ }
    }
    return out.sort();
}

/** Host SSH agent socket to forward into the guest (SSH_AUTH_SOCK). */
export function hostAgentSock(): string | null {
    const s = process.env.SSH_AUTH_SOCK;
    return s && s.startsWith("/") ? s : null;
}
