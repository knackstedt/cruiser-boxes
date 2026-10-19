// ============================================================================
// args.ts — VmSpec → QEMU argv builder.
//
// Faithful port of ~/devvm/devvm qemu_base()/fs_args()/cmd_install():
// q35 + kvm + memfd, OVMF pflash, virtio disk, virtio-gpu variant per gpu.mode,
// SPICE unix console (emergency viewer path), virtio-serial QGA channel,
// QMP monitor socket, user-net hostfwd, optional vhost-vsock, virtiofs/9p
// shares, qemu-xhci + at-boot usb-host devices, autoinstall extras.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VmSpec } from "../config/schema";
import { DISK_SECRET_ID } from "../disk/ops";
import { diskPath, diskKeyPath, homeDiskPath, optDir, type VmPaths } from "../paths";

const SYS_OVMF_CODE = "/usr/share/OVMF/OVMF_CODE_4M.fd";
const SYS_OVMF_VARS_TEMPLATE = "/usr/share/OVMF/OVMF_VARS_4M.fd";

/** UEFI firmware resolution: distro ovmf package first, then the toolchain's
 *  bundled edk2 images (packaged builds carry them — see stage-opt.mts).
 *  QEMU's firmware descriptors pair the x86_64 code fd with the i386 vars
 *  template (share/qemu/firmware/60-edk2-x86_64.json). */
const SYS_OVMF_CODE_SEC = "/usr/share/OVMF/OVMF_CODE_4M.secboot.fd";
const SYS_OVMF_VARS_MS = "/usr/share/OVMF/OVMF_VARS_4M.ms.fd";

export function ovmfCode(secureBoot?: boolean): string {
    if (secureBoot && existsSync(SYS_OVMF_CODE_SEC)) return SYS_OVMF_CODE_SEC;
    if (secureBoot) return join(optDir(), "qemu-11", "share", "qemu", "edk2-x86_64-secure-code.fd");
    if (existsSync(SYS_OVMF_CODE)) return SYS_OVMF_CODE;
    return join(optDir(), "qemu-11", "share", "qemu", "edk2-x86_64-code.fd");
}
export function ovmfVarsTemplate(secureBoot?: boolean): string {
    // the ms template ships Microsoft's KEK/db certs — enrolled secure boot
    // out of the box; the plain i386 vars leaves the TPM-less setup mode.
    if (secureBoot && existsSync(SYS_OVMF_VARS_MS)) return SYS_OVMF_VARS_MS;
    if (existsSync(SYS_OVMF_VARS_TEMPLATE)) return SYS_OVMF_VARS_TEMPLATE;
    return join(optDir(), "qemu-11", "share", "qemu", "edk2-i386-vars.fd");
}

export interface GuestMonitor { name: string; xres: number; yres: number }

export interface BuildOpts {
    mode?: "run" | "install";
    /** Guest virtual monitors for the gpu outputs[] (host layout mirror). */
    guestMonitors?: GuestMonitor[];
    /** virtiofsd socket per share when virtiofsd is available; else 9p. */
    virtiofs?: boolean;
    /** iso omitted → seed-only boot (cloudimg first-boot provisioning). */
    install?: { iso?: string; seedIso: string; kernel?: string; initrd?: string; serialLog?: string };
    /** display.viewer=dmabuf: rendernode QEMU exports scanouts from — must be
     *  the host display GPU (resolved by the lifecycle, auto-detected). */
    dbusRenderNode?: string;
    /** Resolved by the lifecycle: display.clipboard AND the qemu binary has
     *  the qemu-vdagent chardev backend (CONFIG_SPICE_PROTOCOL). */
    vdagent?: boolean;
    /** dmabuf-viewer audiodev backend — the lifecycle picks a real host
     *  backend (pipewire/pa) when one's running so guest audio actually
     *  plays; falls back to dbus (silent until viewer-dd implements the
     *  org.qemu.Display1 audio interfaces). */
    audioBackend?: "pipewire" | "pa" | "alsa" | "dbus";
    /** false forces a foreground QEMU even for persist=daemonize specs —
     *  the ISO install runs an owned child it waits on itself. */
    daemonize?: boolean;
    extraArgs?: string[];
}

