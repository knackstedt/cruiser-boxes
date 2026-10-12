import { describe, expect, test } from "bun:test";
import { defaultSpec, parseVmSpec } from "../libraries/vm-core/src/config/schema";
import {
    exportPortable, mergePulledSpec, parsePortable, pickConfigFile,
    portableFilename, serializePortable, sniffPortable, toPortableSpec,
} from "../libraries/vm-core/src/config/portable";

const spec = () => {
    const s = defaultSpec("testvm");
    s.description = "a test box";
    s.network.sshPort = 2222;
    s.network.rdpPort = 3390;
    s.network.hostfwd.push(
        { hostPort: 2222, guestPort: 22, proto: "tcp" },
        { hostPort: 3390, guestPort: 3389, proto: "tcp" },
        { hostPort: 8080, guestPort: 8080, proto: "tcp" });
    s.provisioned = { method: "cloudimg", source: "ubuntu-26.04", completedAt: "2026-01-01" };
    s.credentials.passwordFile = "/secret/pw";
    s.origin = { kind: "gist", id: "0123456789abcdef0123456789abcdef" };
    s.shares.push({
        hostPath: "/home/u/src", tag: "src", mode: "mount", direction: "host-to-guest",
        readOnly: true, enabled: true, deletions: false,
    });
    return s;
};

describe("portable export scrub", () => {
    test("ports, provisioned, passwordFile, origin are stripped", () => {
        const p = toPortableSpec(spec()) as any;
        expect(p.network.sshPort).toBeUndefined();
        expect(p.network.rdpPort).toBeUndefined();
        expect(p.network.hostfwd).toEqual([{ hostPort: 8080, guestPort: 8080, proto: "tcp" }]);
        expect(p.provisioned).toEqual({});
        expect(p.credentials.passwordFile).toBeUndefined();
        expect(p.origin).toBeUndefined();
        // real settings survive
        expect(p.resources.cpus).toBe(4);
        expect(p.shares[0].hostPath).toBe("/home/u/src");
    });
    test("description: explicit arg wins over spec.description", () => {
        expect(exportPortable(spec(), "override").description).toBe("override");
        expect(exportPortable(spec()).description).toBe("a test box");
        const bare = spec(); bare.description = "";
        expect(exportPortable(bare).description).toBeUndefined();
    });
});

describe("serialize + parse round-trips", () => {
    const doc = () => exportPortable(spec());
    (["json", "yaml", "toml"] as const).forEach((fmt) => {
        test(fmt, () => {
            const text = serializePortable(doc(), fmt);
            const back = parsePortable(text, fmt);
            expect(back.spec.name).toBe("testvm");
            expect(back.spec.shares[0]!.direction).toBe("host-to-guest");
            expect(back.spec.os.family).toBe("ubuntu");
            expect(back.description).toBe("a test box");
        });
    });
    test("round-tripped spec re-parses into identical defaults", () => {
        const text = serializePortable(doc(), "yaml");
        const back = parsePortable(text);
        // parse → serialize → parse is stable
        const again = serializePortable(exportPortable(back.spec), "yaml");
        expect(parsePortable(again).spec.resources).toEqual(back.spec.resources);
    });
});

describe("format sniffing", () => {
    test("by filename", () => {
        expect(sniffPortable("anything", "x.cruiser.yaml")).toBe("yaml");
        expect(sniffPortable("anything", "x.cruiser.toml")).toBe("toml");
        expect(sniffPortable("anything", "x.json")).toBe("json");
    });
    test("by content", () => {
        expect(sniffPortable('{"format":"cruiser-vm"}')).toBe("json");
        expect(sniffPortable('format = "cruiser-vm"')).toBe("toml");
        expect(sniffPortable('[spec]\nname = "x"')).toBe("toml");
        expect(sniffPortable("format: cruiser-vm\nspec:\n  name: x")).toBe("yaml");
        expect(sniffPortable("# comment\nname = x")).toBe("toml");
    });
});

