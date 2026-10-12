#!/usr/bin/env bun
// ============================================================================
// build.mts — pinned source-build toolchain for cruiser.
//
//   bun run toolchain/build.mts check                         # resolution report
//   bun run toolchain/build.mts build [--component qemu]      # build into opt/
//          [--src-dir DIR] [--opt-dir DIR] [--force]
//
// Ports ~/devvm/scripts/build-deps.sh. Why custom builds:
//   - distro QEMU 8.2 GL module broken (undefined symbol: qemu_egl_display)
//   - distro virglrenderer is built WITHOUT Venus (no Vulkan passthrough)
//   - distro spice-server too old for QEMU remote-client GL (moot — display
//     is RDP — but QEMU links it so we keep the pinned version)
// ============================================================================

import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run, which, parseVersion, versionGte } from "../libraries/sys/src/exec.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Component {
    version: string;
    url?: string;
    sha256?: string | null;
    kind: "tool" | "meson" | "qemu" | "cmake";
    prefix?: string;
    /** patch files in toolchain/patches/, applied to the extracted tree. */
    patches?: string[];
    dir?: string;
    mesonArgs?: string[];
    cmakeArgs?: string[];
    configureArgs?: string[];
    pkgConfigPath?: string[];
    optional?: boolean;
    aptAlternative?: string;
    systemFloor?: string;
    why?: string;
}
interface Versions {
    order: string[];
    components: Record<string, Component>;
    systemTools: Record<string, { floor?: string; pkg: string; why?: string; versionFlag?: string }>;
    aptBuildDeps: string[];
}

const versions: Versions = JSON.parse(await readFile(join(ROOT, "toolchain", "versions.json"), "utf-8"));

// ── args ──
const argv = process.argv.slice(2);
const cmd = argv.shift() ?? "check";
const flagVal = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (name: string) => argv.includes(name);
const SRC_DIR = resolve(flagVal("--src-dir") ?? join(ROOT, "src-tarballs"));
const OPT_DIR = resolve(flagVal("--opt-dir") ?? join(ROOT, "opt"));
const ONLY = flagVal("--component");
const FORCE = hasFlag("--force");

const log = (s: string) => console.log(s);
const msg = (tag: string, s: string) => console.log(`[${tag}] ${s}`);

// ── check ──

async function systemVersion(bin: string, flag = "--version"): Promise<{ path: string; version: string } | null> {
    const path = await which(bin);
    if (!path) return null;
    const r = await run(path, [flag], { noThrow: true });
    const v = (r.stdout + r.stderr).match(/\d+\.\d+[\d.]*/)?.[0] ?? "?";
    return { path, version: v };
}

async function check(): Promise<number> {
    let bad = 0;
    log("== toolchain check ==");
    log(`opt dir: ${OPT_DIR}   src dir: ${SRC_DIR}`);
    log("");

    // qemu binary resolution order: opt/qemu-11/bin → PATH
    const optQemu = join(OPT_DIR, "qemu-11", "bin", "qemu-system-x86_64");
    if (existsSync(optQemu)) {
        const r = await run(optQemu, ["--version"], { noThrow: true });
        log(`qemu     opt:  ${r.stdout.split("\n")[0] ?? "?"}`);
    } else {
        const s = await systemVersion("qemu-system-x86_64");
        const need = versions.components.qemu.version;
        const ok = s && versionGte(parseVersion(s.version) ?? [0, 0, 0], parseVersion(need) as [number, number, number]);
        log(`qemu     ${s ? `system: ${s.version}` : "MISSING"}  (need ${need} via opt/ build${s && !ok ? " — too old" : ""})`);
        if (!s || !ok) bad++;
    }

    const toolEntries = Object.entries(versions.systemTools);
    for (let i = 0; i < toolEntries.length; i++) {
        const [bin, tool] = toolEntries[i]!;
        const s = await systemVersion(bin, tool.versionFlag);
        const status = s ? `${s.version} @ ${s.path}` : `MISSING (apt: ${tool.pkg})`;
        log(`${bin.padEnd(14)} ${status}${tool.why ? `  — ${tool.why}` : ""}`);
        if (!s && !tool.why?.includes("optional")) bad++;
    }

    const compEntries = Object.entries(versions.components);
    for (let ci = 0; ci < compEntries.length; ci++) {
        const [name, c] = compEntries[ci]!;
        if (c.kind === "tool") {
            const d = join(SRC_DIR, `${name}-${c.version}`);
            log(`${name.padEnd(14)} ${existsSync(d) ? `src ready @ ${d}` : "not extracted"}`);
            continue;
        }
        const pref = c.prefix ? join(OPT_DIR, c.prefix) : null;
        const built = pref ? existsSync(pref) : false;
        const sys = c.aptAlternative ? await systemVersion(c.aptAlternative) : null;
        const floorOk = c.systemFloor && sys ? versionGte(parseVersion(sys.version) ?? [0, 0, 0], parseVersion(c.systemFloor) as [number, number, number]) : false;
        log(`${name.padEnd(14)} ${built ? `built @ ${pref}` : sys ? `system ${sys.version} @ ${sys.path}${floorOk || !c.systemFloor ? " (ok)" : ` (< ${c.systemFloor} floor)`}` : `not built${c.aptAlternative ? ` (apt: ${c.aptAlternative})` : ""}`}`);
        if (!built && (!sys || (c.systemFloor && !floorOk)) && !c.optional) bad++;
    }

    log("");
    log("apt build deps (install once):");
    log(`  sudo apt install ${versions.aptBuildDeps.join(" ")}`);
    return bad ? 1 : 0;
}

