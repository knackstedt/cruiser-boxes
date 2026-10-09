// ============================================================================
// registry.ts — VM discovery + port allocation + adoption sweep.
//
// ~/.local/share/cruiser/vms/<name>/vm.json is the source of truth. On app
// start we scan it and adopt any live QEMU (persist=daemonize) by reattaching
// to monitor/qga sockets.
// ============================================================================

import { readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { VMS_DIR } from "../paths";
import { VmHandle, type VmState } from "./vm";
import { VmSpec, parseVmSpec } from "../config/schema";
import { readFile } from "node:fs/promises";

const SSH_PORT_BASE = 2222;
const RDP_PORT_BASE = 3390;

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

    /** Next free host port for this forward kind — registry scan + bind probe
     *  (something outside cruiser may already hold the port, e.g. the devvm). */
    private async nextPort(kind: "ssh" | "rdp"): Promise<number> {
        const base = kind === "ssh" ? SSH_PORT_BASE : RDP_PORT_BASE;
        const used = new Set<number>();
        this.vms.forEach((v) => {
            const p = kind === "ssh" ? v.spec.network.sshPort : v.spec.network.rdpPort;
            if (p) used.add(p);
        });
        let p = base;
        while (used.has(p) || !(await portFree(p))) p++;
        return p;
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
