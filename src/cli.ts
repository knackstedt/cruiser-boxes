#!/usr/bin/env bun
// ============================================================================
// cli.ts — headless control surface for cruiser.
//
//   bun run src/cli.ts vm list
//   bun run src/cli.ts vm create <name> [--cpus N --mem MiB --gpu venus|virgl|software
//                                        --disk GiB --head-mode M --share PATH]
//   bun run src/cli.ts vm start|stop|kill|status|args <name>
//   bun run src/cli.ts vm snapshot <name> <snap> | restore <name> <snap> |
//                      snapshots <name> | backup <name> <dest> | resize <name> <GiB>
//   bun run src/cli.ts usb ls | attach <vm> <vid:pid> | detach <vm> <id>
//   bun run src/cli.ts toolchain check|build|adopt-src
//   bun run src/cli.ts doctor
//
// The UI drives the same libraries; escape shortcuts and .desktop files also
// invoke this CLI.
// ============================================================================

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { VmRegistry, VmSpec, VmHandle, defaultSpec } from "../libraries/vm-core/src/index";
import { listUsbDevices } from "../libraries/vm-core/src/usb/usb";
import { createDisk } from "../libraries/vm-core/src/disk/ops";
import { resolveToolchain } from "../libraries/vm-core/src/qemu/resolve";
import { run, which, virtiofsdPath } from "../libraries/sys/src/exec";

const argv = process.argv.slice(2);

function usage(): never {
    console.log(`cruiser — QEMU/KVM VM manager for Linux guests

usage: cruiser <area> <command> [args]

  vm list
  vm create <name> [--cpus N] [--mem MiB] [--disk GiB] [--gpu venus|virgl|software]
                   [--head-mode fullscreen-monitor|windowed|virtual-desktop|app]
                   [--share PATH[:tag]] [--persist daemonize|owned]
                   [--distro ubuntu|debian|fedora] [--desktop gnome|kde]
                   [--browser none|firefox|chrome|chromium|vivaldi|brave]
                   [--snap] [--xfonts]
  vm start <name> [--mode <headmode>]   vm stop <name>    vm kill <name>
  vm status <name>                      vm args <name>   (print QEMU argv)
  vm snapshots <name>                   vm snapshot <name> <snapname>
  vm restore <name> <snapname>          vm snapshot-rm <name> <snapname>
  vm backup <name> <dest.qcow2>         vm resize <name> <newGiB>
  vm rm <name> [--disk]                vm view <name>   launch freerdp viewer + place window
  host session                         detected DE/session + adapter caps
  host monitors|desktops               probe host display topology
  usb ls                                usb attach <vm> <vid:pid>
  usb detach <vm> <id>
  vm mount <name> [guestPath] [mp]      sshfs-mount a guest dir on the host
  vm umount <name> [mp]                 unmount (default ~/.local/share/cruiser/mounts/<vm>)
  app list <vm>                         guest .desktop app catalog (via QGA)
  app run <vm> <command...>             launch a guest app via waypipe (vsock→ssh)
  provision cloudimg <vm> [release]   [--user u] [--password p]  (release defaults to the VM's distro default)
  provision iso <vm> <iso-or-url> [--user u] [--password p]
  provision guest-setup <vm>           re-run in-guest setup on a provisioned VM
  toolchain check|build|adopt-src [dir]
  doctor                                host dependency + permission report
`);
    process.exit(2);
}

const flagVal = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const num = (name: string) => { const v = flagVal(name); return v === undefined ? undefined : Number(v); };
const has = (name: string) => argv.includes(name);
const positionals = argv.filter((a) => !a.startsWith("--") && !prevIsFlag(a));
function prevIsFlag(a: string): boolean {
    const i = argv.indexOf(a);
    return i > 0 && argv[i - 1].startsWith("--");
}

const registry = new VmRegistry();
await registry.scan();

