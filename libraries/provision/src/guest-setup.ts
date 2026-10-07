// ============================================================================
// guest-setup.ts — drive in-guest setup over QGA. Port of devvm's
// guest-setup.sh: packages, gnome-remote-desktop system daemon, autologin,
// share mount, no-lock, monitors.xml.
// ============================================================================

import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import type { VmSpec } from "../../vm-core/src/config/schema";

/**
 * Wait until the QEMU guest agent answers (guest booted + agent installed).
 * QEMU's socket accepts immediately but the agent only talks post-boot.
 */
export async function waitForAgent(h: VmHandle, timeoutMs = 5 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let g;
        try {
            g = await h.qga(5_000);
            await g.ping(5_000);
            return;
        } catch (e) {
            // Drop the socket — a failed ping leaves unrecoverable wire state,
            // and reconnect storms are what wedge qemu-ga in the first place.
            try { g?.close(); } catch { /* already gone */ }
            if (Date.now() > deadline) throw new Error(`guest agent not up after ${timeoutMs}ms: ${e}`);
            await new Promise((r) => setTimeout(r, 3000));
        }
    }
}

/** The guest setup script — run via `qga sh` (one bash -c per section batch). */
export function guestSetupScript(spec: VmSpec, o: { rdpPassword: string; monitorsXmlB64?: string }): string {
    const u = spec.credentials.username;
    // NOTE: runs as root via QGA — user-context steps are explicitly `runuser`'d.
    return `set -euo pipefail
U='${u}'
UHOME=$(getent passwd "$U" | cut -d: -f6)
UUID=$(id -u "$U")

# packages (no-op if autoinstall/cloudimg already installed).
# pkexec/polkitd are required: grdctl --system re-execs through pkexec and
# fails *silently* (exit 0, error on stderr) when it is missing.
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    gnome-remote-desktop qemu-guest-agent spice-vdagent mesa-vulkan-drivers xdotool \
    pkexec polkitd gdm3 gnome-shell gnome-session || true
usermod -aG render "$U" || true

# host shares (9p tags — virtiofs mounts use the same tag names)
${spec.shares.map((s) => `grep -q ' ${s.tag} ' /etc/fstab || tee -a /etc/fstab <<'FSTAB'
${s.tag} /mnt/${s.tag} 9p trans=virtio,version=9p2000.L,msize=262144,_netdev,x-systemd.automount,x-systemd.idle-timeout=60 0 0
FSTAB
mkdir -p /mnt/${s.tag}`).join("\n")}
systemctl daemon-reload || true
systemctl enable gdm.service 2>/dev/null || systemctl enable gdm3.service 2>/dev/null || true

# GDM autologin (console seat; headless RDP seat is separate)
if [ -d /etc/gdm3 ] && ! grep -q AutomaticLoginEnable /etc/gdm3/custom.conf 2>/dev/null; then
    tee -a /etc/gdm3/custom.conf <<'GDM'

[daemon]
AutomaticLoginEnable=true
AutomaticLogin=${u}
GDM
fi

# gnome-remote-desktop system (headless) daemon — the multi-monitor path
mkdir -p /var/lib/gnome-remote-desktop/tls
[ -f /var/lib/gnome-remote-desktop/tls/cert.pem ] || openssl req -x509 \
    -newkey rsa:2048 -keyout /var/lib/gnome-remote-desktop/tls/key.pem \
    -out /var/lib/gnome-remote-desktop/tls/cert.pem -days 3650 -nodes -subj /CN=${spec.name}
chown -R gnome-remote-desktop:gnome-remote-desktop /var/lib/gnome-remote-desktop
systemctl enable --now gnome-remote-desktop.service
grdctl --system rdp set-tls-cert /var/lib/gnome-remote-desktop/tls/cert.pem
grdctl --system rdp set-tls-key /var/lib/gnome-remote-desktop/tls/key.pem
printf '%s\n%s\n' '${u}' '${o.rdpPassword}' | grdctl --system rdp set-credentials
grdctl --system rdp set-auth-methods credentials
grdctl --system rdp disable-view-only
grdctl --system rdp disable-port-negotiation
grdctl --system rdp enable
# grdctl lies: it exits 0 while printing polkit/dbus errors to stderr and
# applying nothing. Trust only the socket.
systemctl restart gnome-remote-desktop.service || true
sleep 3
ss -tln | grep -q ':3389' || { echo "GRD RDP server is not listening on 3389"; exit 1; }

# no lock/suspend inside the VM (user session bus may not exist pre-login)
runuser -u "$U" -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \
    gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null || true
runuser -u "$U" -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \
    gsettings set org.gnome.desktop.lockdown disable-lock-screen true 2>/dev/null || true
runuser -u "$U" -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \
    gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type nothing 2>/dev/null || true
runuser -u "$U" -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \
    gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true

${o.monitorsXmlB64 ? `mkdir -p "$UHOME/.config" && echo '${o.monitorsXmlB64}' | base64 -d > "$UHOME/.config/monitors.xml" && chown -R "$U":"$U" "$UHOME/.config"` : ""}
echo CRUISER_GUEST_SETUP_OK
`;
}

/** Run guest setup inside the VM; throws unless the OK marker comes back. */
export async function runGuestSetup(
    h: VmHandle,
    o: { rdpPassword: string; monitorsXml?: string; timeoutMs?: number },
): Promise<void> {
    const monitorsXmlB64 = o.monitorsXml ? Buffer.from(o.monitorsXml).toString("base64") : undefined;
    const script = guestSetupScript(h.spec, { rdpPassword: o.rdpPassword, monitorsXmlB64 });
    const res = await h.guestSh(script, o.timeoutMs ?? 10 * 60_000);
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (!out.includes("CRUISER_GUEST_SETUP_OK"))
        throw new Error(`guest setup did not complete cleanly:\n${out.slice(-3000)}`);
}
