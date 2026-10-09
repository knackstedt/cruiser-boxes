// ============================================================================
// guest-setup.ts — drive in-guest setup over QGA. Distro- and desktop-aware:
// the script re-detects the real distro from /etc/os-release (an imported
// disk's spec.os.family may be wrong) and picks the matching package list
// from packages.ts. GNOME → gdm + gnome-remote-desktop system daemon;
// KDE → sddm autologin + krdpserver (user-session service under
// plasma-workspace.target). Port of devvm's guest-setup.sh.
// ============================================================================

import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { profileFromSpec, resolvePackages, resolveFlatpaks } from "./packages";

/**
 * Wait until the QEMU guest agent answers (guest booted + agent installed).
 * QEMU's socket accepts immediately but the agent only talks post-boot.
 */
export async function waitForAgent(h: VmHandle, timeoutMs = 5 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            // Each attempt uses a fresh socket (withQga closes on return) — a
            // failed ping leaves unrecoverable wire state, and reconnect
            // storms are what wedge qemu-ga in the first place.
            await h.withQga((g) => g.ping(5_000), 5_000);
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
    const p = profileFromSpec(spec);
    // Resolve all three families — the script picks by live /etc/os-release
    // so imported disks get correct names even when spec.os.family is a guess.
    const pkgLists = (["ubuntu", "debian", "fedora"] as const)
        .map((f) => `        ${f}) WANTED="${resolvePackages({ ...p, family: f }, "setup").join(" ")}" ;;`)
        .join("\n");
    const flatpaks = resolveFlatpaks(p);
    const gnome = p.desktop === "gnome";
    const dm = gnome ? "gdm" : "sddm";

    const pkgSection = `# distro detect — spec says '${p.family}' but imported disks may differ;
# os-release wins, and each family maps to its own package names.
FAM=${p.family}
if [ -r /etc/os-release ]; then . /etc/os-release
    case " \${ID:-} \${ID_LIKE:-} " in *" fedora "*) FAM=fedora ;; *" debian "*|*" ubuntu "*) FAM=debian ;; esac
    [ "\${ID:-}" = "ubuntu" ] && FAM=ubuntu
fi
case "$FAM" in
${pkgLists}
        *) WANTED="${resolvePackages({ ...p, family: "ubuntu" }, "setup").join(" ")}" ;;
esac
# The agent answers while cloud-init's package stage is still running —
# wait it out, then wait out any lingering dpkg lock (unattended-upgrades
# races this too). Without this the install batch silently no-ops.
command -v cloud-init >/dev/null && cloud-init status --wait >/dev/null 2>&1 || true
for i in $(seq 1 300); do
    fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break
    sleep 2
done
${p.extraFonts ? `# MS core fonts EULA — accepted on behalf of the user via debconf preseed
echo 'ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true' | \\
    debconf-set-selections 2>/dev/null || true` : ""}
if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq || true
    apt-get install -y $WANTED || true
elif command -v dnf5 >/dev/null; then dnf5 install -y --skip-unavailable $WANTED || true
elif command -v dnf >/dev/null; then dnf install -y --skip-unavailable $WANTED || true
elif command -v zypper >/dev/null; then zypper --non-interactive install $WANTED || true
fi
usermod -aG render "$U" || true
systemctl enable --now qemu-guest-agent 2>/dev/null || true
systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || true
# firewalld blocks the RDP/ssh inbound on distros that ship it (fedora wkst)
command -v firewall-cmd >/dev/null && {
    firewall-cmd --permanent --add-service=ssh >/dev/null 2>&1 || true
    firewall-cmd --permanent --add-port=3389/tcp >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
}`;

    const shareSection = `# host shares — virtiofs when a virtio-fs device is bound, 9p otherwise.
# (virtiofs devices have no mount_tag sysfs attr; driver binding is the test.)
SHARE_FSTYPE=9p; ls -d /sys/bus/virtio/drivers/virtiofs/virtio* >/dev/null 2>&1 && SHARE_FSTYPE=virtiofs
${spec.shares.map((s) => `mkdir -p /mnt/${s.tag}
if [ "$SHARE_FSTYPE" = virtiofs ]; then
    grep -q ' /mnt/${s.tag} ' /etc/fstab || tee -a /etc/fstab <<'FSTAB'
${s.tag} /mnt/${s.tag} virtiofs rw,nofail,_netdev,x-systemd.automount 0 0
FSTAB
    mount -t virtiofs ${s.tag} /mnt/${s.tag} 2>/dev/null || true
else
    grep -q ' /mnt/${s.tag} ' /etc/fstab || tee -a /etc/fstab <<'FSTAB'
${s.tag} /mnt/${s.tag} 9p trans=virtio,version=9p2000.L,msize=262144,_netdev,x-systemd.automount,x-systemd.idle-timeout=60,nofail 0 0
FSTAB
    mount -t 9p -o trans=virtio,version=9p2000.L ${s.tag} /mnt/${s.tag} 2>/dev/null || true
fi`).join("\n")}
systemctl daemon-reload || true`;

    const dmSection = gnome ? `# GDM autologin (console seat; headless RDP seat is separate).
# debian/ubuntu keep custom.conf under /etc/gdm3, fedora under /etc/gdm.
for GDMCONF in /etc/gdm3/custom.conf /etc/gdm/custom.conf; do
    [ -d "$(dirname "$GDMCONF")" ] || continue
    grep -q AutomaticLoginEnable "$GDMCONF" 2>/dev/null || tee -a "$GDMCONF" <<'GDM'

[daemon]
AutomaticLoginEnable=true
AutomaticLogin=${u}
GDM
done
systemctl enable gdm.service 2>/dev/null || systemctl enable gdm3.service 2>/dev/null || true` : `# SDDM autologin — krdpserver is a user-session service, so an RDP session
# needs the autologged-in Plasma session up first.
mkdir -p /etc/sddm.conf.d
SESS=plasma
[ -f /usr/share/wayland-sessions/plasmawayland.desktop ] && SESS=plasmawayland
kwriteconfig6 --file /etc/sddm.conf.d/cruiser.conf --group Autologin --key User "$U" 2>/dev/null || {
    cat > /etc/sddm.conf.d/cruiser.conf <<SDDM
[Autologin]
User=$U
Relogin=true
Session=$SESS
SDDM
}
kwriteconfig6 --file /etc/sddm.conf.d/cruiser.conf --group Autologin --key Relogin true 2>/dev/null || true
kwriteconfig6 --file /etc/sddm.conf.d/cruiser.conf --group Autologin --key Session "$SESS" 2>/dev/null || true
systemctl enable sddm.service 2>/dev/null || true`;

    const rdpSection = gnome ? `# gnome-remote-desktop system (headless) daemon — the multi-monitor path
mkdir -p /var/lib/gnome-remote-desktop/tls
[ -f /var/lib/gnome-remote-desktop/tls/cert.pem ] || openssl req -x509 \\
    -newkey rsa:2048 -keyout /var/lib/gnome-remote-desktop/tls/key.pem \\
    -out /var/lib/gnome-remote-desktop/tls/cert.pem -days 3650 -nodes -subj /CN=${spec.name}
chown -R gnome-remote-desktop:gnome-remote-desktop /var/lib/gnome-remote-desktop
systemctl enable --now gnome-remote-desktop.service
# GRD ≥47: grdctl talks to a separate configuration daemon — it must be up
# before the grdctl calls or the settings land nowhere.
systemctl enable --now gnome-remote-desktop-configuration.service 2>/dev/null || true
sleep 1
grdctl --system rdp set-tls-cert /var/lib/gnome-remote-desktop/tls/cert.pem
grdctl --system rdp set-tls-key /var/lib/gnome-remote-desktop/tls/key.pem
grdctl --system rdp set-credentials '${u}' '${o.rdpPassword}'
grdctl --system rdp set-auth-methods credentials
grdctl --system rdp disable-view-only
grdctl --system rdp disable-port-negotiation
grdctl --system rdp enable
# grdctl lies: it exits 0 while printing polkit/dbus errors to stderr and
# applying nothing. Trust only the socket.
# The RDP listener only binds once a seat exists — make sure the DM is up
# first (skipped on live reattach), then bounce the daemon while polling:
# older GRD builds never retry the bind after a no-seat start.
ss -tln | grep -q ':3389' || systemctl restart gdm 2>/dev/null || systemctl restart gdm3 2>/dev/null || true
systemctl restart gnome-remote-desktop.service || true
rdpok=; i=0
while [ $i -lt 60 ]; do
    if ss -tln | grep -q ':3389'; then rdpok=1; break; fi
    i=$((i+1))
    if [ $((i % 15)) -eq 0 ]; then systemctl restart gnome-remote-desktop.service || true; fi
    sleep 2
done
if [ -z "$rdpok" ]; then echo "GRD RDP server is not listening on 3389"; exit 1; fi
[ -s /var/lib/gnome-remote-desktop/.local/share/gnome-remote-desktop/credentials.ini ] || \\
    { echo "GRD credentials were not persisted"; exit 1; }` : `# krdpserver — user-session RDP (wanted by plasma-workspace.target).
# SystemUserEnabled lets RDP clients authenticate with the system password;
# the permission-set preseed suppresses the portal allow/deny prompt.
KDIR="$UHOME/.local/share/krdpserver"
mkdir -p "$KDIR"
[ -f "$KDIR/krdp.crt" ] || openssl req -nodes -new -x509 \\
    -keyout "$KDIR/krdp.key" -out "$KDIR/krdp.crt" -days 3650 -batch -subj /CN=${spec.name}
chown -R "$U":"$U" "$KDIR"
KUSR() { runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/"$UUID" DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus "$@"; }
KUSR flatpak permission-set kde-authorized remote-desktop org.kde.krdpserver yes 2>/dev/null || true
KUSR kwriteconfig6 --file krdpserverrc --group General --key Certificate "$KDIR/krdp.crt"
KUSR kwriteconfig6 --file krdpserverrc --group General --key CertificateKey "$KDIR/krdp.key"
KUSR kwriteconfig6 --file krdpserverrc --group General --key SystemUserEnabled true
KUSR kwriteconfig6 --file krdpserverrc --group General --key User "$U"
KUSR kwriteconfig6 --file krdpserverrc --group General --key Password '${o.rdpPassword}'
KUSR kwriteconfig6 --file krdpserverrc --group General --key Port 3389
KUSR kwriteconfig6 --file krdpserverrc --group General --key Autostart true
systemctl --global enable app-org.kde.krdpserver.service 2>/dev/null || \\
    systemctl --global enable plasma-krdp_server.service 2>/dev/null || true
# boot the autologged-in Plasma session — krdpserver starts with it.
# (skipped if :3389 is already serving — don't kill a live reattach session)
ss -tln | grep -q ':3389' || systemctl restart ${dm} || true
rdpok=; i=0
while [ $i -lt 90 ]; do
    if ss -tln | grep -q ':3389'; then rdpok=1; break; fi
    i=$((i+1)); sleep 2
done
KUSR flatpak permission-set kde-authorized remote-desktop org.kde.krdpserver yes 2>/dev/null || true
if [ -z "$rdpok" ]; then echo "krdpserver is not listening on 3389 (needs a running Plasma session)"; exit 1; fi`;

    const lockSection = gnome ? `# no lock/suspend inside the VM (user session bus may not exist pre-login)
runuser -u "$U" -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \\
    gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null || true
runuser -u "$U" -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \\
    gsettings set org.gnome.desktop.lockdown disable-lock-screen true 2>/dev/null || true
runuser -u "$U" -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \\
    gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type nothing 2>/dev/null || true
runuser -u "$U" -- env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \\
    gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true` : `# no lock/suspend inside the VM — kscreenlocker + powerdevil config
runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/"$UUID" \\
    kwriteconfig6 --file kscreenlockerrc --group Daemon --key Autolock false 2>/dev/null || true
runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/"$UUID" \\
    kwriteconfig6 --file kscreenlockerrc --group Daemon --key LockOnResume false 2>/dev/null || true
runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/"$UUID" \\
    kwriteconfig6 --file powermanagementprofilesrc --group AC --group SuspendSession --key idleTime 0 2>/dev/null || true`;

    const appSection = `# app channels — flatpak always (store backends plug into it), snapd opt-in
if command -v flatpak >/dev/null; then
    flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo || true
${flatpaks.length ? `    flatpak install -y --noninteractive --or-update flathub ${flatpaks.join(" ")} || true` : ""}
fi
${p.snap ? `# classic snaps need /snap -> /var/lib/snapd/snap (fedora; deb distros
# ship /snap as a real dir already — ln -sfn then fails harmlessly)
ln -sfn /var/lib/snapd/snap /snap 2>/dev/null || true
systemctl enable --now snapd.socket 2>/dev/null || true` : ""}`;

    // NOTE: runs as root via QGA — user-context steps are explicitly `runuser`'d.
    // PATH is set explicitly: QGA exec on Fedora gets /usr/local/bin:/usr/bin.
    return `set -euo pipefail
export PATH=/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin
U='${u}'
UHOME=$(getent passwd "$U" | cut -d: -f6)
UUID=$(id -u "$U")

${pkgSection}

${shareSection}

${dmSection}

${rdpSection}

${lockSection}

${appSection}

${!gnome || !o.monitorsXmlB64 ? "" : `mkdir -p "$UHOME/.config" && echo '${o.monitorsXmlB64}' | base64 -d > "$UHOME/.config/monitors.xml" && chown -R "$U":"$U" "$UHOME/.config"`}
echo CRUISER_GUEST_SETUP_OK
`;
}

