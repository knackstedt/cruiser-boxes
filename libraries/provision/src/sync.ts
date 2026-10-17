// ============================================================================
// sync.ts — host → guest sync engine. Replaces the theme-only ThemeSync with
// a per-channel registry driven by spec.sync.*.
//
// Live channels (watcher lifetime = viewer session):
//   theme/accentColor/contrast — one dbus-monitor on portal SettingChanged
//   timezone                   — fs.watch on /etc/localtime + /etc/timezone
//                                (system-bus monitoring needs root; inotify
//                                doesn't)
// Session one-shots (re-pushed at each viewer open, hash-gated like
// wallpaper.state — in-guest drift is never clobbered unless host input
// actually changed):
//   locale, keyboard, monitors, gitIdentity, proxy, caCerts
// Held process:
//   sshAgent — ssh -N -R of the host agent socket, respawned with backoff
//
// Every guest script follows the guestThemeScript/guestWallpaperScript
// mold: run via guestRun as root (QGA, ssh+sudo fallback), runuser for
// user-context steps, `command -v` gates so spec.os.desktop guesses can't
// misfire, and never a nonzero exit that could abort a provision bake.
// ============================================================================

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { guestRun } from "../../vm-core/src/logs";
import { guestThemeScript } from "./theme";
import { detectAdapter } from "../../host-int/src/detect";
import { guestLayoutFromHost } from "./monitors";
import { pushFileToGuest } from "./stage";
import {
    hostAccentColor, hostColorScheme, hostContrast, watchPortalSettings,
    type ColorScheme,
} from "../../host-int/src/appearance";
import {
    hostAgentSock, hostCaCerts, hostDisplayScale, hostGitIdentity, hostGitSshKey, hostKeyboard, hostLocale,
    hostProxy, hostTimezone,
    type GitIdentity, type HostKeymap, type HostProxy, type HostScale,
} from "../../host-int/src/hoststate";

export type { ColorScheme };

// ── channel gating ──
// The channel table itself lives in vm-core's sync-channels registry —
// schema.ts, the create form, and the cli all derive from it.

export { SYNC_IDS, type SyncId } from "../../vm-core/src/config/sync-channels";
import { SYNC_CHANNELS, type SyncChannelDef, type SyncId } from "../../vm-core/src/config/sync-channels";

/** spec.sync[id] AND env: CRUISER_HOST_SYNC=0 kills all, the channel's own
 *  env key kills it (CRUISER_SYNC_<ID>=0); legacyEnv still honored. */
export function syncEnabled(spec: VmSpec, id: SyncId, env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.CRUISER_HOST_SYNC === "0") return false;
    const c: SyncChannelDef = SYNC_CHANNELS.find((x) => x.id === id)!;
    if (env[c.env] === "0") return false;
    if (c.legacyEnv && env[c.legacyEnv] === "0") return false;
    return spec.sync[id];
}

// ── host snapshot ──

/** Host values gathered once for a provision bake (each field channel-gated). */
export interface HostSnapshot {
    scheme?: ColorScheme;
    accent?: { r: number; g: number; b: number };
    contrast?: boolean;
    timezone?: string;
    locale?: string;
    keyboard?: HostKeymap;
    scale?: HostScale;
}

export async function gatherHostSync(spec: VmSpec): Promise<HostSnapshot> {
    const e = (id: SyncId) => syncEnabled(spec, id);
    const [scheme, accent, contrast, timezone, locale, keyboard, scale] = await Promise.all([
        e("theme") ? hostColorScheme() : null,
        e("accentColor") ? hostAccentColor() : null,
        e("contrast") ? hostContrast() : null,
        e("timezone") ? hostTimezone() : null,
        e("locale") ? hostLocale() : null,
        e("keyboard") ? hostKeyboard() : null,
        e("scale") ? hostDisplayScale() : null,
    ]);
    return {
        scheme: scheme ?? undefined,
        accent: accent ?? undefined,
        contrast: contrast ?? undefined,
        timezone: timezone ?? undefined,
        locale: locale ?? undefined,
        keyboard: keyboard ?? undefined,
        scale: scale ?? undefined,
    };
}

/** Host timezone for the seed's `timezone:` — respects sync.timezone. */
export async function seedTimezone(spec: VmSpec, explicit?: string): Promise<string> {
    if (explicit) return explicit;
    if (syncEnabled(spec, "timezone")) return (await hostTimezone()) ?? "UTC";
    return "UTC";
}

// ── guest scripts ──

const sq = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;

/** runuser preamble — the same U/UHOME/UUID/RUNU shape every script needs. */
const preamble = (spec: VmSpec) => `U=${sq(spec.credentials.username)}
UHOME=$(getent passwd "$U" | cut -d: -f6)
UUID=$(id -u "$U")
RUNU() { runuser -u "$U" -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus XDG_RUNTIME_DIR=/run/user/"$UUID" "$@"; }`;

/** host timezone → guest. Root-level, no session bus needed. The tz name
 *  is sanitized once — it embeds into a filesystem path, so dots go away
 *  entirely (zoneinfo names never contain one). */
export function guestTimezoneScript(tz: string): string {
    const safe = tz.replace(/\.+/g, "").replace(/[^A-Za-z0-9_+/-]/g, "");
    return `# host timezone → guest
if command -v timedatectl >/dev/null 2>&1; then
    timedatectl set-timezone ${sq(safe)} 2>/dev/null || true
elif [ -w /etc/localtime ] && [ -f "/usr/share/zoneinfo/${safe}" ]; then
    ln -sf "/usr/share/zoneinfo/${safe}" /etc/localtime 2>/dev/null || true
fi`;
}

/** host LANG → guest. localectl writes /etc/locale.conf + vconsole; the
 *  /etc/default/locale write covers deb userspace that reads it directly. */
