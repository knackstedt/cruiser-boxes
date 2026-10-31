// ============================================================================
// screens.ts — markup for each route. Plain HTML strings rasterized by the
// Blitz html-ui stack; interactivity via data-action + DOM input events.
// ============================================================================

import { existsSync } from "node:fs";
import { DISTROS, supportsKrdp } from "../../provision/src/distros";
import { DEVTOOLS } from "../../provision/src/packages";
import { VMS_DIR } from "../../vm-core/src/paths";
import { ansiToHtml } from "./ansi";
import { fontFaceCss } from "./fonts";
import type { CruiserState, UsbChoice, VmSummary } from "./store";

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
/* Buttons/labels/chips should never enter text-selection drags — a >2px
   move during a press would highlight a few characters and leave it stuck
   until the next click (in-input selection is the editor's own path and
   doesn't consult user-select). .logpre keeps real selection for log
   copying; body is auto so hits canonicalized to .logpre itself pass the
   parent check — html stays none so bare-body presses still can't select. */
* { user-select:none; }
body, .logpre, .logpre * { user-select:auto; }
html, body { height:100%; }
body { background:#141414; color:#ececec; font-family:'Cruiser Sans',sans-serif; overflow:hidden;
       display:flex; flex-direction:column; }
/* position:relative lifts the topbar to paint level 2 so it hit-tests BEFORE
   .content — blitz hit_inner doesn't clip hits to the scrollport, so once
   .content scrolls, clipped rows above it still take clicks over whatever
   sits there (blitz#1182). Unpositioned siblings lose to the scrollport's
   scrolled-away children and nav clicks die. */
