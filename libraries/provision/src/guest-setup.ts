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
        try {
            const g = await h.qga(5_000);
            await g.ping();
            return;
        } catch (e) {
            if (Date.now() > deadline) throw new Error(`guest agent not up after ${timeoutMs}ms: ${e}`);
            await new Promise((r) => setTimeout(r, 3000));
        }
    }
}

/** The guest setup script — run via `qga sh` (one bash -c per section batch). */
export function guestSetupScript(spec: VmSpec, o: { rdpPassword: string; monitorsXmlB64?: string }): string {
    const u = spec.credentials.username;
    return `set -euo pipefail
# packages (no-op if autoinstall/cloudimg already installed)
sudo -n apt-get install -y gnome-remote-desktop qemu-guest-agent spice-vdagent mesa-vulkan-drivers xdotool || true
sudo -n usermod -aG render "$USER" || true

# host shares (9p tags — virtiofs mounts use the same tag names)
${spec.shares.map((s) => `grep -q ' ${s.tag} ' /etc/fstab || sudo tee -a /etc/fstab <<'FSTAB'
${s.tag} /mnt/${s.tag} 9p trans=virtio,version=9p2000.L,msize=262144,_netdev,x-systemd.automount,x-systemd.idle-timeout=60 0 0
FSTAB
sudo mkdir -p /mnt/${s.tag}`).join("\n")}
sudo -n systemctl daemon-reload || true

# GDM autologin (console seat; headless RDP seat is separate)
grep -q AutomaticLoginEnable /etc/gdm3/custom.conf 2>/dev/null || sudo -n tee -a /etc/gdm3/custom.conf <<'GDM'

[daemon]
AutomaticLoginEnable=true
AutomaticLogin=${u}
GDM

# gnome-remote-desktop system (headless) daemon — the multi-monitor path
sudo -n mkdir -p /var/lib/gnome-remote-desktop/tls
[ -f /var/lib/gnome-remote-desktop/tls/cert.pem ] || sudo -n openssl req -x509 \
    -newkey rsa:2048 -keyout /var/lib/gnome-remote-desktop/tls/key.pem \
    -out /var/lib/gnome-remote-desktop/tls/cert.pem -days 3650 -nodes -subj /CN=${spec.name}
sudo -n chown -R gnome-remote-desktop:gnome-remote-desktop /var/lib/gnome-remote-desktop
sudo -n grdctl --system rdp set-tls-cert /var/lib/gnome-remote-desktop/tls/cert.pem
sudo -n grdctl --system rdp set-tls-key /var/lib/gnome-remote-desktop/tls/key.pem
sudo -n grdctl --system rdp set-credentials '${u}' '${o.rdpPassword}'
sudo -n grdctl --system rdp set-auth-methods credentials
sudo -n grdctl --system rdp disable-view-only
sudo -n grdctl --system rdp disable-port-negotiation
sudo -n grdctl --system rdp enable
sudo -n systemctl enable --now gnome-remote-desktop.service

# no lock/suspend inside the VM
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null || true
gsettings set org.gnome.desktop.lockdown disable-lock-screen true 2>/dev/null || true
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type nothing 2>/dev/null || true
gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true

${o.monitorsXmlB64 ? `mkdir -p "$HOME/.config" && echo '${o.monitorsXmlB64}' | base64 -d > "$HOME/.config/monitors.xml"` : ""}
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
