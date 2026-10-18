// ============================================================================
// registry.ts — VM discovery + port allocation + adoption sweep.
//
// ~/.local/share/cruiser/vms/<name>/vm.json is the source of truth. On app
// start we scan it and adopt any live QEMU (persist=daemonize) by reattaching
// to monitor/qga sockets.
// ============================================================================

import { readdir, readFile, copyFile, cp, mkdir, rename as fsRename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";

import { VMS_DIR, vmPaths, homeDiskPath } from "../paths";
import { VmHandle, type VmState } from "./vm";
import { VmSpec, parseVmSpec } from "../config/schema";
import { cloneDisk } from "../disk/ops";
import { resolveToolchain } from "../qemu/resolve";

// Random-allocation band for auto hostfwd host ports. Deliberately below
// the default Linux ephemeral range (32768–60999) so a transient outbound
// connection can't be squatting on a candidate between our bind probe and
// QEMU's own bind at start.
const HOSTFWD_PORT_MIN = 20000;
const HOSTFWD_PORT_MAX = 31999;

/** Try binding 127.0.0.1:port — free means usable for hostfwd. */
async function portFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const srv = createServer();
        srv.once("error", () => resolve(false));
        srv.once("listening", () => srv.close(() => resolve(true)));
        srv.listen(port, "127.0.0.1");
    });
}

export interface RegistryEntry {
    name: string;
    state: VmState;
    spec: VmSpec;
    handle: VmHandle;
}

export class VmRegistry extends EventTarget {
    private vms = new Map<string, VmHandle>();

    /** Scan VMS_DIR; adopt live VMs. onHandle fires the moment a spec parses
     *  (before probing) so callers can paint spec-derived rows immediately —
     *  probes run in parallel since a wedged monitor socket (connect timeout)
     *  must not delay every other VM's adoption. */
    async scan(onHandle?: (h: VmHandle) => void): Promise<RegistryEntry[]> {
        this.vms.clear();
        let names: string[] = [];
        try { names = (await readdir(VMS_DIR)).filter((n) => existsSync(join(VMS_DIR, n, "vm.json"))); }
        catch { return []; }
        const out = await Promise.all(names.sort().map(async (name) => {
            try {
                const spec = parseVmSpec(JSON.parse(await readFile(join(VMS_DIR, name, "vm.json"), "utf-8")));
                const h = await VmHandle.load(name);
                this.vms.set(name, h);
                onHandle?.(h);
                // detach persisted sockets from a previous process
                const state = await h.probe();
                return { name, state, spec, handle: h } as RegistryEntry;
            } catch {
                return { name, state: "unknown", spec: null as unknown as VmSpec, handle: null as unknown as VmHandle } as RegistryEntry;
            }
        }));
        this.dispatchEvent(new Event("change"));
        return out;
    }

    list(): VmHandle[] { return [...this.vms.values()]; }
    get(name: string): VmHandle | undefined { return this.vms.get(name); }

    async create(spec: VmSpec): Promise<VmHandle> {
        if (this.vms.has(spec.name)) throw new Error(`vm '${spec.name}' already exists`);
        // allocate network ports if unset
        spec.network.sshPort ??= await this.nextPort("ssh");
        spec.network.rdpPort ??= await this.nextPort("rdp");
        if (!spec.network.hostfwd.some((f) => f.guestPort === 22) && spec.network.sshPort)
            spec.network.hostfwd.push({ hostPort: spec.network.sshPort, guestPort: 22, proto: "tcp" });
        if (!spec.network.hostfwd.some((f) => f.guestPort === 3389) && spec.network.rdpPort)
            spec.network.hostfwd.push({ hostPort: spec.network.rdpPort, guestPort: 3389, proto: "tcp" });
        const h = await VmHandle.create(spec);
        this.vms.set(spec.name, h);
        this.dispatchEvent(new Event("change"));
        return h;
    }