/**
 * Is the guest agent exec context confined? Fedora confines qemu-ga under
 * SELinux (virt_qemu_ga_t) — root uid but no system privileges. Returns the
 * context string (or "" on probe failure).
 */
async function agentContext(h: VmHandle): Promise<string> {
    const r = await h.guestSh("cat /proc/self/attr/current 2>/dev/null; id -u", 15_000)
        .catch(() => null);
    if (!r) return "";
    const out = String(r.stdout);
    const last = out.trim().split("\n").pop() ?? "";
    return out.includes("_ga_t:") || !last.startsWith("0") ? out : "";
}

/**
 * Guest setup over SSH. Needed where qemu-ga is SELinux-confined (Fedora):
 * sshd runs unconfined and the seed grants the user NOPASSWD sudo.
 * Requires the cruiser key authorized (seed injects it for provisioned VMs).
 */
async function runGuestSetupSsh(
    h: VmHandle, script: string, timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
    const port = h.spec.network.sshPort;
    if (!port)
        throw new Error("guest agent is confined (SELinux) and no SSH hostfwd is mapped — cannot run guest setup");
    const { ensureKeypair } = await import("../../vm-core/src/sshkey");
    const { priv } = await ensureKeypair();
    const { run } = await import("../../sys/src/exec");
    const b64 = Buffer.from(script).toString("base64");
    // the agent answers long before sshd is enabled during first-boot
    // provisioning (the enable lands after the seed's package install on
    // older seeds) — retry transport errors for a grace window.
    const deadline = Date.now() + Math.min(timeoutMs, 10 * 60_000);
    let r = { code: 255, stdout: "", stderr: "not attempted" };
    for (;;) {
        r = await run("ssh", [
            "-i", priv, "-p", String(port),
            "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=15",
            `${h.spec.credentials.username}@127.0.0.1`,
            `echo ${b64} | base64 -d | sudo -n bash`,
        ], { noThrow: true, timeoutMs });
        if (r.code !== 255 || Date.now() > deadline) break;
        await new Promise((res) => setTimeout(res, 5000));
    }
    if (r.code === 255 && !r.stdout)
        throw new Error(`guest setup over ssh failed to connect — is the cruiser key authorized in the guest and sudo NOPASSWD?\n${r.stderr.slice(-1000)}`);
    return { stdout: r.stdout, stderr: r.stderr };
}