export function guestLocaleScript(lang: string): string {
    return `# host locale → guest
if command -v localectl >/dev/null 2>&1; then
    localectl set-locale LANG=${sq(lang)} 2>/dev/null || true
fi
if [ -d /etc/default ]; then
    grep -q '^LANG=' /etc/default/locale 2>/dev/null \\
        && sed -i 's/^LANG=.*/LANG=${lang.replace(/[^A-Za-z0-9_.@-]/g, "")}/' /etc/default/locale \\
        || echo 'LANG=${lang.replace(/[^A-Za-z0-9_.@-]/g, "")}' >> /etc/default/locale
fi`;
}

/**
 * Host X11 keymap → guest. localectl persists for next login; the DE lines
 * cover the live session — GNOME input-sources, KDE kxkbrc + setxkbmap.
 */
export function guestKeyboardScript(spec: VmSpec, k: HostKeymap): string {
    const xkb = `${k.layout}${k.variant ? `+${k.variant}` : ""}`;
    const setx = `localectl set-x11-keymap ${[k.layout, k.model ?? "", k.variant ?? "", k.options ?? ""].map(sq).join(" ")}`;
    return `# host keyboard → guest
${preamble(spec)}
command -v localectl >/dev/null 2>&1 && {
    localectl set-keymap ${sq(k.layout)} 2>/dev/null || true
    ${setx} 2>/dev/null || true
}
if command -v gsettings >/dev/null 2>&1; then
    RUNU gsettings set org.gnome.desktop.input-sources sources "[('xkb', '${xkb.replace(/'/g, "")}')]" 2>/dev/null || \\
    runuser -u "$U" -- dbus-run-session -- gsettings set org.gnome.desktop.input-sources sources "[('xkb', '${xkb.replace(/'/g, "")}')]" 2>/dev/null || true
fi
if command -v kwriteconfig6 >/dev/null 2>&1; then
    RUNU kwriteconfig6 --file kxkbrc --group Layout --key LayoutList ${sq(k.layout)} 2>/dev/null || true
    RUNU kwriteconfig6 --file kxkbrc --group Layout --key VariantList ${sq(k.variant ?? "")} 2>/dev/null || true
    RUNU kwriteconfig6 --file kxkbrc --group Layout --key Use true 2>/dev/null || true
    RUNU setxkbmap ${sq(k.layout)} ${k.variant ? sq(k.variant) : ""} 2>/dev/null || true
fi`;
}

/** libadwaita/GNOME-47 named accents — the enum is closed, so a host rgb
 *  triple quantizes to the nearest name. */
const GNOME_ACCENTS: [string, [number, number, number]][] = [
    ["blue", [53, 132, 228]], ["teal", [33, 144, 164]], ["green", [58, 148, 74]],
    ["yellow", [200, 136, 0]], ["orange", [237, 91, 0]], ["red", [230, 45, 66]],
    ["pink", [213, 97, 153]], ["purple", [145, 65, 172]], ["slate", [111, 131, 150]],
];

export function nearestGnomeAccent(c: { r: number; g: number; b: number }): string {
    const rgb = [c.r * 255, c.g * 255, c.b * 255];
    // near-neutral inputs (white/gray/black) read as "no accent" — slate is
    // GNOME's neutral accent; pure rgb distance would land them on pink.
    const mx = Math.max(...rgb), mn = Math.min(...rgb);
    if (mx - mn < 46) return "slate";
    let best = GNOME_ACCENTS[0]![0], bd = Infinity;
    for (let i = 0; i < GNOME_ACCENTS.length; i++) {
        const [name, [r, g, b]] = GNOME_ACCENTS[i]!;
        const d = (rgb[0]! - r) ** 2 + (rgb[1]! - g) ** 2 + (rgb[2]! - b) ** 2;
        if (d < bd) { bd = d; best = name; }
    }
    return best;
}

/** host accent-color → guest. GNOME takes the nearest enum name (older
 *  schemas lack the key — the || true covers them); KDE wants "r,g,b" in
 *  kdeglobals, which applies at next login. */
export function guestAccentScript(spec: VmSpec, c: { r: number; g: number; b: number }): string {
    const name = nearestGnomeAccent(c);
    const kde = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
    return `# host accent color → guest (gnome: ${name}, kde: ${kde})
${preamble(spec)}
if command -v gsettings >/dev/null 2>&1; then
    RUNU gsettings set org.gnome.desktop.interface accent-color '${name}' 2>/dev/null || \\
    runuser -u "$U" -- dbus-run-session -- gsettings set org.gnome.desktop.interface accent-color '${name}' 2>/dev/null || true
fi
if command -v kwriteconfig6 >/dev/null 2>&1; then
    RUNU kwriteconfig6 --file kdeglobals --group General --key AccentColor '${kde}' 2>/dev/null || true
fi`;
}

/** host contrast → guest. KDE's off case re-applies the scheme-mapped
 *  Breeze variant since there's no "high contrast off" toggle. */
export function guestContrastScript(spec: VmSpec, high: boolean, scheme: ColorScheme): string {
    const breeze = scheme === "dark" ? "BreezeDark" : "BreezeLight";
    const kde = high ? "BreezeHighContrast" : breeze;
    return `# host contrast → guest (${high ? "high" : "normal"})
${preamble(spec)}
if command -v gsettings >/dev/null 2>&1; then
    RUNU gsettings set org.gnome.desktop.a11y.interface high-contrast ${high} 2>/dev/null || \\
    runuser -u "$U" -- dbus-run-session -- gsettings set org.gnome.desktop.a11y.interface high-contrast ${high} 2>/dev/null || true
fi
if command -v plasma-apply-colorscheme >/dev/null 2>&1; then
    RUNU plasma-apply-colorscheme ${kde} 2>/dev/null || \\
    runuser -u "$U" -- plasma-apply-colorscheme ${kde} 2>/dev/null || true
fi`;
}

/** host display + font scale → guest. GNOME: text-scaling-factor carries
 *  the font multiplier (a fractional display scale folds into it — mutter
 *  ignores scaling-factor on Wayland anyway); scaling-factor only when the
 *  host scale is integral. Per-monitor scale rides the monitors channel
 *  (monitors.xml / kscreen-doctor). KDE: kcmfonts forceFontDPI (0 = off). */