    /** Next free host port for this forward kind — random pick in
     *  [HOSTFWD_PORT_MIN, HOSTFWD_PORT_MAX], checked against the registry's
     *  allocations + a bind probe (something outside cruiser may already
     *  hold the port, e.g. the devvm). */
    private async nextPort(kind: "ssh" | "rdp"): Promise<number> {
        const used = new Set<number>();
        this.vms.forEach((v) => {
            const p = kind === "ssh" ? v.spec.network.sshPort : v.spec.network.rdpPort;
            if (p) used.add(p);
        });
        for (let i = 0; i < 50; i++) {
            const p = HOSTFWD_PORT_MIN
                + Math.floor(Math.random() * (HOSTFWD_PORT_MAX - HOSTFWD_PORT_MIN + 1));
            if (!used.has(p) && await portFree(p)) return p;
        }
        // Pathological band exhaustion — sweep linearly before giving up.
        for (let p = HOSTFWD_PORT_MIN; p <= HOSTFWD_PORT_MAX; p++)
            if (!used.has(p) && await portFree(p)) return p;
        throw new Error(`no free host port for '${kind}' hostfwd`);
    }

    /**
     * Clone a stopped VM under a new name: fresh ssh/rdp ports + their
     * auto hostfwd (custom forwards carry over — both VMs can't serve the
     * same port simultaneously, that's on the user), the disk copied via
     * reflink-or-convert WITHOUT its internal snapshots, OVMF vars and
     * secrets/ carried over. run/, snapshots/, backups/ and the launch
     * baseline start clean. spec.origin is dropped — a clone is a fork;
     * `config pull` must not revert two VMs from one source.
     */
    async clone(srcName: string, newName: string): Promise<VmHandle> {
        const src = this.vms.get(srcName);
        if (!src) throw new Error(`unknown vm '${srcName}'`);
        if (src.isRunning()) throw new Error(`stop '${srcName}' before cloning it`);
        if (this.vms.has(newName)) throw new Error(`vm '${newName}' already exists`);
        if (!/^[a-z0-9][a-z0-9-]*$/.test(newName))
            throw new Error("name must be lowercase letters/digits/dashes (e.g. 'dev-box')");

        const spec: VmSpec = JSON.parse(JSON.stringify(src.spec));
        spec.name = newName;
        spec.origin = undefined;
        spec.network.sshPort = undefined;
        spec.network.rdpPort = undefined;
        spec.network.hostfwd = spec.network.hostfwd
            .filter((f) => f.guestPort !== 22 && f.guestPort !== 3389);

        // A disk inside the vm dir (the usual relative disk.file, or an
        // absolute path that still points there) clones into the new vm
        // dir; an external custom path clones beside the source.
        const srcDisk = src.diskPath();
        if (!existsSync(srcDisk)) throw new Error(`'${srcName}' has no disk to clone — provision or start it first`);
        const rel = !src.spec.disk.file.startsWith("/");
        const dstDisk = srcDisk.startsWith(`${src.paths.dir}/`)
            ? join(vmPaths(newName).dir, srcDisk.slice(src.paths.dir.length + 1))
            : join(dirname(srcDisk), `${newName}${extname(srcDisk) || ".qcow2"}`);
        if (existsSync(dstDisk)) throw new Error(`clone target disk already exists: ${dstDisk}`);
        spec.disk.file = rel ? src.spec.disk.file : dstDisk;

        // secrets/ holds the password file — repoint the spec at the copy.
        const pw = spec.credentials.passwordFile;
        if (pw && pw.startsWith(`${src.paths.dir}/`))
            spec.credentials.passwordFile = join(vmPaths(newName).dir, "secrets", pw.split("/").pop()!);

        // The encrypt=home second image clones alongside the system disk
        // (same passphrase — the secrets/ dir copy carries it over).
        const srcHome = homeDiskPath(src.spec, src.paths.dir);
        const hasHome = src.spec.disk.encrypt === "home" && existsSync(srcHome);

        const h = await this.create(spec);   // writes vm.json + allocates ports
        try {
            const tc = await resolveToolchain();
            // LUKS sources reflink cleanly (a byte copy keeps the same
            // passphrase); the non-CoW convert fallback needs the key to
            // read the source — diskKeyFile() supplies it when present.
            const keyFile = src.diskKeyFile() ?? undefined;
            await mkdir(dirname(dstDisk), { recursive: true });
            await cloneDisk(tc.qemuImg, srcDisk, dstDisk, spec.disk.format, keyFile);
            if (hasHome)
                await cloneDisk(tc.qemuImg, srcHome, homeDiskPath(spec, h.paths.dir), "qcow2", keyFile);
            if (existsSync(src.paths.ovmfVars)) await copyFile(src.paths.ovmfVars, h.paths.ovmfVars);
            const srcSecrets = join(src.paths.dir, "secrets");
            if (existsSync(srcSecrets)) await cp(srcSecrets, join(h.paths.dir, "secrets"), { recursive: true });
        } catch (e) {
            // A failed copy must not leave a registered-but-diskless VM —
            // nor a half-written external disk file.
            this.vms.delete(newName);
            const { rm } = await import("node:fs/promises");
            await rm(h.paths.dir, { recursive: true, force: true }).catch(() => {});
            if (!dstDisk.startsWith(`${h.paths.dir}/`)) await rm(dstDisk, { force: true }).catch(() => {});
            // an external system disk means an external <stem>-home too —
            // sweep the half-clone (in-dir copies die with the dir).
            if (hasHome) {
                const dstHome = homeDiskPath(spec, h.paths.dir);
                if (!dstHome.startsWith(`${h.paths.dir}/`)) await rm(dstHome, { force: true }).catch(() => {});
            }
            throw e;
        }
        return h;
    }

