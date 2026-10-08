// ============================================================================
// sshkey.ts — cruiser-owned SSH keypair for passwordless guest access.
//
// Detached child processes (sshfs, ssh -X, waypipe ssh) can't answer a
// password prompt — so cruiser keeps one ed25519 keypair under
// ~/.config/cruiser/keys/, injects the pubkey into cloud-init/autoinstall
// seeds, and can add it to a running guest's authorized_keys via QGA.
// ============================================================================

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../../sys/src/exec";
import { CONFIG_DIR } from "./paths";

const KEYS_DIR = join(CONFIG_DIR, "keys");
const PRIV = join(KEYS_DIR, "id_ed25519");
const PUB = join(KEYS_DIR, "id_ed25519.pub");

/** Ensure the cruiser keypair exists; returns { privateKey, publicKey } paths + pubkey text. */
export async function ensureKeypair(): Promise<{ priv: string; pub: string; pubText: string }> {
    if (!existsSync(PRIV) || !existsSync(PUB)) {
        await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 });
        // ssh-keygen writes the OpenSSH private-key format — node:crypto's
        // pkcs8 pem is rejected by ssh/sshfs ("invalid format")
        await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "cruiser", "-f", PRIV, "-q"]);
    }
    const pubText = (await readFile(PUB, "utf-8")).trim();
    return { priv: PRIV, pub: PUB, pubText };
}

/** Authorize the cruiser pubkey inside a running guest via QGA (idempotent). */
export async function authorizeInGuest(h: { guestSh: (s: string, t?: number) => Promise<any>; spec: { credentials: { username: string } } }): Promise<void> {
    const { pubText } = await ensureKeypair();
    const u = h.spec.credentials.username;
    const b64 = Buffer.from(pubText).toString("base64");
    await h.guestSh(`
        U='${u}'; UHOME=$(getent passwd "$U" | cut -d: -f6)
        mkdir -p "$UHOME/.ssh"; touch "$UHOME/.ssh/authorized_keys"
        KEY=$(echo '${b64}' | base64 -d)
        grep -qxF "$KEY" "$UHOME/.ssh/authorized_keys" || echo "$KEY" >> "$UHOME/.ssh/authorized_keys"
        chmod 700 "$UHOME/.ssh"; chmod 600 "$UHOME/.ssh/authorized_keys"
        chown -R "$U":"$U" "$UHOME/.ssh"
    `, 15_000);
}