export function guestScaleScript(spec: VmSpec, s: HostScale): string {
    const scale = s.scale ?? 1, text = s.text ?? 1;
    const tsf = Number.isInteger(scale) && scale >= 1 ? text : scale * text;
    const dpi = Math.round(96 * scale * text);
    return `# host display scale → guest (scale=${scale}, text=${text}, dpi=${dpi})
${preamble(spec)}
if command -v gsettings >/dev/null 2>&1; then
    RUNU gsettings set org.gnome.desktop.interface text-scaling-factor ${tsf} 2>/dev/null || \\
    runuser -u "$U" -- dbus-run-session -- gsettings set org.gnome.desktop.interface text-scaling-factor ${tsf} 2>/dev/null || true
${Number.isInteger(scale) && scale >= 1 ? `    RUNU gsettings set org.gnome.desktop.interface scaling-factor 'uint32 ${scale}' 2>/dev/null || \\
    runuser -u "$U" -- dbus-run-session -- gsettings set org.gnome.desktop.interface scaling-factor 'uint32 ${scale}' 2>/dev/null || true` : ""}
fi
if command -v kwriteconfig6 >/dev/null 2>&1; then
    RUNU kwriteconfig6 --file kcmfonts --group General --key forceFontDPI ${dpi === 96 ? 0 : dpi} 2>/dev/null || true
fi`;
}

/** host git identity → guest (~/.gitconfig user.name/user.email). */
export function guestGitScript(spec: VmSpec, id: GitIdentity): string {
    const lines = ["# host git identity → guest", preamble(spec), "if command -v git >/dev/null 2>&1; then"];
    if (id.name) lines.push(`    RUNU git config --global user.name ${sq(id.name)} 2>/dev/null || true`);
    if (id.email) lines.push(`    RUNU git config --global user.email ${sq(id.email)} 2>/dev/null || true`);
    lines.push("fi");
    return lines.join("\n");
}

/** host proxy → guest: DE settings (manual/none/auto) + /etc/environment
 *  block + a profile.d line for shells that bypass pam_env. */
export function guestProxyScript(spec: VmSpec, px: HostProxy): string {
    // Values come from host gsettings — sq() for command args; the profile.d
    // heredoc is shell-parsed so values need "…" escaping; /etc/environment
    // is literal (no shell eval) so values stay raw.
    const dq = (s: string) => `"${s.replace(/["\\$`]/g, "\\$&")}"`;
    const env: string[] = [];
    if (px.mode === "manual") {
        if (px.http) env.push(`http_proxy=http://${px.http}`, `HTTP_PROXY=http://${px.http}`);
        if (px.https) env.push(`https_proxy=http://${px.https}`, `HTTPS_PROXY=http://${px.https}`);
    }
    if (px.mode === "auto" && px.pacUrl) env.push(`auto_proxy=${px.pacUrl}`);
    if (px.noProxy.length) env.push(`no_proxy=${px.noProxy.join(",")}`, `NO_PROXY=${px.noProxy.join(",")}`);
    const envBlock = env.length
        ? `cat > /etc/profile.d/cruiser-proxy.sh <<'PROXYENV'
${env.map((e) => `export ${e.split("=")[0]}=${dq(e.split("=").slice(1).join("="))}`).join("\n")}
PROXYENV
{ grep -v '^# cruiser-proxy' /etc/environment 2>/dev/null | grep -vE '^(http_proxy|https_proxy|no_proxy|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)=' || true; } > /etc/environment.new
echo '# cruiser-proxy' >> /etc/environment.new
cat >> /etc/environment.new <<'PROXYENV'
${env.join("\n")}
PROXYENV
mv /etc/environment.new /etc/environment`
        : `rm -f /etc/profile.d/cruiser-proxy.sh
{ grep -v '^# cruiser-proxy' /etc/environment 2>/dev/null | grep -vE '^(http_proxy|https_proxy|no_proxy|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)=' || true; } > /etc/environment.new
mv /etc/environment.new /etc/environment`;
    const kdeType = px.mode === "manual" ? 1 : px.mode === "auto" ? 2 : 0;
    return `# host proxy → guest (mode: ${px.mode})
${preamble(spec)}
${envBlock}
if command -v gsettings >/dev/null 2>&1; then
    RUNU gsettings set org.gnome.system.proxy mode ${sq(px.mode)} 2>/dev/null || true
${px.mode === "manual" && px.http ? `    RUNU gsettings set org.gnome.system.proxy.http host ${sq(px.http.split(":")[0]!)} 2>/dev/null || true
    RUNU gsettings set org.gnome.system.proxy.http port ${Number(px.http.split(":")[1] ?? 0)} 2>/dev/null || true` : ""}
${px.mode === "manual" && px.https ? `    RUNU gsettings set org.gnome.system.proxy.https host ${sq(px.https.split(":")[0]!)} 2>/dev/null || true
    RUNU gsettings set org.gnome.system.proxy.https port ${Number(px.https.split(":")[1] ?? 0)} 2>/dev/null || true` : ""}
${px.mode === "auto" && px.pacUrl ? `    RUNU gsettings set org.gnome.system.proxy autoconfig-url ${sq(px.pacUrl)} 2>/dev/null || true` : ""}
    RUNU gsettings set org.gnome.system.proxy ignore-hosts "[${px.noProxy.map(sq).join(", ")}]" 2>/dev/null || true
fi
if command -v kwriteconfig6 >/dev/null 2>&1; then
    RUNU kwriteconfig6 --file kioslaverc --group "Proxy Settings" --key ProxyType ${kdeType} 2>/dev/null || true
${px.mode === "manual" && px.http ? `    RUNU kwriteconfig6 --file kioslaverc --group "Proxy Settings" --key httpProxy ${sq(`http://${px.http}`)} 2>/dev/null || true` : ""}
${px.mode === "manual" && px.https ? `    RUNU kwriteconfig6 --file kioslaverc --group "Proxy Settings" --key httpsProxy ${sq(`http://${px.https}`)} 2>/dev/null || true` : ""}
${px.mode === "auto" && px.pacUrl ? `    RUNU kwriteconfig6 --file kioslaverc --group "Proxy Settings" --key "Proxy Config Script" ${sq(px.pacUrl)} 2>/dev/null || true` : ""}
    RUNU kwriteconfig6 --file kioslaverc --group "Proxy Settings" --key NoProxyFor ${sq(px.noProxy.join(","))} 2>/dev/null || true
fi`;
}