async function needVm(name?: string): Promise<VmHandle> {
    if (!name) { console.error("missing vm name"); usage(); }
    const h = registry.get(name);
    if (!h) { console.error(`vm '${name}' not found (registered: ${registry.list().map((v) => v.spec.name).join(", ") || "none"})`); process.exit(1); }
    return h;
}

async function vmCmd(cmd: string | undefined, args: string[]) {
    switch (cmd) {
        case "list": {
            const handles = registry.list();
            for (let i = 0; i < handles.length; i++) {
                const h = handles[i]!;
                const s = await h.probe();
                console.log(`${h.spec.name.padEnd(20)} ${s.padEnd(10)} ${h.spec.gpu.mode.padEnd(8)} ${h.spec.display.headMode.padEnd(20)} ssh:${h.spec.network.sshPort} rdp:${h.spec.network.rdpPort}`);
            }
            if (!registry.list().length) console.log("(no VMs — `cruiser vm create <name>`)");
            break;
        }
        case "create": {
            const name = args[0];
            if (!name) usage();
            const spec = defaultSpec(name);
            if (num("--cpus")) spec.resources.cpus = num("--cpus")!;
            if (num("--mem")) spec.resources.memoryMiB = num("--mem")!;
            if (num("--disk")) spec.disk.sizeGiB = num("--disk")!;
            const gpu = flagVal("--gpu"); if (gpu) spec.gpu.mode = gpu as VmSpec["gpu"]["mode"];
            const hm = flagVal("--head-mode"); if (hm) spec.display.headMode = hm as VmSpec["display"]["headMode"];
            const persist = flagVal("--persist"); if (persist) spec.persist = persist as VmSpec["persist"];
            const distro = flagVal("--distro"); if (distro) spec.os.family = distro as VmSpec["os"]["family"];
            const desktop = flagVal("--desktop"); if (desktop) spec.os.desktop = desktop as VmSpec["os"]["desktop"];
            const browser = flagVal("--browser"); if (browser) spec.os.browser = browser as VmSpec["os"]["browser"];
            if (has("--snap")) spec.os.snap = true;
            if (has("--xfonts")) spec.os.extraFonts = true;
            for (let i = 0; i < argv.length; i++) {
                if (argv[i] === "--share") {
                    const [p, tag] = (argv[i + 1] ?? "").split(":");
                    spec.shares.push({ hostPath: p, tag: tag ?? "hostshare", readOnly: false });
                }
            }
            const h = await registry.create(spec);
            console.log(`created ${spec.name} @ ${h.paths.dir}`);
            console.log(`  ssh:${spec.network.sshPort} rdp:${spec.network.rdpPort} gpu:${spec.gpu.mode} head:${spec.display.headMode}`);
            console.log(`  next: cruiser provision cloudimg ${spec.name} <release>  (or drop a disk.qcow2 in)`);
            break;
        }
        case "start": {
            const h = await needVm(args[0]);
            if (!existsSync(h.diskPath())) {
                await mkdir(h.paths.dir, { recursive: true });
                console.log(`creating disk ${h.diskPath()} (${h.spec.disk.sizeGiB}G sparse)`);
                await createDisk((await resolveToolchain()).qemuImg, h.diskPath(), h.spec.disk.sizeGiB);
            }
            await h.start();
            console.log(`${h.spec.name} started (pid ${h.pid()})`);
            break;
        }
        case "stop": { const h = await needVm(args[0]); const out = await h.stop(); console.log(out === "stopped" ? "stopped" : "still running — guest ignored shutdown; use kill"); break; }
        case "kill": { const h = await needVm(args[0]); await h.kill(); console.log("killed"); break; }
        case "status": { const h = await needVm(args[0]); console.log(await h.probe()); break; }
        case "args": { const h = await needVm(args[0]); const b = await h.buildArgv(); console.log(b.argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" \\\n  ")); break; }
        case "snapshots": { const h = await needVm(args[0]); console.table(await h.snapshots()); break; }
        case "snapshot": { const h = await needVm(args[0]); await h.snapshot(args[1] ?? `snap-${Date.now()}`); console.log("snapshotted"); break; }
        case "restore": { const h = await needVm(args[0]); await h.restoreSnapshot(args[1]!); console.log("restored"); break; }
        case "snapshot-rm": { const h = await needVm(args[0]); await h.deleteSnapshot(args[1]!); console.log("deleted"); break; }
        case "backup": { const h = await needVm(args[0]); if (!args[1]) usage(); await h.backup(args[1]); console.log(`backed up -> ${args[1]}`); break; }
        case "resize": { const h = await needVm(args[0]); await h.resizeDisk(Number(args[1])); console.log(`resized to ${args[1]}G`); break; }
        case "rm": { await registry.remove(args[0]!, { deleteDisk: has("--disk") }); console.log("removed"); break; }
        case "mount": {
            const h = await needVm(args[0]);
            const { mountGuest } = await import("../libraries/host-int/src/mount");
            const m = await mountGuest(h, args[1], args[2]);
            console.log(`mounted ${m.vm}:${m.guestPath} -> ${m.mountpoint}`);
            break;
        }
        case "umount": {
            if (!args[0]) usage();
            const { umountGuest } = await import("../libraries/host-int/src/mount");
            await umountGuest(args[0], args[1]);
            console.log("unmounted");
            break;
        }
        case "view": {
            const h = await needVm(args[0]);
            if (!h.isRunning()) { console.error(`'${h.spec.name}' is not running`); process.exit(1); }
            const { ViewerSession } = await import("../libraries/host-int/src/session");
            const s = new ViewerSession(h.spec);
            console.log(`adapter: ${s.adapter.id}`);
            await s.open();
            console.log("viewer launched");
            break;
        }
        default: usage();
    }
}

