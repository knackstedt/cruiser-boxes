// ============================================================================
// guest-setup.ts — drive in-guest setup over QGA. Distro- and desktop-aware:
// the script re-detects the real distro from /etc/os-release (an imported
// disk's spec.os.family may be wrong) and picks the matching package list
// from packages.ts. GNOME → gdm + gnome-remote-desktop system daemon;
// KDE → sddm (autologin per spec.os.autologin) + krdpserver (user-session
// service under plasma-workspace.target). Port of devvm's guest-setup.sh.
// ============================================================================

import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { appendVmLog, guestAgentContext } from "../../vm-core/src/logs";
import { sq } from "../../sys/src/exec";
import { profileFromSpec, resolvePackages, resolveFlatpaks } from "./packages";
import { guestDevtoolsScript } from "./devtools";
import { guestSyncScript, guestSharesScript, type HostSnapshot } from "./sync";
import { guestKwalletScript, guestGnomeKeyringScript } from "./keyrings";

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
export function guestSetupScript(spec: VmSpec, o: { rdpPassword: string; monitorsXmlB64?: string; host?: HostSnapshot }): string {
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
${p.extraFonts ? `    # MS core fonts live outside main — debian contrib, ubuntu multiverse.
    # Cloud images ship main only; enable the component then refresh.
    case "$FAM" in
        debian) for f in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; do
            [ -f "$f" ] || continue
            grep -q contrib "$f" || sed -i -e 's/^Components: main\\>/Components: main contrib/' \\
                -e 's/ main$/ main contrib/' "$f" 2>/dev/null || true
        done ;;
        ubuntu) for f in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do
            [ -f "$f" ] || continue
            grep -q multiverse "$f" || sed -i -e 's/^Components: main\\>/Components: main multiverse/' \\
                -e 's/ main$/ main multiverse/' "$f" 2>/dev/null || true
        done ;;
    esac
` : ""}    apt-get update -qq || true
    # one unresolvable name aborts apt's whole transaction — filter to
    # packages with a real candidate first (release drift, arch gaps).
    PKGS=""
    for p in $WANTED; do
        # no grep -q here: under pipefail, grep -q's early exit SIGPIPEs
        # apt-cache (141) and the pipeline reads as failure — false skips.
        if apt-cache policy "$p" 2>/dev/null | grep "Candidate: [^ (]" >/dev/null; then
            PKGS="$PKGS $p"
        else
            echo "guest-setup: no apt candidate for $p — skipped" >&2
        fi
    done
    [ -n "$PKGS" ] && apt-get install -y $PKGS || true
elif command -v dnf5 >/dev/null; then dnf5 install -y --skip-unavailable $WANTED || true
elif command -v dnf >/dev/null; then dnf install -y --skip-unavailable $WANTED || true
elif command -v zypper >/dev/null; then zypper --non-interactive install $WANTED || true
fi
usermod -aG render "$U" || true
systemctl enable --now qemu-guest-agent 2>/dev/null || true
# spice-vdagentd owns the com.redhat.spice.0 port the dmabuf clipboard bridge
# uses. udev (70-spice-vdagentd.rules) auto-starts it when the port exists;
# this is a no-op on distros where the unit is static.
systemctl enable --now spice-vdagentd.service 2>/dev/null || true
systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || true
# ttyS1 is the interactive console port (unix socket on the host side —
# 'vm serial'). enable --now starts a getty on this boot too when the
# port exists (already-booted VMs re-running guest-setup get it live).
systemctl enable --now serial-getty@ttyS1.service 2>/dev/null || true
# firewalld blocks the RDP/ssh inbound on distros that ship it (fedora wkst)
command -v firewall-cmd >/dev/null && {
    firewall-cmd --permanent --add-service=ssh >/dev/null 2>&1 || true
    firewall-cmd --permanent --add-port=3389/tcp >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
}`;

    // Managed fstab block + mounts — the same reconcile the session "shares"
    // channel runs, so provision and post-edit converge identically.
    const shareSection = guestSharesScript(spec);

    // disk.encrypt="home": the second virtio-blk LUKS image arrives as
    // /dev/disk/by-id/virtio-cruiser-home (serial=cruiser-home in argv).
    // Format ext4 on first sight, migrate the existing /home over, then
    // pin a by-id fstab entry + mount — idempotent on re-provision, and
    // ordered BEFORE the share/dm/rdp sections so everything that writes
    // under $UHOME lands on the encrypted disk.
    const homeSection = spec.disk.encrypt !== "home" ? "" : `# cruiser encrypted /home — the qcow2 LUKS layer is unlocked by QEMU;
# the guest sees a plain virtio disk we own end-to-end.
HDEV=/dev/disk/by-id/virtio-cruiser-home
i=0; while [ ! -b "$HDEV" ] && [ $i -lt 30 ]; do i=$((i+1)); sleep 1; done
if [ -b "$HDEV" ]; then
    blkid "$HDEV" >/dev/null 2>&1 || mkfs.ext4 -q -F -L cruiser-home "$HDEV"
    if ! grep -q 'virtio-cruiser-home' /etc/fstab; then
        mkdir -p /mnt/cruiser-home
        if mount "$HDEV" /mnt/cruiser-home; then
            cp -a /home/. /mnt/cruiser-home/ 2>/dev/null || true
            umount /mnt/cruiser-home
            echo '/dev/disk/by-id/virtio-cruiser-home /home ext4 defaults 0 2' >> /etc/fstab
            mount /home || true
        fi
    else
        mountpoint -q /home || mount /home || true
    fi
else
    echo "guest-setup: $HDEV never appeared — /home stays on the root disk" >&2
fi`;

    const dmSection = gnome ? `# GDM — a seat0 autologin session collides with GRD remote login:
# GNOME allows ONE graphical session per user, so every RDP greeter login
# hit the "kick off the other session" prompt, and the replacement session
# raced the old one's shutdown on the shared user manager
# (gnome-session@*.target start vs queued gnome-session-shutdown.target →
# TransactionIsDestructive → "Session never registered" → gray RDP stream).
# gnome-headless-session@<user> (GDM ~49+) instead keeps a persistent
# HEADLESS session alive — remote logins reattach to it through the
# handover path, no prompt, no teardown race. Distros without the unit
# fall back to the old console autologin below.
HEADLESS_UNIT=/usr/lib/systemd/system/gnome-headless-session@.service
if [ -f "$HEADLESS_UNIT" ]; then
    # Ubuntu 26.04's unit runs a DynamicUser — GDM drops the transient uid's
    # bus connection before polkit runs ("The connection is closed"); the
    # manage-user-displays rule + GDM's peer check want the static gdm user.
    mkdir -p /etc/systemd/system/gnome-headless-session@.service.d
    tee /etc/systemd/system/gnome-headless-session@.service.d/cruiser.conf <<'GHSD' >/dev/null
[Service]
DynamicUser=no
User=gdm
GHSD
    systemctl daemon-reload || true
fi
# debian/ubuntu keep custom.conf under /etc/gdm3, fedora under /etc/gdm.
for GDMCONF in /etc/gdm3/custom.conf /etc/gdm/custom.conf; do
    [ -d "$(dirname "$GDMCONF")" ] || continue
${p.autologin ? `    if [ -f "$HEADLESS_UNIT" ]; then
        # headless unit carries autologin — strip seat0 autologin keys so no
        # console session can compete with (or block) the headless one.
        [ -f "$GDMCONF" ] && sed -i -e '/^AutomaticLoginEnable=/d' -e '/^AutomaticLogin=/d' "$GDMCONF"
    else
    # drop prior autologin keys (ours or hand-set) then append our block —
    # idempotent and able to flip a previous disable back on. The stock
    # "# AutomaticLoginEnable = true" comment doesn't match the ^ anchors.
    [ -f "$GDMCONF" ] && sed -i -e '/^AutomaticLoginEnable=/d' -e '/^AutomaticLogin=/d' "$GDMCONF"
    tee -a "$GDMCONF" <<'GDM'

[daemon]
AutomaticLoginEnable=true
AutomaticLogin=${u}
GDM
    fi` : `    # autologin off — flip a previous enable back off (re-provision retrofits).
    [ -f "$GDMCONF" ] && sed -i -e 's/^AutomaticLoginEnable=.*/AutomaticLoginEnable=false/' \\
        -e '/^AutomaticLogin=/d' "$GDMCONF"`}
done
systemctl enable gdm.service 2>/dev/null || systemctl enable gdm3.service 2>/dev/null || true` : `# SDDM — krdpserver is a user-session service, so an RDP session needs a
# logged-in Plasma session up first (autologin provides it).
mkdir -p /etc/sddm.conf.d
${p.autologin ? `SESS=plasma
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
kwriteconfig6 --file /etc/sddm.conf.d/cruiser.conf --group Autologin --key Session "$SESS" 2>/dev/null || true` : `# autologin off — drop the config a previous provision wrote.
rm -f /etc/sddm.conf.d/cruiser.conf`}
systemctl enable sddm.service 2>/dev/null || true`;

    const rdpSection = gnome ? `# gnome-remote-desktop system (headless) daemon — the multi-monitor path
mkdir -p /var/lib/gnome-remote-desktop/tls
[ -f /var/lib/gnome-remote-desktop/tls/cert.pem ] || openssl req -x509 \\
    -newkey rsa:2048 -keyout /var/lib/gnome-remote-desktop/tls/key.pem \\
    -out /var/lib/gnome-remote-desktop/tls/cert.pem -days 3650 -nodes -subj ${sq(`/CN=${spec.name}`)}
chown -R gnome-remote-desktop:gnome-remote-desktop /var/lib/gnome-remote-desktop
# the stock unit has no ordering on the DM — it starts parallel to gdm, and
# a failed connect to /org/gnome/DisplayManager/Displays is never retried
# (the daemon stays alive, so Restart=on-failure can't help either), leaving
# :3389 unbound forever. gdm is Type=dbus, so ordering after the DM alias
# defers GRD until gdm owns its bus name. Wants (not Requires) keeps GRD
# starting on DM-less imported disks.
mkdir -p /etc/systemd/system/gnome-remote-desktop.service.d
tee /etc/systemd/system/gnome-remote-desktop.service.d/after-dm.conf <<'GRDDROP' >/dev/null
[Unit]
Wants=display-manager.service
After=display-manager.service
GRDDROP
systemctl daemon-reload || true
systemctl enable --now gnome-remote-desktop.service
# GRD ≥47: grdctl talks to a separate configuration daemon — it must be up
# before the grdctl calls or the settings land nowhere.
systemctl enable --now gnome-remote-desktop-configuration.service 2>/dev/null || true
sleep 1
grdctl --system rdp set-tls-cert /var/lib/gnome-remote-desktop/tls/cert.pem
grdctl --system rdp set-tls-key /var/lib/gnome-remote-desktop/tls/key.pem
grdctl --system rdp set-credentials ${sq(u)} ${sq(o.rdpPassword)}
# optional knobs vary across grdctl versions (trixie lacks set-auth-methods)
grdctl --system rdp set-auth-methods credentials 2>/dev/null || true
grdctl --system rdp disable-view-only 2>/dev/null || true
grdctl --system rdp disable-port-negotiation 2>/dev/null || true
grdctl --system rdp enable
# grdctl lies: it exits 0 while printing polkit/dbus errors to stderr and
# applying nothing. Trust only the socket.
# The RDP listener only binds once a seat exists — make sure the DM is up
# first (skipped on live reattach), then bounce the daemon while polling:
# older GRD builds never retry the bind after a no-seat start.
ss -tln | grep -q ':3389' || systemctl ${p.autologin ? "restart" : "start"} gdm 2>/dev/null || systemctl ${p.autologin ? "restart" : "start"} gdm3 2>/dev/null || true
systemctl restart gnome-remote-desktop.service || true
rdpok=; i=0
while [ $i -lt 60 ]; do
    if ss -tln | grep -q ':3389'; then rdpok=1; break; fi
    i=$((i+1))
    if [ $((i % 15)) -eq 0 ]; then
        systemctl restart gnome-remote-desktop.service || true
        # rdp-enable doesn't latch while the daemon's DM connect is still
        # racing (RDP status stays "disabled" — daemon restarts alone never
        # retry it). Re-issue on the same cadence; a big first-boot install
        # (devtools) pushes gdm's settle time past the initial call.
        grdctl --system rdp enable 2>/dev/null || true
    fi
    sleep 2
done
if [ -z "$rdpok" ]; then echo "GRD RDP server is not listening on 3389"; exit 1; fi
[ -s /var/lib/gnome-remote-desktop/.local/share/gnome-remote-desktop/credentials.ini ] || \\
    { echo "GRD credentials were not persisted"; exit 1; }
${p.autologin ? `# persistent headless session — starts after the gdm/GRD churn above so a
# gdm restart can't kill a half-created session. A leftover session for
# the same user makes gdm-new-session fail and restart-flap; that session
# is itself reattachable, so the flap is harmless noise.
if [ -f /usr/lib/systemd/system/gnome-headless-session@.service ]; then
    systemctl enable gnome-headless-session@"$U".service 2>/dev/null || true
    systemctl start gnome-headless-session@"$U".service 2>/dev/null || true
fi` : `# autologin off — drop a headless-session unit a previous provision enabled
# (disable only: a live session isn't killed out from under a connected user)
systemctl disable gnome-headless-session@"$U".service 2>/dev/null || true`}` : `# krdpserver — user-session RDP (wanted by plasma-workspace.target).
# SystemUserEnabled lets RDP clients authenticate with the system password;
# the permission-set preseed suppresses the portal allow/deny prompt.
KDIR="$UHOME/.local/share/krdpserver"
# mkdir as the user — a root mkdir -p leaves ~/.local{,/share} root-owned,
# which breaks kwalletd ("Cannot create wallet save location!") etc.
runuser -u "$U" -- mkdir -p "$KDIR"
[ -f "$KDIR/krdp.crt" ] || openssl req -nodes -new -x509 \\
    -keyout "$KDIR/krdp.key" -out "$KDIR/krdp.crt" -days 3650 -batch -subj ${sq(`/CN=${spec.name}`)}
chown -R "$U":"$U" "$KDIR"
KUSR() { runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/"$UUID" DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus "$@"; }
KUSR flatpak permission-set kde-authorized remote-desktop org.kde.krdpserver yes 2>/dev/null || true
KUSR kwriteconfig6 --file krdpserverrc --group General --key Certificate "$KDIR/krdp.crt"
KUSR kwriteconfig6 --file krdpserverrc --group General --key CertificateKey "$KDIR/krdp.key"
KUSR kwriteconfig6 --file krdpserverrc --group General --key SystemUserEnabled true
KUSR kwriteconfig6 --file krdpserverrc --group General --key User "$U"
KUSR kwriteconfig6 --file krdpserverrc --group General --key Password ${sq(o.rdpPassword)}
KUSR kwriteconfig6 --file krdpserverrc --group General --key Port 3389
KUSR kwriteconfig6 --file krdpserverrc --group General --key Autostart true
systemctl --global enable app-org.kde.krdpserver.service 2>/dev/null || \\
    systemctl --global enable plasma-krdp_server.service 2>/dev/null || true
# boot the autologged-in Plasma session — krdpserver starts with it.
# (skipped if :3389 is already serving — don't kill a live reattach session;
# with autologin off use start — restart would kill a live console session)
ss -tln | grep -q ':3389' || systemctl ${p.autologin ? "restart" : "start"} ${dm} || true
rdpok=; i=0
while [ $i -lt ${p.autologin ? 90 : 5} ]; do
    if ss -tln | grep -q ':3389'; then rdpok=1; break; fi
    i=$((i+1)); sleep 2
done
KUSR flatpak permission-set kde-authorized remote-desktop org.kde.krdpserver yes 2>/dev/null || true
${p.autologin
    ? `if [ -z "$rdpok" ]; then echo "krdpserver is not listening on 3389 (needs a running Plasma session)"; exit 1; fi`
    : `if [ -z "$rdpok" ]; then echo "krdpserver not listening yet — autologin is off, so it binds once a user logs into the console session"; fi`}`;

    // Seed a silently-unlocking secret store for autologin sessions — runs
    // after the rdp section's :3389 wait, which guarantees the autologged-in
    // session (and its user bus/user manager) is up. KDE gets an
    // empty-password kdewallet, GNOME a blank-password login keyring.
    const walletSection = !p.autologin ? "" : gnome ? guestGnomeKeyringScript() : guestKwalletScript();

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
    return `set -eu
set -o pipefail 2>/dev/null || true   # dash (QGA /bin/sh) lacks pipefail
export PATH=/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin
U=${sq(u)}
UHOME=$(getent passwd "$U" | cut -d: -f6)
UUID=$(id -u "$U")

${pkgSection}

${homeSection}

${shareSection}

${dmSection}

${rdpSection}

${walletSection}

${lockSection}

${appSection}

${guestDevtoolsScript(p)}

${!gnome || !o.monitorsXmlB64 ? "" : `mkdir -p "$UHOME/.config" && echo '${o.monitorsXmlB64}' | base64 -d > "$UHOME/.config/monitors.xml" && chown -R "$U":"$U" "$UHOME/.config"`}

${o.host ? guestSyncScript(spec, o.host) : ""}
echo CRUISER_GUEST_SETUP_OK
`;
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
    o: { rdpPassword: string; monitorsXml?: string; host?: HostSnapshot; timeoutMs?: number },
): Promise<void> {
    const timeoutMs = o.timeoutMs ?? 10 * 60_000;
    const monitorsXmlB64 = o.monitorsXml ? Buffer.from(o.monitorsXml).toString("base64") : undefined;
    const { authorizeInGuest } = await import("../../vm-core/src/sshkey");
    await authorizeInGuest(h).catch(() => {}); // confined agents can't write files — ssh seeds still work
    const script = guestSetupScript(h.spec, { rdpPassword: o.rdpPassword, monitorsXmlB64, host: o.host });
    const res = await guestAgentContext(h)
        ? await runGuestSetupSsh(h, script, timeoutMs)
        : await h.guestSh(script, timeoutMs);
    const stdout = res.stdout?.toString() ?? "";
    const stderr = res.stderr?.toString() ?? "";
    if (!stdout.includes("CRUISER_GUEST_SETUP_OK") && !stderr.includes("CRUISER_GUEST_SETUP_OK"))
        throw new Error(`guest setup did not complete cleanly:\n--- stderr ---\n${stderr.slice(-2000)}\n--- stdout ---\n${stdout.slice(-2000)}`);
    // Every best-effort step echoes its skips to stderr — keep them in the
    // VM journal on success too, so "provisioned but package X missing"
    // is diagnosable after the fact.
    if (stderr.trim()) void appendVmLog(h.paths, `guest-setup stderr:\n${stderr.trim().slice(-4000)}`);
}