/**
 * CA roots staged at /tmp/cruiser-ca/*.crt → the distro's local-trust dir +
 * store rebuild. Trust-store commands are gated per family; the staging
 * dir is wiped first so removed host certs stop propagating.
 */
export function guestCaCertsScript(): string {
    return `# host CA roots → guest trust store
[ -d /tmp/cruiser-ca ] || exit 0
if [ -d /usr/local/share/ca-certificates ]; then
    rm -rf /usr/local/share/ca-certificates/cruiser
    mkdir -p /usr/local/share/ca-certificates/cruiser
    cp /tmp/cruiser-ca/*.crt /usr/local/share/ca-certificates/cruiser/ 2>/dev/null || true
    chmod 644 /usr/local/share/ca-certificates/cruiser/* 2>/dev/null || true
    update-ca-certificates 2>/dev/null || true
elif [ -d /etc/pki/ca-trust/source/anchors ]; then
    rm -rf /etc/pki/ca-trust/source/anchors/cruiser
    mkdir -p /etc/pki/ca-trust/source/anchors/cruiser
    cp /tmp/cruiser-ca/*.crt /etc/pki/ca-trust/source/anchors/cruiser/ 2>/dev/null || true
    update-ca-trust 2>/dev/null || true
fi`;
}

/**
 * Fill missing per-monitor scale from the host's global display scale —
 * xrandr has no scale concept, so an X11 host's MonitorInfo comes back
 * scale-less even when the desktop runs at 2×. Callers: provision's
 * monitorsXml and the session monitors oneshot. Gated on the `scale`
 * channel; a probe miss leaves the list untouched.
 */
export async function applyHostScale<T extends { scale?: number }>(spec: VmSpec, mons: T[]): Promise<T[]> {
    if (!syncEnabled(spec, "scale") || mons.every((m) => m.scale !== undefined)) return mons;
    const hs = await hostDisplayScale().catch(() => null);
    if (hs?.scale) mons.forEach((m) => { m.scale ??= hs.scale; });
    return mons;
}

/** monitors.xml staged at /tmp/cruiser-monitors.xml → ~/.config (GNOME guests). */
export function guestMonitorScript(spec: VmSpec): string {
    return `# host monitor topology → guest monitors.xml
${preamble(spec)}
if [ -f /tmp/cruiser-monitors.xml ]; then
    mkdir -p "$UHOME/.config"
    cp /tmp/cruiser-monitors.xml "$UHOME/.config/monitors.xml" && rm -f /tmp/cruiser-monitors.xml
    chown -R "$U":"$U" "$UHOME/.config" 2>/dev/null || true
fi`;
}

/** KDE guests — arrange virtio outputs to mirror host topology via
 *  kscreen-doctor (monitors.xml is GNOME/mutter-only). Output i (Virtual-N)
 *  maps to host monitor i — the same order buildArgs writes outputs[] in.
 *  Positions are normalized to the composite's top-left. */
export function guestKdeMonitorsScript(spec: VmSpec, host: { x: number; y: number; w: number; h: number; primary: boolean; scale?: number }[]): string {
    const ox = Math.min(...host.map((m) => m.x));
    const oy = Math.min(...host.map((m) => m.y));
    const args: string[] = [];
    host.forEach((m, i) => {
        const o = `output.Virtual-${i + 1}`;
        // No .mode — QEMU's per-output xres/yres already makes the mirrored
        // resolution the EDID-preferred mode; only positions need pushing.
        args.push(`${o}.enable`, `${o}.position.${m.x - ox},${m.y - oy}`);
        if (m.primary) args.push(`${o}.priority.1`);
        if (m.scale) args.push(`${o}.scale.${m.scale}`);
    });
    return `# host monitor topology → guest kscreen layout (KDE)
${preamble(spec)}
if command -v kscreen-doctor >/dev/null 2>&1; then
    # kscreen-doctor needs a Qt platform plugin just to init QApplication —
    # pick it from the session's sockets (wayland socket → wayland QPA,
    # X socket → xcb); RUNU supplies the session bus + runtime dir.
    # Retry until a session socket exists AND the apply succeeds — the sync
    # can run before login while outputs already exist, and a silent
    # no-op would leave the guest auto-layout diverged from --offsets for
    # the whole boot. kscreen-doctor also persists the per-setup config, so
    # later boots with the same output set self-correct.
    i=0; ok=
    while [ $i -lt 60 ]; do
        if [ -S "/run/user/$UUID/wayland-0" ]; then
            RUNU env QT_QPA_PLATFORM=wayland WAYLAND_DISPLAY=wayland-0 \\
                kscreen-doctor ${args.map(sq).join(" ")} 2>/dev/null && ok=1 && break
        elif [ -S /tmp/.X11-unix/X0 ]; then
            RUNU env QT_QPA_PLATFORM=xcb DISPLAY=:0 \\
                kscreen-doctor ${args.map(sq).join(" ")} 2>/dev/null && ok=1 && break
        fi
        i=$((i + 1)); sleep 3
    done
    [ -n "$ok" ]
fi`;
}

/**
 * SSH agent: /etc/environment + profile.d point at the forwarded socket.
 * Idempotent — runs from AgentForward.start each session, so enabling
 * sshAgent mid-life doesn't need a re-provision (desktop apps still pick
 * it up at next login via pam_env).
 */
export function guestAgentEnvScript(spec: VmSpec): string {
    return `# ssh agent socket path → guest env
${preamble(spec)}
mkdir -p "$UHOME/.ssh" && chown "$U":"$U" "$UHOME/.ssh"
SOCK="$UHOME/.ssh/cruiser-agent.sock"
grep -q '^SSH_AUTH_SOCK=' /etc/environment 2>/dev/null \\
    && sed -i "s|^SSH_AUTH_SOCK=.*|SSH_AUTH_SOCK=$SOCK|" /etc/environment \\
    || echo "SSH_AUTH_SOCK=$SOCK" >> /etc/environment
cat > /etc/profile.d/cruiser-agent.sh <<AGENTENV
[ -S "$UHOME/.ssh/cruiser-agent.sock" ] && export SSH_AUTH_SOCK="$UHOME/.ssh/cruiser-agent.sock"
AGENTENV`;
}

