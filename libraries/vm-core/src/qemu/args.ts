// ============================================================================
// args.ts — VmSpec → QEMU argv builder.
//
// Faithful port of ~/devvm/devvm qemu_base()/fs_args()/cmd_install():
// q35 + kvm + memfd, OVMF pflash, virtio disk, virtio-gpu variant per gpu.mode,
// SPICE unix console (emergency viewer path), virtio-serial QGA channel,
// QMP monitor socket, user-net hostfwd, optional vhost-vsock, virtiofs/9p
// shares, qemu-xhci + at-boot usb-host devices, autoinstall extras.
// ============================================================================

import type { VmSpec } from "../config/schema";
import type { VmPaths } from "../paths";

export const OVMF_CODE = "/usr/share/OVMF/OVMF_CODE_4M.fd";
export const OVMF_VARS_TEMPLATE = "/usr/share/OVMF/OVMF_VARS_4M.fd";

export interface GuestMonitor { name: string; xres: number; yres: number }

export interface BuildOpts {
    mode?: "run" | "install";
    /** Guest virtual monitors for the gpu outputs[] (host layout mirror). */
    guestMonitors?: GuestMonitor[];
    /** virtiofsd socket per share when virtiofsd is available; else 9p. */
    virtiofs?: boolean;
    /** iso omitted → seed-only boot (cloudimg first-boot provisioning). */
    install?: { iso?: string; seedIso: string; kernel?: string; initrd?: string; serialLog?: string };
    extraArgs?: string[];
}

export interface BuiltArgs {
    argv: string[];
    /** env vars needed to run the resolved binary (LD_LIBRARY_PATH). */
    env: Record<string, string>;
    /** virtiofsd instances the lifecycle must spawn (socket per share). */
    virtiofsd: { socket: string; sharedDir: string; tag: string }[];
}

/** Deterministic vsock guest CID per VM name (>= 1024 avoids reserved cids). */
export function guestCid(name: string): number {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return 1024 + (Math.abs(h) % 60000);
}

