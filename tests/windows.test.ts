import { describe, expect, test } from "bun:test";
import { defaultSpec, parseVmSpec } from "../libraries/vm-core/src/config/schema";
import { buildArgs } from "../libraries/vm-core/src/qemu/args";
import { vmPaths } from "../libraries/vm-core/src/paths";
import { exportPortable, parsePortable, serializePortable, toPortableSpec } from "../libraries/vm-core/src/config/portable";
import { autounattendXml, cruiserSetupPs1, windowsHostname, windowsLocale, windowsTimezone } from "../libraries/provision/src/windows/unattend";

const env = { ldLibraryPath: "/opt/lib" };

const winSpec = (mutate?: (s: ReturnType<typeof defaultSpec>) => void) => {
    const s = defaultSpec("winvm");
    s.os.family = "windows";
    s.os.desktop = "windows";
    s.os.release = "11";
    s.gpu.mode = "venus";
    mutate?.(s);
    return s;
};

describe("windows spec schema", () => {
    test("a minimal windows spec parses + winDriver defaults to yttrium", () => {
        const s = parseVmSpec(JSON.parse(JSON.stringify(winSpec())));
        expect(s.os.family).toBe("windows");
        expect(s.os.desktop).toBe("windows");
        expect(s.os.winDriver).toBe("yttrium");
    });

    test("yttrium + secure boot is rejected (driver needs testsigning)", () => {
        const s = winSpec((x) => { x.security.secureBoot = true; x.security.tpm = true; });
        expect(() => parseVmSpec(JSON.parse(JSON.stringify(s)))).toThrow(/Secure Boot/);
    });

    test("yttrium + non-venus gpu is rejected (needs blob scanouts)", () => {
        const s = winSpec((x) => { x.gpu.mode = "virgl"; });
        expect(() => parseVmSpec(JSON.parse(JSON.stringify(s)))).toThrow(/venus/);
    });

    test("virtio2d on virgl is a valid fallback", () => {
        const s = winSpec((x) => { x.os.winDriver = "virtio2d"; x.gpu.mode = "virgl"; });
        expect(() => parseVmSpec(JSON.parse(JSON.stringify(s)))).not.toThrow();
    });

    test("virtio2d + secure boot is allowed (signed stock driver)", () => {
        const s = winSpec((x) => {
            x.os.winDriver = "virtio2d"; x.gpu.mode = "virgl";
            x.security.secureBoot = true; x.security.tpm = true;
        });
        expect(() => parseVmSpec(JSON.parse(JSON.stringify(s)))).not.toThrow();
    });

    test("encrypt=home and headMode=app are linux-only", () => {
        const s = winSpec((x) => { x.os.winDriver = "virtio2d"; x.disk.encrypt = "home"; });
        expect(() => parseVmSpec(JSON.parse(JSON.stringify(s)))).toThrow(/linux/i);
        const a = winSpec((x) => { x.display.headMode = "app"; });
        expect(() => parseVmSpec(JSON.parse(JSON.stringify(a)))).toThrow();
    });

    test("windows-iso is a valid provisioned method", () => {
        const s = winSpec();
        s.provisioned = { method: "windows-iso", source: "en-us-windows-11.iso", completedAt: "2026-01-01" };
        const p = parseVmSpec(JSON.parse(JSON.stringify(s)));
        expect(p.provisioned.method).toBe("windows-iso");
    });
});

