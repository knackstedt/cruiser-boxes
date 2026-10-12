#!/usr/bin/env bun
// ============================================================================
// stage-viewer-dd.mts — build the Rust dmabuf viewer (cargo release) and
// stage it into native/dist/<platform>-<arch>/.
//
// `draft release`'s game-native convention copies that whole dir into
// <appdir>/native/ (extension filter covers .so/.node on the bun path and
// every file on the desktop path — viewer-dd is a plain executable), and
// host-int's ddViewerPath() probes <execDir>/native/viewer-dd there.
// Run before `draft release` — release.yml does.
// ============================================================================

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plat = `${process.platform}-${process.arch}`;   // packager's platKey

const r = spawnSync("cargo", ["build", "--release", "--locked"],
    { cwd: join(root, "viewer-dd"), stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

const destDir = join(root, "native", "dist", plat);
mkdirSync(destDir, { recursive: true });
copyFileSync(join(root, "viewer-dd", "target", "release", "viewer-dd"), join(destDir, "viewer-dd"));
console.log(`staged viewer-dd → native/dist/${plat}/viewer-dd`);