export function buildArgs(
    spec: VmSpec,
    paths: VmPaths,
    opts: BuildOpts,
    env: { ldLibraryPath: string },
): BuiltArgs {
    const a: string[] = [];
    const push = (...v: (string | number)[]) => a.push(...v.map(String));
    const virtiofsd: BuiltArgs["virtiofsd"] = [];

    const memBytes = spec.resources.memoryMiB * 1024 * 1024;
    const cpus = spec.resources.cpus;
    const disk = spec.disk.file.startsWith("/") ? spec.disk.file : `${paths.dir}/${spec.disk.file}`;

    push("-name", spec.name);
    push("-machine", "q35,kernel_irqchip=on,memory-backend=mem0");
    push("-object", `memory-backend-memfd,share=on,id=mem0,size=${memBytes}`);
    push("-accel", "kvm");
    push("-cpu", "host");
    push("-smp", `${cpus},sockets=${spec.resources.sockets},cores=${cpus},threads=${spec.resources.threads}`);
    push("-drive", `if=pflash,format=raw,unit=0,readonly=on,file=${OVMF_CODE}`);
    push("-drive", `if=pflash,format=raw,unit=1,file=${paths.ovmfVars}`);
    push("-drive", `file=${disk},if=virtio,format=qcow2,discard=unmap`);

    // ── GPU ──
    const outs = opts.guestMonitors ?? [{ name: "cruiser-1", xres: 1920, yres: 1080 }];
    const maxOut = Math.max(1, outs.length);
    const primary = outs[0];
    if (spec.gpu.mode === "venus") {
        push("-device", JSON.stringify({
            driver: "virtio-vga-gl", id: "gpu0",
            venus: true, blob: true,
            hostmem: spec.gpu.hostmemMiB * 1024 * 1024,
            max_outputs: maxOut, xres: primary.xres, yres: primary.yres,
            outputs: outs,
        }));
    } else if (spec.gpu.mode === "virgl") {
        push("-device", JSON.stringify({
            driver: "virtio-vga-gl", id: "gpu0",
            max_outputs: maxOut, xres: primary.xres, yres: primary.yres,
            outputs: outs,
        }));
    } else {
        push("-device", JSON.stringify({
            driver: "virtio-vga", id: "gpu0",
            max_outputs: maxOut, xres: primary.xres, yres: primary.yres,
        }));
    }

    // SPICE unix console — emergency/alternate viewer + audiodev backend.
    // gl=on only makes sense with virgl/venus; rendernode must be a mesa node
    // (NVIDIA EGL dmabuf export is broken — see devvm README).
    const spiceParts = [`unix=on`, `addr=${paths.spiceSock}`, `disable-ticketing=on`];
    if (spec.gpu.mode !== "software") {
        spiceParts.push("gl=on");
        if (spec.gpu.renderNode) spiceParts.push(`rendernode=${spec.gpu.renderNode}`);
    }
    push("-spice", spiceParts.join(","));
    push("-device", "intel-hda", "-device", "hda-duplex,audiodev=aud0", "-audiodev", "spice,id=aud0");

    // ── network ──
    const fwd = spec.network.hostfwd
        .map((f) => `hostfwd=${f.proto}:127.0.0.1:${f.hostPort}-:${f.guestPort}`);
    push("-netdev", `user,id=n0${fwd.length ? "," + fwd.join(",") : ""}`);
    push("-device", "virtio-net-pci,netdev=n0");

    push("-device", "virtio-keyboard-pci", "-device", "virtio-tablet-pci");
    push("-object", "rng-random,filename=/dev/urandom,id=rng0", "-device", "virtio-rng-pci,rng=rng0");

    // vsock for waypipe app-mode (and general host↔guest channels)
    if (spec.network.vsock) push("-device", `vhost-vsock-pci,guest-cid=${guestCid(spec.name)}`);

    // ── QGA + monitor ──
    push("-device", "virtio-serial-pci,id=ser0");
    push("-chardev", `socket,path=${paths.qgaSock},server=on,wait=off,id=qga`);
    push("-device", "virtserialport,chardev=qga,name=org.qemu.guest_agent.0");
    // QMP monitor directly on a unix socket (the "-mon chardev=" form is deprecated in QEMU 11).
    push("-qmp", `unix:path=${paths.monitorSock},server=on,wait=off`);

    // ── USB: xhci controller + at-boot passthrough ──
    push("-device", "qemu-xhci,id=xhci");
    spec.usb.autoAttach.filter((u) => u.atBoot).forEach((d) => {
        push("-device", `usb-host,bus=xhci.0,vendorid=0x${d.vendorId},productid=0x${d.productId}`);
    });

    // ── host shares ──
    spec.shares.forEach((s, i) => {
        if (opts.virtiofs) {
            const sock = `${paths.vfsSock}.${i}`;
            virtiofsd.push({ socket: sock, sharedDir: s.hostPath, tag: s.tag });
            push("-chardev", `socket,id=vfs${i},path=${sock}`);
            push("-device", `vhost-user-fs-pci,queue-size=1024,chardev=vfs${i},tag=${s.tag}`);
        } else {
            push("-fsdev", `local,id=fs${i},path=${s.hostPath},security_model=none${s.readOnly ? ",readonly=on" : ""}`);
            push("-device", `virtio-9p-pci,fsdev=fs${i},mount_tag=${s.tag}`);
        }
    });

    // ── install-mode extras (autoinstall ISO path) ──
    if (opts.mode === "install" && opts.install) {
        const ins = opts.install;
        push("-device", "virtio-scsi-pci,id=scsi0");
        if (ins.iso) {
            push("-drive", `file=${ins.iso},media=cdrom,if=none,id=cd0,readonly=on`);
            push("-device", "scsi-cd,drive=cd0");
        }
        push("-drive", `file=${ins.seedIso},media=cdrom,if=none,id=cd1,readonly=on`);
        push("-device", "scsi-cd,drive=cd1");
        if (ins.kernel && ins.initrd) {
            push("-kernel", ins.kernel, "-initrd", ins.initrd);
            push("-append", "boot=casper autoinstall ds=nocloud console=ttyS0,115200n8 ---");
            push("-serial", `file:${ins.serialLog ?? paths.serialLog}`);
        }
    }

    if (spec.persist === "daemonize") push("-daemonize");
    push("-pidfile", paths.pidFile, "-D", paths.log);
    if (opts.extraArgs) a.push(...opts.extraArgs);

    return { argv: a, env: { LD_LIBRARY_PATH: env.ldLibraryPath }, virtiofsd };
}