/**
 * Mount-mode shares → guest fstab + mounts, reconciled. Both provision and
 * the session channel run this: it rewrites the managed block between the
 * markers (dropping legacy unmarked per-share lines and virtfs mounts whose
 * tags left the spec), so adding/removing a share in vm.json converges the
 * guest on the next pass. QEMU fsdevs are CLI-only — a share added while
 * the VM is running gets its fstab entry now and the device at next boot.
 */
export function guestSharesScript(spec: VmSpec): string {
    const mounts = spec.shares.filter((s) => s.enabled !== false && s.mode !== "copy");
    const keep = mounts.map((s) => s.tag).join(" ");
    const lines = mounts.map((s) => {
        const mp = s.guestPath ?? `/mnt/${s.tag}`;
        const mpFstab = mp.replace(/ /g, "\\040");   // fstab field escapes
        const ro = s.direction === "host-to-guest";
        const opts9p = `trans=virtio,version=9p2000.L,msize=262144,_netdev,x-systemd.automount,x-systemd.idle-timeout=60,nofail${ro ? ",ro" : ""}`;
        const optsVfs = `${ro ? "ro," : "rw,"}nofail,_netdev,x-systemd.automount`;
        return `if [ "$SHARE_FSTYPE" = virtiofs ]; then
        echo '${s.tag} ${mpFstab} virtiofs ${optsVfs} 0 0'
    else
        echo '${s.tag} ${mpFstab} 9p ${opts9p} 0 0'
    fi
    case ${sq(mp)} in "$UHOME"/*) runuser -u "$U" -- mkdir -p ${sq(mp)};; *) mkdir -p ${sq(mp)};; esac
    grep -qs '^${s.tag} ' /proc/mounts || {
        if [ "$SHARE_FSTYPE" = virtiofs ]; then
            mount -t virtiofs -o ${ro ? "ro" : "rw"} ${sq(s.tag)} ${sq(mp)} 2>/dev/null
        else
            mount -t 9p -o trans=virtio,version=9p2000.L${ro ? ",ro" : ""} ${sq(s.tag)} ${sq(mp)} 2>/dev/null
        fi
    } || echo "cruiser: share '${s.tag}' has no device yet — it mounts at next boot" >&2`;
    });
    return `# host shares → guest fstab + mounts (managed block, reconciled)
[ -f /etc/fstab ] || : > /etc/fstab
SHARE_FSTYPE=9p; ls -d /sys/bus/virtio/drivers/virtiofs/virtio* >/dev/null 2>&1 && SHARE_FSTYPE=virtiofs
KEEP=" ${keep} "
sed -i '/# >>> cruiser-shares/,/# <<< cruiser-shares/d' /etc/fstab
for T in ${keep}; do sed -i "\\|^\${T}[[:space:]]|d" /etc/fstab; done
# drop virtfs mounts whose tag left the spec (only cruiser creates fsdevs)
awk '$3=="9p"||$3=="virtiofs"{print $1" "$2}' /proc/mounts | while read -r SRC MP; do
    case "$KEEP" in *" $SRC "*) ;; *) umount -l "$MP" 2>/dev/null || true ;; esac
done
{
    echo '# >>> cruiser-shares >>>'
${lines.map((l) => `    ${l}`).join("\n")}
    echo '# <<< cruiser-shares <<<'
} >> /etc/fstab
systemctl daemon-reload 2>/dev/null || true`;
}

/**
 * Host git SSH key → guest ~/.ssh/cruiser-git-key (0600) plus a managed
 * ~/.ssh/config block binding it to the common git forges. IdentitiesOnly
 * matters: a stale forwarded-agent socket (dead session) would otherwise
 * wedge auth behind publickey failures. The private key rides the same
 * QGA/ssh channel as every other script — base64 in a heredoc, no quoting
 * pitfalls.
 */
export function guestGitKeyScript(spec: VmSpec, key: { priv: string; pub: string | null }): string {
    const b64 = Buffer.from(key.priv.trimEnd() + "\n").toString("base64");
    return `# host git ssh key → guest
${preamble(spec)}
mkdir -p "$UHOME/.ssh"
base64 -d > "$UHOME/.ssh/cruiser-git-key" <<'CRUISERKEY'
${b64}
CRUISERKEY
chmod 700 "$UHOME/.ssh" && chmod 600 "$UHOME/.ssh/cruiser-git-key"
${key.pub ? `cat > "$UHOME/.ssh/cruiser-git-key.pub" <<'CRUISERPUB'\n${key.pub}\nCRUISERPUB\nchmod 644 "$UHOME/.ssh/cruiser-git-key.pub"` : ""}
touch "$UHOME/.ssh/config"
sed -i '/# >>> cruiser-git-key/,/# <<< cruiser-git-key/d' "$UHOME/.ssh/config"
cat >> "$UHOME/.ssh/config" <<'CRUISERCFG'
# >>> cruiser-git-key >>>
Host github.com gitlab.com bitbucket.org
  IdentityFile ~/.ssh/cruiser-git-key
  IdentitiesOnly yes
# <<< cruiser-git-key <<<
CRUISERCFG
chmod 600 "$UHOME/.ssh/config"
chown -R "$U":"$U" "$UHOME/.ssh"`;
}

/**
 * Wayland → X11 clipboard bridge for the dmabuf viewer — deployed by
 * runOneshots (not a sync channel) whenever display.clipboard is on.
 * spice-vdagent is X11-only: on a Wayland guest session it sees XWayland
 * copies but native Wayland copies never reach the QEMU clipboard, so
 * guest→host is dead for native apps. This autostart entry mirrors each
 * Wayland text offer into the X11 selection via xclip; the sha guard
 * stops host→guest echoes from bouncing back. No-op on X11 sessions —
 * wl-paste exits instantly without a wayland socket. The push lands
 * mid-session, so the script also launches the bridge immediately with
 * env borrowed from a live session process — autostart alone would leave
 * the current session unbridged.
 */
