// ============================================================================
// gist.ts — minimal GitHub Gist client over plain fetch (node 18+/bun).
//
// Reads are unauthenticated for public gists; when a token is available
// it's sent too, which also unlocks secret gists the token owns.
// Writes need a token: `gh auth token` when the gh CLI is installed, else
// CRUISER_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN. No token is ever stored.
// ============================================================================

import { run, which } from "./exec";

// Overridable for GitHub Enterprise (gists at gist.<corp-host>) and for tests.
const apiBase = () =>
    (process.env.CRUISER_GITHUB_API?.replace(/\/+$/, "") || "https://api.github.com");

export interface GistFile {
    filename: string;
    content: string;
    truncated?: boolean;
    raw_url?: string;
}

export interface GistData {
    id: string;
    url: string;
    description: string;
    files: GistFile[];
}

/** Extract the gist id from a bare id, gist URL, or user/id form. */
export function gistIdFromRef(ref: string): string {
    const t = ref.trim().replace(/\.git$/, "").split("#")[0]!;
    // https://gist.github.com/<user>/<id>, gist.github.com/<id>, or a
    // GitHub-Enterprise URL where the last path segment is the hex id.
    const m = t.match(/gist\.github(?:usercontent)?\.com\/(?:[^/]+\/)?([0-9a-f]+)/i)
        ?? t.match(/\/([0-9a-f]{20,})(?:\?|\/|$)/i);
    const id = (m?.[1] ?? t).toLowerCase();
    if (!/^[0-9a-f]{20,}$/.test(id))
        throw new Error(`can't parse a gist id out of '${ref}' — pass the id or the gist URL`);
    return id;
}

/** Resolve a GitHub token: env first (explicit), then the gh CLI. */
export async function githubToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
    const keys = ["CRUISER_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];
    for (let i = 0; i < keys.length; i++) {
        const v = env[keys[i]!]?.trim();
        if (v) return v;
    }
    if (await which("gh")) {
        const r = await run("gh", ["auth", "token"], { noThrow: true, timeoutMs: 15_000 });
        const t = r.stdout.trim();
        if (r.code === 0 && t) return t;
    }
    return null;
}

async function api(path: string, init: RequestInit = {}, token?: string | null): Promise<any> {
    const r = await fetch(`${apiBase()}${path}`, {
        ...init,
        headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
        },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok)
        throw new Error(`github ${path}: ${r.status} ${typeof body?.message === "string" ? body.message : r.statusText}`);
    return body;
}

/** Fetch a gist by id/URL. Truncated file bodies are refetched from their
 *  raw_url (the API caps inline content around ~1 MiB). */
export async function readGist(ref: string): Promise<GistData> {
    const id = gistIdFromRef(ref);
    const token = await githubToken();
    const j = await api(`/gists/${id}`, {}, token);
    const files: GistFile[] = await Promise.all(
        Object.values(j.files ?? {}).map(async (f: any) => {
            if (f?.truncated && f.raw_url) {
                const rr = await fetch(f.raw_url);
                if (rr.ok) return { filename: f.filename, content: await rr.text() };
            }
            return { filename: String(f?.filename ?? "file"), content: String(f?.content ?? "") };
        }),
    );
    return { id: j.id, url: j.html_url, description: j.description ?? "", files };
}

/** Create a gist, or update it when `id` is given. Requires a token. */
export async function pushGist(opts: {
    id?: string;
    description?: string;
    isPublic?: boolean;
    files: Record<string, string>;
}): Promise<{ id: string; url: string }> {
    const token = await githubToken();
    if (!token)
        throw new Error("github auth needed — install gh and run `gh auth login`, or set GITHUB_TOKEN / CRUISER_GITHUB_TOKEN");
    const body = {
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        ...(opts.id ? {} : { public: !!opts.isPublic }),
        files: Object.fromEntries(Object.entries(opts.files).map(([name, content]) => [name, { content }])),
    };
    const j = await api(opts.id ? `/gists/${opts.id}` : "/gists",
        { method: opts.id ? "PATCH" : "POST", body: JSON.stringify(body) }, token);
    return { id: j.id, url: j.html_url };
}
