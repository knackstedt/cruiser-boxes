#!/usr/bin/env bun
// ============================================================================
// stage-opt.mts — prune the built toolchain into a release payload.
//
//   bun run toolchain/stage-opt.mts [--opt-dir DIR] [--out DIR] [--src-dir DIR]
//
// The full opt/ tree (~470M) carries every arch's firmware, build headers,
// and unstripped binaries. The packaged appdir only needs the x86_64 slice,
// so this stages a minimal tree (≈90M) the packager's build.files entry
// copies to <appdir>/opt/ — where optDir() probes dirname(process.execPath).
//
// License texts: every shipped component's COPYING/LICENSE is collected from
// src-tarballs into licenses/<component>/ plus a THIRD_PARTY_NOTICES.md —
// GPL-family binaries (QEMU) can't ship without them.
// ============================================================================

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flagVal = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const OPT = resolve(flagVal("--opt-dir") ?? join(ROOT, "opt"));
const OUT = resolve(flagVal("--out") ?? join(ROOT, "release", "opt"));
const SRC_DIR = resolve(flagVal("--src-dir") ?? join(ROOT, "src-tarballs"));

interface Component { version: string; url?: string; prefix?: string; dir?: string }
const versions = JSON.parse(await readFile(join(ROOT, "toolchain", "versions.json"), "utf-8")) as {
    order: string[];
    components: Record<string, Component>;
};

const msg = (tag: string, s: string) => console.log(`[${tag}] ${s}`);

if (!existsSync(join(OPT, "qemu-11", "bin", "qemu-system-x86_64")))
    throw new Error(`${OPT}: no toolchain — run \`bun run toolchain build\` first`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function cp(src: string, dst: string): void {
    if (!existsSync(src)) { msg("warn", `missing ${src}`); return; }
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true, verbatimSymlinks: false });
}

/** strip in place — silently skips non-ELF files. */
function strip(paths: string[]): void {
    for (let i = 0; i < paths.length; i++) {
        const r = spawnSync("strip", ["--strip-unneeded", paths[i]!], { stdio: "pipe" });
        if (r.status !== 0) msg("warn", `strip ${basename(paths[i]!)}: ${(r.stderr + "").trim().split("\n")[0]}`);
    }
}

// ── qemu-11 ──
// Firmware blocklist: everything non-x86 QEMU's share/qemu ships. This is
// ~290M of the tree (edk2-arm alone is 130M). Kept: bios*/vgabios*/x86 roms,
// x86 edk2 fds + firmware descriptors, keymaps, boot roms.
const FOREIGN_ARCH = new RegExp([
    "aarch64", "arm", "riscv", "loongarch", "hppa", "s390", "sparc", "ppc",
    "openbios", "opensbi", "skiboot", "slof", "u-boot", "petalogix", "palcode",
    "npcm", "ast[0-9]", "pnv", "bamboo", "canyonlands", "sam460", "e500",
    "cgthree", "tcx", "qemu_vga\\.ndrv", "dtb", "virt-*-dtb", "bacon",
].join("|"), "i");

{
    const dst = join(OUT, "qemu-11");
    ["qemu-system-x86_64", "qemu-img"].forEach((b) => cp(join(OPT, "qemu-11", "bin", b), join(dst, "bin", b)));

    const shareSrc = join(OPT, "qemu-11", "share", "qemu");
    const shareDst = join(dst, "share", "qemu");
    readdirSync(shareSrc, { withFileTypes: true }).forEach((ent) => {
        if (FOREIGN_ARCH.test(ent.name) && !/^edk2-(i386|x86_64)/.test(ent.name)) return;
        cp(join(shareSrc, ent.name), join(shareDst, ent.name));
    });
    // firmware descriptors: only the x86 pair is meaningful
    const fwDir = join(shareDst, "firmware");
    if (existsSync(fwDir)) {
        readdirSync(fwDir)
            .filter((f) => !/(i386|x86_64)/.test(f))
            .forEach((f) => rmSync(join(fwDir, f), { force: true }));
    }
    strip([join(dst, "bin", "qemu-system-x86_64"), join(dst, "bin", "qemu-img")]);
}

