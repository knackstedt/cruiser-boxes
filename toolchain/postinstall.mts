#!/usr/bin/env bun
// ============================================================================
// postinstall.mts — runs after `bun install` and builds everything JS deps
// can't provide:
//   1. term-bundle.gen.ts      — xterm.js page bundle for the embedded term
//   2. native/dist/            — viewer-dd + term-dd Rust helpers (cargo)
//   3. opt/ toolchain          — QEMU 11 + spice + virglrenderer + freerdp
//                                (.built-* markers make re-runs cheap)
//
// Skipped in CI (ci.yml only typechecks/tests; release.yml builds these
// explicitly via the stage scripts). CRUISER_SKIP_POSTINSTALL=1 opts out
// locally. Fails loudly on a real build error — a silent green install that
// leaves QEMU missing is how "get this damn thing running" happens.
// ============================================================================

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.CI || process.env.GITHUB_ACTIONS) {
    console.log("[postinstall] CI detected — skipping toolchain builds");
    process.exit(0);
}
if (process.env.CRUISER_SKIP_POSTINSTALL) {
    console.log("[postinstall] CRUISER_SKIP_POSTINSTALL set — skipping");
    process.exit(0);
}

const run = (name: string, args: string[]): boolean => {
    console.log(`[postinstall] ${name}`);
    const r = spawnSync("bun", ["run", ...args], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) console.error(`[postinstall] FAIL: ${name} (exit ${r.status})`);
    return r.status === 0;
};

const has = (bin: string): boolean =>
    spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;

const failed: string[] = [];
const step = (ok: boolean, name: string) => { if (!ok) failed.push(name); };

step(run("term:bundle", ["toolchain/build-term-page.mts"]), "term:bundle");

if (has("cargo")) {
    step(run("viewer-dd:stage", ["toolchain/stage-viewer-dd.mts"]), "viewer-dd:stage");
    step(run("term-dd:stage", ["toolchain/stage-term-dd.mts"]), "term-dd:stage");
} else {
    console.warn("[postinstall] cargo not found — skipping viewer-dd/term-dd (install rustup for the dmabuf viewer + embedded term)");
}

// opt/ toolchain — QEMU 11 is the headline dep; freerdp is "optional" in
// versions.json but distro freerdp3 lacks H.264 which krdp guests need, so
// build it too. Both no-op when their .built-* markers exist.
step(run("toolchain build", ["toolchain/build.mts", "build"]), "toolchain");
step(run("toolchain freerdp", ["toolchain/build.mts", "build", "--component", "freerdp"]), "toolchain:freerdp");

if (failed.length) {
    console.error(`[postinstall] failed: ${failed.join(", ")}`);
    process.exit(1);
}
console.log("[postinstall] done — `bun run toolchain check` for the resolution report");