/** Run guest setup inside the VM; throws unless the OK marker comes back. */
export async function runGuestSetup(
    h: VmHandle,
    o: { rdpPassword: string; monitorsXml?: string; timeoutMs?: number },
): Promise<void> {
    const timeoutMs = o.timeoutMs ?? 10 * 60_000;
    const monitorsXmlB64 = o.monitorsXml ? Buffer.from(o.monitorsXml).toString("base64") : undefined;
    const { authorizeInGuest } = await import("../../vm-core/src/sshkey");
    await authorizeInGuest(h).catch(() => {}); // confined agents can't write files — ssh seeds still work
    const script = guestSetupScript(h.spec, { rdpPassword: o.rdpPassword, monitorsXmlB64 });
    const res = await agentContext(h)
        ? await runGuestSetupSsh(h, script, timeoutMs)
        : await h.guestSh(script, timeoutMs);
    const stdout = res.stdout?.toString() ?? "";
    const stderr = res.stderr?.toString() ?? "";
    if (!stdout.includes("CRUISER_GUEST_SETUP_OK") && !stderr.includes("CRUISER_GUEST_SETUP_OK"))
        throw new Error(`guest setup did not complete cleanly:\n--- stderr ---\n${stderr.slice(-2000)}\n--- stdout ---\n${stdout.slice(-2000)}`);
}