// ── fetch + extract ──

async function sha256File(p: string): Promise<string> {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
    return h.digest("hex");
}

/**
 * Apply a component's toolchain/patches/ entries — idempotent: a clean
 * forward dry-run applies for real; a clean REVERSE dry-run means it's
 * already applied (skip); neither means upstream drifted — hard fail so a
 * re-extract on a new release can't silently drop a local patch.
 */
async function applyPatches(name: string, src: string, c: Component): Promise<void> {
    const ps = c.patches ?? [];
    for (let i = 0; i < ps.length; i++) {
        const p = ps[i]!;
        const pf = join(ROOT, "toolchain", "patches", p);
        const fwd = await run("patch", ["-p1", "--dry-run", "-d", src, "-i", pf], { noThrow: true });
        if (fwd.code === 0) {
            await run("patch", ["-p1", "-d", src, "-i", pf]);
            msg("patch", `${name}: ${p}`);
            continue;
        }
        const rev = await run("patch", ["-p1", "-R", "--dry-run", "-d", src, "-i", pf], { noThrow: true });
        if (rev.code === 0) { msg("ok", `${name}: ${p} already applied`); continue; }
        throw new Error(`${name}: patch ${p} doesn't apply and isn't already applied — upstream drifted:\n${(fwd.stdout + fwd.stderr).slice(-800)}`);
    }
}

async function ensureSource(name: string, c: Component): Promise<string> {
    const dirName = c.dir ?? `${name === "spice-server" ? "spice" : name}-${c.version}`;
    const dst = join(SRC_DIR, dirName);
    if (existsSync(dst) && !FORCE) { await applyPatches(name, dst, c); return dst; }
    await mkdir(SRC_DIR, { recursive: true });
    if (!c.url) throw new Error(`${name}: no url configured`);
    const tarball = join(SRC_DIR, `${dirName}${extFor(c.url)}`);
    if (!existsSync(tarball)) {
        msg("fetch", `${name} ${c.version} <- ${c.url}`);
        const res = await fetch(c.url, { redirect: "follow" });
        if (!res.ok) throw new Error(`fetch ${c.url}: HTTP ${res.status}`);
        await writeFile(tarball, Buffer.from(await res.arrayBuffer()));
    }
    const sum = await sha256File(tarball);
    if (c.sha256 && c.sha256 !== sum) throw new Error(`${name}: sha256 mismatch (${sum} != ${c.sha256})`);
    if (!c.sha256) msg("warn", `${name}: no pinned sha256 (got ${sum}) — record it in versions.json`);
    msg("extract", `${dirName}`);
    await run("tar", ["xf", tarball, "-C", SRC_DIR]);
    if (!existsSync(dst)) {
        // Some archives extract to a differently-named root — find it.
        throw new Error(`${name}: expected ${dst} after extract — adjust url/dir naming`);
    }
    await applyPatches(name, dst, c);
    return dst;
}