const CLIPBRIDGE_V = "v4";
export function guestClipBridgeScript(spec: VmSpec): string {
    return `# wayland→x11 clipboard bridge for spice-vdagent (${CLIPBRIDGE_V})
${preamble(spec)}
if command -v wl-paste >/dev/null 2>&1 && command -v xclip >/dev/null 2>&1; then
    runuser -u "$U" -- mkdir -p "$UHOME/.local/bin" "$UHOME/.config/autostart"
    cat > "$UHOME/.local/bin/cruiser-clip-in" <<'CLIPIN'
#!/bin/sh
d=$(cat); [ -z "$d" ] && exit 0
f="\${XDG_RUNTIME_DIR:-/tmp}/cruiser-clip.last"
h=$(printf %s "$d" | sha256sum | cut -d" " -f1)
[ "$h" = "$(cat "$f" 2>/dev/null)" ] && exit 0
printf %s "$h" > "$f"
printf %s "$d" | xclip -selection clipboard -i
CLIPIN
    chmod 755 "$UHOME/.local/bin/cruiser-clip-in"
    # mid-session deploys can't wait for the next autostart scan — this
    # launcher borrows the session env off the pid it's handed (desktop
    # shell or systemd --user), then detaches so runuser can return.
    cat > "$UHOME/.local/bin/cruiser-clip-launch" <<'CLIPLN'
#!/bin/sh
export $(tr '\0' '\n' < /proc/$1/environ | grep -E '^(WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS)=')
setsid wl-paste --type text --watch "$(dirname "$0")/cruiser-clip-in" >/dev/null 2>&1 </dev/null &
CLIPLN
    cat > "$UHOME/.config/autostart/cruiser-clipbridge.desktop" <<CLIPDSK
[Desktop Entry]
Type=Application
Name=Cruiser clipboard bridge
Comment=Mirror the Wayland clipboard into X11 for spice-vdagent host sync
Exec=wl-paste --type text --watch $UHOME/.local/bin/cruiser-clip-in
X-GNOME-Autostart-enabled=true
CLIPDSK
    chown -R "$U":"$U" "$UHOME/.local/bin" "$UHOME/.config/autostart"
    # launch now too — pgreps match comm only, -f would self-match this
    # script's own cmdline text.
    if ! pgrep -u "$U" -x wl-paste >/dev/null 2>&1; then
        SPID=$(pgrep -u "$U" -n "^(plasmashell|gnome-shell|xfce4-session|kwin_wayland|kwin_x11|sway|labwc|weston|cinnamon|mate-session|lxqt-session|systemd)$" | head -1)
        [ -n "$SPID" ] && runuser -u "$U" -- "$UHOME/.local/bin/cruiser-clip-launch" "$SPID" || true
    fi
fi`;
}

/**
 * Provision-bake script — every enabled channel with a resolved host value,
 * concatenated. Sections are individually `|| true`-gated so a sync failure
 * can't abort guest-setup's `set -eu`.
 */
export function guestSyncScript(spec: VmSpec, s: HostSnapshot): string {
    const parts: string[] = [];
    if (s.timezone) parts.push(guestTimezoneScript(s.timezone));
    if (s.locale) parts.push(guestLocaleScript(s.locale));
    if (s.keyboard) parts.push(guestKeyboardScript(spec, s.keyboard));
    if (s.scheme) parts.push(guestThemeScript(spec, s.scheme));
    if (s.accent) parts.push(guestAccentScript(spec, s.accent));
    if (s.contrast !== undefined) parts.push(guestContrastScript(spec, s.contrast, s.scheme ?? "light"));
    if (s.scale) parts.push(guestScaleScript(spec, s.scale));
    return parts.join("\n\n");
}

// ── session pushes ──

/** Hash of one channel's inputs → run/sync.state entry. */
function chanHash(v: unknown): string {
    return createHash("sha256").update(JSON.stringify({ v: 1, val: v })).digest("hex").slice(0, 16);
}

/** Run a guest script, throw on nonzero (callers catch — never propagate). */
async function pushScript(h: VmHandle, script: string, label: string, timeoutMs = 30_000): Promise<void> {
    const r = await guestRun(h, ["/bin/sh", "-c", script], timeoutMs);
    if (r.code !== 0)
        throw new Error(`${label} exited ${r.code} via ${r.transport}: ${(r.stderr || r.stdout).slice(-400)}`);
}

/** fs.watch on /etc — the durable timezone change signal. dbus-monitor on
 *  the system bus needs root on most distros, so inotify is the reliable
 *  watcher here. The directory is watched rather than the files:
 *  /etc/localtime is a symlink that timedatectl REPLACES (rename-over),
 *  which silently kills an inode-level watch after the first change. */
function watchHostTimezone(onChanged: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
        if (timer) return;
        timer = setTimeout(() => { timer = null; onChanged(); }, 500);
    };
    let w: FSWatcher | null = null;
    try {
        w = watch("/etc", { persistent: false }, (_ev, name) => {
            if (name === "localtime" || name === "timezone") fire();
        });
    } catch { /* /etc unwatched — timezone just won't live-sync */ }
    return () => {
        if (timer) clearTimeout(timer);
        w?.close();
    };
}

/**
 * Host SSH agent → guest via a held `ssh -N -R` remote forward.
 * Guest target: ~user/.ssh/cruiser-agent.sock (resolved on start — we can't
 * assume /home). Respawns with backoff until dispose; dies with the viewer
 * session since SessionSyncs owns it.
 */
export class AgentForward {
    private child: ChildProcess | null = null;
    private disposed = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    private hostSock: string | null = null;
    private guestSock: string | null = null;

    constructor(
        private readonly h: VmHandle,
        private readonly log?: (msg: string) => void,
    ) {}