.topbar { display:flex; align-items:center; gap:12px; padding:0 18px; height:56px;
          position:relative;
          background:#1b1b1b; border-bottom:1px solid #303030; }
.brand { display:flex; align-items:center; }
.brandicon { width:24px; height:24px; display:block; }
.nav { display:flex; gap:4px; }
.nav .item { padding:8px 15px; border-radius:4px; font-size:13px; color:#939393; cursor:default; }
.nav .item.on { background:#2c4e3c; color:#5ee6a8; font-weight:bold; }
.nav .item:hover { color:#d1d1d1; }
/* scrollbar-color styles the overlay thumb (blitz-paint "scrollbars"
   feature) — transparent track, slate thumb; thumb fades in on scroll. */
.content { padding:20px; flex:1; overflow-y:scroll; scrollbar-color:#696969 transparent; }
.h1 { font-size:20px; font-weight:bold; margin-bottom:14px; }
.h2 { font-size:14px; font-weight:bold; margin:18px 0 8px; color:#939393; }
/* checklist group headers — sit above an .opts block inside form rows */
.h3 { font-size:12px; font-weight:bold; color:#666666; margin:12px 0 4px 140px; }
.h3 .opt { margin-left:8px; }
.vmlist { display:flex; flex-direction:column; gap:8px; }
.vmlist-head { display:flex; align-items:center; justify-content:space-between;
               margin-bottom:14px; }
.vmlist-head .h1 { margin-bottom:0; }
.vmfilter { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end;
            margin-right:12px; }
.vmfilter input { width:180px; padding:6px 10px; font-size:13px; }
.vmrow { display:flex; align-items:center; flex-wrap:wrap; gap:8px 14px;
         padding:11px 16px;
         background:#1b1b1b; border:1px solid #303030; border-radius:6px; }
/* 240px basis: below that the pill/buttons wrap to a second line instead
   of crushing the spec text into one-word-per-line. */
.vmrow .grow { flex:1 1 240px; min-width:0; }
.vmbtns { display:flex; align-items:center; flex-wrap:wrap; row-gap:4px; }
.vmname { font-size:15px; font-weight:bold; }
.vmspecs { font-size:12px; color:#939393; margin-top:3px; }
.vmmode { font-size:12px; color:#666666; margin-top:2px; }
.vmdisk { font-size:12px; color:#666666; margin-top:2px; }
.sparks { display:flex; gap:16px; margin:0 4px; flex-wrap:wrap; }
/* five sparks don't fit beside the buttons — running rows get a full-width
   stats band under the name/spec/pill/button line. */
.vmrow > .sparks { flex:1 1 100%; margin:4px 0 0; padding-top:8px;
                   border-top:1px solid #282828; justify-content:flex-end; }
.spark { display:flex; flex-direction:column; align-items:flex-end; gap:3px; }
.spbars { display:flex; align-items:flex-end; gap:1px; height:24px; }
.spb { width:2px; border-radius:1px; background:#282828; }
.spark.cpu .spb.v { background:#5ee6a8; }
.spark.mem .spb.v { background:#9fd89f; }
.spark.disk .spb.v { background:#f0c98a; }
.spark.net .spb.v { background:#b39af0; }
.spark.gpu .spb.v { background:#7fd0b0; }
.splbl { font-size:10px; color:#666666; white-space:nowrap; }
.pill { padding:4px 11px; border-radius:11px; font-size:12px; white-space:nowrap; }
.pill.running { background:#1d3a24; color:#9fd89f; }
.pill.stopped { background:#282828; color:#939393; }
.pill.other { background:#3a2e1d; color:#f0c98a; }
.meta { font-size:12px; color:#666666; }
.empty { padding:40px; text-align:center; color:#666666; font-size:14px;
         border:1px dashed #303030; border-radius:8px; }
.btn { display:inline-block; padding:8px 15px; border-radius:4px; font-size:13px;
       background:#1b3a2c; color:#5ee6a8; border:1px solid #5ee6a8; margin-right:6px; }
.btn.sm { padding:4px 10px; font-size:12px; margin-right:5px; }
.btn:hover { background:#2a5240; }
.btn:active { background:#2a5240; }
.btn.warn { background:#3a2530; color:#f08aa8; border-color:#a04868; }
.btn.warn:hover { background:#4a2e3c; }
.btn.dim { background:#1b1b1b; color:#939393; border-color:#303030; }
.btn.dim:hover { background:#222222; border-color:#555555; }
/* Cap form rows so apply-mode tags can pin to a consistent right column —
   without a bound they scatter wherever each row's content happens to end. */
.row { display:flex; gap:16px; align-items:center; margin-bottom:10px; max-width:1060px; }
.lbl { width:140px; font-size:13px; color:#939393; }
input { background:#0e0e0e; border:1px solid #303030; border-radius:4px; color:#ececec;
        padding:8px 10px; font-size:14px; width:220px; }
input:focus { border-color:#5ee6a8; outline:none; }
.opts { display:flex; gap:6px; }
.opts.wrap { flex-wrap:wrap; max-width:680px; }
.opt { padding:7px 13px; border-radius:4px; font-size:13px; border:1px solid #303030;
       background:#1b1b1b; color:#939393; }
.opt.on { background:#2c4e3c; color:#5ee6a8; border-color:#5ee6a8; font-weight:bold; }
.opt:hover { border-color:#555555; color:#b3b3b3; }
.opt.on:hover { color:#5ee6a8; }
/* Armed destructive chips (share/fwd "remove?") — the warn palette, same as
   "Confirm kill". Accent-blue read as a selection, not a danger state. */
.opt.armed { background:#3a2530; color:#f08aa8; border-color:#a04868; }
.opt.armed:hover { background:#4a2e3c; color:#f08aa8; }
/* .tog marks the lone on/off switch chip — a pill shape + state dot so it
   reads as a control, not a status badge or an option in a group. */
.opt.tog { border-radius:11px; min-width:58px; text-align:center; }
.opt.tog::before { content:"● "; font-size:9px; opacity:.5; }
.opt.tog.on::before { opacity:1; }
/* Flattened 45%-opacity equivalents — a real opacity layer would rasterize
   the label onto a transparent backdrop where LCD subpixel blending leaves
   colored fringes. */
.opt.dim { background:#1b1b1b; color:#505050; border-color:#242424; }
.opt.sm { padding:4px 9px; font-size:12px; }
/* Apply-mode tags on the edit form while the VM runs: boot = frozen into
   QEMU's launch argv (needs restart), live = takes effect immediately. */
.aptag { font-size:10px; padding:1px 7px; border-radius:8px; white-space:nowrap; margin-left:auto; }
.aptag.boot { color:#f0c98a; border:1px solid #6b5527; }
.aptag.live { color:#9fd89f; border:1px solid #2f5233; }
/* Text-height clickable for inline toggles in kv rows — a .btn.sm would
   stretch the row. */
.kvtog { display:inline-block; font-size:11px; color:#939393; border:1px solid #303030;
         border-radius:3px; padding:1px 7px; }
.kvtog:hover { border-color:#555555; color:#d1d1d1; }
.kvtog:active { background:#2a5240; }
.crumb { display:inline-block; font-size:12px; color:#5ee6a8; margin-bottom:10px; }
.crumb:hover { text-decoration:underline; }
.sharebox { background:#1b1b1b; border:1px solid #303030; border-radius:6px;
            padding:10px 14px 2px; margin-top:10px; }
.hint { font-size:12px; color:#666666; margin:-4px 0 10px 156px; max-width:560px; line-height:1.45; }
.hint.warn { color:#f0c98a; }
.hostsum { font-size:13px; color:#939393; background:#1b1b1b; border:1px solid #303030;
           border-radius:6px; padding:9px 12px; margin-bottom:14px; }
.hostsum b { color:#ececec; }
.vdgrid { display:grid; gap:6px; }
.spinwrap { display:flex; flex-direction:column; align-items:center; justify-content:center;
            height:540px; gap:18px; }
.spinglyph { font-size:64px; color:#5ee6a8; }
.spinlbl { font-size:14px; color:#939393; max-width:460px; text-align:center; line-height:1.5; }
.kv { display:grid; grid-template-columns:160px 1fr; gap:7px 16px; font-size:13px;
      margin-bottom:16px; }
.kv .k { color:#939393; }
/* Facts are things users copy — paths, ports, ids. Keys stay unselectable. */
.kv div { user-select:text; }
.kv .k { user-select:none; }
/* A group divider for the lower half of the detail page — the share/fwd/
   mount/snapshot/portable sections are configuration, not live state. */
.sech { font-size:12px; color:#939393; font-weight:bold; margin:22px 0 4px;
        padding-bottom:6px; border-bottom:1px solid #282828; }
.docrow { display:flex; gap:10px; padding:9px 12px; font-size:13px; align-items:center; }
.docrow .ok { color:#9fd89f; font-weight:bold; width:40px; }
.docrow .bad { color:#f08aa8; font-weight:bold; width:40px; }
.docrow .fix { color:#666666; font-size:12px; }
.snap { display:inline-block; padding:5px 11px; margin:0 0 6px 0; font-size:12px;
        background:#282828; border-radius:11px 0 0 11px; color:#939393; }
.snap.armed { background:#3a2e1d; color:#f0c98a; }
.snapdel { display:inline-block; padding:5px 9px; margin:0 8px 6px 0; font-size:12px;
        background:#282828; border-radius:0 11px 11px 0; color:#666666; }
.snapdel.armed { background:#3a1d1d; color:#f08aa8; }
.logbar { display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
/* On the logs route the scrollpane is a SIBLING of .content (see RouteParts)
   — patching .content's innerHTML would rebuild a nested .logpre on every
   poll, resetting its scroll offset and flashing the pane. A top-level
   scrollport patched via its own innerHTML keeps the node (and offset) alive. */
.content.logtop { flex:0 1 auto; max-height:62%; }
.logpre { flex:1; min-height:80px; margin:0 20px 12px;
          font-family:'Cruiser Mono',monospace; font-size:11px; line-height:1.5;
          background:#0e0e0e; border:1px solid #303030; border-radius:6px;
          padding:10px 12px; overflow-y:scroll;
          scrollbar-color:#696969 transparent; white-space:pre-wrap;
          word-break:break-all; color:#d1d1d1; }
.logmeta { font-size:11px; color:#666666; }
.logerr { color:#f08aa8; }
.unitlist { max-height:104px; overflow-y:scroll; scrollbar-color:#696969 transparent;
            margin:0 0 10px 140px; }
.footer { height:28px; flex-shrink:0;
          background:#1b1b1b; border-top:1px solid #303030; }
/* Status notifier — one severity-colored bar (dot + single-line text). */
.fbar { display:flex; align-items:center; gap:9px; height:100%; padding:0 18px;
        font-size:12px; color:#666666; }
.fbar .fdot { width:7px; height:7px; border-radius:4px; background:#505050; flex-shrink:0; }
.fbar.warn { color:#f0c98a; }
.fbar.warn .fdot { background:#f0c98a; }
.fbar.err { color:#f0b8c8; background:#331e27; }
.fbar.err .fdot { background:#f08aa8; }
.fbar .ftext { flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.fbar .fbtn { flex-shrink:0; padding:1px 8px; border:1px solid #505050;
              border-radius:3px; font-size:11px; }
.fbar .fbtn:hover { border-color:#5ee6a8; color:#5ee6a8; }
.fbar .fbtn:active { background:#2a5240; }
/* Term route: the .content scrollport becomes a fixed column — the head
   strip stays put and #termbox fills the rest. The embedded webui view
   composites over #termbox's rect (TermManager probes it post-layout). */
.content.termroute { display:flex; flex-direction:column; overflow:hidden; }
.termhead { display:flex; align-items:center; gap:12px; margin-bottom:10px;
            flex-shrink:0; }
.termhead .crumb { margin-bottom:0; }
#termbox { flex:1; min-height:80px; background:#0e0e0e;
           border:1px solid #303030; border-radius:6px; }
`;

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pillClass(state: string): string {
    return state === "running" ? "running" : state === "stopped" ? "stopped" : "other";
}

const btn = (label: string, action: string, extra = "", cls = "btn") =>
    `<div class="${cls}" data-action="${esc(action)}"${extra}>${esc(label)}</div>`;
const attr = (k: string, v: string) => ` data-${k}="${esc(v)}"`;

const GPU_LABEL: Record<string, string> = {
    venus: "Venus (Vulkan)", virgl: "virgl (OpenGL)", software: "software",
};
const HEAD_LABEL: Record<string, string> = {
    "virtual-desktop": "virtual desktop",
    "fullscreen-monitor": "fullscreen monitor",
    windowed: "windowed",
    app: "app-only",
};
/** spec.persist → layman phrasing for the detail kv ("daemonize" means
 *  nothing to someone who didn't read the QEMU docs). */
const PERSIST_LABEL: Record<string, string> = {
    daemonize: "keeps running after the app exits",
    owned: "stops with the app",
    ephemeral: "deleted when the app exits",
};
/** spec.provisioned → friendly label (the raw method name is jargon). */
const PROV_LABEL: Record<string, string> = {
    cloudimg: "cloud image", iso: "ISO autoinstall", imported: "imported image",
};

const GiB = 1024 ** 3;

function fmtBytes(b: number): string {
    const g = b / GiB;
    return g >= 10 ? `${Math.round(g)} GiB`
        : g >= 1 ? `${g.toFixed(1)} GiB`
        : `${Math.round(b / 1048576)} MiB`;
}

/** Small sizes for log files — MiB granularity reads "0 MiB" on a 4KB log. */
function fmtSmall(b: number): string {
    return b >= 1048576 ? fmtBytes(b)
        : b >= 1024 ? `${(b / 1024).toFixed(1)} KiB`
        : `${b} B`;
}

/** Guest fs usage vs the disk cap: "guest 34.5 / 98 GiB". */
function guestDiskStr(vm: VmSummary): string | null {
    if (vm.guestUsedBytes === undefined) return null;
    const cap = vm.guestTotalBytes ?? vm.diskGiB * GiB;
    return `guest ${fmtBytes(vm.guestUsedBytes)} / ${fmtBytes(cap)}`;
}

const SPARK_N = 40;
const SPARK_H = 24;

const lastSample = (a: number[]): number | null => (a.length ? a[a.length - 1]! : null);

function spark(kind: "cpu" | "mem" | "disk" | "net" | "gpu", samples: number[],
    opts: { auto?: boolean; label?: string } = {}): string {
    const cur = lastSample(samples);
    // auto: unbounded rates scale to the window's max instead of a 0–100 axis.
    const max = opts.auto ? Math.max(1e-9, ...samples.slice(-SPARK_N)) : 100;
    let bars = "";
    for (let i = 0; i < SPARK_N; i++) {
        const v = samples[samples.length - SPARK_N + i];
        bars += v === undefined
            ? `<div class="spb" style="height:1px"></div>`
            : `<div class="spb v" style="height:${Math.max(1, Math.round(v * SPARK_H / max))}px"></div>`;
    }
    const lbl = opts.label ?? `${kind} ${cur === null ? "–" : `${Math.round(cur)}%`}`;
    return `<div class="spark ${kind}"><div class="spbars">${bars}</div>
        <div class="splbl">${esc(lbl)}</div></div>`;
}

function fmtIops(v: number): string {
    return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
}

/** bytes/s → compact rate: "340B", "12.4K", "2.4M", "1.1G". */
function fmtRate(bps: number): string {
    return bps >= GiB ? `${(bps / GiB).toFixed(1)}G`
        : bps >= 1048576 ? `${(bps / 1048576).toFixed(1)}M`
        : bps >= 1024 ? `${(bps / 1024).toFixed(1)}K`
        : `${Math.round(bps)}B`;
}

/** The running-VM stats band — cpu/mem/gpu are % scales; disk/net rates are
 *  unbounded so their bars scale to the visible window. The gpu spark only
 *  appears once a DRM client reading has landed (none in software mode). */
function sparksFor(vm: VmSummary): string {
    const d = lastSample(vm.disk), n = lastSample(vm.net), g = lastSample(vm.gpu);
    const parts = [
        spark("cpu", vm.cpu),
        spark("mem", vm.mem),
        spark("disk", vm.disk, { auto: true, label: `disk ${d === null ? "–" : `${fmtIops(d)} iops`}` }),
        spark("net", vm.net, { auto: true, label: `net ${n === null ? "–" : `${fmtRate(n)}/s`}` }),
    ];
    if (vm.gpu.length || vm.gpuMemBytes !== undefined) {
        const mem = vm.gpuMemBytes !== undefined ? ` · ${fmtBytes(vm.gpuMemBytes)}` : "";
        parts.push(spark("gpu", vm.gpu, { label: `gpu ${g === null ? "–" : `${Math.round(g)}%`}${mem}` }));
    }
    return `<div class="sparks">${parts.join("")}</div>`;
}

/** Action buttons for a VM state — shared between the list row and the
 *  detail screen. Destructive ops render their armed label. While an action
 *  targets this VM the cluster collapses to a single live indicator — the
 *  shell's busy ticker animates [data-spin] (~140ms/frame). */
function vmBtns(vm: VmSummary, s: CruiserState, detail = false): string {
    const act = s.action?.vm === vm.name ? s.action : null;
    if (act) {
        const secs = Math.floor((Date.now() - act.at) / 1000);
        return `<div class="btn sm dim"><span data-spin>◐</span>&nbsp;${esc(act.verb)}… ${secs}s</div>`;
    }
    const confirm = s.confirm;
    const up = vm.state === "running";
    const paused = vm.state === "paused";
    const transitional = vm.state === "starting" || vm.state === "stopping";
    const stopped = !up && !paused && !transitional;
    const b = (label: string, action: string, cls = "btn sm") => btn(label, action, attr("vm", vm.name), cls);
    const parts: string[] = [];
    // "app" head mode has no freerdp viewer — waypipe apps are launched via CLI.
    if (up && vm.headMode !== "app") parts.push(b("View", "vm-view"));
    if (up) parts.push(b("Term", "vm-term"));
    if (up) parts.push(b("Screenshot", "vm-shot", "btn sm dim"));
    if (up) parts.push(b("Reboot", "vm-reboot", "btn sm dim"));
    if (up && detail) parts.push(b("Suspend", "vm-suspend", "btn sm dim"));
    if (up && detail) parts.push(b("Hibernate", "vm-hibernate", "btn sm dim"));
    if (up && detail) parts.push(b("Ctrl+Alt+Del", "vm-cad", "btn sm dim"));
    if (paused) parts.push(b("Resume", "vm-resume"));
    if (up || paused) parts.push(b("Stop", "vm-stop", "btn sm dim"));
    if (stopped) parts.push(b(vm.hibernated ? "Resume" : "Start", "vm-start"));
    if (!transitional) parts.push(b("Edit", "vm-edit", "btn sm dim"));
    parts.push(btn("Logs", "nav", attr("route", "logs") + attr("vm", vm.name), "btn sm dim"));
    if (up || paused || transitional)
        parts.push(confirm === `vm-kill:${vm.name}`
            ? b("Confirm kill", "vm-kill", "btn sm warn")
            : b("Kill", "vm-kill", "btn sm warn"));
    if (detail && stopped) {
        parts.push(b("Clone", "vm-clone", "btn sm dim"));
        parts.push(confirm === `vm-rm:${vm.name}`
            ? b("Confirm delete", "vm-rm", "btn sm warn")
            : b("Delete", "vm-rm", "btn sm warn"));
    }
    return parts.join("");
}

/** Inner markup of a list row — #vmrow-<name> is patched via innerHtml on
 *  same-route updates, so the row node (and any :active/hover on it)
 *  survives metric ticks. VM names match [a-z0-9-]+ — css-ident safe. */
function vmRowInner(vm: VmSummary, s: CruiserState): string {
    const up = vm.state === "running";
    const specs = `${vm.cpus} vCPU · ${Math.round(vm.memMiB / 1024)} GiB RAM · ${vm.diskGiB} GiB cap`;
    const diskParts = [
        vm.hostDiskBytes !== undefined ? `${fmtBytes(vm.hostDiskBytes)} file` : "",
        guestDiskStr(vm) ?? "",
    ].filter(Boolean).join(" · ");
    const ports = up
        ? [vm.sshPort && `ssh :${vm.sshPort}`, vm.rdpPort && `rdp :${vm.rdpPort}`]
            .filter(Boolean).join(" · ")
        : "";
    const mode = [GPU_LABEL[vm.gpuMode] ?? vm.gpuMode, HEAD_LABEL[vm.headMode] ?? vm.headMode, vm.viewer, ports,
        vm.encrypt !== "off" ? `luks ${vm.encrypt}` : ""]
        .filter(Boolean).join(" · ");
    // Markup appended after esc(mode) — a colored "locked" badge, not text.
    const lockedBit = vm.encrypt !== "off" && vm.diskLocked
        ? ` · <span style="color:#f0c98a">locked</span>` : "";
    return `<div class="grow" data-action="nav" data-route="vm" data-vm="${esc(vm.name)}">
            <div class="vmname">${esc(vm.name)}</div>
            ${vm.description ? `<div class="vmmode">${esc(vm.description)}</div>` : ""}
            <div class="vmspecs">${esc(specs)}</div>
            <div class="vmmode">${esc(mode)}${lockedBit}${vm.provisioned ? "" : ` · <span style="color:#f0c98a">not provisioned</span>`}${vm.pendingRestart?.length ? ` · <span style="color:#f0c98a">restart pending: ${esc(vm.pendingRestart.join(", "))}</span>` : ""}</div>
            ${diskParts ? `<div class="vmdisk">${esc(diskParts)}</div>` : ""}
        </div>
        <div class="pill ${pillClass(vm.state)}">${esc(vm.state)}</div>
        <div class="vmbtns">${vmBtns(vm, s)}</div>
        ${up ? sparksFor(vm) : ""}`;
}

/** The parked auto-snapshot low-space decision — the user picks between
 *  deleting the remaining snapshots and continuing without one. */
function autoSnapBanner(s: CruiserState): string {
    const p = s.autoSnapPrompt;
    if (!p) return "";
    const purge = p.remaining.length
        ? btn(`Delete ${p.remaining.length} snapshot${p.remaining.length === 1 ? "" : "s"}`, "autosnap-purge", attr("vm", p.vm), "btn sm warn")
        : "";
    const skip = btn(p.context === "start" ? "Start without snapshot" : "Dismiss", "autosnap-skip", attr("vm", p.vm), "btn sm dim");
    return `<div class="hostsum" style="border-color:#6b5527;color:#f0c98a">
        <b>${esc(p.vm)}</b>: an auto snapshot wants ~${fmtBytes(p.needBytes)} free but only ${fmtBytes(p.freeBytes)} is available.
        ${purge ? "Delete the remaining snapshots to make room, or " : ""}${p.context === "start" ? "start without one." : "skip it."}
        <div style="margin-top:8px">${purge}${skip}</div></div>`;
}

/** The parked LUKS unlock — a prompt-mode VM's passphrase lives nowhere on
 *  disk, so ops that need it wait on this banner (re-dispatched by
 *  unlock-go once provided). */
function unlockBanner(s: CruiserState): string {
    const p = s.unlockPrompt;
    if (!p) return "";
    const opLabel = ({
        start: "start it", clone: "clone it", snapshot: "take a snapshot",
        restore: `restore '${p.arg ?? ""}'`, snapdel: `delete '${p.arg ?? ""}'`,
        grow: "grow the disk", backup: "back it up", compact: "compact the disk",
    } as Record<string, string>)[p.op] ?? p.op;
    return `<div class="hostsum" style="border-color:#6b5527;color:#f0c98a">
        <b>${esc(p.vm)}</b>: the disk is LUKS-encrypted — enter its passphrase to ${esc(opLabel)}.
        <div class="row" style="margin-top:8px">
            <input type="password" data-field="unlock-pw" value="${"*".repeat(s.unlockPw.length)}" style="width:240px" placeholder="disk passphrase">
            ${btn("Unlock", "unlock-go", attr("vm", p.vm), "btn sm")}
            ${btn("Cancel", "unlock-cancel", attr("vm", p.vm), "btn sm dim")}</div></div>`;
}

/** The VM list is the hot path — a store tick every ~3s rebuilds it. Rows
 *  carry stable ids so applyHtml can patch just the changed rows through
 *  rowGroup instead of re-parsing the whole list (each running row is
 *  ~200 sparkline divs). Exported: the shell re-patches #vmlist directly
 *  while the filter input holds focus (the render gate defers full pushes
 *  until blur, which would make typing feel dead). */
export function vmListInner(s: CruiserState): string {
    const q = s.vmFilter.trim().toLowerCase();
    const match = (vm: VmSummary) => !q ||
        [vm.name, vm.state, vm.description ?? "", GPU_LABEL[vm.gpuMode] ?? vm.gpuMode,
         HEAD_LABEL[vm.headMode] ?? vm.headMode, vm.viewer].some((t) => t.toLowerCase().includes(q));
    const rows = s.vms.filter(match).map((vm) => ({ id: `vmrow-${vm.name}`, html: vmRowInner(vm, s) }));
    if (!rows.length) {
        return s.vms.length
            ? `<div class="empty">no VMs match "${esc(q)}"</div>`
            : `<div class="empty">No VMs yet.
                <div style="margin-top:14px">${btn("+ New VM", "nav", attr("route", "create"))}</div></div>`;
    }
    return rows.map((r) => `<div class="vmrow" id="${esc(r.id)}">${r.html}</div>`).join("");
}

function home(s: CruiserState): RouteBody {
    const q = s.vmFilter.trim().toLowerCase();
    const match = (vm: VmSummary) => !q ||
        [vm.name, vm.state, vm.description ?? "", GPU_LABEL[vm.gpuMode] ?? vm.gpuMode,
         HEAD_LABEL[vm.headMode] ?? vm.headMode, vm.viewer].some((t) => t.toLowerCase().includes(q));
    const rows = s.vms.filter(match).map((vm) => ({ id: `vmrow-${vm.name}`, html: vmRowInner(vm, s) }));
    const head = `${unlockBanner(s)}${autoSnapBanner(s)}<div class="vmlist-head"><div class="h1">Virtual Machines</div>
        <div class="vmfilter"><span class="meta">filter</span>
            <input data-field="vm-filter" value="${esc(s.vmFilter)}"></div>
        ${btn("+ New VM", "nav", attr("route", "create"))}</div>`;
    // .vmlist is the row container — it survives even when empty so add/
    // remove/reorder swaps patch it rather than the whole .content.
    const listInner = vmListInner(s);
    return {
        html: `<div id="homehead">${head}</div><div class="vmlist" id="vmlist">${listInner}</div>`,
        regions: [{ sel: "#homehead", html: head }],
        rowGroup: { container: "#vmlist", containerHtml: listInner, rows },
    };
}

// ── create wizard ──

function field(label: string, key: string, val: string | number, w = 220, tag = "", type = ""): string {
    // Blitz ignores type=password, so the doc renders one bullet per char —
    // the shell diffs the visible string against the bullets on each input
    // event to recover the real edit (MASKED_FIELDS in shell.ts).
    const shown = type === "password" ? "*".repeat(String(val).length) : String(val);
    return `<div class="row"><div class="lbl">${esc(label)}</div>
        <input${type ? ` type="${type}"` : ""} data-field="${esc(key)}" value="${esc(shown)}" style="width:${w}px">${tag}</div>`;
}

function optRow(label: string, key: string, cur: string, choices: [string, string][], action = "set-field", tag = ""): string {
    return `<div class="row"><div class="lbl">${esc(label)}</div><div class="opts">${
        choices.map(([v, l]) =>
            `<div class="opt${cur === v ? " on" : ""}" data-action="${action}" data-field="${esc(key)}" data-value="${esc(v)}">${esc(l)}</div>`).join("")
    }</div>${tag}</div>`;
}

function checkRow(label: string, key: string, cur: boolean, hint = "", tag = ""): string {
    return `<div class="row"><div class="lbl">${esc(label)}</div>
        <div class="opt tog${cur ? " on" : ""}" data-action="set-field" data-field="${esc(key)}" data-value="${!cur}">${cur ? "on" : "off"}</div>
        ${hint ? `<div class="meta">${esc(hint)}</div>` : ""}${tag}</div>`;
}

const PERSIST_HINT: Record<string, string> = {
    daemonize: "keeps running after you close cruiser — reattach anytime",
    owned: "shuts down when you close cruiser — the VM and its disk are kept",
    ephemeral: "shuts down and deletes the VM (config + disk) when you close cruiser",
};

/* Inline validation hints. The create form writes field values straight to
 * the store without notifying (re-render would drop input focus), so these
 * are each wrapped in a persistent container the shell re-patches on input —
 * see createHints(). */
const hintName = (s: CruiserState) =>
    s.create.name && !/^[a-z0-9][a-z0-9-]*$/.test(s.create.name)
        ? `<div class="hint warn">lowercase letters, digits and dashes only (e.g. 'dev-box')</div>` : "";
const hintCpus = (s: CruiserState) =>
    s.hostRes && s.create.cpus > s.hostRes.cpus
        ? `<div class="hint warn">over the host's ${s.hostRes.cpus} CPUs — the VM won't start</div>` : "";
const hintMem = (s: CruiserState) =>
    s.hostRes && s.create.memMiB > s.hostRes.memGiB * 1024
        ? `<div class="hint warn">over the host's ${s.hostRes.memGiB} GiB — the VM won't start</div>` : "";
const hintDisk = (s: CruiserState) =>
    s.hostRes && s.create.diskGiB > s.hostRes.diskFreeGiB
        ? `<div class="hint warn">over the ${s.hostRes.diskFreeGiB} GiB free at the disk location</div>` : "";
const hintPw2 = (s: CruiserState) =>
    s.create.diskPassword2 && s.create.diskPassword !== s.create.diskPassword2
        ? `<div class="hint" style="color:#f08aa8">disk passwords don't match</div>` : "";

/** selector → innerHtml for every live validation container on the create
 *  route. The shell calls this after a direct create-field write. */
export function createHints(s: CruiserState): Record<string, string> {
    return {
        "#hint-name": hintName(s),
        "#hint-cpus": hintCpus(s),
        "#hint-mem": hintMem(s),
        "#hint-disk": hintDisk(s),
        "#hint-pw2": hintPw2(s),
    };
}

function create(s: CruiserState): string {
    const f = s.create;
    const r = s.hostRes;
    const editing = s.editVm !== null;
    const editTarget = editing ? s.vms.find((v) => v.name === s.editVm) : undefined;
    // Edit mode on a live VM: tag each field by whether it can apply now —
    // argv-level fields are frozen until the next boot, the rest take
    // effect immediately (sync channels on the next session pass).
    const vmUp = !!editTarget && editTarget.state !== "stopped";
    const aptag = (kind: "boot" | "live") => vmUp
        ? `<span class="aptag ${kind}">${kind === "boot" ? "needs restart" : "applies live"}</span>`
        : "";
    const hostsum = r
        ? `<div class="hostsum">host — <b>${r.cpus}</b> CPUs · <b>${r.memGiB}</b> GiB RAM · <b>${r.diskFreeGiB}</b> GiB free at ${esc(f.diskDir || f.vmDir || "default location")}</div>`
        : "";
    const memVal = f.memUnit === "GiB" ? Math.round((f.memMiB / 1024) * 100) / 100 : f.memMiB;
    const memRow = `<div class="row"><div class="lbl">Memory</div>
        <input data-field="memInput" value="${memVal}" style="width:100px">
        <div class="opts">${(["MiB", "GiB"] as const).map((u) =>
            `<div class="opt${f.memUnit === u ? " on" : ""}" data-action="set-field" data-field="memUnit" data-value="${u}">${u}</div>`).join("")}</div>
        ${r ? `<div class="meta">of ${r.memGiB} GiB</div>` : ""}${aptag("boot")}</div>
        <div id="hint-mem">${hintMem(s)}</div>`;
    const diskRow = `<div class="row"><div class="lbl">Disk GiB</div>
        <input data-field="diskGiB" value="${f.diskGiB}" style="width:100px">
        ${editing ? `<div class="meta">grow-only</div>` : r ? `<div class="meta">of ${r.diskFreeGiB} GiB free</div>` : ""}${aptag("boot")}</div>
        <div id="hint-disk">${hintDisk(s)}</div>
        ${editing ? "" : `<div class="row"><div class="lbl">Disk location</div>
        <div class="meta" style="width:280px">${esc(f.diskDir || `${VMS_DIR}/‹name›/`)}</div>
        <div class="opt" data-action="pick-disk-dir">Choose…</div></div>`}`;
    const vmDirRow = `<div class="row"><div class="lbl">VM location</div>
        <div class="meta" style="width:280px">${esc(f.vmDir || VMS_DIR)}</div>
        <div class="opt" data-action="pick-vm-dir">Choose…</div></div>
        <div class="hint">${editing
            ? "where the VM dir actually lives — moving it to another disk needs the VM stopped"
            : "the whole VM dir (config, disk image, secrets) goes under ‹dir›/‹name› — pick another drive to keep big VMs off the system disk"}</div>`;
    const vdPicker = f.headMode === "virtual-desktop" && s.desktops.length
        ? `<div class="row"><div class="lbl">Desktop</div>
            <div class="opt${f.vd === 0 ? " on" : ""}" data-action="set-vd" data-vd="0">auto</div>
            <div class="vdgrid" style="grid-template-columns:repeat(${Math.max(1, Math.ceil(s.desktops.length / Math.max(1, s.vdRows)))},auto)">
            ${s.desktops.map((d) =>
                `<div class="opt${f.vd === d.index ? " on" : ""}" data-action="set-vd" data-vd="${d.index}">${esc(d.name || String(d.index))}${d.current ? "•" : ""}</div>`).join("")}
            </div>${aptag("live")}</div>
            <div class="hint">the viewer window lands on this desktop (${s.vdRows > 1 ? `${s.vdRows}×${Math.ceil(s.desktops.length / s.vdRows)} grid` : "row"} layout) — • is where you are now</div>`
        : "";
    const kdeOk = f.distro in DISTROS && supportsKrdp(f.distro as keyof typeof DISTROS, f.release);
    const winGuest = f.method === "windows" || f.distro === "windows";
    const provRows =
        f.method === "cloudimg" ? `
            <div class="hint">A <b>cloud image</b> is a prebuilt disk published by the distro — cruiser downloads it once, resizes it to your disk size, and injects a cloud-init seed that creates your user, sets the password, and enables SSH/RDP. Fastest path to a working VM — no installer.</div>
            ${optRow("Guest OS", "distro", f.distro, [["ubuntu", "Ubuntu"], ["debian", "Debian"], ["fedora", "Fedora"]], "set-distro")}
            ${optRow("Release", "release", f.release, (DISTROS[f.distro as keyof typeof DISTROS]?.releases ?? []).map((r) => [r.id, r.label] as [string, string]))}` :
        f.method === "iso" ? `${field("ISO path or URL", "iso", f.iso, 340)}
            <div class="hint">Boots the ISO with a NoCloud autoinstall seed — slower (~20 min) but runs the real installer unattended. Ubuntu ISOs only for now.</div>` :
        f.method === "windows" ? `
            ${optRow("Release", "release", f.release, DISTROS.windows.releases.map((r) => [r.id, r.label] as [string, string]))}
            ${optRow("Display driver", "winDriver", f.winDriver, [["yttrium", "yttrium (viogpu3d)"], ["virtio2d", "virtio-win 2D"]])}
            ${f.winDriver === "yttrium"
                ? `<div class="hint"><b>experimental</b> — Venus GPU + test-signed driver: the zero-copy dmabuf path (best latency, D3D9–11/Vulkan). Turns on test-signing, so Secure Boot must stay off.</div>`
                : `<div class="hint">stock virtio-win display driver — one extra copy per frame but stable and signed; works with Secure Boot.</div>`}
            ${field("Edition", "winEdition", f.winEdition, 220)}
            <div class="hint">unattend edition key — blank installs the ISO's default (Pro).</div>
            ${field("ISO path or URL", "iso", f.iso, 340)}
            <div class="hint">blank → cruiser resolves the official ISO from Microsoft's software-download service (a Windows <b>evaluation</b>-equivalent consumer ISO — unactivated, time-limited; bring your own key/ISO for production). Downloads are ~5 GB and the install runs ~30–60 min fully unattended.</div>` :
        f.method === "imported" ? `
            <div class="row"><div class="lbl">Image file</div>
                <input data-field="importPath" value="${esc(f.importPath)}" style="width:340px">
                <div class="opt" data-action="pick-import">Browse…</div></div>
            ${optRow("Guest OS", "distro", f.distro, [["ubuntu", "Ubuntu"], ["debian", "Debian"], ["fedora", "Fedora"], ["windows", "Windows"]], "set-distro")}
            <div class="hint">Boots an existing disk image in place (qcow2/raw/vmdk/… — format is auto-detected). Use for images you've already installed elsewhere.</div>` : "";
    const syncSection = `<div class="h2">Host → guest sync ${aptag("live")}</div>
        <div class="hint" style="margin-left:0">mirrored into the guest while a viewer session is open (and at provision). Turn off per channel.</div>
        ${checkRow("Dark / light theme", "syncTheme", f.syncTheme, "xdg portal color-scheme — watches host changes live")}
        ${checkRow("Accent color", "syncAccent", f.syncAccent, "portal accent-color → nearest GNOME accent / KDE AccentColor")}
        ${checkRow("Contrast", "syncContrast", f.syncContrast, "portal high-contrast preference")}
        ${checkRow("Timezone", "syncTimezone", f.syncTimezone, "host tz → guest timedatectl — follows laptop travel")}
        ${checkRow("Locale", "syncLocale", f.syncLocale, "host LANG → guest localectl")}
        ${checkRow("Keyboard layout", "syncKeyboard", f.syncKeyboard, "host X11 keymap → guest input sources")}
        ${checkRow("Monitor topology", "syncMonitors", f.syncMonitors, "host layout + scale → guest monitors.xml (GNOME guests)")}
        ${checkRow("Display scale", "syncScale", f.syncScale, "host display scale → guest monitor scale + font DPI")}
        ${checkRow("Host wallpaper", "syncHostWallpaper", f.syncHostWallpaper, "host's wallpaper as the composite source — an explicit wallpaper path always wins")}
        ${checkRow("Share mounts", "syncShares", f.syncShares, "reconciles the shared-folders fstab inside the guest whenever the share list changes")}
        ${checkRow("Git identity", "syncGit", f.syncGit, "pushes host ~/.gitconfig user.name/email into the guest")}
        ${checkRow("Proxy settings", "syncProxy", f.syncProxy, "pushes host proxy config (gsettings/kioslaverc + /etc/environment) into the guest")}
        ${checkRow("Custom CA roots", "syncCa", f.syncCa, "pushes host /usr/local/share/ca-certificates + pki anchors into the guest trust store")}
        ${checkRow("SSH agent", "syncAgent", f.syncAgent, "forwards an agent socket into the guest via ssh -R (viewer-session lifetime); pick keys for a dedicated agent, none picked = your session agent as-is")}
        ${!f.syncAgent ? "" : `<div class="opts wrap" style="margin-left:140px">${[
            ...s.sshKeys.map((k) =>
                `<div class="opt${f.agentKeys.includes(k.path) ? " on" : ""}" data-action="agentkey-toggle" data-key="${esc(k.path)}">${esc(k.label)}</div>`),
            // a picked path the probe lost sight of (deleted key, imported
            // spec) stays shown so it can be unpicked
            ...f.agentKeys.filter((p) => !s.sshKeys.some((k) => k.path === p)).map((p) =>
                `<div class="opt on dim" data-action="agentkey-toggle" data-key="${esc(p)}">${esc(p)} <span class="meta">missing</span></div>`),
        ].join("") || `<div class="meta">no private keys detected under ~/.ssh</div>`}</div>
        <div class="hint" style="margin-left:140px">${f.agentKeys.length
            ? "picked keys are loaded into a dedicated agent forwarded to this VM — passphrase-protected keys can't load unattended"
            : "no keys picked — your session agent is forwarded as-is"}</div>`}
        ${checkRow("Git SSH key", "syncGitKey", f.syncGitKey, "installs a host private key into the guest (credentials.gitSshKeyPath, else ~/.ssh/<git email>) + an ssh config block for the common forges")}`;
    // Identical devices share a vid:pid:serial key — and the saved spec
    // can't tell them apart either — so collapse them into one chip with a
    // ×n badge instead of a row of indistinguishable duplicates.
    const usbGroups = new Map<string, { d: UsbChoice; n: number; writable: boolean }>();
    s.usbDevices.forEach((d) => {
        const g = usbGroups.get(d.key);
        if (g) { g.n++; g.writable ||= d.writable; }
        else usbGroups.set(d.key, { d, n: 1, writable: d.writable });
    });
    const usbSorted = [...usbGroups.values()].sort((a, b) => Number(b.writable) - Number(a.writable));
    const usbBlocked = usbSorted.filter((g) => !g.writable);
    const usbShown = s.usbShowBlocked ? usbSorted : usbSorted.filter((g) => g.writable);
    const usbChip = (g: (typeof usbSorted)[number]) => {
        const d = g.d;
        return `<div class="opt${f.usb.includes(d.key) ? " on" : ""}${g.writable ? "" : " dim"}" data-action="usb-toggle" data-key="${esc(d.key)}">${esc(d.label)}${g.n > 1 ? ` ×${g.n}` : ""} <span class="meta">${d.vendorId}:${d.productId}${d.serial ? ` · ${esc(d.serial)}` : ""}${g.writable ? "" : " · no access"}</span></div>`;
    };
    const usbSection = `<div class="h2">USB passthrough ${aptag("boot")}</div>
        ${s.usbDevices.length
            ? `<div class="opts wrap">${usbShown.map(usbChip).join("")}${
                usbBlocked.length
                    ? `<div class="opt${s.usbShowBlocked ? " on" : ""}" data-action="usb-blocked-toggle">${s.usbShowBlocked ? "hide devices without access" : `+ ${usbBlocked.length} more — no host access`}</div>`
                    : ""}</div>
               <div class="hint" style="margin-left:0">selected devices are passed straight to the guest at boot — "no access" needs a udev rule or group fix</div>`
            : `<div class="meta">no USB devices found</div>`}`;
    // grouped devtools checklist — categories render in DEVTOOLS order, each
    // with an all/none toggle chip beside the header
    const devtoolsSection = f.preset !== "developer" ? ""
        : [...new Set(DEVTOOLS.map((t) => t.cat))].map((c) => {
            const items = DEVTOOLS.filter((t) => t.cat === c);
            const allOn = items.every((t) => f.devtools.includes(t.id));
            return `<div class="h3">${esc(c)}
                <span class="opt sm${allOn ? " on" : ""}" data-action="devtools-cat" data-key="${esc(c)}">${allOn ? "none" : "all"}</span></div>
            <div class="opts wrap" style="margin-left:140px">${items.map((t) =>
                `<div class="opt${f.devtools.includes(t.id) ? " on" : ""}" data-action="devtools-toggle" data-key="${esc(t.id)}"
                     title="${esc(t.desc)}">${esc(t.label)} <span class="meta">${esc(t.desc)}</span></div>`).join("")}</div>`;
        }).join("") + `<div class="hint">installs during guest setup — uncheck what you don't want.
            distro packages where they exist; upstream installers/repos for the rest
            (fnm, bun, hashicorp, github, microsoft, mongodb…). "Containers" includes
            distrobox, which shells into other distros' packages.</div>`;
    const importSection = editing ? "" : `<div class="h2">Import a config</div>
        <div class="row"><div class="lbl">Gist or file</div>
            <input data-field="importRef" value="${esc(f.importRef)}" style="width:340px">
            <div class="opt" data-action="import-config">Import</div></div>
        <div class="hint">a gist url/id or a local <b>*.cruiser.{yaml,toml,json}</b> doc creates the VM
            straight from the config — ports re-allocate, everything else (resources, shares, sync
            channels, os profile) comes along. Export a VM from its detail page.</div>`;
    return `<div class="crumb" data-action="nav" data-route="home">‹ VMs</div>
        <div class="h1">${editing ? `${esc(s.editVm ?? "")} <span class="meta" style="font-weight:normal">editing</span>` : "New VM"}</div>
        ${hostsum}
        ${importSection}
        ${editing
            ? `<div class="row"><div class="lbl">Name</div><div class="meta" style="color:#ececec">${esc(s.editVm ?? "")}</div></div>
        <div class="row"><div class="lbl">Description</div>
            <input data-field="vm-desc" value="${esc(s.vmDesc)}" style="width:320px">${aptag("live")}</div>
        <div class="hint">exported with the config — a one-liner like "work dev box, cuda testing".</div>`
            : field("Name", "name", f.name) + `<div id="hint-name">${hintName(s)}</div>`}
        <div class="h2">Resources</div>
        ${field("vCPUs", "cpus", f.cpus, 80, aptag("boot"))}
        <div id="hint-cpus">${hintCpus(s)}</div>
        ${memRow}
        ${diskRow}
        ${vmDirRow}
        ${checkRow("Nested virtualization", "nestedVirt", f.nestedVirt, "pass the host's vmx/svm flag to the guest — run KVM inside the VM (needs the host kvm module's nested=1, see doctor)", aptag("boot"))}
        ${field("CPU quota", "cpuQuota", f.cpuQuota, 80, aptag("boot"))}
        ${field("Memory max", "memMax", f.memMax, 80, aptag("boot"))}
        ${field("IO weight", "ioWeight", f.ioWeight, 80, aptag("boot"))}
        <div class="hint">optional host-side cgroup caps on the QEMU process — blank leaves each uncapped.
            CPU quota sums across cores ("50%" = half a core, "200%" = two). Memory max covers QEMU's RSS
            <b>including</b> guest RAM — keep it above the memory size or the host OOM-kills the VM. IO weight is 1–10000.</div>
        ${editing ? "" : `<div class="h2">Disk encryption</div>
        ${optRow("Encryption", "encrypt", f.encrypt, [["off", "off"], ["full", "full disk"], ["home", "/home only"]])}
        <div class="hint">qcow2 LUKS — the image file is encrypted at rest and QEMU unlocks it with a
            passphrase (the guest sees a plain disk). <b>full disk</b> encrypts the whole system image;
            <b>/home only</b> keeps the system disk plaintext and adds a second encrypted volume
            mounted at /home. Baked into the image — can't be changed after creation.</div>
        ${f.encrypt === "off" && f.method !== "imported" ? "" : `
        ${f.method === "imported" ? `<div class="hint">importing an image? If it's already LUKS-encrypted it's detected
            automatically — enter its disk password below so the VM can unlock it. Plaintext images stay plaintext
            (encryption can't be retrofitted).</div>` : ""}
        ${f.method === "imported" ? "" : optRow("Key storage", "keyStore", f.keyStore, [["store", "remember"], ["prompt", "ask each time"]])}
        ${f.encrypt !== "off" && f.method !== "imported" ? `<div class="hint">${f.keyStore === "store"
            ? "the passphrase is kept in the VM's secrets/ dir (0600) — the VM boots unattended"
            : "nothing is kept on disk — starting, cloning, and snapshotting each ask for the passphrase"}</div>` : ""}
        ${f.encrypt === "home" && f.method !== "imported" ? field("Home disk GiB", "homeGiB", f.homeGiB, 80) : ""}
        ${field("Disk password", "diskPassword", f.diskPassword, 220, "", "password")}
        ${f.encrypt !== "off" || f.method !== "imported" ? field("Repeat", "diskPassword2", f.diskPassword2, 220, "", "password") : ""}
        <div id="hint-pw2">${hintPw2(s)}</div>
        <div class="hint">unlocks the qcow2 image itself — separate from the guest login below, and
            <b>not recoverable</b> if lost.</div>`}`}
        <div class="h2">Security &amp; firmware</div>
        ${checkRow("TPM 2.0", "tpm", f.tpm, "swtpm emulator — TPM-bound LUKS + measured boot; state persists in the VM dir", aptag("boot"))}
        ${checkRow("Secure Boot", "secureBoot", f.secureBoot, "edk2 secboot firmware + SMM — some Windows guests want it; the yttrium driver needs it off", aptag("boot"))}
        <div class="h2">Graphics &amp; display</div>
        ${optRow("GPU mode", "gpu", f.gpu, [["venus", "Venus (Vulkan)"], ["virgl", "virgl (GL)"], ["software", "software"]], "set-field", aptag("boot"))}
        ${f.gpu === "venus" ? checkRow("Host software Vulkan", "swVk", f.swVk, "expose the host's lavapipe (CPU renderer) to the guest — off keeps software Vulkan on the guest's own lavapipe", aptag("boot")) : ""}
        ${optRow("Viewer", "viewer", f.viewer, [["dmabuf", "dmabuf"], ["rdp", "rdp"]], "set-field", aptag("boot"))}
        <div class="hint">${f.viewer === "dmabuf"
            ? "the guest's display straight on your screen — lower latency than rdp; needs a venus/virgl GPU"
            : "remote-desktop into the guest — works with any GPU mode"}</div>
        ${optRow("Head mode", "headMode", f.headMode, [["virtual-desktop", "virtual desktop"], ["fullscreen-monitor", "fullscreen monitor"], ["windowed", "windowed"], ["app", "app-only"]], "set-field", aptag("live"))}
        ${vdPicker}
        ${checkRow("Sound", "sound", f.sound, "intel-hda audio out through the viewer", aptag("boot"))}
        ${checkRow("Microphone", "microphone", f.microphone, "mic into the guest — dmabuf viewer path", aptag("boot"))}
        ${checkRow("Clipboard sync", "clipboard", f.clipboard, "host↔guest text clipboard — vdagent/freerdp channel", aptag("boot"))}
        ${checkRow("Open links on host", "urlOpen", f.urlOpen, "guest http(s) links land in the host browser", aptag("boot"))}
        ${optRow("Persist", "persist", f.persist, [["daemonize", "survives app"], ["owned", "stops with app"], ["ephemeral", "deleted on exit"]], "set-field", aptag("live"))}
        <div class="hint">${PERSIST_HINT[f.persist] ?? ""}</div>
        ${checkRow("Start on boot", "autostart", f.autostart, "start with the app and at login — headless (open a console yourself); a systemd --user unit is installed while any VM is flagged", aptag("live"))}
        ${optRow("Network", "netMode", f.netMode, [["nat", "nat"], ["restricted", "restricted"], ["isolated", "isolated"], ["vmnet", "vmnet"]], "set-field", aptag("boot"))}
        <div class="hint">${{
            nat: "full outbound internet + LAN via slirp, with port forwards into the guest.",
            restricted: "sandbox: the guest can only talk to the host — no internet/LAN egress. ssh + forwards still work.",
            isolated: "no network at all — QGA, serial console and vsock still reach the guest; ssh and app-mode don't.",
            vmnet: "nat plus a second NIC on a layer-2 net shared by every vmnet VM on this host (multi-VM labs — no DHCP, use link-local or static IPs).",
        }[f.netMode] ?? ""}</div>
        ${checkRow("Host↔guest vsock", "vsock", f.vsock, "vhost-vsock channel — app-mode (waypipe) and host services ride it", aptag("boot"))}
        <div class="h2">Snapshots ${aptag("live")}</div>
        ${optRow("Auto snapshot", "snapAuto", f.snapAuto, [["off", "off"], ["daily", "daily"], ["weekly", "weekly"], ["monthly", "monthly"]])}
        ${f.snapAuto === "off" ? "" : `
        ${optRow("Take it", "snapTrigger", f.snapTrigger, [["stop", "after shutdown"], ["start", "before start"], ["both", "both"]])}
        ${field("Keep", "snapKeep", f.snapKeep, 80)}
        <div class="hint">auto snapshots are named <b>auto-*</b> and rotate down to the keep count — manual snapshots are never pruned. Only a clean edge can snapshot (qemu-img needs the disk offline): a kill or a host power loss can't.</div>`}
        ${editing ? "" : `<div class="h2">Provisioning</div>
        ${optRow("Method", "method", f.method, [["none", "none"], ["cloudimg", "cloud image"], ["iso", "ISO autoinstall"], ["windows", "Windows"], ["imported", "import existing"]])}
        ${provRows}
        ${f.method === "none" || winGuest ? "" : `<div class="h2">Guest software</div>
        ${optRow("Desktop", "desktop", f.desktop, [["gnome", "GNOME"], ["kde", "KDE Plasma"]])}
        ${f.method === "cloudimg" && f.desktop === "kde" && !kdeOk ? `<div class="hint">KDE needs a guest release that ships krdp — ${esc(f.distro)} ${esc(f.release)} doesn't have one; pick a newer release.</div>` : ""}
        ${optRow("Browser", "browser", f.browser, [["none", "none"], ["firefox", "Firefox"], ["chrome", "Chrome"], ["chromium", "Chromium"], ["vivaldi", "Vivaldi"], ["brave", "Brave"]])}
        <div class="hint">installed via Flathub</div>
        ${checkRow("Snap support", "snap", f.snap, "off → flatpak is the only app channel")}
        ${checkRow("Extra fonts", "extraFonts", f.extraFonts, "CJK + MS core fonts on top of the base bundle")}
        ${checkRow("Autologin", "autologin", f.autologin, "boot straight into the desktop — KDE needs this for RDP (krdpserver runs in the user session)")}
        ${optRow("Preset", "preset", f.preset, [["standard", "Standard"], ["developer", "Developer"]], "set-preset")}
        ${devtoolsSection}
        <div class="hint">The base bundle — desktop, RDP/audio/GPU stack, flatpak + software store, fonts — is always installed.</div>`}`}
        ${winGuest ? "" : syncSection}
        ${usbSection}
        <div class="h2">Advanced</div>
        ${field("Extra QEMU args", "qemuArgs", f.qemuArgs, 460, aptag("boot"))}
        <div class="hint">raw args appended verbatim to QEMU's command line — the escape hatch for features
            cruiser doesn't model ("-rtc base=localtime", "-boot menu=on", "-device …"). Quotes group words.
            Unvalidated — bad args fail the launch (check the qemu log).</div>
        ${editing ? "" : `<div class="h2">Credentials</div>
        ${field("Username", "username", f.username)}
        ${field("Password", "password", f.password, 220, "", "password")}`}
        ${vmUp
            ? `<div class="hint" style="margin-left:0">the VM is ${esc(editTarget!.state)} —
                <span class="aptag boot">needs restart</span> fields are frozen into the running QEMU and apply at the next boot;
                <span class="aptag live">applies live</span> fields take effect immediately.${editTarget!.pendingRestart?.length
                    ? ` Already pending from earlier changes: <b>${esc(editTarget!.pendingRestart.join(", "))}</b>.` : ""}</div>` : ""}
        <div style="margin-top:18px">${editing
            ? btn("Save", "vm-save") + btn("Cancel", "nav", attr("route", "vm") + attr("vm", s.editVm ?? ""), "btn dim")
            : btn("Create VM", "vm-create") + btn("Cancel", "nav", attr("route", "home"), "btn dim")}</div>`;
}

// ── vm detail ──

function vmDetail(s: CruiserState): RouteBody {
    const vm = s.vms.find((v) => v.name === s.selectedVm);
    if (!vm) return { html: `<div class="h1">${esc(s.selectedVm ?? "?")}</div><div class="empty">not found</div>` };
    const up = vm.state === "running";
    const snaps = vm.snapshots.length
        ? vm.snapshots.map((sn) => {
            const armed = s.confirm === `vm-restore:${vm.name}:${sn}`;
            const delArmed = s.confirm === `vm-snap-del:${vm.name}:${sn}`;
            return `<span class="snap${armed ? " armed" : ""}" data-action="vm-restore" data-vm="${esc(vm.name)}" data-snap="${esc(sn)}">${armed ? `restore ${esc(sn)}?` : esc(sn)}</span>` +
                `<span class="snapdel${delArmed ? " armed" : ""}" data-action="vm-snap-del" data-vm="${esc(vm.name)}" data-snap="${esc(sn)}">${delArmed ? "delete?" : "✕"}</span>`;
        }).join("")
        : `<span class="meta">none</span>`;
    const autoSpec = vm.snapAuto !== "off"
        ? `auto: ${esc(vm.snapAuto)} · ${esc({ start: "before start", stop: "after shutdown", both: "start + stop" }[vm.snapTrigger] ?? vm.snapTrigger)} · keep ${vm.snapKeep}`
        : "";
    const snapSection = up || vm.state === "starting" || vm.state === "stopping"
        ? `<div class="meta">${vm.snapshots.length
            ? `${vm.snapshots.length} snapshot${vm.snapshots.length === 1 ? "" : "s"} — list + restore appear when the VM is stopped`
            : `none — the list + restore appear when the VM is stopped`}</div>`
        : `<div>${snaps}</div>
           ${vm.snapshots.length ? `<div class="hint" style="margin-left:0">click a snapshot to restore (overwrites the current disk state) · ✕ deletes it</div>` : ""}
           ${autoSpec ? `<div class="meta">${autoSpec}</div>` : ""}
           <div style="margin-top:8px">${btn("Take snapshot", "vm-snap", attr("vm", vm.name))}</div>`;
    const diskDetail = [
        vm.hostDiskBytes !== undefined ? `${fmtBytes(vm.hostDiskBytes)} file` : "",
        guestDiskStr(vm) ?? "",
    ].filter(Boolean).join(" · ");
    // login row — masked until "show" reads the 0600 secrets file into
    // store.pwReveal; user-select:text makes the revealed text copyable
    // (selection is globally off otherwise). The toggle is a text-height
    // chip — a .btn.sm would stretch the whole kv row.
    const pwRev = s.pwReveal?.vm === vm.name ? s.pwReveal.pw : null;
    const pwTog = (label: string) =>
        `<span class="kvtog" data-action="vm-pw"${attr("vm", vm.name)}>${esc(label)}</span>`;
    const login = !vm.hasPassword
        ? `${esc(vm.username)} · <span class="meta">no password on record</span>`
        : pwRev !== null
            ? `${esc(vm.username)} · <b style="user-select:text">${esc(pwRev)}</b> ${pwTog("hide")}`
            : `${esc(vm.username)} · •••••••• ${pwTog("show")}`;
    // #vmtop carries everything that churns on a metrics tick (pill, kv,
    // sparkline band, action buttons); #vmrest holds the slow sections —
    // the share form's inputs only rebuild when share/snapshot state
    // actually changes, not every poll.
    const kvTog = (label: string, action: string, extra: string) =>
        ` <span class="kvtog" data-action="${esc(action)}"${extra}>${esc(label)}</span>`;
    // Copyable/connectable facts — paths and the ssh command are the things
    // users reach for most. Ports alone were dead text on a stopped VM.
    const connect = up
        ? `ssh <b>${esc(vm.username)}@127.0.0.1 -p ${vm.sshPort ?? "–"}</b>`
          + kvTog("copy", "kv-copy", attr("copy", `ssh ${vm.username}@127.0.0.1 -p ${vm.sshPort ?? ""}`))
          + (vm.rdpPort ? ` <span class="meta">· rdp 127.0.0.1:${vm.rdpPort}</span>` : "")
        : `<span class="meta">ssh :${vm.sshPort ?? "–"} · rdp :${vm.rdpPort ?? "–"} — reserved, live when the VM runs</span>`;
    const locked = vm.diskLocked;
    const caps = [
        vm.limits.cpuQuota ? `cpu ≤ ${vm.limits.cpuQuota}` : "",
        vm.limits.memoryMax ? `mem ≤ ${vm.limits.memoryMax}` : "",
        vm.limits.ioWeight ? `io weight ${vm.limits.ioWeight}` : "",
    ].filter(Boolean).join(" · ");
    const top = `<div class="crumb" data-action="nav" data-route="home">‹ VMs</div>
        <div class="h1">${esc(vm.name)} <span class="pill ${pillClass(vm.state)}">${esc(vm.state)}</span></div>
        ${vm.description ? `<div class="meta" style="margin:-8px 0 12px">${esc(vm.description)}</div>` : ""}
        ${vm.pendingRestart?.length
            ? `<div class="hostsum" style="border-color:#6b5527;color:#f0c98a">restart pending — these changed while the VM was up and only apply at the next boot: <b>${esc(vm.pendingRestart.join(", "))}</b>. Stop &amp; start to apply.</div>`
            : ""}
        ${autoSnapBanner(s)}
        ${unlockBanner(s)}
        <div class="kv">
            <div class="k">resources</div><div>${vm.cpus} vCPU · ${Math.round(vm.memMiB / 1024)} GiB · ${vm.diskGiB} GiB disk${vm.nestedVirt ? " · nested virt" : ""}${caps ? ` · ${esc(caps)}` : ""}</div>
            ${diskDetail ? `<div class="k">disk usage</div><div>${esc(diskDetail)}</div>` : ""}
            <div class="k">location</div><div>${esc(vm.vmDir)}${kvTog("copy", "kv-copy", attr("copy", vm.vmDir))}${kvTog("open", "kv-open", attr("path", vm.vmDir))}</div>
            <div class="k">gpu / head / viewer</div><div>${esc(vm.gpuMode)} / ${esc(vm.headMode)} / ${esc(vm.viewer)}</div>
            <div class="k">encryption</div><div>${vm.encrypt === "off" ? "off"
                : `qcow2 LUKS — ${vm.encrypt === "full" ? "full disk" : "/home volume"}`
                  + ` · ${vm.keyStorage === "prompt" ? "passphrase not stored" : "key stored"}${locked ? ` · <span style="color:#f0c98a">locked</span>` : ""}`}</div>
            <div class="k">connect</div><div>${connect}</div>
            <div class="k">login</div><div>${login}</div>
            <div class="k">provisioned</div><div>${esc(vm.provisioned ? (PROV_LABEL[vm.provisioned] ?? vm.provisioned) : "—")}</div>
            <div class="k">persist</div><div>${esc(PERSIST_LABEL[vm.persist] ?? vm.persist)}</div>
        </div>
        ${locked ? `<div class="hint warn" style="margin-left:0">the encrypted volume didn't unlock — restart the VM and enter the passphrase when prompted (unless it's stored).</div>` : ""}
        ${up ? `<div class="h2">Usage</div>${sparksFor(vm)}` : ""}
        <div style="margin:10px 0 18px">
            ${vmBtns(vm, s, true)}
        </div>`;
    const rest = `${runtimeSection(vm, s)}<div class="sech">Configuration</div>
        ${shareSection(vm, s, up)}
        ${fwdSection(vm, s)}
        ${mountSection(vm)}
        <div class="h2">Snapshots</div>
        ${snapSection}
        <div class="h2">Disk</div>
        <div class="row"><div class="lbl"></div>
            ${btn("Backup image", "vm-backup", attr("vm", vm.name), "btn sm")}
            ${up ? btn("Fstrim", "vm-fstrim", attr("vm", vm.name), "btn sm dim") : ""}
            ${vm.state === "stopped"
                ? (s.confirm === `vm-compact:${vm.name}`
                    ? btn(vm.snapshots.length ? "compact — drops snapshots?" : "compact?", "vm-compact", attr("vm", vm.name), "btn sm warn")
                    : btn("Compact", "vm-compact", attr("vm", vm.name), "btn sm dim"))
                : ""}</div>
        <div class="hint" style="margin-left:0">backup writes a full copy of the image — live + consistent while
            running, offline while stopped. fstrim runs FITRIM inside the guest so free blocks are reclaimable.
            compact rewrites the qcow2 sparse (stopped VMs only) — internal snapshots don't survive
            ${vm.snapshots.length ? `(${vm.snapshots.length} present)` : "it"}.</div>
        <div class="h2">Portable config</div>
        <div class="row"><div class="lbl">Export / pull</div>
            ${btn("Export (yaml)", "vm-export", attr("vm", vm.name), "btn sm")}
            ${btn("Push to gist", "vm-gist-push", attr("vm", vm.name), "btn sm")}
            ${vm.origin ? btn("Pull", "vm-gist-pull", attr("vm", vm.name), "btn sm") : ""}
            <div class="meta">${vm.origin ? esc(vm.origin) : "gist/file origin set on push or import"}</div></div>
        <div class="hint">a *.cruiser.{yaml,toml,json} doc captures the whole spec — import one from the New VM screen</div>`;
    return {
        html: `<div id="vmtop">${top}</div><div id="vmrest">${rest}</div>`,
        regions: [{ sel: "#vmtop", html: top }, { sel: "#vmrest", html: rest }],
    };
}

/** Session-level controls for a running VM — USB hotplug + the memory
 *  balloon. Nothing here persists; the boot-time equivalents live on the
 *  Edit screen (usb chips, Memory). */
function runtimeSection(vm: VmSummary, s: CruiserState): string {
    if (vm.state !== "running") return "";
    const attached = vm.usbAttached ?? [];
    const isAttached = (d: UsbChoice) =>
        attached.some((a) => a.id === `usb-${d.vendorId}-${d.productId}-${d.bus ?? "?"}-${d.addr ?? "?"}`)
        // sysfs bus/addr unreadable (0/absent) → the port-qualified id can
        // never match; vid:pid is close enough to keep a passed-through
        // device out of the attachable list.
        || ((!d.bus || !d.addr) &&
            attached.some((a) => a.id.startsWith(`usb-${d.vendorId}-${d.productId}-`)));
    const rows = [
        ...attached.map((a) => `<div class="row">
            <div style="flex:1">${esc(a.label)} <span class="meta">· passed through (${esc(a.id)})</span></div>
            <div class="opt sm" data-action="usb-detach" data-vm="${esc(vm.name)}" data-id="${esc(a.id)}">detach</div></div>`),
        ...s.usbDevices.filter((d) => !isAttached(d)).map((d) => `<div class="row">
            <div style="flex:1">${esc(d.label)} <span class="meta">· ${d.vendorId}:${d.productId}${d.serial ? ` · ${esc(d.serial)}` : ""}${d.writable ? "" : " · no host access"}</span></div>
            <div class="opt sm${d.writable ? "" : " dim"}" data-action="usb-attach" data-vm="${esc(vm.name)}" data-key="${esc(d.key)}">attach</div></div>`),
    ];
    return `<div class="sech">Runtime — this boot only</div>
        <div class="h2">USB passthrough</div>
        <div class="hint" style="margin-left:0">hot-attached until detached or the VM stops — the Edit screen's
            USB picks are the boot-time set.</div>
        ${rows.length ? rows.join("") : `<div class="meta">no USB devices on the host</div>`}
        <div class="h2">Memory balloon</div>
        <div class="row"><div class="lbl">Guest-visible</div>
            <input data-field="memtarget" value="${esc(s.memTarget)}" style="width:100px">
            ${btn("Apply", "vm-memset", attr("vm", vm.name), "btn sm")}
            <div class="meta">MiB${vm.memBalloonMiB !== undefined ? ` — now ${vm.memBalloonMiB}` : ""}, capped at the ${vm.memMiB} MiB boot size</div></div>`;
}

/** The shares list + add form on the vm detail screen. */
function shareSection(vm: VmSummary, s: CruiserState, up: boolean): string {
    const sf = s.shareForm;
    const opt = (field: string, value: string, label: string, cur: string) =>
        `<div class="opt${cur === value ? " on" : ""}" data-action="share-form" data-field="${field}" data-value="${value}">${esc(label)}</div>`;
    const rows = vm.shares.length ? vm.shares.map((sh) => {
        const mp = sh.guestPath ?? (sh.mode === "copy"
            ? `~/cruiser-sync/${sh.hostPath.replace(/\/+$/, "").split("/").pop() ?? sh.tag}`
            : `/mnt/${sh.tag}`);
        const chip = (field: string, value: string, label: string, on: boolean) =>
            `<div class="opt sm${on ? " on" : ""}" data-action="share-attr" data-vm="${esc(vm.name)}" data-idx="${sh.idx}" data-field="${field}" data-value="${value}">${esc(label)}</div>`;
        const armed = s.confirm === `share-rm:${vm.name}:${sh.idx}`;
        const tog = (field: string, value: string, label: string, on: boolean) =>
            `<div class="opt sm tog${on ? " on" : ""}" data-action="share-attr" data-vm="${esc(vm.name)}" data-idx="${sh.idx}" data-field="${field}" data-value="${value}">${esc(label)}</div>`;
        return `<div class="vmrow">
            ${tog("enabled", String(!sh.enabled), sh.enabled ? "on" : "off", sh.enabled)}
            <div class="grow">${esc(sh.hostPath)} → ${esc(mp)}
                <div class="vmmode">${esc(sh.tag)} · ${sh.mode === "copy" ? "copy (rsync)" : "mount (virtiofs/9p)"}${sh.deletions ? " · --delete" : ""}</div></div>
            <div class="opts">
                ${chip("direction", "both", "two-way", sh.direction === "both")}
                ${chip("direction", "host-to-guest", "host→guest", sh.direction === "host-to-guest")}
            </div>
            <div class="opts">
                ${chip("mode", "mount", "mount", sh.mode === "mount")}
                ${chip("mode", "copy", "copy", sh.mode === "copy")}
            </div>
            <div class="opt sm${armed ? " armed" : ""}" data-action="share-rm" data-vm="${esc(vm.name)}" data-idx="${sh.idx}">${armed ? "remove?" : "✕"}</div>
        </div>`;
    }).join("") : `<div class="meta">no shares yet</div>`;
    const syncNow = vm.shares.some((x) => x.mode === "copy" && x.enabled) && up
        ? btn("Sync now", "filesync-now", attr("vm", vm.name), "btn sm dim") : "";
    const form = `<div class="sharebox">
        <div class="row"><div class="lbl">Host path</div>
            <input data-field="share-hostPath" value="${esc(sf.hostPath)}" style="width:280px">
            <div class="opt" data-action="share-pick">Browse…</div></div>
        <div class="row"><div class="lbl">Guest path</div>
            <input data-field="share-guestPath" value="${esc(sf.guestPath)}" style="width:280px">
            <div class="meta">${sf.mode === "mount" ? "mountpoint — default /mnt/<tag>; the tag is the share's short name, derived from the folder" : "destination dir — default ~/cruiser-sync/<name>"}</div></div>
        <div class="row"><div class="lbl">Mode</div><div class="opts">
            ${opt("mode", "mount", "mount", sf.mode)}${opt("mode", "copy", "copy", sf.mode)}</div>
            <div class="meta">${sf.mode === "mount" ? "real host folder in the guest — attaches at boot" : "rsync'd copies — applies live, single files work"}</div></div>
        <div class="row"><div class="lbl">Direction</div><div class="opts">
            ${opt("direction", "both", "two-way", sf.direction)}${opt("direction", "host-to-guest", "host→guest only", sf.direction)}</div></div>
        <div class="row"><div class="lbl"></div>
            ${btn("Add share", "share-add", attr("vm", vm.name), "btn sm")}
            ${btn("Cancel", "share-form", attr("field", "open") + attr("value", "false"), "btn sm dim")}</div>
    </div>`;
    return `<div class="h2">Shared folders &amp; file sync</div>
        <div class="hint" style="margin-left:0"><b>mount</b> shows the real host folder inside the guest
            (virtiofs/9p — applied at boot; fstab reconciles on each session). <b>copy</b> rsyncs real
            copies — works for single files too, and applies live with no restart.</div>
        ${rows}
        ${sf.open ? form
            : `<div style="margin-top:10px">${btn("+ Add share", "share-form", attr("field", "open") + attr("value", "true"), "btn sm")}</div>`}
        ${syncNow ? `<div style="margin-top:8px">${syncNow}</div>` : ""}`;
}

/** Port forwards — spec.network.hostfwd, applied live via slirp
 *  hostfwd_add/remove on a running VM and persisted for the next boot. */
function fwdSection(vm: VmSummary, s: CruiserState): string {
    const ff = s.fwdForm;
    const rows = vm.forwards.length ? vm.forwards.map((f) => {
        const armed = s.confirm === `fwd-rm:${vm.name}:${f.proto}:${f.hostPort}`;
        const autoLabel = f.guestPort === 22 ? "built-in — vm ssh"
            : f.guestPort === 3389 ? "built-in — the rdp viewer" : "built-in";
        return `<div class="vmrow">
            <div class="grow"><code>${esc(f.proto)}</code> 127.0.0.1:${f.hostPort} → guest:${f.guestPort}
                <div class="vmmode">${f.auto ? autoLabel : "custom"}</div></div>
            ${f.auto ? "" : `<div class="opt sm${armed ? " armed" : ""}" data-action="fwd-rm" data-vm="${esc(vm.name)}" data-port="${f.hostPort}" data-proto="${esc(f.proto)}">${armed ? "remove?" : "✕"}</div>`}
        </div>`;
    }).join("") : `<div class="meta">no forwards</div>`;
    const form = `<div class="sharebox">
        <div class="row"><div class="lbl">Host port</div>
            <input data-field="fwd-hostPort" value="${esc(ff.hostPort)}" style="width:110px" placeholder="8080">
            <div class="lbl" style="width:auto">→ guest port</div>
            <input data-field="fwd-guestPort" value="${esc(ff.guestPort)}" style="width:110px" placeholder="80"></div>
        <div class="row"><div class="lbl">Protocol</div><div class="opts">
            <div class="opt${ff.proto === "tcp" ? " on" : ""}" data-action="fwd-form" data-field="proto" data-value="tcp">tcp</div>
            <div class="opt${ff.proto === "udp" ? " on" : ""}" data-action="fwd-form" data-field="proto" data-value="udp">udp</div></div>
            <div class="meta">guests reach the host as 10.0.2.2 on the slirp net</div></div>
        <div class="row"><div class="lbl"></div>
            ${btn("Add forward", "fwd-add", attr("vm", vm.name), "btn sm")}
            ${btn("Cancel", "fwd-form", attr("field", "open") + attr("value", "false"), "btn sm dim")}</div>
    </div>`;
    return `<div class="h2">Port forwards</div>
        <div class="hint" style="margin-left:0">host 127.0.0.1:port → a guest port — added/removed live on a running VM, no restart needed.</div>
        ${rows}
        ${ff.open ? form
            : `<div style="margin-top:10px">${btn("+ Add forward", "fwd-form", attr("field", "open") + attr("value", "true"), "btn sm")}</div>`}`;
}

/** Guest→host sshfs mount — mounts the guest home at
 *  ~/.local/share/cruiser/mounts/<vm> (same as `vm mount`). */
function mountSection(vm: VmSummary): string {
    const row = vm.mount
        ? `<div class="vmrow">
            <div class="grow"><code>${esc(vm.mount)}</code>
                <div class="vmmode">guest /home/${esc(vm.username)} via sshfs</div></div>
            ${btn("Open", "vm-open-mount", attr("vm", vm.name), "btn sm")}
            ${btn("Unmount", "vm-umount", attr("vm", vm.name), "btn sm")}
        </div>`
        : `<div class="meta">not mounted — mounts the guest's home dir on the host via sshfs (cli: vm mount)</div>
           <div style="margin-top:10px">${btn("Mount guest files", "vm-mount", attr("vm", vm.name), "btn sm")}</div>`;
    return `<div class="h2">Guest files</div>
        <div class="hint" style="margin-left:0">sshfs over the VM's forwarded ssh port — the guest must be running.</div>
        ${row}`;
}

// ── logs ──

function logsView(s: CruiserState): RouteBody {
    const name = s.selectedVm ?? "?";
    const vm = s.vms.find((v) => v.name === name);
    const l = s.logs;
    const chip = (field: string, value: string, label: string, cur: string) =>
        `<div class="opt${cur === value ? " on" : ""}" data-action="log-set" data-field="${esc(field)}" data-value="${esc(value)}">${esc(label)}</div>`;
    const srcTabs = `<div class="opts">${chip("source", "runner", "host log", l.source)}${chip("source", "journal", "guest journal", l.source)}</div>`;
    const linesSel = `<div class="opts">${[100, 300, 1000, 3000].map((n) => chip("lines", String(n), String(n), String(l.lines))).join("")}</div>`;
    const follow = `<div class="opt${l.follow ? " on" : ""}" data-action="log-set" data-field="follow" data-value="${!l.follow}">follow</div>`;

    const controls = l.source === "runner"
        ? `<div class="row"><div class="lbl">File</div><div class="opts wrap">${l.files.length
            ? l.files.map((f) =>
                `<div class="opt${l.file === f.id ? " on" : ""}${f.exists ? "" : " dim"}" data-action="log-set" data-field="file" data-value="${esc(f.id)}">${esc(f.name)}${f.exists ? ` <span class="meta">${fmtSmall(f.sizeBytes)}</span>` : ""}</div>`).join("")
            : `<span class="meta">probing…</span>`}</div></div>`
        : `${vm?.state === "running" ? "" : `<div class="hint" style="margin-left:0">the guest isn't running — start it to read its journal</div>`}
            <div class="row"><div class="lbl">Priority</div><div class="opts">${
                chip("priority", "", "all", l.priority) + chip("priority", "err", "err+", l.priority) +
                chip("priority", "warning", "warning+", l.priority) + chip("priority", "info", "info+", l.priority) +
                chip("priority", "debug", "debug", l.priority)}</div></div>
            <div class="row"><div class="lbl">Boot</div><div class="opts">${
                chip("boot", "0", "current", l.boot) + chip("boot", "-1", "previous", l.boot) + chip("boot", "", "all", l.boot)}</div></div>
            <div class="row"><div class="lbl">Since</div>
                <input data-field="log-since" value="${esc(l.since)}" style="width:200px">
                <div class="meta">e.g. "1 hour ago", "today", "10:00"</div></div>
            <div class="row"><div class="lbl">Grep</div>
                <input data-field="log-grep" value="${esc(l.grep)}" style="width:260px">
                <div class="meta">regex filter (journalctl -g)</div></div>
            <div class="row"><div class="lbl">Unit</div>
                <input data-field="log-unit" value="${esc(l.unit)}" style="width:260px">
                ${l.unit ? `<div class="opt" data-action="log-set" data-field="unit" data-value="">clear</div>` : ""}</div>
            ${l.units.length ? `<div class="opts wrap unitlist">${l.units.slice(0, 80).map((u) =>
                `<div class="opt${l.unit === u ? " on" : ""}" data-action="log-set" data-field="unit" data-value="${esc(u)}">${esc(u)}</div>`).join("")}</div>` : ""}`;

    const meta = [
        l.fetchedAt ? `fetched ${Math.max(0, Math.round((Date.now() - l.fetchedAt) / 1000))}s ago` : "",
        l.transport ? `via ${l.transport}` : "",
        l.loading ? "fetching…" : "",
    ].filter(Boolean).join(" · ");
    // The active runner file's real path — the pane only shows the tail, so
    // open/copy get users to the file itself (editor, bug reports).
    const activeFile = l.source === "runner" ? l.files.find((x) => x.id === l.file) : undefined;
    const fileBtns = activeFile?.exists
        ? ` <span class="kvtog" data-action="status-open"${attr("path", activeFile.path)}>open</span>
            <span class="kvtog" data-action="status-copy"${attr("path", activeFile.path)}>copy path</span>`
        : "";

    // .logpre is NOT emitted here — it's a sibling of .content patched
    // through the RouteParts.log region so the scrollport node survives
    // content patches (see applyHtml). #logmeta splits off the "fetched Ns
    // ago" line — it changes on every refresh while the controls don't.
    const ctl = `<div class="crumb" data-action="nav" data-route="vm" data-vm="${esc(name)}">‹ ${esc(name)}</div>
        <div class="h1">${esc(name)} logs <span class="pill ${pillClass(vm?.state ?? "")}">${esc(vm?.state ?? "?")}</span></div>
        <div class="logbar">${srcTabs}<span class="meta">lines</span>${linesSel}${follow}${btn("Refresh", "log-refresh", "", "btn sm")}</div>
        ${controls}`;
    return {
        html: `<div id="logctl">${ctl}</div><div id="logmeta"><div class="logmeta" style="margin-bottom:6px">${esc(meta)}${fileBtns}</div></div>`,
        regions: [{ sel: "#logctl", html: ctl }, { sel: "#logmeta", html: `<div class="logmeta" style="margin-bottom:6px">${esc(meta)}${fileBtns}</div>` }],
    };
}

/** Inner markup of the logs scrollpane — patched into .logpre directly so
 *  the scrollport node (and its scroll offset) survives content updates.
 *  .logend is the bottom sentinel the shell probes for "is pinned"
 *  (a class, not an id — scroll events report the nearest ancestor id and
 *  we want them to keep resolving to #logpane). */
function logPaneInner(s: CruiserState): string {
    const l = s.logs;
    const body = l.error ? `<span class="logerr">${esc(l.error)}</span>` : ansiToHtml(l.text || "(empty)");
    return `${body}<div class="logend" style="height:1px"></div>`;
}

// ── term ──

/** Term route — a head strip + the empty #termbox the webui terminal view
 *  composites over. Sessions outlive the route (TermManager); the head
 *  shows the connect status and offers reconnect / host-window escapes. */
/** Term route — a head strip + the empty #termbox the webui terminal view
 *  composites over. Sessions outlive the route (TermManager); the head
 *  shows the connect status and offers reconnect / host-window escapes.
 *  #termhead is its own region so termLine ticks never rebuild #termbox —
 *  TermManager holds its rect, and a node swap under the composited view
 *  would blank the terminal for a frame. */
function termView(s: CruiserState): RouteBody {
    const name = s.selectedVm ?? "?";
    const vm = s.vms.find((v) => v.name === name);
    const head = `<div class="crumb" data-action="nav" data-route="vm" data-vm="${esc(name)}">‹ ${esc(name)}</div>
        <span class="pill ${pillClass(vm?.state ?? "")}">${esc(vm?.state ?? "not found")}</span>
        <div class="meta">terminal · ${esc(s.termLine || "…")}</div>
        <div style="flex:1"></div>
        ${btn("Reconnect", "vm-term-reconnect", attr("vm", name), "btn sm dim")}
        ${btn("Open in window", "vm-term-host", attr("vm", name), "btn sm dim")}`;
    return {
        html: `<div class="termhead" id="termhead">${head}</div><div id="termbox"></div>`,
        regions: [{ sel: "#termhead", html: head }],
    };
}

// ── settings / doctor ──

function settings(s: CruiserState): string {
    const h = s.host;
    const hostBlock = h ? `<div class="kv">
            <div class="k">session</div><div>${esc(h.session)}</div>
            <div class="k">wm adapter</div><div>${esc(h.adapterId)}</div>
            <div class="k">monitors</div><div>${h.monitors.map((m) => `${esc(m.name)} ${m.w}x${m.h} +${m.x}+${m.y}${m.primary ? "*" : ""}`).join(" · ") || "none"}</div>
            <div class="k">desktops</div><div>${h.desktops.map((d) => `${esc(d.name || String(d.index))}${d.current ? "*" : ""}`).join(" · ") || "none"}</div>
            <div class="k">caps</div><div>${Object.entries(h.caps).filter(([k]) => k !== "notes").map(([k, v]) => `${k}:${v ? "yes" : "no"}`).join(" ")}</div>
        </div>` : `<div class="empty">probing host…</div>`;
    const res = s.hostRes ? `<div class="kv">
            <div class="k">cpu</div><div>${s.hostRes.cpus} cores</div>
            <div class="k">memory</div><div>${s.hostRes.memGiB} GiB</div>
            <div class="k">disk free</div><div>${s.hostRes.diskFreeGiB} GiB (at vm dir)</div>
        </div>` : "";
    const si = s.sysinfo;
    const sysBlock = si ? `<div class="kv">
            <div class="k">runtime</div><div>${esc(si.runtime)}</div>
            <div class="k">display</div><div>${esc(si.displayEnv)}</div>
            <div class="k">ui backend</div><div>${esc(si.uiBackend)}</div>
            <div class="k">qemu</div><div>${si.qemu ? `${esc(si.qemu)}${si.qemuFromOpt ? " <span class='meta'>(opt/ toolchain)</span>" : " <span class='meta'>(system)</span>"}` : `<span class="bad">not found</span>`}</div>
            <div class="k">xfreerdp</div><div>${si.xfreerdp ? esc(si.xfreerdp) : `<span class="bad">not found</span>`}</div>
        </div>` : `<div class="empty">probing…</div>`;
    const pathBlock = si ? `<div class="kv">
            <div class="k">vms</div><div>${esc(si.vmsDir)}</div>
            <div class="k">isos</div><div>${esc(si.isoDir)}</div>
            <div class="k">cloud cache</div><div>${esc(si.cloudimgDir)}</div>
            <div class="k">data</div><div>${esc(si.dataDir)}</div>
            <div class="k">config</div><div>${esc(si.configDir)}</div>
            <div class="k">cache</div><div>${esc(si.cacheDir)}</div>
        </div>` : "";
    const usbBlock = s.usbDevices.length
        ? [...s.usbDevices].sort((a, b) => Number(b.writable) - Number(a.writable) || (a.bus ?? 0) - (b.bus ?? 0) || (a.addr ?? 0) - (b.addr ?? 0))
            .map((d) => `<div class="docrow"><div class="${d.writable ? "ok" : "bad"}">${d.writable ? " ok" : "ro"}</div>
            <div style="flex:1">${esc(d.label)}</div><div class="fix">${d.vendorId}:${d.productId}${d.serial ? ` · ${esc(d.serial)}` : ""}${d.bus !== undefined ? ` · port ${d.bus}-${d.addr}` : ""}</div></div>`).join("")
        : `<div class="empty">no USB devices found</div>`;
    const blocked = s.usbDevices.filter((d) => !d.writable).length;
    const docRows = s.doctor === null
        ? ""
        : s.doctor.map((d) => `<div class="docrow"><div class="${d.ok ? "ok" : "bad"}">${d.ok ? " ok" : "FAIL"}</div><div style="flex:1">${esc(d.label)}</div><div class="fix">${esc(d.fix)}</div></div>`).join("");
    return `<div class="h1">Diagnostics</div>
        <div class="h2">Host session</div>
        ${hostBlock}
        <div class="h2">Host resources</div>
        ${res}
        <div class="h2">Runtime &amp; toolchain</div>
        ${sysBlock}
        <div class="h2">Paths</div>
        ${pathBlock}
        <div class="h2">Doctor</div>
        ${btn("Run doctor", "doctor")}${docRows ? `<div style="margin-top:8px">${docRows}</div>` : `<div class="meta" style="display:inline-block;margin-left:10px">not run</div>`}
        <div class="h2">USB devices ${blocked ? `<span class="meta">(${blocked} need permission — run doctor for the udev fix)</span>` : ""}</div>
        ${usbBlock}`;
}

/** A patchable region — a stable container whose INNER markup is swapped
 *  via setInnerHtml when it changes between same-route renders. */
export interface RegionPart { sel: string; html: string }
/** A row inside a rowGroup — inner markup keyed by the row element's id. */
export interface RowPart { id: string; html: string }

/** What a route renderer returns — full inner markup for .content plus the
 *  fine-grained patch surface used on same-route updates. */
interface RouteBody {
    html: string;
    /** Containers patched individually when their markup changed. */
    regions?: RegionPart[];
    /** Ordered rows inside `container` — patched per-row when the id list
     *  is unchanged, wholesale via containerHtml on add/remove/reorder. */
    rowGroup?: { container: string; containerHtml: string; rows: RowPart[] };
}

/** Per-region markup — same-route updates patch these into the live doc via
 *  setInnerHtml, which keeps the .content scrollport node (and its scroll
 *  offset) alive. A full setHtml rebuild resets scroll and replays the
 *  scrollbar fade on every poll. */
export interface RouteParts {
    topbar: string;
    content: string;
    footer: string;
    /** Inner markup of the logs scrollpane (.logpre), or null on other
     *  routes — patched as its own region so the scrollport node survives. */
    log: string | null;
    /** Fine-grained patch surface for .content (region/row ops) — when
     *  present on both prev and cur render, applyHtml mutates only the
     *  changed regions instead of re-parsing all of .content. */
    regions?: RegionPart[];
    rowGroup?: RouteBody["rowGroup"];
    /** Full document (topbar/content/footer wrapped in the page shell) —
     *  used for mount, route changes, and gate dedupe. */
    html: string;
}

export function renderRouteParts(s: CruiserState): RouteParts {
    const nav = (r: string, label: string, on = s.route === r) =>
        `<div class="item${on ? " on" : ""}" data-action="nav" data-route="${r}">${label}</div>`;
    const spinner = `<div class="spinwrap"><div class="spinglyph" data-spin>◐</div>
        <div class="spinlbl">${esc(s.status)}</div>
        ${s.route === "create" ? `<div class="meta">provisioning can take a few minutes — the image download is cached for future VMs</div>` : ""}</div>`;
    // Busy only takes over the create wizard — provisioning runs for minutes
    // and the form shouldn't be touched mid-flight. Everywhere else the
    // topbar "working…" + footer status carry the in-flight op: blanking the
    // VM list for a 20s stop drain reads as "the list vanished".
    const b: RouteBody =
        s.busy && s.route === "create" ? { html: spinner } :
        s.route === "home" ? home(s) :
        s.route === "create" ? { html: create(s) } :
        s.route === "vm" ? vmDetail(s) :
        s.route === "logs" ? logsView(s) :
        s.route === "term" ? termView(s) : { html: settings(s) };
    const topbar = `<div class="brand"><img class="brandicon" src="ui://cruiser/icon.png"></div>
        <div class="nav">${nav("home", "VMs", ["home", "create", "vm", "logs", "term"].includes(s.route))}${nav("settings", "Diagnostics")}</div>
        <div style="flex:1"></div>`;
    const fcls = s.statusKind === "error" ? " err" : s.statusKind === "warn" ? " warn" : "";
    // A status carrying a real absolute path ("— see /…/viewer-dd.log")
    // gets open/copy actions — the bar's single-line text isn't selectable.
    // (existsSync filters stray "/word" fragments out of status text.)
    const stPath = s.status.match(/\/\S+/g)?.pop()?.replace(/[.,;:!?'")\]]+$/, "") ?? null;
    const pathBtns = stPath && existsSync(stPath)
        ? `<div class="fbtn" data-action="status-open"${attr("path", stPath)}>open</div>
           <div class="fbtn" data-action="status-copy"${attr("path", stPath)}>copy path</div>`
        : "";
    const footer = `<div class="fbar${fcls}"><div class="fdot"></div><div class="ftext">${esc(s.status)}</div>${pathBtns}</div>`;
    const log = s.route === "logs" ? logPaneInner(s) : null;
    return {
        topbar, content: b.html, footer, log,
        regions: b.regions, rowGroup: b.rowGroup,
        html: `<html><head><style>${fontFaceCss()}${CSS}</style></head><body>
        <div class="topbar">${topbar}</div>
        <div class="content${log !== null ? " logtop" : ""}${s.route === "term" ? " termroute" : ""}">${b.html}</div>
        ${log !== null ? `<div class="logpre" id="logpane">${log}</div>` : ""}
        <div class="footer">${footer}</div>
    </body></html>`,
    };
}

export function renderRoute(s: CruiserState): string {
    return renderRouteParts(s).html;
}