function extFor(url: string): string {
    const m = url.match(/\.tar\.(gz|xz|bz2)|\.tgz$/);
    return m ? m[0] : ".tar.gz";
}

// ── build ──

async function build(): Promise<number> {
    await mkdir(OPT_DIR, { recursive: true });
    const mesonDir = join(SRC_DIR, `meson-${versions.components.meson.version}`);
    const meson = ["python3", join(mesonDir, "meson.py")];
    const want = versions.order.filter((n) => !ONLY || n === ONLY);

    const pkgConfigPath = (): string => {
        const paths = versions.order
            .flatMap((n) => (versions.components[n].pkgConfigPath ?? []).map((p) => join(OPT_DIR, p)));
        return [...paths, process.env.PKG_CONFIG_PATH ?? ""].filter(Boolean).join(":");
    };

    for (let wi = 0; wi < want.length; wi++) {
        const name = want[wi]!;
        const c = versions.components[name];
        if (!c) { msg("skip", `unknown component ${name}`); continue; }
        if (c.optional && !ONLY) { msg("skip", `${name} optional (build with --component ${name} to force)`); continue; }

        const src = await ensureSource(name, c);

        if (c.kind === "tool") { msg("ok", `${name} (tool) ready at ${src}`); continue; }

        const prefix = join(OPT_DIR, c.prefix ?? name);
        const buildDir = join(src, "build");
        if (existsSync(prefix) && !FORCE) { msg("skip", `${name} already installed at ${prefix} (--force to rebuild)`); continue; }

        const env = { PKG_CONFIG_PATH: pkgConfigPath() };

        if (c.kind === "meson" || c.kind === "cmake") {
            if (c.kind === "meson") {
                if (!existsSync(buildDir) || FORCE) {
                    await run(meson[0], [meson[1], "setup", buildDir, src, `--prefix=${prefix}`, ...(c.mesonArgs ?? [])], { env });
                }
                await run(meson[0], [meson[1], "compile", "-C", buildDir], { env });
                await run(meson[0], [meson[1], "install", "-C", buildDir], { env });
            } else {
                await mkdir(buildDir, { recursive: true });
                await run("cmake", ["-S", src, "-B", buildDir, `-DCMAKE_INSTALL_PREFIX=${prefix}`, "-DCMAKE_BUILD_TYPE=Release", ...(c.cmakeArgs ?? [])], { env });
                await run("cmake", ["--build", buildDir, "-j"], { env });
                await run("cmake", ["--install", buildDir], { env });
            }
        } else if (c.kind === "qemu") {
            // QEMU wants its own configure inside a build dir (not meson directly).
            if (!existsSync(buildDir) || FORCE) {
                await mkdir(buildDir, { recursive: true });
                const spicePc = join(OPT_DIR, "spice", "lib", "x86_64-linux-gnu", "pkgconfig");
                await run(join(src, "configure"), [
                    `--prefix=${prefix}`,
                    ...(c.configureArgs ?? []),
                    `--with-pkgconfigpath=${spicePc}`,
                ], { cwd: buildDir, env });
            }
            await run("ninja", ["-C", buildDir], { env });
            await run("ninja", ["-C", buildDir, "install"], { env });
        }
        msg("ok", `${name} ${c.version} -> ${prefix}`);
    }
    msg("done", `toolchain in ${OPT_DIR}`);
    return 0;
}

// Reuse trees from the old devvm checkout: link src dirs into SRC_DIR.
async function adoptSrc(fromDir: string): Promise<void> {
    await mkdir(SRC_DIR, { recursive: true });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(fromDir);
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const dst = join(SRC_DIR, entry);
        if (existsSync(dst)) continue;
        await symlink(join(fromDir, entry), dst);
        msg("adopt", `${entry} -> ${dst}`);
    }
}

if (cmd === "check") process.exit(await check());
if (cmd === "adopt-src") { await adoptSrc(resolve(argv[0] ?? `${process.env.HOME}/devvm/src`)); process.exit(0); }
if (cmd === "build") process.exit(await build());
console.log(`usage: build.mts check | build [--component x] [--src-dir DIR] [--opt-dir DIR] [--force] | adopt-src [DIR]`);
process.exit(2);
