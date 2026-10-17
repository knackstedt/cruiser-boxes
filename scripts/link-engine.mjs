#!/usr/bin/env node
// @downdraft/* deps resolve to the published npm packages by default; when a
// sibling engine checkout exists, this links node_modules/@downdraft/* into it
// so local engine changes are picked up without touching package.json.
//
//   postinstall: link-engine.mjs          -> link (no-op without a checkout)
//   preinstall:  link-engine.mjs --prune  -> drop dead symlinks so install
//                                            restores the npm packages
//
// Engine root resolution: $CRUISER_ENGINE_DIR, then ../downdraft-engine,
// then ../downdraft — the first dir containing packages/<name> for each dep.
import { spawnSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const nmScope = join(root, "node_modules", "@downdraft");

// Every @downdraft/* dep, mapped to its packages/<dir> in the engine repo.
const wanted = new Map();
for (const sec of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(pkg[sec] ?? {})) {
        if (name.startsWith("@downdraft/")) wanted.set(name, name.slice("@downdraft/".length));
    }
}

function ensureLink(linkPath, target) {
    const rel = relative(dirname(linkPath), target);
    const st = lstatSync(linkPath, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) {
        if (readlinkSync(linkPath) === rel) return "ok";
        rmSync(linkPath);
    } else if (st) {
        rmSync(linkPath, { recursive: true, force: true }); // npm-installed dir — override it
    }
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(rel, linkPath);
    return "linked";
}

if (process.argv.includes("--prune")) {
    // Checkout gone (or never present): dead symlinks would shadow the npm
    // packages bun is about to install — remove them first.
    for (const [name] of wanted) {
        const linkPath = join(nmScope, name.slice("@downdraft/".length));
        const st = lstatSync(linkPath, { throwIfNoEntry: false });
        // existsSync follows links — false on a symlink whose target is gone.
        if (st?.isSymbolicLink() && !existsSync(linkPath)) {
            rmSync(linkPath);
            console.log(`link-engine: pruned dead link ${name}`);
        }
    }
    process.exit(0);
}

const candidates = [process.env.CRUISER_ENGINE_DIR, "../downdraft-engine", "../downdraft"]
    .filter(Boolean)
    .map((p) => resolve(root, p));

let engineRoot = null;
for (const cand of candidates) {
    if (existsSync(join(cand, "package.json")) && existsSync(join(cand, "packages"))) {
        engineRoot = cand;
        break;
    }
}

if (!engineRoot) {
    console.log("link-engine: no sibling engine checkout — using npm @downdraft/*");
    process.exit(0);
}

let created = 0;
let existing = 0;
const missing = [];
for (const [name, dir] of wanted) {
    const target = join(engineRoot, "packages", dir);
    if (!existsSync(join(target, "package.json"))) {
        missing.push(name);
        continue;
    }
    const r = ensureLink(join(nmScope, dir), target);
    if (r === "linked") created++;
    else existing++;
}
for (const m of missing) console.warn(`link-engine: ${m} not found under ${engineRoot}/packages`);
console.log(`link-engine: ${engineRoot} — ${created} linked, ${existing} already correct`);

// Runtime imports resolve the "default" export condition -> dist/. Build it
// once per link (incremental no-op after the first) so `draft dev` works
// against a fresh checkout.
if (existsSync(join(engineRoot, "scripts/build-dist.mjs"))
    && (!existsSync(join(engineRoot, "packages/engine/dist"))
        || !existsSync(join(engineRoot, "packages/platform-native/dist")))) {
    const r = spawnSync(process.execPath, [join(engineRoot, "scripts/build-dist.mjs")],
        { stdio: "inherit" });
    if (r.status !== 0) console.warn("link-engine: build-dist failed — @downdraft/* imports will not resolve until dist is built");
}