describe("windows qemu argv", () => {
    const build = (mutate?: (s: ReturnType<typeof defaultSpec>) => void, opts = {}) =>
        buildArgs(winSpec(mutate), vmPaths("winvm"), opts, env).argv.join("\n");

    test("Hyper-V enlightenments land on -cpu", () => {
        const a = build();
        expect(a).toContain("hv_relaxed");
        expect(a).toContain("hv_vapic");
        expect(a).toContain("hv_vpindex");
        expect(a).toContain("hv_runtime");
        expect(a).toContain("hv_synic");
        expect(a).toContain("hv_stimer");
        expect(a).toContain("hv_spinlocks=0x1fff");
    });

    test("linux guests get no hv flags", () => {
        const s = defaultSpec("lx");
        const a = buildArgs(s, vmPaths("lx"), {}, env).argv.join("\n");
        expect(a).not.toContain("hv_relaxed");
    });

    test("install.sata puts disk + all cds on native AHCI (WinPE-visible)", () => {
        const a = build(undefined, {
            mode: "install",
            install: {
                iso: "/media/win.iso", seedIso: "/media/seed.iso",
                extraCds: ["/media/virtio-win.iso"], sata: true,
            },
        });
        // disk stays virtio — install.sata scopes to cds only; IDE install
        // + virtio boot = INACCESSIBLE_BOOT_DEVICE. WinPE sees the virtio
        // disk via the seed ISO's DriverPaths (viostor).
        expect(a).toContain("disk.qcow2,if=virtio");
        expect(a).toContain("file=/media/win.iso,media=cdrom,if=ide");
        expect(a).toContain("file=/media/seed.iso,media=cdrom,if=ide");
        expect(a).toContain("file=/media/virtio-win.iso,media=cdrom,if=ide");
        expect(a).not.toContain("virtio-scsi");
    });

    test("install without sata keeps virtio disk + scsi cds (linux path)", () => {
        const a = build(undefined, {
            mode: "install",
            install: { iso: "/media/u.iso", seedIso: "/media/seed.iso" },
        });
        expect(a).toContain("disk.qcow2,if=virtio");
        expect(a).toContain("virtio-scsi-pci");
        expect(a).toContain("scsi-cd");
    });
});

describe("windows portable spec", () => {
    const roundtrip = (fmt: "json" | "yaml" | "toml") => {
        const s = winSpec((x) => { x.os.winEdition = "Windows 11 Pro"; });
        s.provisioned = { method: "windows-iso", source: "w11.iso", completedAt: "2026-01-01" };
        const text = serializePortable(exportPortable(s), fmt);
        return parsePortable(text, fmt).spec;
    };

    (["json", "yaml", "toml"] as const).forEach((fmt) => {
        test(`${fmt} round-trip keeps the windows identity`, () => {
            const s = roundtrip(fmt);
            expect(s.os.family).toBe("windows");
            expect(s.os.winDriver).toBe("yttrium");
            expect(s.os.winEdition).toBe("Windows 11 Pro");
        });
    });

    test("export strips provisioned + carries no credential surface", () => {
        const s = winSpec();
        s.provisioned = { method: "windows-iso", source: "w11.iso" };
        const p = toPortableSpec(s) as any;
        expect(p.provisioned).toEqual({});
        // a product key is never a spec field — the unattend generator
        // takes it as an option, so there's nothing to scrub.
        expect(JSON.stringify(p)).not.toContain("roductKey");
    });
});

describe("unattend helpers", () => {
    test("windowsHostname is NetBIOS-safe", () => {
        expect(windowsHostname("My Dev Box!")).toBe("my-dev-box");
        expect(windowsHostname("a-very-long-vm-name-exceeding-limit")).toBe("a-very-long-vm-");
        expect(windowsHostname("---")).toBe("cruiser-vm");
    });

    test("windowsTimezone maps IANA → windows ids, unknowns → UTC", () => {
        expect(windowsTimezone("Europe/Berlin")).toBe("W. Europe Standard Time");
        expect(windowsTimezone("America/New_York")).toBe("Eastern Standard Time");
        expect(windowsTimezone("Mars/Olympus")).toBe("UTC");
        expect(windowsTimezone(undefined)).toBeUndefined();
    });

    test("windowsLocale maps IANA → BCP47", () => {
        expect(windowsLocale("en_US.UTF-8")).toBe("en-US");
        expect(windowsLocale("de_DE")).toBe("de-DE");
        expect(windowsLocale(undefined)).toBeUndefined();
    });
});

