import { describe, expect, test } from "bun:test";
import { defaultSpec, parseVmSpec } from "../libraries/vm-core/src/config/schema";
import { buildArgs } from "../libraries/vm-core/src/qemu/args";
import { diskKeyPath, homeDiskPath, vmPaths } from "../libraries/vm-core/src/paths";
import { bootRelevantChanges } from "../libraries/vm-core/src/config/boot-diff";
import { exportPortable, mergePulledSpec, toPortableSpec } from "../libraries/vm-core/src/config/portable";
import { guestSetupScript } from "../libraries/provision/src/guest-setup";

const env = { ldLibraryPath: "/opt/lib" };

function spec(mutate?: (s: ReturnType<typeof defaultSpec>) => void) {
    const s = defaultSpec("enc-vm");
    s.network.sshPort = 2222;
    s.network.rdpPort = 3390;
    mutate?.(s);
    return s;
}

function argvOf(s: ReturnType<typeof spec>) {
    return buildArgs(s, vmPaths(s.name), {}, env).argv.join("\n");
}

describe("disk.encrypt schema", () => {
    test("defaults: off / store / 50GiB home volume", () => {
        const s = spec();
        expect(s.disk.encrypt).toBe("off");
        expect(s.disk.keyStorage).toBe("store");
        expect(s.disk.homeGiB).toBe(50);
    });
    test("parses explicit values; rejects garbage", () => {
        const s = parseVmSpec({ name: "x", disk: { encrypt: "home", keyStorage: "prompt", homeGiB: 32 } });
        expect(s.disk.encrypt).toBe("home");
        expect(s.disk.keyStorage).toBe("prompt");
        expect(s.disk.homeGiB).toBe(32);
        expect(() => parseVmSpec({ name: "x", disk: { encrypt: "maybe" } })).toThrow();
        expect(() => parseVmSpec({ name: "x", disk: { keyStorage: "meh" } })).toThrow();
        expect(() => parseVmSpec({ name: "x", disk: { homeGiB: 1 } })).toThrow();
    });
});

describe("disk key + home image paths", () => {
    const dir = vmPaths("enc-vm").dir;
    test("diskKeyPath: null when off, secrets/ for store, run/ for prompt", () => {
        expect(diskKeyPath(spec(), vmPaths("enc-vm"))).toBeNull();
        const store = spec((s) => { s.disk.encrypt = "full"; });
        expect(diskKeyPath(store, vmPaths("enc-vm"))).toBe(`${dir}/secrets/disk-key`);
        const prompt = spec((s) => { s.disk.encrypt = "full"; s.disk.keyStorage = "prompt"; });
        expect(diskKeyPath(prompt, vmPaths("enc-vm"))).toBe(`${dir}/run/disk-key`);
    });
    test("homeDiskPath is a <stem>-home.qcow2 sibling of the system disk", () => {
        expect(homeDiskPath(spec(), dir)).toBe(`${dir}/disk-home.qcow2`);
        const custom = spec((s) => { s.disk.file = "/big/foo.img"; });
        expect(homeDiskPath(custom, dir)).toBe("/big/foo-home.qcow2");
    });
});

describe("buildArgs LUKS wiring", () => {
    test("off: no secret object, no key-secret on the drive", () => {
        const a = argvOf(spec());
        expect(a).not.toContain("secret,id=diskkey");   // -object itself is used for memfd/rng
        expect(a).not.toContain("encrypt.key-secret");
        expect(a).toContain("disk.qcow2,if=virtio,format=qcow2,discard=unmap\n");
    });
    test("full: secret object + key-secret on the system drive", () => {
        const a = argvOf(spec((s) => { s.disk.encrypt = "full"; }));
        expect(a).toContain(`-object\nsecret,id=diskkey,file=${vmPaths("enc-vm").dir}/secrets/disk-key`);
        expect(a).toContain("disk.qcow2,if=virtio,format=qcow2,discard=unmap,encrypt.key-secret=diskkey");
        expect(a).not.toContain("cruiser-home");
    });
    test("prompt storage: the secret file points at run/, not secrets/", () => {
        const a = argvOf(spec((s) => { s.disk.encrypt = "full"; s.disk.keyStorage = "prompt"; }));
        expect(a).toContain(`secret,id=diskkey,file=${vmPaths("enc-vm").run}/disk-key`);
    });
    test("home: plaintext root + second LUKS drive on virtio serial cruiser-home", () => {
        const a = argvOf(spec((s) => { s.disk.encrypt = "home"; }));
        expect(a).toContain("disk.qcow2,if=virtio,format=qcow2,discard=unmap\n");
        expect(a).toContain(`file=${vmPaths("enc-vm").dir}/disk-home.qcow2,format=qcow2,discard=unmap,encrypt.key-secret=diskkey`);
        expect(a).toContain("virtio-blk-pci,drive=home0,serial=cruiser-home");
    });
    test("full on a non-qcow2 image is a hard error", () => {
        expect(() => argvOf(spec((s) => { s.disk.encrypt = "full"; s.disk.format = "raw"; })))
            .toThrow("qcow2");
    });
});

describe("boot diff + portable", () => {
    test("encrypt/keyStorage/homeGiB changes flag as boot-relevant", () => {
        const a = spec();
        const b = spec((s) => { s.disk.encrypt = "home"; });
        expect(bootRelevantChanges(a, b)).toEqual(["disk"]);
        const c = spec((s) => { s.disk.encrypt = "home"; });
        const d = spec((s) => { s.disk.encrypt = "home"; s.disk.keyStorage = "prompt"; });
        expect(bootRelevantChanges(c, d)).toEqual(["disk"]);
        const e = spec((s) => { s.disk.encrypt = "home"; s.disk.homeGiB = 99; });
        expect(bootRelevantChanges(c, e)).toEqual(["disk"]);
    });
    test("export keeps the encryption config (metadata, not secret)", () => {
        const p = toPortableSpec(spec((s) => { s.disk.encrypt = "home"; s.disk.keyStorage = "prompt"; })) as any;
        expect(p.disk.encrypt).toBe("home");
        expect(p.disk.keyStorage).toBe("prompt");
    });
    test("config pull can't flip encryption on an existing image", () => {
        const local = spec();
        const pulled = exportPortable(spec((s) => { s.disk.encrypt = "full"; s.disk.keyStorage = "prompt"; })).spec;
        const { spec: merged } = mergePulledSpec(local, pulled);
        expect(merged.disk.encrypt).toBe("off");
        expect(merged.disk.keyStorage).toBe("store");
    });
});

describe("guest-setup /home wiring", () => {
    test("encrypt=home emits the virtio-cruiser-home fstab/mount section", () => {
        const s = guestSetupScript(spec((x) => { x.disk.encrypt = "home"; }), { rdpPassword: "pw" });
        expect(s).toContain("virtio-cruiser-home");
        expect(s).toContain("mkfs.ext4");
        expect(s).toContain("/etc/fstab");
    });
    test("off/full emit no home section", () => {
        expect(guestSetupScript(spec(), { rdpPassword: "pw" })).not.toContain("virtio-cruiser-home");
        expect(guestSetupScript(spec((x) => { x.disk.encrypt = "full"; }), { rdpPassword: "pw" }))
            .not.toContain("virtio-cruiser-home");
    });
});
