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
//                               serial.log, cruiser.log (runner journal)
//       snapshots/                (external snapshot files if used)
//   ~/.cache/cruiser/             cloudimg downloads, seed work dirs
//   <repo>/opt/                   toolchain binaries (CRUISER_OPT override)
// ============================================================================

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/** Absolute path to the VM's disk — spec.disk.file is relative to the vm dir
 *  or absolute (custom location / imported image). */
export function diskPath(spec: { name: string; disk: { file: string } }, vmDirOverride?: string): string {
    return spec.disk.file.startsWith("/") ? spec.disk.file : join(vmDirOverride ?? vmDir(spec.name), spec.disk.file);
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
    serialLog: string;
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
        serialLog: join(run, "serial.log"),
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