    /** ssh argv — exported shape for tests: -N -R <guestSock>:<hostSock>. */
    static argv(spec: VmSpec, guestSock: string, hostSock: string, priv: string): string[] {
        const port = spec.network.sshPort;
        if (!port) throw new Error("no sshPort mapped — can't forward the agent socket");
        return [
            "-N", "-T",
            "-R", `${guestSock}:${hostSock}`,
            "-i", priv, "-p", String(port),
            "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
            `${spec.credentials.username}@127.0.0.1`,
        ];
    }

    async start(): Promise<void> {
        const hostSock = hostAgentSock();
        if (!hostSock) { this.log?.("ssh agent: no SSH_AUTH_SOCK on host — channel skipped"); return; }
        const port = this.h.spec.network.sshPort;
        if (!port) { this.log?.("ssh agent: no SSH hostfwd mapped — channel skipped"); return; }
        // resolve the guest home + write env once
        try {
            const r = await guestRun(this.h, [
                "/bin/sh", "-c",
                `getent passwd ${sq(this.h.spec.credentials.username)} | cut -d: -f6`,
            ], 15_000);
            const home = r.stdout.trim().split("\n").pop();
            if (r.code !== 0 || !home?.startsWith("/")) throw new Error("no guest home");
            this.guestSock = `${home}/.ssh/cruiser-agent.sock`;
            await pushScript(this.h, guestAgentEnvScript(this.h.spec), "agent env", 20_000);
        } catch (e) {
            this.log?.(`ssh agent: guest env setup failed: ${e instanceof Error ? e.message : e}`);
            return;
        }
        this.hostSock = hostSock;
        this.spawn();
    }

    private spawn(): void {
        if (this.disposed || !this.hostSock || !this.guestSock) return;
        void (async () => {
            const { priv } = await (await import("../../vm-core/src/sshkey")).ensureKeypair();
            if (this.disposed) return;
            // clear a stale bind — sshd won't unlink a dead socket on -R
            await guestRun(this.h, ["/bin/sh", "-c", `rm -f ${sq(this.guestSock!)}`], 10_000).catch(() => {});
            const argv = AgentForward.argv(this.h.spec, this.guestSock!, this.hostSock!, priv);
            const child = spawn("ssh", argv, { stdio: "ignore" });
            this.child = child;
            this.log?.("ssh agent: forwarding host agent into the guest");
            child.on("exit", () => {
                this.child = null;
                if (this.disposed) return;
                // backoff respawn — guest may just be mid-reboot
                this.timer = setTimeout(() => this.spawn(), 5_000);
            });
            child.on("error", () => {});
        })();
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) clearTimeout(this.timer);
        this.child?.kill("SIGTERM");
        this.child = null;
    }
}

/**
 * Per-viewer-session host→guest syncs. start() is fire-and-forget — every
 * push is isolated so a dead agent or missing probe can't fail the viewer
 * open. dispose() kills watchers and the agent forward.
 */
export class SessionSyncs {
    private unwatch: (() => void)[] = [];
    private agent: AgentForward | null = null;
    private pushing = false;
    private queued = false;
    private last = new Map<string, string>();

    constructor(
        private readonly h: VmHandle,
        private readonly log?: (msg: string) => void,
    ) {}

    start(): void {
        const spec = this.h.spec;
        const live = () => void this.pushLive();
        // Portal appearance channels share one dbus-monitor.
        if (syncEnabled(spec, "theme") || syncEnabled(spec, "accentColor") || syncEnabled(spec, "contrast"))
            this.unwatch.push(watchPortalSettings(live));
        if (syncEnabled(spec, "timezone"))
            this.unwatch.push(watchHostTimezone(live));
        live();
        if (syncEnabled(spec, "sshAgent")) {
            this.agent = new AgentForward(this.h, this.log);
            void this.agent.start();
        }
        void this.runOneshots();
    }

    /**
     * All live channels in one serialized pass. pushIfChanged's hash diff
     * skips unchanged work, and a single queued flag collapses bursts —
     * watchers for different channels queue onto the same merged rerun so
     * neither is dropped mid-push.
     */
    private async pushLive(): Promise<void> {
        if (this.pushing) { this.queued = true; return; }
        this.pushing = true;
        try {
            const spec = this.h.spec;
            if (syncEnabled(spec, "theme")) {
                const s = await hostColorScheme();
                if (s) await this.pushIfChanged("theme", s,
                    () => pushScript(this.h, guestThemeScript(spec, s), "theme"));
            }
            if (syncEnabled(spec, "accentColor")) {
                const a = await hostAccentColor();
                if (a) await this.pushIfChanged("accentColor", a,
                    () => pushScript(this.h, guestAccentScript(spec, a), "accent"));
            }
            if (syncEnabled(spec, "contrast")) {
                const c = await hostContrast();
                if (c !== null) {
                    const scheme = (await hostColorScheme()) ?? "light";
                    await this.pushIfChanged("contrast", { c, scheme },
                        () => pushScript(this.h, guestContrastScript(spec, c, scheme), "contrast"));
                }
            }
            if (syncEnabled(spec, "timezone")) {
                const tz = await hostTimezone();
                if (tz) await this.pushIfChanged("timezone", tz,
                    () => pushScript(this.h, guestTimezoneScript(tz), "timezone"));
            }
        } catch { /* watchers never throw */ }
        finally { this.pushing = false; }
        if (this.queued) { this.queued = false; void this.pushLive(); }
    }

    /** Changed-since-last-success check — `last` only advances on a clean
     *  push so a failed apply retries on the next host change. */
    private async pushIfChanged(id: string, val: unknown, apply: () => Promise<void>): Promise<void> {
        const key = chanHash(val);
        if (key === this.last.get(id)) return;
        await apply();
        this.last.set(id, key);
        this.log?.(`${id} synced into guest`);
    }

