// ============================================================================
// portable.ts — the shareable VM config document ("cruiser-vm" envelope).
//
// A PortableVmConfig is a VmSpec plus a description, serialized as YAML,
// TOML, or JSON for gists/files. Export scrubs host-local state (allocated
// ports, provisioned status, the password-file reference, origin); import
// re-runs the scrubbed spec through the VmSpec schema and the registry's
// port allocator.
//
// Bare VmSpec-shaped objects also parse (a `spec:`-less doc with a `name`),
// so a hand-written minimal doc works as an import source.
// ============================================================================

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parseVmSpec, VmSpec } from "./schema";
import { bootRelevantChanges } from "./boot-diff";
import { readGist } from "../../../sys/src/gist";
import type { VmHandle } from "../lifecycle/vm";

export const PORTABLE_FORMAT = "cruiser-vm";
export const PORTABLE_VERSION = 1;
export type PortableFmt = "json" | "yaml" | "toml";

export interface PortableVmConfig {
    format: typeof PORTABLE_FORMAT;
    version: number;
    description?: string;
    spec: VmSpec;
}

const Envelope = z.object({
    format: z.literal(PORTABLE_FORMAT),
    version: z.number().int().default(PORTABLE_VERSION),
    description: z.string().optional(),
    spec: z.unknown(),
});

/**
 * Strip host-local state so the doc applies cleanly on another machine:
 *   - network.sshPort/rdpPort + the auto 22/3389 hostfwds — re-allocated by
 *     registry.create on import (custom forwards are kept)
 *   - provisioned — nothing was provisioned on the importing host
 *   - credentials.passwordFile — the secret never leaves the host
 *   - origin — the new host sets its own
 *   - disk.file when it's the default relative name (an absolute path from
 *     another host usually doesn't exist here)
 */
export function toPortableSpec(spec: VmSpec): Record<string, unknown> {
    const s = JSON.parse(JSON.stringify(spec)) as Record<string, any>;
    delete s.origin;
    s.provisioned = {};
    if (s.network) {
        delete s.network.sshPort;
        delete s.network.rdpPort;
        if (Array.isArray(s.network.hostfwd))
            s.network.hostfwd = s.network.hostfwd.filter(
                (f: any) => f?.guestPort !== 22 && f?.guestPort !== 3389);
    }
    if (s.credentials) delete s.credentials.passwordFile;
    return s;
}

/** Build the portable envelope for a spec. The explicit description arg
 *  wins over spec.description (the `vm gist push --description` path). */
export function exportPortable(spec: VmSpec, description?: string): PortableVmConfig {
    const desc = description ?? spec.description;
    return {
        format: PORTABLE_FORMAT,
        version: PORTABLE_VERSION,
        ...(desc ? { description: desc } : {}),
        spec: parseVmSpec(toPortableSpec(spec)),
    };
}

/** Conventional filename for a serialized doc — the `*.cruiser.<fmt>`
 *  suffix is what the gist/file importer looks for. */
export function portableFilename(name: string, fmt: PortableFmt): string {
    return `${name}.cruiser.${fmt}`;
}

/** Detect the serialization format from filename or content. */
export function sniffPortable(text: string, filename = ""): PortableFmt {
    if (/\.(ya?ml)$/i.test(filename)) return "yaml";
    if (/\.toml$/i.test(filename)) return "toml";
    if (/\.json$/i.test(filename)) return "json";
    const t = text.trimStart();
    if (t.startsWith("{")) return "json";   // `[` opens a TOML [section], not JSON
    // TOML's `key = value` / `[section]` vs YAML's `key:` — decided by the
    // first meaningful line. (YAML parses TOML into garbage, so the guess
    // has to be made before parsing.)
    const first = t.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
    if (/^\[.*\]$/.test(first) || /^[A-Za-z0-9_.-]+\s*=/.test(first)) return "toml";
    return "yaml";
}

/** Parse document text (json/yaml/toml) into a PortableVmConfig. Throws a
 *  readable error when the text parses but isn't a cruiser doc. */
