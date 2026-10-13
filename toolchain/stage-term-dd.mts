#!/usr/bin/env bun
// ============================================================================
// stage-term-dd.mts — build the Rust PTY proxy (cargo release) and stage it
// into native/dist/<platform>-<arch>/, same convention as viewer-dd.
//
// The packager copies that dir into <appdir>/native/ and host-int's
// termDdPath() probes <execDir>/native/term-dd there.
// Run before `draft release` — release.yml does (with viewer-dd).
// ============================================================================

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plat = `${process.platform}-${process.arch}`;   // packager's platKey

const r = spawnSync("cargo", ["build", "--release", "--locked"],
    { cwd: join(root, "term-dd"), stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

const destDir = join(root, "native", "dist", plat);
mkdirSync(destDir, { recursive: true });
copyFileSync(join(root, "term-dd", "target", "release", "term-dd"), join(destDir, "term-dd"));
console.log(`staged term-dd → native/dist/${plat}/term-dd`);