    /**
     * One-shot channels — hash-gated against run/sync.state (same rule as
     * wallpaper.state: skip when last apply succeeded and inputs are
     * unchanged, so in-guest drift isn't clobbered every session).
     */
    private async runOneshots(): Promise<void> {
        const spec = this.h.spec;
        const statePath = join(this.h.paths.run, "sync.state");
        const state: Record<string, string> = JSON.parse(
            await readFile(statePath, "utf-8").catch(() => "{}"));

        const tryChan = async (id: SyncId, val: unknown, apply: () => Promise<void>) => {
            if (!syncEnabled(spec, id) || val === null || val === undefined) return;
            const key = chanHash(val);
            if (state[id] === key) return;
            try {
                await apply();
                state[id] = key;
                this.log?.(`${id} synced into guest`);
            } catch (e) {
                this.log?.(`${id}: ${e instanceof Error ? e.message : e}`);
            }
        };

        const jobs: Promise<void>[] = [];

        if (syncEnabled(spec, "locale")) {
            jobs.push(hostLocale().then((v) => tryChan("locale", v,
                () => pushScript(this.h, guestLocaleScript(v!), "locale"))));
        }
        if (syncEnabled(spec, "scale")) {
            jobs.push(hostDisplayScale().then((v) => tryChan("scale", v,
                () => pushScript(this.h, guestScaleScript(spec, v!), "scale"))));
        }
        if (syncEnabled(spec, "keyboard")) {
            jobs.push(hostKeyboard().then((v) => tryChan("keyboard", v,
                () => pushScript(this.h, guestKeyboardScript(spec, v!), "keyboard"))));
        }
        if (syncEnabled(spec, "gitIdentity")) {
            jobs.push(hostGitIdentity().then((v) => tryChan("gitIdentity", v,
                () => pushScript(this.h, guestGitScript(spec, v!), "git identity"))));
        }
        if (syncEnabled(spec, "proxy")) {
            jobs.push(hostProxy().then((v) => tryChan("proxy", v,
                () => pushScript(this.h, guestProxyScript(spec, v!), "proxy"))));
        }
        if (syncEnabled(spec, "caCerts")) {
            jobs.push((async () => {
                const certs = await hostCaCerts();
                if (!certs.length) return;
                const files = await Promise.all(certs.map(async (p) => ({
                    name: p.split("/").pop()!,
                    data: await readFile(p).catch(() => null),
                })));
                const good = files.filter((f) => f.data !== null) as { name: string; data: Buffer }[];
                if (!good.length) return;
                await tryChan("caCerts", good.map((f) => `${f.name}:${f.data.length}:${createHash("sha256").update(f.data).digest("hex").slice(0, 12)}`), async () => {
                    // one staging dir per push — removed certs stop propagating
                    for (let i = 0; i < good.length; i++)
                        await pushFileToGuest(this.h, `/tmp/cruiser-ca/${i}-${good[i]!.name}`, good[i]!.data);
                    await pushScript(this.h, guestCaCertsScript(), "ca certs");
                });
            })());
        }
        if (syncEnabled(spec, "shares")) {
            const mounts = spec.shares.filter((s) => s.enabled !== false && s.mode !== "copy");
            jobs.push(tryChan("shares", mounts, () =>
                pushScript(this.h, guestSharesScript(spec), "shares")));
        }
        if (syncEnabled(spec, "gitKey")) {
            jobs.push((async () => {
                const key = await hostGitSshKey(spec);
                if (!key) {
                    this.log?.("gitKey: no host key resolved — set credentials.gitSshKeyPath or drop the key at ~/.ssh/<git email>");
                    return;
                }
                // hash the private half — a rotated key re-pushes
                await tryChan("gitKey", `${key.path}:${createHash("sha256").update(key.priv).digest("hex").slice(0, 16)}`,
                    () => pushScript(this.h, guestGitKeyScript(spec, key), "git key"));
            })());
        }
        // Not a channel — a display.clipboard fixture the dmabuf viewer
        // needs; the same hash gate makes it idempotent and reaches
        // already-provisioned VMs on their next session.
        if (spec.display.clipboard && spec.display.viewer === "dmabuf") {
            jobs.push((async () => {
                const key = chanHash(CLIPBRIDGE_V);
                if (state.clipBridge === key) return;
                try {
                    await pushScript(this.h, guestClipBridgeScript(spec), "clipboard bridge");
                    state.clipBridge = key;
                    this.log?.("clipboard bridge synced into guest");
                } catch (e) {
                    this.log?.(`clipBridge: ${e instanceof Error ? e.message : e}`);
                }
            })());
        }
        if (syncEnabled(spec, "monitors") && (spec.os.desktop === "gnome" || spec.os.desktop === "kde")) {
            jobs.push((async () => {
                const adapter = detectAdapter();
                if (!adapter.caps.monitors) return;
                const host = await applyHostScale(spec, await adapter.monitors().catch(() => []));
                if (!host.length) return;
                if (spec.os.desktop === "kde") {
                    // hash includes the QEMU pid — the guest re-derives its
                    // output layout at every boot (kscreen auto-arrange), so
                    // this channel must re-apply once per boot, not just when
                    // the host topology changes.
                    await tryChan("monitors",
                        [...host.map((m) => `${m.name}@${m.x},${m.y} ${m.w}x${m.h}`), `boot:${this.h.pid()}`],
                        () => pushScript(this.h, guestKdeMonitorsScript(spec, host), "monitors (kscreen)", 200_000));
                } else {
                    const xml = guestLayoutFromHost(spec.name, host).xml;
                    await tryChan("monitors", xml, async () => {
                        await pushFileToGuest(this.h, "/tmp/cruiser-monitors.xml", xml);
                        await pushScript(this.h, guestMonitorScript(spec), "monitors");
                    });
                }
            })());
        }

        await Promise.allSettled(jobs);
        await mkdir(this.h.paths.run, { recursive: true });
        await writeFile(statePath, `${JSON.stringify(state, null, 1)}\n`);
    }

    dispose(): void {
        this.unwatch.forEach((u) => u());
        this.unwatch = [];
        this.agent?.dispose();
        this.agent = null;
    }

    /**
     * Push every enabled channel once and resolve — the `vm sync --apply`
     * path. Watchers aren't started (this instance is one-shot; the
     * sshAgent forward needs a held session, so it only ever starts via
     * start()).
     */
    async applyOnce(): Promise<void> {
        await this.pushLive();
        await this.runOneshots();
    }
}