export interface BuiltArgs {
    argv: string[];
    /** env vars needed to run the resolved binary (LD_LIBRARY_PATH). */
    env: Record<string, string>;
    /** virtiofsd instances the lifecycle must spawn (socket per share). */
    virtiofsd: { socket: string; sharedDir: string; tag: string }[];
}

/**
 * The nested-virt CPUID bit for this host: "vmx" (Intel) / "svm" (AMD),
 * null when the CPU advertises neither. QEMU strips virt flags from
 * -cpu host, so resources.nestedVirt needs an explicit +vmx/+svm; the
 * guest still won't see it unless the kvm module's nested param is on
 * (doctor reports that).
 */
export function hostVirtFlag(): "vmx" | "svm" | null {
    try {
        const info = readFileSync("/proc/cpuinfo", "utf8");
        if (/\bvmx\b/.test(info)) return "vmx";
        if (/\bsvm\b/.test(info)) return "svm";
    } catch { /* unreadable cpuinfo — KVM can't be in play anyway */ }
    return null;
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
    const disk = diskPath(spec, paths.dir);

    push("-name", spec.name);
    const sb = spec.security.secureBoot;
    push("-machine", `q35,kernel_irqchip=on,memory-backend=mem0${sb ? ",smm=on" : ""}`);
    push("-object", `memory-backend-memfd,share=on,id=mem0,size=${memBytes}`);
    push("-accel", "kvm");
    const nestedFlag = spec.resources.nestedVirt ? hostVirtFlag() : null;
    push("-cpu", `host${nestedFlag ? `,+${nestedFlag}` : ""}`);
    push("-smp", `${cpus},sockets=${spec.resources.sockets},cores=${cpus},threads=${spec.resources.threads}`);
    push("-drive", `if=pflash,format=raw,unit=0,readonly=on,file=${ovmfCode(sb)}`);
    push("-drive", `if=pflash,format=raw,unit=1,file=${paths.ovmfVars}`);
    // secboot firmware requires the pflash-secure property or OVMF writes
    // vars updates through the unprotected interface.
    if (sb) push("-global", "driver=cfi.pflash01,property=secure,value=on");

    // LUKS (spec.disk.encrypt): the passphrase reaches QEMU as a `-object
    // secret` file reference — never inline on argv. "full" keys the
    // system drive itself; "home" leaves it plaintext and attaches the
    // second encrypted image as a virtio-blk disk (serial → a stable
    // /dev/disk/by-id/virtio-cruiser-home the guest setup mounts at /home).
    const enc = spec.disk.encrypt;
    if (enc !== "off") {
        const keyFile = diskKeyPath(spec, paths);
        // argv carries the path even when the file is absent — start()
        // enforces existence beforehand, and `vm args` should still show
        // the real command line for a locked VM.
        if (keyFile) push("-object", `secret,id=${DISK_SECRET_ID},file=${keyFile}`);
        if (enc === "full" && spec.disk.format !== "qcow2")
            throw new Error(`disk.encrypt=full requires disk.format=qcow2 (got ${spec.disk.format})`);
    }
    push("-drive", `file=${disk},if=virtio,format=${spec.disk.format},discard=unmap` +
        (enc === "full" ? `,encrypt.key-secret=${DISK_SECRET_ID}` : ""));
    if (enc === "home") {
        push("-drive", `if=none,id=home0,file=${homeDiskPath(spec, paths.dir)},format=qcow2,discard=unmap,encrypt.key-secret=${DISK_SECRET_ID}`);
        push("-device", "virtio-blk-pci,drive=home0,serial=cruiser-home");
    }

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
        const dd = spec.display.viewer === "dmabuf";
        push("-device", JSON.stringify({
            driver: "virtio-vga-gl", id: "gpu0",
            max_outputs: maxOut, xres: primary.xres, yres: primary.yres,
            outputs: outs,
            // dmabuf viewer needs host-resident scanouts — blob keeps the
            // guest's buffers on the virgl rendernode (no per-flip transfer).
            ...(dd ? { blob: true, hostmem: spec.gpu.hostmemMiB * 1024 * 1024 } : {}),
        }));
    } else {
        push("-device", JSON.stringify({
            driver: "virtio-vga", id: "gpu0",
            max_outputs: maxOut, xres: primary.xres, yres: primary.yres,
        }));
    }

    // dmabuf viewer: QEMU D-Bus display backend (org.qemu.Display1, p2p).
    // viewer-dd connects over the QMP monitor socket (getfd + add_client)
    // and presents exported scanouts zero-copy. The rendernode is the virgl
    // export device — it must be the HOST DISPLAY GPU's node or the viewer's
    // EGL can't import the buffers (auto-detected by the lifecycle).
    if (spec.display.viewer === "dmabuf") {
        const node = opts.dbusRenderNode ?? spec.gpu.renderNode;
        push("-display", `dbus,p2p=on,gl=on${node ? `,rendernode=${node}` : ""}`);
    }

    if (spec.display.viewer === "dmabuf") {
        // SPICE can't attach to a GL-context console at all ("Display spice
        // is incompatible with the GL context") — drop it entirely. Audio
        // flows over the dbus display backend instead; the viewer side can
        // consume it when it implements the audio interfaces (silence until
        // then — same as no client attached).
        // hda-duplex gives the guest a mic input too; sound without
        // microphone is playback-only via hda-output.
        if (spec.display.sound) {
            const dev = spec.display.microphone ? "hda-duplex" : "hda-output";
            push("-device", "intel-hda", "-device", `${dev},audiodev=aud0`,
                "-audiodev", `${opts.audioBackend ?? "dbus"},id=aud0`);
        }
    } else {
        // SPICE unix console — emergency/alternate viewer + audiodev backend.
        // gl=on only makes sense with virgl/venus; rendernode must be a mesa
        // node (NVIDIA EGL dmabuf export is broken — see devvm README).
        const spiceParts = [`unix=on`, `addr=${paths.spiceSock}`, `disable-ticketing=on`];
        if (spec.gpu.mode !== "software") {
            spiceParts.push("gl=on");
            if (spec.gpu.renderNode) spiceParts.push(`rendernode=${spec.gpu.renderNode}`);
        }
        push("-spice", spiceParts.join(","));
        if (spec.display.sound)
            push("-device", "intel-hda", "-device", "hda-duplex,audiodev=aud0", "-audiodev", "spice,id=aud0");
    }

    // ── network ──
    // nat: slirp outbound + hostfwd. restricted: slirp restrict=on — the
    // guest can only reach the host-side addresses (hostfwd still maps
    // in); the AI-sandbox mode. isolated: no netdev at all — QGA, serial
    // and vsock still work, ssh/app-mode don't. vmnet: n0 nat PLUS a
    // second virtio NIC on a multicast socket — every vmnet-mode VM on
    // this host shares the L2 (no DHCP: link-local or static IPs).
    const netMode = spec.network.mode;
    if (netMode !== "isolated") {
        const fwd = spec.network.hostfwd
            .map((f) => `hostfwd=${f.proto}:127.0.0.1:${f.hostPort}-:${f.guestPort}`);
        push("-netdev", `user,id=n0${netMode === "restricted" ? ",restrict=on" : ""}${fwd.length ? "," + fwd.join(",") : ""}`);
        push("-device", "virtio-net-pci,netdev=n0");
        if (netMode === "vmnet") {
            push("-netdev", "socket,id=n1,mcast=230.0.0.1:1234");
            push("-device", "virtio-net-pci,netdev=n1");
        }
    }

    push("-device", "virtio-keyboard-pci", "-device", "virtio-tablet-pci");
    push("-object", "rng-random,filename=/dev/urandom,id=rng0", "-device", "virtio-rng-pci,rng=rng0");
    // virtio-balloon — live guest-visible memory resize (`vm mem`, QMP
    // balloon) + query-balloon gives real in-guest free mem for metrics.
    push("-device", "virtio-balloon-pci,id=balloon0");

    // swtpm (TPM 2.0) on a run/ unix socket — the lifecycle spawns the
    // emulator before QEMU opens it (like the virtiofsd pattern).
    if (spec.security.tpm) {
        push("-chardev", `socket,id=tpm0,path=${paths.tpmSock}`);
        push("-tpmdev", "emulator,id=tpm0,chardev=tpm0");
        push("-device", "tpm-tis,tpmdev=tpm0");
    }

    // vsock for waypipe app-mode (and general host↔guest channels)
    if (spec.network.vsock) push("-device", `vhost-vsock-pci,guest-cid=${guestCid(spec.name)}`);

    // ── QGA + monitor ──
    push("-device", "virtio-serial-pci,id=ser0");
    push("-chardev", `socket,path=${paths.qgaSock},server=on,wait=off,id=qga`);
    push("-device", "virtserialport,chardev=qga,name=org.qemu.guest_agent.0");
    // dmabuf clipboard: the vdagent chardev bridges the guest's spice-vdagent
    // (com.redhat.spice.0) to QEMU's clipboard core, which -display dbus
    // exposes to viewer-dd as org.qemu.Display1.Clipboard (text only).
    // The RDP path uses freerdp +clipboard instead.
    if (spec.display.viewer === "dmabuf" && spec.display.clipboard && opts.vdagent) {
        push("-chardev", "qemu-vdagent,id=vda,clipboard=on,mouse=off");
        push("-device", "virtserialport,chardev=vda,name=com.redhat.spice.0");
    }
    // guest → host URL channel: the guest's xdg-open shim writes URLs into
    // org.cruiser.urlopen.0; a host listener socat'd onto urlopen.sock runs
    // real xdg-open on http(s) targets only.
    if (spec.display.urlOpen) {
        push("-chardev", `socket,id=urlop,path=${paths.urlOpenSock},server=on,wait=off`);
        push("-device", `virtserialport,chardev=urlop,name=org.cruiser.urlopen.0`);
    }
    // QMP monitor directly on a unix socket (the "-mon chardev=" form is deprecated in QEMU 11).
    push("-qmp", `unix:path=${paths.monitorSock},server=on,wait=off`);

    // ── USB: xhci controller + at-boot passthrough ──
    push("-device", "qemu-xhci,id=xhci");
    spec.usb.autoAttach.filter((u) => u.atBoot).forEach((d) => {
        push("-device", `usb-host,bus=xhci.0,vendorid=0x${d.vendorId},productid=0x${d.productId}`);
    });

    // ── host shares ──
    // Mount-mode shares only — copy-mode entries are synced by FileSyncs
    // over ssh and get no fsdev.
    spec.shares.filter((s) => s.enabled !== false && s.mode !== "copy").forEach((s, i) => {
        if (opts.virtiofs) {
            const sock = `${paths.vfsSock}.${i}`;
            virtiofsd.push({ socket: sock, sharedDir: s.hostPath, tag: s.tag });
            // NOTE: no reconnect-ms — QEMU 11's reconnecting chardev does an
            // eager connect at parse time that exhausts virtiofsd's
            // single-shot listener before the device's real handshake
            // ("Failed to set msg fds" at init). A dead daemon still needs
            // a VM restart to re-pair; detached spawn + the lifecycle
            // watchdog keep it from dying in the first place.
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
        }
    }

    // serial console to file on every boot — the Logs screen tails it.
    // autoinstall boots (kernel+initrd) keep their dedicated log path.
    const serialLog = opts.mode === "install" && opts.install?.kernel && opts.install?.initrd
        ? (opts.install.serialLog ?? paths.serialLog)
        : paths.serialLog;
    push("-serial", `file:${serialLog}`);

    // Second serial port (guest ttyS1) on a host unix socket — `vm serial`
    // bridges it to stdio for an interactive console when ssh/QGA are dead.
    // guest-setup enables serial-getty@ttyS1 so it presents a login.
    push("-chardev", `socket,id=sercon,path=${paths.serialSock},server=on,wait=off`);
    push("-serial", "chardev:sercon");

    if (spec.persist === "daemonize" && opts.daemonize !== false) push("-daemonize");
    push("-pidfile", paths.pidFile, "-D", paths.log);
    if (opts.extraArgs) a.push(...opts.extraArgs);

    const outEnv: Record<string, string> = { LD_LIBRARY_PATH: env.ldLibraryPath };
    if (spec.gpu.mode === "venus" && !spec.gpu.softwareVk) {
        // Venus exposes every host VkPhysicalDevice to the guest — including
        // lavapipe. A guest app that asks wgpu for the software/fallback
        // adapter (DOWNDRAFT_GPU=swiftshader, test harnesses) then rasterizes
        // on host CPU inside virgl_render_server (~2 cores of sustained burn)
        // and starves real work. Hide the lvp driver from enumeration; a true
        // software fallback still exists via the guest's own lavapipe ICD.
        // Ignored silently by Vulkan loaders older than 1.3.234.
        outEnv.VK_LOADER_DRIVERS_DISABLE = "*lvp*";
    }
    return { argv: a, env: outEnv, virtiofsd };
}
