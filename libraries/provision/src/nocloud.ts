// ============================================================================
// nocloud.ts — NoCloud seed generation: user-data/meta-data + seed.iso.
// Two flavors: `autoinstall` (Ubuntu desktop/server ISO) and `cloudimg`.
// ============================================================================

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run, which } from "../../sys/src/exec";
import type { VmSpec } from "../../vm-core/src/config/schema";

export interface SeedOpts {
    hostname: string;
    username: string;
    /** sha512-crypt hash ($6$...) for autoinstall; plaintext never stored in tree. */
    passwordHash: string;
    /** plaintext password for cloudimg chpasswd (still only in the seed.iso). */
    password?: string;
    sshAuthorizedKeys?: string[];
    timezone?: string;
    /** resolved package list — see packages.ts (resolvePackages(profile,"seed")) */
    packages: string[];
    /**
     * Package manager for the seed's install step (cloudimg only; autoinstall
     * is always apt). rpm seeds install via `runcmd dnf --skip-unavailable`
     * because one unresolvable name aborts cloud-init's whole `packages:` txn.
     */
    pkgMgr?: "apt" | "dnf";
    /** cloudimg only: extra runcmd lines. */
    runcmd?: string[];
}

// ── cloudimg user-data ──

export function cloudimgUserData(o: SeedOpts): string {
    const pkgs = o.packages;
    const rpm = o.pkgMgr === "dnf";
    return `#cloud-config
hostname: ${o.hostname}
preserve_hostname: false
timezone: ${o.timezone ?? "UTC"}
users:
  - name: ${o.username}
    gecos: ${o.hostname}
    groups: [sudo, render, adm]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: false
${o.password ? `    passwd: ${o.passwordHash}` : ""}
${o.sshAuthorizedKeys?.length ? `    ssh_authorized_keys:\n${o.sshAuthorizedKeys.map((k) => `      - ${k}`).join("\n")}` : ""}
ssh_pwauth: true
${rpm ? "" : `package_update: true\npackages:\n${pkgs.map((p) => `  - ${p}`).join("\n")}\n`}runcmd:
  - systemctl enable --now qemu-guest-agent
  - systemctl enable --now ssh || systemctl enable --now sshd
${rpm ? `  - dnf -y makecache\n  - dnf install -y --skip-unavailable ${pkgs.join(" ")}\n` : ""}${(o.runcmd ?? []).map((c) => `  - ${c}`).join("\n")}
`;
}

// ── autoinstall user-data (ISO path, subiquity) ──

export function autoinstallUserData(o: SeedOpts): string {
    const pkgs = ["build-essential", ...o.packages];
    return `#cloud-config
autoinstall:
  version: 1
  locale: en_US.UTF-8
  keyboard: { layout: us }
  timezone: ${o.timezone ?? "UTC"}
  identity:
    hostname: ${o.hostname}
    realname: ${o.hostname}
    username: ${o.username}
    password: ${o.passwordHash}
  ssh:
    install-server: true
    allow-pw: true
${o.sshAuthorizedKeys?.length ? `    authorized-keys:\n${o.sshAuthorizedKeys.map((k) => `      - ${k}`).join("\n")}` : "    authorized-keys: []"}
  storage:
    layout: { name: direct }
  shutdown: poweroff
  late-commands:
    - curtin in-target --target=/target -- apt-get update
    - >-
      curtin in-target --target=/target -- apt-get install -y
      ${pkgs.join(" ")}
    - curtin in-target --target=/target -- systemctl enable qemu-guest-agent
`;
}

export function metaData(o: SeedOpts): string {
    return `instance-id: cruiser-${o.hostname}\nlocal-hostname: ${o.hostname}\n`;
}

/** Write user-data/meta-data and build seed.iso. Returns the iso path. */
export async function buildSeedIso(workDir: string, userData: string, meta: string): Promise<string> {
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, "user-data"), userData);
    await writeFile(join(workDir, "meta-data"), meta);
    const iso = join(workDir, "seed.iso");
    if (await which("cloud-localds")) {
        await run("cloud-localds", [iso, join(workDir, "user-data"), join(workDir, "meta-data")]);
    } else if (await which("genisoimage")) {
        await run("genisoimage", ["-output", iso, "-volid", "cidata", "-joliet", "-rock",
            join(workDir, "user-data"), join(workDir, "meta-data")]);
    } else if (await which("xorriso")) {
        await run("xorriso", ["-as", "mkisofs", "-o", iso, "-V", "cidata", "-J", "-R",
            join(workDir, "user-data"), join(workDir, "meta-data")]);
    } else {
        throw new Error("need cloud-localds (cloud-image-utils) or genisoimage/xorriso for seed.iso");
    }
    return iso;
}

/** sha512-crypt password hash for autoinstall/cloudimg. */
export async function passwordHash(plain: string): Promise<string> {
    const r = await run("openssl", ["passwd", "-6", plain]);
    return r.stdout.trim();
}

/** Persist the VM's plaintext RDP/SSH password to a 0600 file; returns path. */
export async function writePasswordFile(spec: VmSpec, plain: string): Promise<string> {
    const { join: j } = await import("node:path");
    const { vmPaths } = await import("../../vm-core/src/paths");
    const p = j(vmPaths(spec.name).dir, "secrets", "rdp-password");
    await mkdir(j(p, ".."), { recursive: true });
    await writeFile(p, plain, { mode: 0o600 });
    spec.credentials.passwordFile = p;
    return p;
}