// ── runtime libs (QEMU's LD_LIBRARY_PATH wiring lives on these paths) ──
cp(join(OPT, "spice", "lib"), join(OUT, "spice", "lib"));
cp(join(OPT, "virglrenderer", "lib"), join(OUT, "virglrenderer", "lib"));

// ── freerdp (rdp viewer) — $ORIGIN/../lib RUNPATH keeps it relocatable ──
cp(join(OPT, "freerdp", "bin"), join(OUT, "freerdp", "bin"));
cp(join(OPT, "freerdp", "lib"), join(OUT, "freerdp", "lib"));
// cmake's per-target metadata dirs are useless at runtime
rmSync(join(OUT, "freerdp", "lib", "cmake"), { recursive: true, force: true });

// ── materialize symlinks into real files ──
// meson/cmake bake ABSOLUTE .so version links into the install tree, and
// every cpSync in the chain (staging, packager build.files, AppImage
// assembly) can re-emit them as absolute build-host paths — dangling on an
// end-user machine, where the loader falls back to system libs (the
// AppImage bug: qemu loaded host libspice 0.15 → SPICE_SERVER_0.16 missing).
// Copy the resolved file over each link so the payload ships NO symlinks —
// downstream copiers can't corrupt what isn't there. Runs BEFORE strip so
// the duplicated .so names get stripped too.
{
    const walk = (d: string) => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d, { withFileTypes: true }).values()) {
            const p = join(d, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!e.isSymbolicLink()) continue;
            const real = realpathSync(p);
            if (statSync(real).isDirectory()) { msg("warn", `dir symlink left in payload: ${p}`); continue; }
            const tmp = p + ".materialize";
            copyFileSync(real, tmp);
            rmSync(p);
            renameSync(tmp, p);
        }
    };
    walk(OUT);
}

// strip every staged shared object + helper binary
{
    const elfs: string[] = [];
    const walk = (d: string, inBin: boolean) => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d, { withFileTypes: true }).values()) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p, inBin || e.name === "bin");
            else if (e.isFile() && (/\.so(\.\d+)*$/.test(e.name) || inBin))
                elfs.push(p);
        }
    };
    walk(join(OUT, "spice"), false); walk(join(OUT, "virglrenderer"), false); walk(join(OUT, "freerdp"), false);
    strip(elfs);
}

// ── licenses + notices ──
const LICENSE_RE = /^(copying|licen[cs]e|copyright|notice|authors|edk2-licenses)/i;
const notices: string[] = ["# Third-party notices", "",
    "This distribution bundles binaries built from the following projects.",
    "License texts are reproduced under licenses/<component>/.", ""];
{
    const licRoot = join(OUT, "licenses");
    for (let i = 0; i < versions.order.length; i++) {
        const name = versions.order[i]!;
        const c = versions.components[name];
        if (!c || !c.url) continue; // tools (meson) aren't shipped
        // Only components whose prefix actually made it into the payload —
        // optional/unbuilt ones (waypipe) ship nothing and ship no licenses.
        if (!existsSync(join(OUT, c.prefix ?? name))) continue;
        const dirName = c.dir ?? `${name === "spice-server" ? "spice" : name}-${c.version}`;
        const src = join(SRC_DIR, dirName);
        if (!existsSync(src)) { msg("warn", `${name}: no source tree at ${src} — license texts skipped`); continue; }
        const files = (await readdir(src)).filter((f) => LICENSE_RE.test(f));
        if (!files.length) { msg("warn", `${name}: no license files found in ${dirName}`); continue; }
        files.forEach((f) => cp(join(src, f), join(licRoot, name, f)));
        notices.push(`- **${name}** ${c.version} — ${c.url}`);
    }
    // edk2 firmware blobs ship inside qemu's share/qemu — their license file too
    cp(join(OPT, "qemu-11", "share", "qemu", "edk2-licenses.txt"), join(licRoot, "edk2", "edk2-licenses.txt"));
    writeFileSync(join(OUT, "THIRD_PARTY_NOTICES.md"), notices.join("\n") + "\n");
}

const du = spawnSync("du", ["-sh", OUT], { encoding: "utf8" }).stdout?.split("\t")[0];
msg("done", `staged ${OUT} (${du?.trim() ?? "?"})`);