export function parsePortable(text: string, hint?: PortableFmt, filename = ""): PortableVmConfig {
    const fmt = hint ?? sniffPortable(text, filename);
    let raw: unknown;
    try {
        raw = fmt === "json" ? JSON.parse(text) : fmt === "toml" ? parseToml(text) : parseYaml(text);
    } catch (e) {
        throw new Error(`can't parse ${filename || "config"} as ${fmt}: ${e instanceof Error ? e.message : e}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        throw new Error(`not a cruiser config — parsed as ${fmt} but got ${Array.isArray(raw) ? "an array" : typeof raw}`);

    const obj = raw as Record<string, unknown>;
    const specish = (o: unknown): o is Record<string, unknown> =>
        typeof o === "object" && o !== null;

    // Envelope form: { format: "cruiser-vm", version, description, spec }
    if (specish(obj.spec) || obj.format === PORTABLE_FORMAT) {
        const env = Envelope.parse(obj);
        return {
            format: PORTABLE_FORMAT,
            version: env.version,
            description: env.description,
            spec: parseVmSpec(env.spec),
        };
    }
    // Bare-spec form: the doc itself is a VmSpec (has `name`).
    if (typeof obj.name === "string") {
        const spec = parseVmSpec(obj);
        return {
            format: PORTABLE_FORMAT,
            version: PORTABLE_VERSION,
            description: spec.description || undefined,
            spec,
        };
    }
    throw new Error(`parsed as ${fmt} but found neither a 'spec' envelope nor a 'name' field — is this a cruiser config?`);
}

/** Serialize a portable doc. undefined is dropped by the JSON clone —
 *  TOML can't represent it. */
export function serializePortable(doc: PortableVmConfig, fmt: PortableFmt): string {
    const clean = JSON.parse(JSON.stringify(doc));
    switch (fmt) {
        case "json": return `${JSON.stringify(clean, null, 2)}\n`;
        case "yaml": return stringifyYaml(clean);
        case "toml": return `${stringifyToml(clean)}\n`;
    }
}

/** Pick the config file out of a gist's file list — `*.cruiser.<fmt>` wins,
 *  a lone file is taken as-is, `vm.*` is the legacy fallback. */
export function pickConfigFile<T extends { filename: string }>(files: T[]): T {
    const cfg = files.find((f) => /\.cruiser\.(json|ya?ml|toml)$/i.test(f.filename));
    if (cfg) return cfg;
    if (files.length === 1) return files[0]!;
    const named = files.find((f) => /^vm\.(json|ya?ml|toml)$/i.test(f.filename));
    if (named) return named;
    throw new Error(`can't tell which file is the VM config — expected a *.cruiser.{yaml,toml,json} file (found: ${files.map((f) => f.filename).join(", ")})`);
}

/**
 * Merge a freshly-imported spec over an existing VM (`vm config pull`).
 * Host-allocated and provisioned state is preserved; everything else comes
 * from the pulled doc. Returns the merged spec plus the section names that
 * changed and need a restart to take effect.
 */
export function mergePulledSpec(current: VmSpec, incoming: VmSpec): { spec: VmSpec; needsRestart: string[] } {
    const next = JSON.parse(JSON.stringify(incoming)) as VmSpec;
    next.name = current.name;
    next.description = incoming.description || current.description;
    next.network = {
        ...next.network,
        sshPort: current.network.sshPort,
        rdpPort: current.network.rdpPort,
        hostfwd: mergeHostfwd(current, next),
    };
    next.provisioned = current.provisioned;
    next.credentials = { ...next.credentials, passwordFile: current.credentials.passwordFile };
    next.disk.file = current.disk.file;
    next.origin = current.origin;   // pull source is host-local state — survive the merge

    return { spec: next, needsRestart: bootRelevantChanges(current, next) };
}

/** Local hostfwd entries always exist (registry-allocated ssh/rdp); union
 *  them with the pulled doc's custom forwards, local ports winning. */
function mergeHostfwd(current: VmSpec, next: VmSpec): VmSpec["network"]["hostfwd"] {
    const out = [...current.network.hostfwd];
    next.network.hostfwd.forEach((f) => {
        if (!out.some((o) => o.guestPort === f.guestPort && o.proto === f.proto)) out.push(f);
    });
    return out;
}

// ── shared fetch/apply helpers (cli + app-shell consume these) ──

/** Load a portable config from a local file path or a gist ref
 *  (bare id / gist url / user/id). */
export async function loadPortableRef(ref: string): Promise<{
    doc: PortableVmConfig;
    origin: NonNullable<VmSpec["origin"]>;
}> {
    if (existsSync(ref)) {
        const text = await readFile(ref, "utf-8");
        return { doc: parsePortable(text, undefined, ref), origin: { kind: "file", url: ref } };
    }
    const g = await readGist(ref);
    const f = pickConfigFile(g.files);
    const doc = parsePortable(f.content, undefined, f.filename);
    if (!doc.description && g.description) doc.description = g.description;
    return { doc, origin: { kind: "gist", id: g.id, url: g.url } };
}

/**
 * Re-fetch the spec from spec.origin and merge it over the local spec
 * (host-allocated ports, provisioned state, credentials preserved). Saves
 * the spec; returns the boot-relevant sections that changed.
 */
export async function pullConfigFromOrigin(h: VmHandle): Promise<{ needsRestart: string[] }> {
    const o = h.spec.origin;
    if (!o) throw new Error(`${h.spec.name} has no origin — it wasn't imported. Push it first: 'vm gist push ${h.spec.name}'`);
    let doc: PortableVmConfig;
    if (o.kind === "gist") {
        const g = await readGist(o.id ?? o.url ?? "");
        const f = pickConfigFile(g.files);
        doc = parsePortable(f.content, undefined, f.filename);
        h.spec.origin = { kind: "gist", id: g.id, url: g.url };
    } else {
        if (!o.url || !existsSync(o.url)) throw new Error(`origin file ${o.url ?? "?"} is gone`);
        doc = parsePortable(await readFile(o.url, "utf-8"), undefined, o.url);
    }
    const { spec, needsRestart } = mergePulledSpec(h.spec, doc.spec);
    h.spec = VmSpec.parse(spec);
    await h.saveSpec();
    return { needsRestart };
}
