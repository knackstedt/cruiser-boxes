// ============================================================================
// keyrings.ts — seed empty-password secret stores on autologin guests.
//
// KDE: pam_kwallet5 gets an empty authtok under autologin and does NOTHING
// ("Empty or missing password, doing nothing"), so no wallet is ever
// created and the first secret-service consumer hits the new-wallet
// wizard — or a crash loop when the save dir is unreachable. ksecretd's
// internalOpen tries open("") before prompting, so a wallet created with
// an empty password auto-unlocks silently on every login.
//
// Creation replays the real pam handshake: ksecretd only honors pamOpen
// when spawned as `--pam-login <pipefd> <sockfd>` — it reads the 56-byte
// PBKDF2-SHA512 key off the pipe, then accepts one unix-socket connection
// carrying the session env (that's all pam_kwallet_init's `env | socat`
// does). A bare D-Bus pamOpen call is a silent no-op. The key derives from
// a random per-wallet salt at ~/.local/share/kwalletd/kdewallet.salt —
// the same file the backend reads when hashing passwords at open time.
//
// GNOME: gkr-pam likewise can't unlock at autologin ("couldn't unlock the
// login keyring") and --login/--unlock refuse an empty stdin password, so
// the first store blocks on an invisible gcr-prompter dialog. But a
// blank-password keyring is stored as plaintext GKeyFile — seeding an
// empty login.keyring ahead of first use makes every store/lookup silent.
// ============================================================================

/**
 * Empty-password kdewallet seed for autologin guests. Idempotent (skips
 * when a wallet file already exists in either save location) and fully
 * best-effort — a missing python3/daemon just degrades to stock behavior.
 * Only ever call this for autologin sessions: a passworded login must
 * instead let pam_kwallet create the wallet keyed by the login password.
 */
export function guestKwalletScript(): string {
    return `# kwallet seed — empty-password kdewallet so autologin sessions get a
# silently-unlocking secret store (see AGENTS.md — pam does nothing without
# a login password; dbus pamOpen on a running daemon is a no-op).
KWALLET_KWL=0
for d in "$UHOME/.local/share/kwalletd" "$UHOME/.local/share/kwallets"; do
    [ -f "$d/kdewallet.kwl" ] && KWALLET_KWL=1
done
if [ "$KWALLET_KWL" = 0 ]; then
    KWBIN=$(command -v ksecretd || command -v kwalletd6 || command -v kwalletd5 || true)
    if [ -n "$KWBIN" ] && command -v python3 >/dev/null 2>&1; then
        runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/"$UUID" \\
            DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \\
            python3 - "$KWBIN" <<'CRUISER_PAM_SEED' || true
import hashlib, os, socket, subprocess, sys, time

kwbin = sys.argv[1]
kd = os.path.expanduser("~/.local/share/kwalletd")
os.makedirs(kd, exist_ok=True)
# same dir the pam module salts into — open("") derives its key from it
saltp = os.path.join(kd, "kdewallet.salt")
if not os.path.exists(saltp) or os.path.getsize(saltp) == 0:
    with open(saltp, "wb") as f:
        f.write(os.urandom(56))
    os.chmod(saltp, 0o600)
with open(saltp, "rb") as f:
    salt = f.read(56)
key = hashlib.pbkdf2_hmac("sha512", b"", salt, 50000, 56)

r, w = os.pipe()
sockp = os.path.join(os.environ["XDG_RUNTIME_DIR"], "kwallet-pam.cruiser.sock")
try:
    os.unlink(sockp)
except FileNotFoundError:
    pass
lsock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
lsock.bind(sockp)
lsock.listen(1)

env = dict(os.environ)
env["PAM_KWALLET5_LOGIN"] = sockp
env["QT_QPA_PLATFORM"] = "offscreen"
subprocess.Popen([kwbin, "--pam-login", str(r), str(lsock.fileno())],
                 pass_fds=(r, lsock.fileno()), env=env,
                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
os.write(w, key)
os.close(w)
os.close(r)
c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
c.connect(sockp)
c.sendall(("XDG_RUNTIME_DIR=" + env["XDG_RUNTIME_DIR"]
           + "\nDBUS_SESSION_BUS_ADDRESS=" + env["DBUS_SESSION_BUS_ADDRESS"] + "\n").encode())
c.close()
lsock.close()
try:
    os.unlink(sockp)
except FileNotFoundError:
    pass
time.sleep(1)
CRUISER_PAM_SEED
        for d in "$UHOME/.local/share/kwalletd" "$UHOME/.local/share/kwallets"; do
            [ -f "$d/kdewallet.kwl" ] && echo "cruiser: seeded empty-password kdewallet"
        done
    fi
fi`;
}

/**
 * Blank-password login keyring for autologin guests. Blank-password
 * keyrings serialize as plaintext GKeyFile (gkm-secret-textual.c), so a
 * minimal [keyring]-only file is a valid empty store the daemon loads as
 * unlocked — stores then land without touching the prompter. Runs after
 * the rdp section's :3389 wait so the user manager/session bus exist for
 * the daemon restart that picks the file up.
 */
export function guestGnomeKeyringScript(): string {
    return `# gnome-keyring seed — blank-password login keyring (plaintext GKeyFile)
# so autologin sessions get a silently-unlocking secret store. The daemon
# must reload to notice a file it wasn't started with.
KRDIR="$UHOME/.local/share/keyrings"
if [ ! -f "$KRDIR/login.keyring" ] && command -v gnome-keyring-daemon >/dev/null 2>&1; then
    runuser -u "$U" -- mkdir -p "$KRDIR"
    runuser -u "$U" -- tee "$KRDIR/login.keyring" >/dev/null <<'CRUISER_KR_SEED'
[keyring]
display-name=Login
ctime=0
mtime=0
lock-on-idle=false
lock-after=false
CRUISER_KR_SEED
    chmod 600 "$KRDIR/login.keyring"
    runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/"$UUID" \\
        DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$UUID"/bus \\
        systemctl --user restart gnome-keyring-daemon.service 2>/dev/null || true
    echo "cruiser: seeded blank-password login keyring"
fi`;
}