    /** Rename a stopped VM: move the vm dir, update spec.name, and repoint
     *  spec fields that held paths inside the old dir (an absolute
     *  disk.file/passwordFile/gitSshKeyPath under it moves with it — an
     *  external path stays valid). The vsock guest CID is name-derived and
     *  changes too — nothing persists it. */
    async rename(oldName: string, newName: string): Promise<VmHandle> {
        const h = this.vms.get(oldName);
        if (!h) throw new Error(`unknown vm '${oldName}'`);
        if (h.isRunning()) throw new Error(`stop '${oldName}' before renaming it`);
        if (this.vms.has(newName)) throw new Error(`vm '${newName}' already exists`);
        if (!/^[a-z0-9][a-z0-9-]*$/.test(newName))
            throw new Error("name must be lowercase letters/digits/dashes (e.g. 'dev-box')");
        const dst = vmPaths(newName);
        if (existsSync(dst.dir)) throw new Error(`target dir already exists: ${dst.dir}`);
        const oldDir = h.paths.dir;
        await fsRename(oldDir, dst.dir);
        try {
            const spec = h.spec;
            spec.name = newName;
            const repoint = (p?: string) => p?.startsWith(`${oldDir}/`) ? join(dst.dir, p.slice(oldDir.length + 1)) : p;
            spec.disk.file = repoint(spec.disk.file)!;
            spec.credentials.passwordFile = repoint(spec.credentials.passwordFile);
            spec.credentials.gitSshKeyPath = repoint(spec.credentials.gitSshKeyPath);
            await writeFile(dst.spec, JSON.stringify(spec, null, 2) + "\n");
        } catch (e) {
            await fsRename(dst.dir, oldDir).catch(() => {});
            throw e;
        }
        const nh = await VmHandle.load(newName);
        this.vms.delete(oldName);
        this.vms.set(newName, nh);
        this.dispatchEvent(new Event("change"));
        return nh;
    }

    async remove(name: string, { deleteDisk = false } = {}): Promise<void> {
        const h = this.vms.get(name);
        if (!h) return;
        if (h.isRunning()) await h.kill();
        this.vms.delete(name);
        if (deleteDisk) {
            const { rm } = await import("node:fs/promises");
            await rm(h.paths.dir, { recursive: true, force: true });
        }
        this.dispatchEvent(new Event("change"));
    }
}