describe("autounattend.xml", () => {
    const xml = autounattendXml({
        hostname: "winvm", username: "cruiser", password: "s3cret",
        edition: "Windows 11 Pro", timezone: "W. Europe Standard Time",
        locale: "de-DE", testsigning: true,
    });

    test("carries the core identity + partitioning", () => {
        expect(xml).toContain("<ComputerName>winvm</ComputerName>");
        expect(xml).toContain("<Username>cruiser</Username>");
        expect(xml).toContain("<Value>s3cret</Value>");
        expect(xml).toContain("<Type>EFI</Type>");
        expect(xml).toContain("<Key>/IMAGE/NAME</Key>");
        expect(xml).toContain("<Value>Windows 11 Pro</Value>");
        expect(xml).toContain("W. Europe Standard Time");
        expect(xml).toContain("<UILanguage>de-DE</UILanguage>");
    });

    test("xml-escapes interpolated values", () => {
        const x = autounattendXml({ hostname: "v", username: "a<b", password: `p"&'` });
        expect(x).not.toContain("a<b");
        expect(x).toContain("a&lt;b");
    });

    test("no edition → no InstallFrom (single-image media)", () => {
        const x = autounattendXml({ hostname: "v", username: "u", password: "p" });
        expect(x).not.toContain("InstallFrom");
    });

    test("product key only appears when provided", () => {
        const x = autounattendXml({ hostname: "v", username: "u", password: "p", productKey: "AAAAA-BBBBB" });
        expect(x).toContain("AAAAA-BBBBB");
        expect(xml).not.toContain("<ProductKey>");
    });

    // a malformed answer file fails the whole install deep inside WinPE
    // (0x80070001/0x40030) — assert well-formedness for every emission
    // shape so a raw `&`/`<` in a literal command can't regress it.
    test("the whole document is well-formed XML in every emission shape", () => {
        [
            { hostname: "v", username: "u", password: "p" },
            { hostname: "v", username: "a<b&c", password: `p"&'`, edition: "W & E", productKey: "K&" },
            { hostname: "v", username: "u", password: "p", testsigning: true },
        ].forEach((o) => {
            const x = autounattendXml(o);
            expect(x).toMatch(/^<\?xml/);
            expect(x.match(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g)).toBeNull();
            // balance check — every open tag closed
            const opens = x.match(/<[A-Za-z]/g)?.length ?? 0;
            const closes = (x.match(/<\//g)?.length ?? 0) + (x.match(/\/>/g)?.length ?? 0);
            expect(closes).toBe(opens);
        });
    });
});

describe("cruiser-setup.ps1", () => {
    const ps = cruiserSetupPs1({
        hostname: "winvm", username: "cruiser", password: "pw",
        testsigning: true, yttriumDir: "D:\\yttrium",
    });

    test("installs virtio-win drivers + enables testsigning for yttrium", () => {
        expect(ps).toMatch(/virtio-win|viostor|NetKVM/i);
        expect(ps).toMatch(/bcdedit.*testsigning|testsigning.*on/i);
        expect(ps).toMatch(/yttrium/i);
    });

    test("enables RDP + guest agent + a completion marker", () => {
        expect(ps).toMatch(/fDenyTSConnections|Terminal Server|RDP/i);
        expect(ps).toMatch(/qemu-ga|QEMU-GA|guest.agent/i);
        expect(ps).toMatch(/marker|provisioned|cruiser/i);
    });

    test("no yttrium dir → no yttrium install block (comments may still name it)", () => {
        const p = cruiserSetupPs1({ hostname: "v", username: "u", password: "p" });
        expect(p).not.toMatch(/YttriumInstalled|pnputil/i);
        expect(p).not.toMatch(/testsigning on/i);
    });
});
