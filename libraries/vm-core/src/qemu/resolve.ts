// ============================================================================
// resolve.ts — locate QEMU + friends: toolchain opt/ first, then PATH.
// Custom opt/ binaries need LD_LIBRARY_PATH wiring for virglrenderer/spice.
// ============================================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import { optDir } from "../paths";
import { run, which, parseVersion, versionGte } from "../../../sys/src/exec";

export interface Toolchain {
    qemu: string;
    qemuImg: string;
    xfreerdp: string;
    /** LD_LIBRARY_PATH prefix required to run the opt/ qemu. */
    ldLibraryPath: string;
    fromOpt: boolean;
}

const QEMU_MIN: [number, number, number] = [9, 0, 0];       // Venus/blob needs modern qemu
const FREERDP_MIN: [number, number, number] = [3, 5, 0];

export async function resolveToolchain(): Promise<Toolchain> {
    const opt = optDir();
    const optQemu = join(opt, "qemu-11", "bin", "qemu-system-x86_64");
    const optImg = join(opt, "qemu-11", "bin", "qemu-img");

    let qemu: string;
    let qemuImg: string;
    let fromOpt = false;
    if (existsSync(optQemu) && existsSync(optImg)) {
        qemu = optQemu; qemuImg = optImg; fromOpt = true;
    } else {
        const q = await which("qemu-system-x86_64");
        const qi = await which("qemu-img");
        if (!q || !qi) throw new Error("qemu not found — run `cruiser toolchain build` or install qemu-system-x86");
        const vr = await run(q, ["--version"]);
        const v = parseVersion(vr.stdout);
        if (v && !versionGte(v, QEMU_MIN))
            throw new Error(`system qemu ${v.join(".")} too old (need >= ${QEMU_MIN.join(".")}) — run cruiser toolchain build`);
        qemu = q; qemuImg = qi;
    }

    const freerdpOpt = join(opt, "freerdp", "bin", "xfreerdp3");
    let xfreerdp = existsSync(freerdpOpt) ? freerdpOpt : (await which("xfreerdp3") ?? await which("xfreerdp"));
    if (!xfreerdp) throw new Error("xfreerdp3 not found — apt install freerdp3-x11 or `cruiser toolchain build --component freerdp`");
    const fr = await run(xfreerdp, ["--version"], { noThrow: true });
    const fv = parseVersion(fr.stdout + fr.stderr);
    if (fv && !versionGte(fv, FREERDP_MIN))
        throw new Error(`xfreerdp ${fv.join(".")} too old (need >= ${FREERDP_MIN.join(".")})`);

    // opt/ qemu links pinned virglrenderer + spice — wire them or the binary
    // fails on missing libspice-server.so.1 version symbols.
    const ld = [
        join(opt, "virglrenderer", "lib", "x86_64-linux-gnu"),
        join(opt, "spice", "lib", "x86_64-linux-gnu"),
    ].filter((p) => existsSync(p)).join(":");

    return { qemu, qemuImg, xfreerdp, ldLibraryPath: ld, fromOpt };
}