async function usbCmd(cmd: string | undefined, args: string[]) {
    switch (cmd) {
        case "ls": {
            const devs = await listUsbDevices();
            devs.forEach((d) => {
                console.log(`${d.vendorId}:${d.productId}  bus${d.bus}/dev${d.addr}  ${d.vendor ?? ""} ${d.product ?? ""}  ${d.writable ? "" : "(no rw perm)"}`);
            });
            break;
        }
        case "attach": {
            const h = await needVm(args[0]);
            const [vid, pid] = (args[1] ?? "").split(":");
            if (!vid || !pid) usage();
            const id = await h.usbAttach(vid, pid);
            console.log(`attached as ${id}`);
            break;
        }
        case "detach": {
            const h = await needVm(args[0]);
            await h.usbDetach(args[1]!);
            console.log("detached");
            break;
        }
        default: usage();
    }
}

async function doctor() {
    console.log("== cruiser doctor ==");
    const checks: [string, boolean, string][] = [];
    const k = await run("test", ["-w", "/dev/kvm"], { noThrow: true });
    checks.push(["/dev/kvm writable (kvm group)", k.code === 0, "usermod -aG kvm $USER"]);
    const groups = (await run("id", ["-nG"])).stdout;
    checks.push(["in kvm group", groups.split(" ").includes("kvm"), "usermod -aG kvm $USER (relogin)"]);
    const tools = ["xfreerdp3", "cloud-localds", "genisoimage", "wmctrl", "xdotool", "qdbus", "waypipe", "socat", "sshfs"];
    for (let i = 0; i < tools.length; i++) {
        const p = await which(tools[i]!);
        checks.push([`tool: ${tools[i]}`, !!p, "see toolchain/versions.json systemTools"]);
    }
    const vfsd = await virtiofsdPath();
    checks.push(["tool: virtiofsd", vfsd !== null, "apt install virtiofsd"]);
    const tc = await resolveToolchain().catch((e) => { checks.push(["qemu toolchain", false, String(e)]); return null; });
    if (tc) {
        const env = { LD_LIBRARY_PATH: tc.ldLibraryPath };
        const v = await run(tc.qemu, ["--version"], { noThrow: true, env });
        checks.push([`qemu: ${v.stdout.split("\n")[0] || v.stderr.slice(0, 120)}`, v.code === 0, "cruiser toolchain build"]);
        checks.push([`xfreerdp: ${tc.xfreerdp}`, true, ""]);
    }
    checks.push(["OVMF firmware", existsSync("/usr/share/OVMF/OVMF_CODE_4M.fd"), "apt install ovmf"]);
    // usb-host needs rw on /dev/bus/usb nodes — most distros ship root-only.
    const usbDevs = await listUsbDevices().catch(() => []);
    const blocked = usbDevs.filter((d) => !d.writable);
    checks.push([`usb passthrough (${blocked.length}/${usbDevs.length} devices lack rw)`, blocked.length === 0,
        'udev rule: SUBSYSTEM=="usb", GROUP="plugdev", MODE="0660" → /etc/udev/rules.d/99-cruiser-usb.rules']);
    checks.forEach(([label, ok, fix]) => {
        console.log(`${ok ? " ok " : "FAIL"}  ${label}${ok ? "" : `  → ${fix}`}`);
    });
    if (checks.some(([, ok]) => !ok)) process.exit(1);
}

