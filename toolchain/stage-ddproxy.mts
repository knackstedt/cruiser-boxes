#!/usr/bin/env bun
// ============================================================================
// stage-ddproxy.mts — build the Rust display broker (cargo release) and
// stage it into native/dist/<platform>-<arch>/.
//
// Same convention as stage-viewer-dd.mts: `draft release` copies the whole
// dir into <appdir>/native/, where vm-core's ddproxyPath() probes
// <execDir>/native/ddproxy. Run before `draft release` — release.yml does.
// ============================================================================

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plat = `${process.platform}-${process.arch}`;   // packager's platKey

const r = spawnSync("cargo", ["build", "--release", "--locked"],
    { cwd: join(root, "ddproxy"), stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

const destDir = join(root, "native", "dist", plat);
mkdirSync(destDir, { recursive: true });
copyFileSync(join(root, "ddproxy", "target", "release", "ddproxy"), join(destDir, "ddproxy"));
console.log(`staged ddproxy → native/dist/${plat}/ddproxy`);
