#!/usr/bin/env bun
// ============================================================================
// cli.ts — headless control surface for cruiser.
//
//   bun run src/cli.ts vm list
//   bun run src/cli.ts vm create <name> [--cpus N --mem MiB --gpu venus|virgl|software
//                                        --disk GiB --head-mode M --share PATH]
//   bun run src/cli.ts vm start|stop|kill|status|args|logs <name>
//   bun run src/cli.ts vm snapshot <name> <snap> | restore <name> <snap> |
//                      snapshots <name> | backup <name> <dest> | resize <name> <GiB>
//   bun run src/cli.ts usb ls | attach <vm> <vid:pid> | detach <vm> <id>
//   bun run src/cli.ts toolchain check|build|adopt-src
//   bun run src/cli.ts doctor
//
// The UI drives the same libraries; escape shortcuts and .desktop files also
// invoke this CLI.
// ============================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VmRegistry, VmSpec, VmHandle, HeadMode, defaultSpec, type ShareSpec } from "../libraries/vm-core/src/index";
import { makeShare } from "../libraries/vm-core/src/config/shares";
import type { ViewerSession } from "../libraries/host-int/src/session";
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
                   [--snap] [--xfonts] [--no-autologin] [--devtools toolchain,python,rust,…]
                   [--nested]                          expose vmx/svm to the guest (VMs in the VM —
                                                        needs the host kvm module's nested=1, see doctor)
                   [--sync a,b,c] [--no-sync x,y]     host→guest sync channels (see vm sync)
                   [--viewer rdp|dmabuf]              dmabuf = direct QEMU dma-buf display (virgl+)
                   [--wallpaper PATH] [--wallpaper-pos POS]
                   [--share PATH[:tag]]                mount a host dir rw in the guest
                   [--share-ro PATH[:tag]]             …read-only (host→guest only)
                   [--copy PATH[:guestdir]]            rsync-copy a file/dir, bidirectional
                   [--copy-h2g PATH[:guestdir]]        …host→guest only
  vm import <file|gist-url|id> [--name x] [--description "…"]   create from a *.cruiser doc
  vm export <name> [--format yaml|toml|json] [--out path]       write the portable config
  vm gist push <name> [--gist <id>|--new] [--public] [--format yaml] [--description "…"]
  vm config pull <name>            re-import the spec from its origin (gist/file)
  vm describe <name> [text]        show/set the description exported with configs
  vm share ls <name>               vm share add <name> <hostPath> [--guest PATH]
                                   [--tag t] [--direction both|host-to-guest]
                                   [--mode mount|copy] [--delete] [--disabled]
  vm share rm <name> <tag|hostPath>
  vm filesync <name> [--watch]     run copy-mode shares now (--watch keeps syncing live)
  vm start <name> [--mode <headmode>] [--no-view]         (auto-opens the viewer like the UI)
  vm stop <name>                        vm kill <name>
  vm status <name>                      vm args <name>   (print QEMU argv)
  vm snapshots <name>                   vm snapshot <name> <snapname>
  vm restore <name> <snapname>          vm snapshot-rm <name> <snapname>
  vm backup <name> <dest.qcow2>         vm resize <name> <newGiB>
  vm rm <name> [--disk]                vm view <name>   launch freerdp viewer + place window
  vm ssh <name> [cmd...]               interactive guest shell (or run cmd) over the cruiser key
  vm term <name>                       open the guest shell in a host terminal emulator window
  vm wallpaper <name> [--source PATH|--no-source] [--position POS] [--managed|--no-managed]
                                      [--apply]         guest wallpaper + watermark (POS: top-left|top-right|
                                                        bottom-left|bottom-right|center|off)
  vm sync <name>                      list host→guest sync channels (on/off per vm.json)
  vm sync <name> <channel> on|off     toggle a channel (--apply pushes it now if running)
                                      channels: theme accentColor contrast timezone locale
                                      keyboard monitors hostWallpaper shares | gitIdentity
                                      proxy caCerts sshAgent   (last four default off —
                                      they push host credentials/identity/trust into the guest)
  vm logs <name> [--file cruiser|qemu|serial|install-serial] [--lines N]
           [--journal] [--unit U] [--priority P] [--boot N] [--since X] [--grep PAT]
           [--units]                    guest journal via QGA (ssh fallback on confined agents)
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

/** Hold the process until the viewer exits so in-process cleanup (escape
 *  shortcut uninstallers) actually runs — exiting right after open() would
 *  orphan the kglobalshortcutsrc/gsettings edits. ctrl+c closes the viewer. */
async function holdViewer(s: ViewerSession): Promise<void> {
    const onSig = () => { void s.close(); };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    await s.exited();
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
}

async function needVm(name?: string): Promise<VmHandle> {
    if (!name) { console.error("missing vm name"); usage(); }
    const h = registry.get(name);
    if (!h) { console.error(`vm '${name}' not found (registered: ${registry.list().map((v) => v.spec.name).join(", ") || "none"})`); process.exit(1); }
    return h;
}

/** `vm config pull` / `vm gist pull` — refetch the spec from its origin and
 *  merge over the local spec (ports/provisioned/credentials preserved). */
async function configPull(h: VmHandle): Promise<void> {
    const P = await import("../libraries/vm-core/src/config/portable");
    let needsRestart: string[];
    try {
        ({ needsRestart } = await P.pullConfigFromOrigin(h));
    } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    }
    console.log(`pulled config for ${h.spec.name}` +
        (needsRestart.length ? ` — changed: ${needsRestart.join(", ")}` : " — nothing boot-relevant changed"));
    if (h.isRunning() && needsRestart.length)
        console.log("note: the VM is running — those sections apply at next boot");
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
            const viewer = flagVal("--viewer"); if (viewer) spec.display.viewer = viewer as VmSpec["display"]["viewer"];
            const persist = flagVal("--persist"); if (persist) spec.persist = persist as VmSpec["persist"];
            const distro = flagVal("--distro"); if (distro) spec.os.family = distro as VmSpec["os"]["family"];
            const desktop = flagVal("--desktop"); if (desktop) spec.os.desktop = desktop as VmSpec["os"]["desktop"];
            const browser = flagVal("--browser"); if (browser) spec.os.browser = browser as VmSpec["os"]["browser"];
            if (has("--nested")) spec.resources.nestedVirt = true;
            if (has("--snap")) spec.os.snap = true;
            if (has("--xfonts")) spec.os.extraFonts = true;
            if (has("--no-autologin")) spec.os.autologin = false;
            const devtools = flagVal("--devtools");
            if (devtools) spec.os.devtools = devtools.split(",").map((s) => s.trim()).filter(Boolean) as VmSpec["os"]["devtools"];
            const wp = flagVal("--wallpaper"); if (wp) spec.display.wallpaper.source = wp;
            const wpPos = flagVal("--wallpaper-pos"); if (wpPos) spec.display.wallpaper.position = wpPos as VmSpec["display"]["wallpaper"]["position"];
            const { SYNC_IDS } = await import("../libraries/provision/src/sync");
            const applySyncList = (list: string | undefined, on: boolean) => {
                for (const k of (list ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
                    if (!(SYNC_IDS as readonly string[]).includes(k))
                        { console.error(`unknown sync channel '${k}' — options: ${SYNC_IDS.join(", ")}`); process.exit(2); }
                    spec.sync[k as keyof typeof spec.sync] = on;
                }
            };
            applySyncList(flagVal("--sync"), true);
            applySyncList(flagVal("--no-sync"), false);
            for (let i = 0; i < argv.length; i++) {
                const a = argv[i];
                const push = (raw: string, mode: "mount" | "copy", direction: "both" | "host-to-guest") => {
                    const [p, second] = raw.split(":");
                    if (!p) { console.error(`empty path in '${raw}'`); process.exit(2); }
                    spec.shares.push(makeShare(spec, {
                        hostPath: p,
                        tag: mode === "mount" ? (second ?? "hostshare") : undefined,
                        mode, direction,
                        ...(mode === "copy" && second ? { guestPath: second } : {}),
                    }));
                };
                if (a === "--share") push(argv[++i] ?? "", "mount", "both");
                else if (a === "--share-ro") push(argv[++i] ?? "", "mount", "host-to-guest");
                else if (a === "--copy") push(argv[++i] ?? "", "copy", "both");
                else if (a === "--copy-h2g") push(argv[++i] ?? "", "copy", "host-to-guest");
            }
            // flag values were cast unchecked — re-parse so a bad --distro /
            // --cpus / --share tag fails here instead of poisoning vm.json.
            const checked = VmSpec.parse(spec);
            const h = await registry.create(checked);
            console.log(`created ${h.spec.name} @ ${h.paths.dir}`);
            console.log(`  ssh:${h.spec.network.sshPort} rdp:${h.spec.network.rdpPort} gpu:${h.spec.gpu.mode} head:${h.spec.display.headMode}`);
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
            const mode = flagVal("--mode");
            if (mode) {
                const m = HeadMode.safeParse(mode);
                if (!m.success) { console.error(`bad --mode '${mode}' — expected ${HeadMode.options.join("|")}`); process.exit(2); }
                h.spec.display.headMode = m.data;
            }
            const { hostMirroredGuestMonitors } = await import("../libraries/provision/src/monitors");
            await h.start({ guestMonitors: await hostMirroredGuestMonitors(h.spec) });
            console.log(`${h.spec.name} started (pid ${h.pid()})`);
            // Match the UI's Start button: poll for guest login, then launch the
            // viewer and place its window per headMode. headMode "app" has no
            // freerdp viewer (waypipe is explicit).
            if (!has("--no-view") && h.spec.display.headMode !== "app") {
                console.log(`waiting for ${h.spec.name} guest login (rdp :${h.spec.network.rdpPort ?? "–"})…`);
                try {
                    const { openVmSession } = await import("../libraries/provision/src/session");
                    const sess = await openVmSession(h, {
                        rdpWaitMs: 180_000,
                        log: (m) => console.log(`${h.spec.name}: ${m}`),
                    });
                    console.log("viewer opened — close the window or ctrl+c to end the session");
                    await holdViewer(sess.viewer);
                } catch (e) { console.error(`viewer: ${e instanceof Error ? e.message : e}`); }
            }
            break;
        }
        case "stop": { const h = await needVm(args[0]); const out = await h.stop(); console.log(out === "stopped" ? "stopped" : "still running — guest ignored shutdown; use kill"); break; }
        case "kill": { const h = await needVm(args[0]); await h.kill(); console.log("killed"); break; }
        case "status": { const h = await needVm(args[0]); console.log(await h.probe()); break; }
        case "args": {
            const h = await needVm(args[0]);
            const { hostMirroredGuestMonitors } = await import("../libraries/provision/src/monitors");
            const b = await h.buildArgv({ guestMonitors: await hostMirroredGuestMonitors(h.spec) });
            console.log(b.argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" \\\n  "));
            break;
        }
        case "snapshots": { const h = await needVm(args[0]); console.table(await h.snapshots()); break; }
        case "snapshot": { const h = await needVm(args[0]); await h.snapshot(args[1] ?? `snap-${Date.now()}`); console.log("snapshotted"); break; }
        case "restore": { const h = await needVm(args[0]); await h.restoreSnapshot(args[1]!); console.log("restored"); break; }
        case "snapshot-rm": { const h = await needVm(args[0]); await h.deleteSnapshot(args[1]!); console.log("deleted"); break; }
        case "backup": { const h = await needVm(args[0]); if (!args[1]) usage(); await h.backup(args[1]); console.log(`backed up -> ${args[1]}`); break; }
        case "resize": { const h = await needVm(args[0]); await h.resizeDisk(Number(args[1])); console.log(`resized to ${args[1]}G`); break; }
        case "rm": { await needVm(args[0]); await registry.remove(args[0]!, { deleteDisk: has("--disk") }); console.log("removed"); break; }
        case "logs": {
            const h = await needVm(args[0]);
            const logs = await import("../libraries/vm-core/src/logs");
            if (has("--units")) {
                const u = await logs.guestJournalUnits(h);
                u.units.forEach((x) => console.log(x));
                console.error(`— ${u.units.length} units via ${u.transport}`);
                break;
            }
            if (has("--journal")) {
                const r = await logs.guestJournal(h, {
                    lines: num("--lines"), unit: flagVal("--unit"), priority: flagVal("--priority"),
                    boot: num("--boot"), since: flagVal("--since"), grep: flagVal("--grep"),
                });
                process.stdout.write(r.text.endsWith("\n") ? r.text : `${r.text}\n`);
                console.error(`— via ${r.transport}`);
                break;
            }
            const files = logs.runnerLogFiles(h.paths);
            const want = flagVal("--file") ?? "cruiser";
            const f = files.find((x) => x.id === want || x.path === want);
            if (!f) { console.error(`unknown runner log '${want}' — options: ${files.map((x) => x.id).join(", ")}`); process.exit(1); }
            if (!f.exists) { console.error(`${f.name}: not created yet (${f.path})`); process.exit(1); }
            process.stdout.write(await logs.tailFile(f.path, num("--lines") ?? 300));
            break;
        }
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
        case "wallpaper": {
            const h = await needVm(args[0]);
            const w = h.spec.display.wallpaper;
            let changed = false;
            if (has("--source")) { w.source = flagVal("--source"); changed = true; }
            if (has("--no-source")) { w.source = undefined; changed = true; }
            const pos = flagVal("--position");
            if (pos) { w.position = pos as VmSpec["display"]["wallpaper"]["position"]; changed = true; }
            if (has("--managed")) { w.managed = true; changed = true; }
            if (has("--no-managed")) { w.managed = false; changed = true; }
            if (changed) {
                VmSpec.parse(h.spec); // bad --position dies here, before saveSpec
                await h.saveSpec();
            }
            if (has("--apply") || (changed && h.isRunning())) {
                const { ensureGuestWallpaper } = await import("../libraries/provision/src/wallpaper");
                if (!h.isRunning()) { console.error("vm isn't running — config saved, wallpaper applies at next session"); }
                else await ensureGuestWallpaper(h, (m) => console.log(m), { force: true });
            }
            console.log(`wallpaper: managed=${w.managed} position=${w.position} source=${w.source ?? "(generated default)"}`);
            break;
        }
        case "sync": {
            const h = await needVm(args[0]);
            const { SYNC_IDS, syncEnabled } = await import("../libraries/provision/src/sync");
            const chan = args[1];
            if (!chan) {
                SYNC_IDS.forEach((id) =>
                    console.log(`${id.padEnd(14)} ${h.spec.sync[id] ? "on " : "off"}${syncEnabled(h.spec, id) === h.spec.sync[id] ? "" : " (env-killed)"}`));
                break;
            }
            if (!(SYNC_IDS as readonly string[]).includes(chan)) {
                console.error(`unknown sync channel '${chan}' — options: ${SYNC_IDS.join(", ")}`); process.exit(2);
            }
            const v = args[2];
            if (v !== "on" && v !== "off") { console.error("expected: vm sync <name> <channel> on|off"); usage(); }
            h.spec.sync[chan as keyof typeof h.spec.sync] = v === "on";
            await h.saveSpec();
            console.log(`sync.${chan} = ${v}`);
            if (has("--apply")) {
                if (!h.isRunning()) { console.error("vm isn't running — applies at next session"); break; }
                if (chan === "sshAgent")
                    console.log("note: the agent forward is held by a viewer session — open `vm view` to activate it");
                const { SessionSyncs } = await import("../libraries/provision/src/sync");
                await new SessionSyncs(h, (m) => console.log(`${h.spec.name}: ${m}`)).applyOnce();
            }
            break;
        }
        case "import": {
            const ref = args[0];
            if (!ref) usage();
            const P = await import("../libraries/vm-core/src/config/portable");
            const { doc, origin } = await P.loadPortableRef(ref);
            const name = flagVal("--name") ?? doc.spec.name;
            if (registry.get(name)) {
                console.error(`a VM named '${name}' already exists — pass --name to pick another`);
                process.exit(1);
            }
            const spec = doc.spec;
            spec.name = name;
            spec.origin = origin;
            const desc = flagVal("--description");
            if (desc) spec.description = desc;
            else if (!spec.description && doc.description) spec.description = doc.description;
            const h = await registry.create(VmSpec.parse(spec));
            console.log(`imported '${h.spec.name}' from ${origin.url ?? origin.id} → ${h.paths.dir}`);
            console.log(`  ssh:${h.spec.network.sshPort} rdp:${h.spec.network.rdpPort} (freshly allocated)`);
            console.log(`  next: cruiser provision cloudimg ${h.spec.name}  (or drop a disk.qcow2 in)`);
            break;
        }
        case "export": {
            const h = await needVm(args[0]);
            const P = await import("../libraries/vm-core/src/config/portable");
            const fmt = flagVal("--format") ?? "yaml";
            if (!["yaml", "toml", "json"].includes(fmt)) { console.error(`bad --format '${fmt}'`); process.exit(2); }
            const doc = P.exportPortable(h.spec, flagVal("--description"));
            const out = flagVal("--out") ?? join(h.paths.dir, P.portableFilename(h.spec.name, fmt as "yaml" | "toml" | "json"));
            await writeFile(out, P.serializePortable(doc, fmt as "yaml" | "toml" | "json"));
            console.log(`exported ${h.spec.name} → ${out}`);
            break;
        }
        case "describe": {
            const h = await needVm(args[0]);
            const text = args.slice(1).join(" ");
            if (!args[1]) { console.log(h.spec.description || "(no description)"); break; }
            h.spec.description = text;
            await h.saveSpec();
            console.log("description updated");
            break;
        }
        case "gist": {
            const op = args[0];
            if (op === "pull") { await configPull(await needVm(args[1])); break; }
            if (op !== "push") usage();
            const h = await needVm(args[1]);
            const P = await import("../libraries/vm-core/src/config/portable");
            const G = await import("../libraries/sys/src/gist");
            const fmt = (flagVal("--format") ?? "yaml") as "yaml" | "toml" | "json";
            const desc = flagVal("--description") ?? h.spec.description ?? `cruiser vm '${h.spec.name}'`;
            const doc = P.exportPortable(h.spec, desc);
            const fname = P.portableFilename(h.spec.name, fmt);
            const existing = h.spec.origin?.kind === "gist" ? h.spec.origin.id : undefined;
            const id = has("--new") ? undefined
                : flagVal("--gist") ? G.gistIdFromRef(flagVal("--gist")!) : existing;
            const r = await G.pushGist({
                id, description: desc, isPublic: has("--public"),
                files: { [fname]: P.serializePortable(doc, fmt) },
            });
            h.spec.origin = { kind: "gist", id: r.id, url: r.url };
            if (!h.spec.description) h.spec.description = desc;
            await h.saveSpec();
            console.log(`pushed ${fname} → ${r.url}`);
            break;
        }
        case "config": {
            if (args[0] !== "pull") usage();
            await configPull(await needVm(args[1]));
            break;
        }
        case "share": {
            const op = args[0];
            const h = await needVm(args[1]);
            if (op === "ls" || op === undefined) {
                if (!h.spec.shares.length) console.log("(no shares — 'vm share add <name> <hostPath>')");
                h.spec.shares.forEach((s) => console.log(
                    `${s.tag.padEnd(14)} ${s.mode.padEnd(5)} ${s.direction === "host-to-guest" ? "h→g" : "h↔g"}${s.enabled ? " " : " (off)"}` +
                    `  ${s.hostPath} → ${s.guestPath ?? (s.mode === "copy" ? "~/cruiser-sync/<name>" : `/mnt/${s.tag}`)}${s.deletions ? "  --delete" : ""}`));
                break;
            }
            if (op === "add") {
                const hp = args[2];
                if (!hp) usage();
                const dir = flagVal("--direction") ?? (has("--ro") ? "host-to-guest" : "both");
                const mode = flagVal("--mode") ?? "mount";
                const next = JSON.parse(JSON.stringify(h.spec)) as VmSpec;
                next.shares.push(makeShare(next, {
                    hostPath: hp,
                    tag: flagVal("--tag"),
                    guestPath: flagVal("--guest"),
                    mode: mode as ShareSpec["mode"], direction: dir as ShareSpec["direction"],
                    enabled: !has("--disabled"), deletions: has("--delete"),
                }));
                h.spec = VmSpec.parse(next);
                await h.saveSpec();
                console.log(`share '${h.spec.shares[h.spec.shares.length - 1]!.tag}' added` +
                    (mode === "copy"
                        ? " — syncs while a viewer session is open (or 'vm filesync --once')"
                        : h.isRunning() ? " — fstab lands on the next session sync; device attaches at next boot" : ""));
                break;
            }
            if (op === "rm") {
                const k = args[2];
                if (!k) usage();
                const before = h.spec.shares.length;
                h.spec.shares = h.spec.shares.filter((s) => s.tag !== k && s.hostPath !== k);
                if (h.spec.shares.length === before) { console.error(`no share matching '${k}' (tag or hostPath)`); process.exit(1); }
                h.spec = VmSpec.parse(h.spec);
                await h.saveSpec();
                console.log("removed");
                break;
            }
            usage();
            break;
        }
        case "filesync": {
            const h = await needVm(args[0]);
            const { FileSyncs, copyEntries } = await import("../libraries/provision/src/filesync");
            if (!copyEntries(h.spec).length) {
                console.log("no copy-mode shares — add one with 'vm share add --mode copy'");
                break;
            }
            if (!h.isRunning()) { console.error(`'${h.spec.name}' is not running`); process.exit(1); }
            const fs = new FileSyncs(h, (m) => console.log(`${h.spec.name}: ${m}`));
            if (has("--watch")) {
                fs.start();
                console.log("watching — ctrl+c to stop");
                await new Promise<void>((res) => {
                    process.on("SIGINT", res);
                    process.on("SIGTERM", res);
                });
                fs.dispose();
            } else {
                await fs.applyOnce();
            }
            break;
        }
        case "view": {
            const h = await needVm(args[0]);
            if (!h.isRunning()) { console.error(`'${h.spec.name}' is not running`); process.exit(1); }
            const { openVmSession } = await import("../libraries/provision/src/session");
            const sess = await openVmSession(h, { log: (m) => console.log(`${h.spec.name}: ${m}`) });
            console.log(`adapter: ${sess.viewer.adapter.id}`);
            console.log("viewer launched — close the window or ctrl+c to end the session");
            await holdViewer(sess.viewer);
            break;
        }
        case "ssh": {
            const h = await needVm(args[0]);
            if (!h.isRunning()) { console.error(`'${h.spec.name}' is not running`); process.exit(1); }
            const { sshArgv, sshTarget } = await import("../libraries/vm-core/src/ssh");
            const a = await sshArgv(h.spec, { tty: true, remoteCmd: args.slice(1) });
            if (!args[1]) console.log(`${sshTarget(h.spec)} — interactive shell (ctrl+d / 'exit' to leave)`);
            const { spawnSync } = await import("node:child_process");
            const r = spawnSync("ssh", a, { stdio: "inherit" });
            process.exit(r.status ?? (r.signal ? 1 : 0));
        }
        case "term": {
            const h = await needVm(args[0]);
            if (!h.isRunning()) { console.error(`'${h.spec.name}' is not running`); process.exit(1); }
            const { openHostTerm } = await import("../libraries/host-int/src/termemu");
            try {
                await openHostTerm(h.spec);
            } catch (e) {
                console.error(`${e instanceof Error ? e.message : e} — 'vm ssh ${h.spec.name}' works in this terminal instead`);
                process.exit(1);
            }
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
    const groups = (await run("id", ["-nG"])).stdout.trim().split(/\s+/);
    checks.push(["in kvm group", groups.includes("kvm"), "usermod -aG kvm $USER (relogin)"]);
    const tools = ["xfreerdp3", "cloud-localds", "genisoimage", "wmctrl", "xdotool", "qdbus", "waypipe", "socat", "sshfs"];
    for (let i = 0; i < tools.length; i++) {
        const p = await which(tools[i]!) ?? (tools[i] === "qdbus" ? await which("qdbus6") : null);
        checks.push([`tool: ${tools[i]}`, !!p, "see toolchain/versions.json systemTools"]);
    }
    checks.push(["tool: rsync (copy-mode shares)", !!(await which("rsync")), "apt install rsync — needed for --copy shares"]);
    checks.push(["tool: gh (gist push)", !!(await which("gh")), "apt install gh + gh auth login, or set GITHUB_TOKEN — only needed for 'vm gist push'"]);
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
    // Nested virt only fails doctor when a VM actually asks for it — the
    // flag is opt-in per spec.
    const kvmMod = ["kvm_intel", "kvm_amd"].find((m) => existsSync(`/sys/module/${m}/parameters/nested`));
    const wantsNested = registry.list().some((h) => h.spec.resources.nestedVirt);
    if (kvmMod) {
        const v = (await readFile(`/sys/module/${kvmMod}/parameters/nested`, "utf8")).trim();
        const on = v === "Y" || v === "1" || v === "y" || v.toLowerCase() === "true";
        checks.push([`nested virtualization (${kvmMod} nested=${v})`, on || !wantsNested,
            `echo "options ${kvmMod} nested=1" | sudo tee /etc/modprobe.d/kvm-nested.conf, then reboot`]);
    } else {
        checks.push(["nested virtualization (no kvm_intel/kvm_amd)", !wantsNested,
            "enable VT-x/AMD-V in firmware and load the kvm module"]);
    }
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