const area = argv[0];
const sub = argv[1];
const rest = positionals.slice(2);

switch (area) {
    case "vm": await vmCmd(sub, rest); break;
    case "usb": await usbCmd(sub, rest); break;
    case "toolchain": {
        const { spawnSync } = await import("node:child_process");
        const repoRoot = new URL("..", import.meta.url).pathname;
        const r = spawnSync("bun", ["run", "toolchain/build.mts", ...argv.slice(1)], { stdio: "inherit", cwd: repoRoot });
        process.exit(r.status ?? 1);
    }
    case "doctor": await doctor(); break;
    case "provision": {
        const h = await needVm(rest[0]);
        const o = {
            username: flagVal("--user"), password: flagVal("--password"),
            timezone: flagVal("--timezone"), mirrorHostMonitors: !has("--no-monitor-mirror"),
            onLog: (m: string) => console.log(m),
        };
        const { provisionVmCloudimg, provisionVmIso, reprovisionGuest } = await import("../libraries/provision/src/provision");
        if (sub === "cloudimg") await provisionVmCloudimg(h, { ...o, release: rest[1] });
        else if (sub === "iso") { if (!rest[1]) usage(); await provisionVmIso(h, { ...o, iso: rest[1] }); }
        else if (sub === "guest-setup") await reprovisionGuest(h, o);
        else usage();
        break;
    }
    case "app": {
        const h = await needVm(rest[0]);
        const { guestAppCatalog, launchApp } = await import("../libraries/app-mode/src/waypipe");
        if (sub === "list") {
            (await guestAppCatalog(h)).forEach((a) => console.log(`${a.id.padEnd(45)} ${a.name.padEnd(30)} ${a.exec}`));
        } else if (sub === "run") {
            if (!rest[1]) usage();
            const l = await launchApp(h, rest.slice(1).join(" "));
            console.log(`launched via ${l.transport}: ${l.command}`);
        } else usage();
        break;
    }
    case "host": {
        const { detectAdapter, detectSession } = await import("../libraries/host-int/src/detect");
        const a = detectAdapter();
        switch (sub) {
            case "session": {
                console.log(`session: ${detectSession()}  adapter: ${a.id}`);
                console.log(`caps: ${JSON.stringify(a.caps)}`);
                break;
            }
            case "monitors": console.log(JSON.stringify(await a.monitors(), null, 2)); break;
            case "desktops": console.log(JSON.stringify(await a.desktops(), null, 2)); break;
            default: usage();
        }
        break;
    }
    default: usage();
}
// Open monitor/QGA sockets keep the event loop alive; daemonized QEMU is unaffected by exit.
process.exit(0);
