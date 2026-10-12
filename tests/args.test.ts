import { describe, expect, test } from "bun:test";
import { defaultSpec } from "../libraries/vm-core/src/config/schema";
import { buildArgs, guestCid } from "../libraries/vm-core/src/qemu/args";
import { vmPaths } from "../libraries/vm-core/src/paths";

const env = { ldLibraryPath: "/opt/lib" };

function build(mutate?: (s: ReturnType<typeof defaultSpec>) => void, opts = {}) {
    const spec = defaultSpec("t1");
    spec.network.sshPort = 2222;
    spec.network.rdpPort = 3390;
    spec.network.hostfwd = [
        { hostPort: 2222, guestPort: 22, proto: "tcp" },
        { hostPort: 3390, guestPort: 3389, proto: "tcp" },
    ];
    mutate?.(spec);
    return buildArgs(spec, vmPaths("t1"), opts, env).argv.join("\n");
}

describe("buildArgs", () => {
    test("base layout: q35, kvm, memfd, ovmf, disk, qmp+qga", () => {
        const a = build();
        expect(a).toContain("-machine\nq35,kernel_irqchip=on,memory-backend=mem0");
        expect(a).toContain("memory-backend-memfd,share=on,id=mem0,size=8589934592");
        expect(a).toContain("-accel\nkvm");
        expect(a).toContain("if=pflash,format=raw,unit=0");
        expect(a).toContain("disk.qcow2,if=virtio,format=qcow2");
        expect(a).toContain("-qmp\nunix:path=");
        expect(a).toContain("org.qemu.guest_agent.0");
        expect(a).toContain("hostfwd=tcp:127.0.0.1:2222-:22");
        expect(a).toContain("hostfwd=tcp:127.0.0.1:3390-:3389");
        expect(a).toContain("-daemonize");
    });

    test("venus gpu emits virtio-vga-gl with blob+hostmem+outputs", () => {
        const a = build(undefined, { guestMonitors: [{ name: "t1-1", xres: 3440, yres: 1440 }] });
        expect(a).toContain('"driver":"virtio-vga-gl"');
        expect(a).toContain('"venus":true');
        expect(a).toContain('"hostmem":4294967296');
        expect(a).toContain('"xres":3440');
        expect(a).toContain("gl=on");
    });

    test("software mode drops gl and blob", () => {
        const a = build((s) => { s.gpu.mode = "software"; });
        expect(a).toContain('"driver":"virtio-vga"');
        expect(a).not.toContain("gl=on");
        expect(a).not.toContain('"venus"');
    });

    test("rendernode lands on -spice when set", () => {
        const a = build((s) => { s.gpu.renderNode = "/dev/dri/renderD129"; });
        expect(a).toContain("rendernode=/dev/dri/renderD129");
    });

    test("vsock cid is deterministic + >=1024", () => {
        expect(guestCid("t1")).toBe(guestCid("t1"));
        expect(guestCid("t1")).toBeGreaterThanOrEqual(1024);
        const a = build();
        expect(a).toContain(`vhost-vsock-pci,guest-cid=${guestCid("t1")}`);
        const b = build((s) => { s.network.vsock = false; });
        expect(b).not.toContain("vhost-vsock");
    });

    test("at-boot usb devices emit usb-host; on-demand do not", () => {
        const a = build((s) => {
            s.usb.autoAttach.push({ vendorId: "046d", productId: "c52b", atBoot: true });
            s.usb.autoAttach.push({ vendorId: "aaaa", productId: "bbbb", atBoot: false });
        });
        expect(a).toContain("usb-host,bus=xhci.0,vendorid=0x046d,productid=0xc52b");
        expect(a).not.toContain("aaaa");
    });

    test("shares → 9p without virtiofsd, vhost-user-fs with", () => {
        const spec = (s: ReturnType<typeof defaultSpec>) => s.shares.push({ hostPath: "/home/u/dev", tag: "hostshare", readOnly: false });
        const a9 = build(spec, { virtiofs: false });
        expect(a9).toContain("virtio-9p-pci,fsdev=fs0,mount_tag=hostshare");
        const b = buildArgs(defaultSpec("t2"), vmPaths("t2"), { virtiofs: true }, env);
        const spec2 = defaultSpec("t3");
        spec2.shares.push({ hostPath: "/x", tag: "hostshare", readOnly: false });
        const vfs = buildArgs(spec2, vmPaths("t3"), { virtiofs: true }, env);
        expect(vfs.argv.join("\n")).toContain("vhost-user-fs-pci");
        expect(vfs.virtiofsd[0].sharedDir).toBe("/x");
        // copy-mode + disabled shares get no fsdev — they sync over rsync.
        const spec3 = defaultSpec("t4");
        spec3.shares.push(
            { hostPath: "/c", tag: "copied", readOnly: false, mode: "copy" } as never,
            { hostPath: "/d", tag: "off", readOnly: false, enabled: false } as never);
        const none = buildArgs(spec3, vmPaths("t4"), { virtiofs: false }, env);
        expect(none.argv.join("\n")).not.toContain("9p-pci");
        expect(none.virtiofsd).toEqual([]);
        void b;
    });

    test("install mode attaches iso+seed+kernel", () => {
        const a = build(undefined, {
            mode: "install",
            install: { iso: "/i.iso", seedIso: "/s.iso", kernel: "/k", initrd: "/i" },
        });
        expect(a).toContain("scsi-cd,drive=cd0");
        expect(a).toContain("scsi-cd,drive=cd1");
        expect(a).toContain("-kernel\n/k");
        expect(a).toContain("autoinstall ds=nocloud");
    });

    test("seed-only install mode (cloudimg first boot)", () => {
        const a = build(undefined, { mode: "install", install: { seedIso: "/s.iso" } });
        expect(a).toContain("cd1");
        expect(a).not.toContain("cd0");
    });

    test("owned persist drops -daemonize", () => {
        const a = build((s) => { s.persist = "owned"; });
        expect(a).not.toContain("-daemonize");
    });
});
