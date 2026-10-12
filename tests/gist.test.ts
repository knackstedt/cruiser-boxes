import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, Server } from "node:http";
import { gistIdFromRef, githubToken, pushGist, readGist } from "../libraries/sys/src/gist";

describe("gistIdFromRef", () => {
    const id = "0123456789abcdef0123456789abcdef";
    test("accepts the usual ref shapes", () => {
        expect(gistIdFromRef(id)).toBe(id);
        expect(gistIdFromRef(`https://gist.github.com/u/${id}`)).toBe(id);
        expect(gistIdFromRef(`https://gist.github.com/${id}`)).toBe(id);
        expect(gistIdFromRef(`gist.github.com/u/${id}`)).toBe(id);
        expect(gistIdFromRef(`https://gist.github.com/u/${id}#file-box-cruiser-yaml`)).toBe(id);
        expect(gistIdFromRef(`https://gist.github.com/u/${id}.git`)).toBe(id);
        // githubusercontent raw URLs + enterprise hosts
        expect(gistIdFromRef(`https://gist.githubusercontent.com/u/${id}/raw/box.cruiser.yaml`)).toBe(id);
        expect(gistIdFromRef(`https://gist.corp.example/u/${id}`)).toBe(id);
        expect(gistIdFromRef(id.toUpperCase())).toBe(id);
    });
    test("rejects non-gist refs readably", () => {
        expect(() => gistIdFromRef("hello")).toThrow("can't parse a gist id");
        expect(() => gistIdFromRef("https://github.com/u/repo")).toThrow();
    });
});

describe("githubToken", () => {
    test("env priority: CRUISER_GITHUB_TOKEN > GITHUB_TOKEN > GH_TOKEN", async () => {
        const e = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
        expect(await githubToken(e({ CRUISER_GITHUB_TOKEN: "a", GITHUB_TOKEN: "b", GH_TOKEN: "c" }))).toBe("a");
        expect(await githubToken(e({ GITHUB_TOKEN: "b", GH_TOKEN: "c" }))).toBe("b");
        expect(await githubToken(e({ GH_TOKEN: "c" }))).toBe("c");
        expect(await githubToken(e({ CRUISER_GITHUB_TOKEN: "  x  " }))).toBe("x");
    });
});

// --- HTTP layer against a mock api.github.com -------------------------------

let server: Server;
let lastReq: { method: string; path: string; auth?: string; body: any } | null = null;
const reqs: typeof lastReq[] = [];
const GIST_ID = "aa".repeat(16);

beforeAll(async () => {
    server = createServer((req, res) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
            lastReq = { method: req.method!, path: req.url!, auth: req.headers.authorization, body: data ? JSON.parse(data) : null };
            reqs.push(lastReq);
            res.setHeader("content-type", "application/json");
            if (req.method === "GET" && req.url === `/gists/${GIST_ID}`) {
                res.end(JSON.stringify({
                    id: GIST_ID, html_url: `https://gist.github.com/${GIST_ID}`, description: "mock gist",
                    files: {
                        "readme.md": { filename: "readme.md", content: "hi" },
                        "box.cruiser.yaml": { filename: "box.cruiser.yaml", content: "name: fromgist\n" },
                        "big.txt": { filename: "big.txt", truncated: true, raw_url: `http://${req.headers.host}/raw/big` },
                    },
                }));
            } else if (req.url === "/raw/big") {
                res.end("full content of big file");
            } else if (req.method === "POST" && req.url === "/gists") {
                res.end(JSON.stringify({ id: "newgist1234567890abcdef12345678", html_url: "https://gist.github.com/newgist1234567890abcdef12345678" }));
            } else if (req.method === "PATCH" && req.url?.startsWith("/gists/")) {
                res.end(JSON.stringify({ id: req.url.slice(7), html_url: `https://gist.github.com/${req.url.slice(7)}` }));
            } else {
                res.statusCode = 404; res.end(JSON.stringify({ message: "Not Found" }));
            }
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.CRUISER_GITHUB_API = `http://127.0.0.1:${(server.address() as any).port}`;
    process.env.CRUISER_GITHUB_TOKEN = "test-token";
});
afterAll(() => {
    server.close();
    delete process.env.CRUISER_GITHUB_API;
    delete process.env.CRUISER_GITHUB_TOKEN;
});

describe("readGist", () => {
    test("fetches files, refetches truncated bodies, sends auth", async () => {
        const g = await readGist(GIST_ID);
        expect(g.id).toBe(GIST_ID);
        expect(g.description).toBe("mock gist");
        const names = g.files.map((f) => f.filename).sort();
        expect(names).toEqual(["big.txt", "box.cruiser.yaml", "readme.md"]);
        expect(g.files.find((f) => f.filename === "big.txt")!.content).toBe("full content of big file");
        expect(reqs.find((r) => r!.method === "GET")!.auth).toBe("Bearer test-token");
        // the truncated-file refetch goes to raw_url without auth
        expect(reqs.find((r) => r!.path === "/raw/big")!.auth).toBeUndefined();
    });
    test("404 propagates a readable error", async () => {
        await expect(readGist("bb".repeat(16))).rejects.toThrow("404");
    });
});

describe("pushGist", () => {
    test("POST /gists for new, private by default", async () => {
        const r = await pushGist({ description: "d", files: { "x.cruiser.yaml": "name: x\n" } });
        expect(r.id).toBe("newgist1234567890abcdef12345678");
        expect(lastReq!.method).toBe("POST");
        expect(lastReq!.path).toBe("/gists");
        expect(lastReq!.body.public).toBe(false);
        expect(lastReq!.body.description).toBe("d");
        expect(lastReq!.body.files["x.cruiser.yaml"].content).toBe("name: x\n");
        expect(lastReq!.auth).toBe("Bearer test-token");
    });
    test("PATCH /gists/<id> for update, never sends 'public'", async () => {
        const r = await pushGist({ id: GIST_ID, isPublic: true, files: { a: "b" } });
        expect(r.id).toBe(GIST_ID);
        expect(lastReq!.method).toBe("PATCH");
        expect(lastReq!.body.public).toBeUndefined();
    });
    test("no token → clear auth error", async () => {
        const keep = process.env.CRUISER_GITHUB_TOKEN;
        delete process.env.CRUISER_GITHUB_TOKEN;
        delete process.env.GITHUB_TOKEN;
        delete process.env.GH_TOKEN;
        // may still find `gh`; only assert the message when it can't
        try {
            const r = await pushGist({ files: {} });
            expect(r.id).toBeTruthy();   // gh auth token worked — fine
        } catch (e: any) {
            expect(e.message).toMatch(/github auth needed/);
        }
        process.env.CRUISER_GITHUB_TOKEN = keep;
    });
});
