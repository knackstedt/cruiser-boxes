// ============================================================================
// paths.ts — cruiser filesystem layout (XDG).
//
//   ~/.config/cruiser/            settings, escape-shortcut defs
//   ~/.local/share/cruiser/vms/<name>/
//       vm.json                   VmSpec
//       disk.qcow2                system disk
//       OVMF_VARS.fd              per-VM UEFI vars
//       run/                      monitor.sock, qga.sock, spice.sock,
//                               virtiofs.sock, qemu.pid, qemu.log,
//                               serial.log, cruiser.log (runner journal),
//                               launch-spec.json (spec QEMU booted with —
//                               baseline for the restart-pending diff)
//       snapshots/                (external snapshot files if used)
//   (vms/<name> may itself be a symlink — "VM location" lets the whole
//   dir live on another filesystem)
//   ~/.cache/cruiser/             cloudimg downloads, seed work dirs
//   <repo>/opt/                   toolchain binaries (CRUISER_OPT override)
// ============================================================================

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";

const HOME = homedir();
const x = (env: string, dflt: string) => process.env[env] || dflt;

export const CONFIG_DIR = join(x("XDG_CONFIG_HOME", join(HOME, ".config")), "cruiser");
export const DATA_DIR = join(x("XDG_DATA_HOME", join(HOME, ".local", "share")), "cruiser");
export const CACHE_DIR = join(x("XDG_CACHE_HOME", join(HOME, ".cache")), "cruiser");
export const VMS_DIR = join(DATA_DIR, "vms");
export const ISO_DIR = join(DATA_DIR, "iso");
export const CLOUDIMG_DIR = join(CACHE_DIR, "cloudimg");

export function vmDir(name: string): string {
    return join(VMS_DIR, name);
}

/** The real (link-resolved) VM dir — vms/<name> may be a symlink to a dir
 *  on another filesystem ("VM location" / `vm move`). Falls back to the
 *  link path itself when it doesn't resolve (missing/unmounted target). */
export function vmRealDir(name: string): string {
    const d = vmDir(name);
    try { return realpathSync(d); } catch { return d; }
}

/** Absolute path to the VM's disk — spec.disk.file is relative to the vm dir
 *  or absolute (custom location / imported image). */
export function diskPath(spec: { name: string; disk: { file: string } }, vmDirOverride?: string): string {
    return spec.disk.file.startsWith("/") ? spec.disk.file : join(vmDirOverride ?? vmDir(spec.name), spec.disk.file);
}

/** The encrypted /home image for disk.encrypt="home" — a qcow2 sibling of
 *  the system disk named "<stem>-home.qcow2" (disk.qcow2 → disk-home.qcow2,
 *  /big/foo.qcow2 → /big/foo-home.qcow2). */
export function homeDiskPath(spec: { name: string; disk: { file: string } }, vmDirOverride?: string): string {
    const d = diskPath(spec, vmDirOverride);
    const ext = extname(d);
    return `${d.slice(0, d.length - ext.length)}-home.qcow2`;
}

/** Where QEMU/qemu-img read the LUKS passphrase from. "store" mode's
 *  persistent copy is secrets/disk-key (0600 — survives clone via the
 *  secrets/ dir copy); "prompt" mode's is transient run/ state — written
 *  when the passphrase is provided, deleted as soon as QEMU consumes it.
 *  null when the VM isn't encrypted. */
export function diskKeyPath(
    spec: { disk: { encrypt: string; keyStorage: string } },
    paths: { dir: string; run: string },
): string | null {
    if (spec.disk.encrypt === "off") return null;
    return spec.disk.keyStorage === "prompt"
        ? join(paths.run, "disk-key")
        : join(paths.dir, "secrets", "disk-key");
}

export interface VmPaths {
    dir: string;
    spec: string;
    disk: string;
    ovmfVars: string;
    run: string;
    monitorSock: string;
    qgaSock: string;
    spiceSock: string;
    vfsSock: string;
    pidFile: string;
    log: string;
    /** Spec snapshot taken at launch — VmHandle.pendingRestart's baseline. */
    launchSpec: string;
    serialLog: string;
    /** Second serial port (guest ttyS1) — interactive console socket. */
    serialSock: string;
    /** virtserialport org.cruiser.urlopen.0 — guest → host URL forwarding. */
    urlOpenSock: string;
    /** ddproxy display broker: viewer-facing p2p socket, pidfile, log.
     *  Present only while a dmabuf VM's broker is up. */
    ddproxySock: string;
    ddproxyPid: string;
    ddproxyLog: string;
    /** swtpm emulator control socket (run/) + persistent state dir (<vm>/tpm). */
    tpmSock: string;
    tpmDir: string;
    snapshotsDir: string;
    backupsDir: string;
}

export function vmPaths(name: string): VmPaths {
    const dir = vmDir(name);
    const run = join(dir, "run");
    return {
        dir,
        spec: join(dir, "vm.json"),
        disk: join(dir, "disk.qcow2"),
        ovmfVars: join(dir, "OVMF_VARS.fd"),
        run,
        monitorSock: join(run, "monitor.sock"),
        qgaSock: join(run, "qga.sock"),
        spiceSock: join(run, "spice.sock"),
        vfsSock: join(run, "virtiofs.sock"),
        pidFile: join(run, "qemu.pid"),
        log: join(run, "qemu.log"),
        launchSpec: join(run, "launch-spec.json"),
        serialLog: join(run, "serial.log"),
        serialSock: join(run, "serial.sock"),
        urlOpenSock: join(run, "urlopen.sock"),
        ddproxySock: join(run, "ddproxy.sock"),
        ddproxyPid: join(run, "ddproxy.pid"),
        ddproxyLog: join(run, "ddproxy.log"),
        tpmSock: join(run, "tpm.sock"),
        tpmDir: join(dir, "tpm"),
        snapshotsDir: join(dir, "snapshots"),
        backupsDir: join(dir, "backups"),
    };
}

/** Toolchain opt/ dir: packaged appdir first, then repo-local build output. */
export function optDir(): string {
    if (process.env.CRUISER_OPT) return process.env.CRUISER_OPT;
    // Packaged layout: launcher script, runtime binary, and opt/ are siblings
    // under dirname(process.execPath) — the same anchor native/ + dd-assets/
    // use. In dev, dirname(bun|node)/opt never exists and we fall through.
    const appdir = join(dirname(process.execPath), "opt");
    if (existsSync(appdir)) return appdir;
    // <repo>/opt — this file lives at libraries/vm-core/src/paths.ts
    return join(fileDir(), "..", "..", "..", "opt");
}

function fileDir(): string {
    return new URL(".", import.meta.url).pathname;
}
