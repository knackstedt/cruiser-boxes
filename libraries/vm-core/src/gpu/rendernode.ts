// ============================================================================
// rendernode.ts — pick the right /dev/dri/renderD* for virgl/Venus.
//
// QEMU's -spice gl=on,rendernode= must point at a mesa driver (amdgpu/i915/xe/
// radeon/virtio). NVIDIA's EGL dmabuf path is broken in this stack (devvm
// README: wrong-GPU imports, black surfaces). Wedges QEMU init entirely when
// auto-picked — always select explicitly.
// ============================================================================

import { readdir, readlink, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { run } from "../../../sys/src/exec";

const MESA_DRIVERS = ["amdgpu", "i915", "xe", "radeon", "virtio_gpu", "msm", "panfrost", "nouveau"];
const BAD_DRIVERS = ["nvidia", "nvidia-drm"];

export interface RenderNode { node: string; driver: string; vendor?: string; ok: boolean }

export async function listRenderNodes(): Promise<RenderNode[]> {
    const out: RenderNode[] = [];
    let names: string[] = [];
    try { names = await readdir("/sys/class/drm"); } catch { return out; }
    const nodes = names.filter((x) => /^renderD\d+$/.test(x)).sort();
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]!;
        const dev = `/sys/class/drm/${n}/device`;
        let driver = "unknown";
        let vendor: string | undefined;
        try { driver = basename(await readlink(`${dev}/driver`)); } catch { /* no driver link */ }
        try { vendor = (await readFile(`${dev}/vendor`, "utf-8")).trim(); } catch { /* absent */ }
        out.push({ node: `/dev/dri/${n}`, driver, vendor, ok: MESA_DRIVERS.includes(driver) && !BAD_DRIVERS.includes(driver) });
    }
    return out;
}

/** First mesa-friendly render node; null if only NVIDIA is present. */
export async function pickRenderNode(): Promise<string | null> {
    const nodes = await listRenderNodes();
    return nodes.find((n) => n.ok)?.node ?? null;
}

/**
 * Render node of the GPU driving the host display — required by the
 * `display.viewer=dmabuf` path: QEMU exports virgl scanouts from this node
 * and the viewer's EGL can only import same-vendor dma-bufs.
 *
 * Order: xrandr provider-0 vendor (X11) → boot_vga device → null.
 */
export async function pickDisplayRenderNode(): Promise<string | null> {
    const nodes = await listRenderNodes();
    if (!nodes.length) return null;

    let vendor: string | null = null;
    if (process.env.DISPLAY || process.env.XAUTHORITY) {
        const r = await run("xrandr", ["--listproviders"], { noThrow: true, timeoutMs: 3_000 });
        const m = /Provider 0.*?name:(\S+)/i.exec(r.stdout);
        const name = m?.[1]?.toLowerCase() ?? "";
        if (name.includes("nvidia")) vendor = "0x10de";
        else if (name.includes("amd") || name.includes("ati")) vendor = "0x1002";
        else if (name.includes("intel")) vendor = "0x8086";
    }
    if (!vendor) {
        // boot_vga lives on the PCI function that owns the firmware/console
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i]!;
            try {
                const dev = `/sys/class/drm/${basename(n.node)}/device`;
                if ((await readFile(`${dev}/boot_vga`, "utf-8")).trim() === "1") {
                    vendor = n.vendor ?? null;
                    break;
                }
            } catch { /* no boot_vga attr */ }
        }
    }
    if (vendor) {
        const hit = nodes.find((n) => n.vendor === vendor);
        if (hit) return hit.node;
    }
    return nodes[0]!.node;
}