describe("parse tolerance", () => {
    test("bare spec object (no envelope) parses", () => {
        const d = parsePortable(JSON.stringify({ name: "bare", resources: { cpus: 8 } }));
        expect(d.spec.name).toBe("bare");
        expect(d.spec.resources.cpus).toBe(8);
    });
    test("bare yaml spec parses", () => {
        const d = parsePortable("name: barespec\nos:\n  family: fedora\n");
        expect(d.spec.os.family).toBe("fedora");
    });
    test("garbage errors readably", () => {
        expect(() => parsePortable('"just a string"')).toThrow("not a cruiser config");
        expect(() => parsePortable("{\"foo\":1}")).toThrow("neither a 'spec' envelope nor a 'name'");
    });
    test("invalid spec fields die in zod", () => {
        expect(() => parsePortable('name: "Bad Name!"\n')).toThrow();
    });
});

describe("pickConfigFile", () => {
    const f = (filename: string) => ({ filename, content: "" });
    test("*.cruiser.* wins over others", () => {
        expect(pickConfigFile([f("readme.md"), f("box.cruiser.yaml")]).filename).toBe("box.cruiser.yaml");
    });
    test("single file taken as-is", () => {
        expect(pickConfigFile([f("myvm.json")]).filename).toBe("myvm.json");
    });
    test("vm.* fallback; ambiguity errors", () => {
        expect(pickConfigFile([f("a.txt"), f("vm.json")]).filename).toBe("vm.json");
        expect(() => pickConfigFile([f("a.txt"), f("b.txt")])).toThrow("cruiser");
    });
});

describe("mergePulledSpec", () => {
    test("preserves local runtime state, takes pulled settings", () => {
        const local = spec();
        local.resources.cpus = 4;
        const pulled = spec();
        (pulled as any).network = { hostfwd: [] };   // scrubbed doc
        pulled.resources.cpus = 16;
        pulled.description = "updated desc";
        const { spec: merged, needsRestart } = mergePulledSpec(local, pulled);
        expect(merged.name).toBe("testvm");
        expect(merged.resources.cpus).toBe(16);
        expect(merged.description).toBe("updated desc");
        expect(merged.network.sshPort).toBe(2222);
        expect(merged.network.rdpPort).toBe(3390);
        expect(merged.network.hostfwd.some((f) => f.guestPort === 22)).toBe(true); // local keep
        expect(merged.provisioned.method).toBe("cloudimg");
        expect(merged.credentials.passwordFile).toBe("/secret/pw");
        expect(merged.disk.file).toBe(local.disk.file);
        expect(needsRestart).toContain("resources");
    });
    test("origin survives a pull (host-local pull source)", () => {
        const local = spec();   // has origin {kind:'gist', id:…}
        const pulled = parsePortable(serializePortable(exportPortable(local), "json"));
        const { spec: merged } = mergePulledSpec(local, pulled.spec);
        expect(merged.origin).toEqual({ kind: "gist", id: "0123456789abcdef0123456789abcdef" });
    });
    test("identical doc → empty needsRestart", () => {
        const local = spec();
        const pulled = parsePortable(serializePortable(exportPortable(local), "json"));
        const { needsRestart } = mergePulledSpec(local, pulled.spec);
        expect(needsRestart).toEqual([]);
    });
});

describe("share schema", () => {
    test("legacy readOnly:true → direction host-to-guest", () => {
        const s = parseVmSpec({ name: "x", shares: [{ hostPath: "/a", tag: "t", readOnly: true }] });
        expect(s.shares[0]!.direction).toBe("host-to-guest");
        expect(s.shares[0]!.readOnly).toBe(true);
    });
    test("direction host-to-guest → readOnly stays synced", () => {
        const s = parseVmSpec({ name: "x", shares: [{ hostPath: "/a", tag: "t", direction: "host-to-guest" }] });
        expect(s.shares[0]!.readOnly).toBe(true);
    });
    test("direction wins over a contradictory legacy flag", () => {
        const s = parseVmSpec({ name: "x", shares: [{ hostPath: "/a", tag: "t", direction: "both", readOnly: true }] });
        expect(s.shares[0]!.direction).toBe("both");
        expect(s.shares[0]!.readOnly).toBe(false);
    });
    test("defaults: mount mode, both, enabled", () => {
        const s = parseVmSpec({ name: "x", shares: [{ hostPath: "/a", tag: "t" }] });
        expect(s.shares[0]!.mode).toBe("mount");
        expect(s.shares[0]!.direction).toBe("both");
        expect(s.shares[0]!.enabled).toBe(true);
    });
    test("portableFilename", () => {
        expect(portableFilename("box", "yaml")).toBe("box.cruiser.yaml");
        expect(portableFilename("box", "toml")).toBe("box.cruiser.toml");
    });
});
