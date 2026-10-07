// ============================================================================
// rendernode.ts — pick the right /dev/dri/renderD* for virgl/Venus.
//
// QEMU's -spice gl=on,rendernode= must point at a mesa driver (amdgpu/i915/xe/
// radeon/virtio). NVIDIA's EGL dmabuf path is broken in this stack (devvm
// README: wrong-GPU imports, black surfaces). Wedges QEMU init entirely when
// auto-picked — always select explicitly.
// ============================================================================

import { readdir, readlink } from "node:fs/promises";
import { basename } from "node:path";
import { existsSync } from "node:fs";

const MESA_DRIVERS = ["amdgpu", "i915", "xe", "radeon", "virtio_gpu", "msm", "panfrost", "nouveau"];
const BAD_DRIVERS = ["nvidia", "nvidia-drm"];

export interface RenderNode { node: string; driver: string; ok: boolean }

export async function listRenderNodes(): Promise<RenderNode[]> {
    const out: RenderNode[] = [];
    let names: string[] = [];
    try { names = await readdir("/sys/class/drm"); } catch { return out; }
    for (const n of names.filter((x) => /^renderD\d+$/.test(x)).sort()) {
        const dev = `/sys/class/drm/${n}/device/driver`;
        let driver = "unknown";
        try { driver = basename(await readlink(dev)); } catch { /* no driver link */ }
        out.push({ node: `/dev/dri/${n}`, driver, ok: MESA_DRIVERS.includes(driver) && !BAD_DRIVERS.includes(driver) });
    }
    return out;
}

/** First mesa-friendly render node; null if only NVIDIA is present. */
export async function pickRenderNode(): Promise<string | null> {
    const nodes = await listRenderNodes();
    return nodes.find((n) => n.ok)?.node ?? null;
}
