// ============================================================================
// screens.ts — markup for each route. Plain HTML strings rasterized by the
// Blitz html-ui stack; interactivity via data-action + DOM input events.
// ============================================================================

import { VMS_DIR } from "../../vm-core/src/paths";
import { DISTROS, supportsKrdp } from "../../provision/src/distros";
import { DEVTOOLS } from "../../provision/src/packages";
import { fontFaceCss } from "./fonts";
import type { CruiserState, VmSummary } from "./store";

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
body { background:#10141a; color:#e8ecf1; font-family:'Cruiser Sans',sans-serif; overflow:hidden;
       display:flex; flex-direction:column; }
.topbar { display:flex; align-items:center; gap:12px; padding:0 18px; height:56px;
          background:#161b23; border-bottom:1px solid #2a313c; }
.brand { font-size:17px; font-weight:bold; color:#7fd0ff; }
.nav { display:flex; gap:4px; }
.nav .item { padding:8px 15px; border-radius:4px; font-size:13px; color:#8a94a3; cursor:default; }
.nav .item.on { background:#2e4361; color:#7fd0ff; font-weight:bold; }
/* scrollbar-color styles the overlay thumb (blitz-paint "scrollbars"
   feature) — transparent track, slate thumb; thumb fades in on scroll. */
.content { padding:20px; flex:1; overflow-y:scroll; scrollbar-color:#5d6a80 transparent; }
.h1 { font-size:20px; font-weight:bold; margin-bottom:14px; }
.h2 { font-size:14px; font-weight:bold; margin:18px 0 8px; color:#8a94a3; }
/* checklist group headers — sit above an .opts block inside form rows */
.h3 { font-size:12px; font-weight:bold; color:#5d6775; margin:12px 0 4px 140px; }
.h3 .opt { margin-left:8px; }
.vmlist { display:flex; flex-direction:column; gap:8px; }
.vmlist-head { display:flex; align-items:center; justify-content:space-between;
               margin-bottom:14px; }
.vmlist-head .h1 { margin-bottom:0; }
.vmrow { display:flex; align-items:center; flex-wrap:wrap; gap:8px 14px;
         padding:11px 16px;
         background:#161b23; border:1px solid #2a313c; border-radius:6px; }
/* 240px basis: below that the pill/buttons wrap to a second line instead
   of crushing the spec text into one-word-per-line. */
.vmrow .grow { flex:1 1 240px; min-width:0; }
.vmbtns { display:flex; align-items:center; flex-wrap:wrap; row-gap:4px; }
.vmname { font-size:15px; font-weight:bold; }
.vmspecs { font-size:12px; color:#8a94a3; margin-top:3px; }
.vmmode { font-size:12px; color:#5d6775; margin-top:2px; }
.vmdisk { font-size:12px; color:#5d6775; margin-top:2px; }
.sparks { display:flex; gap:16px; margin:0 4px; flex-wrap:wrap; }
/* five sparks don't fit beside the buttons — running rows get a full-width
   stats band under the name/spec/pill/button line. */
.vmrow > .sparks { flex:1 1 100%; margin:4px 0 0; padding-top:8px;
                   border-top:1px solid #212933; justify-content:flex-end; }
.spark { display:flex; flex-direction:column; align-items:flex-end; gap:3px; }
.spbars { display:flex; align-items:flex-end; gap:1px; height:24px; }
.spb { width:2px; border-radius:1px; background:#212933; }
.spark.cpu .spb.v { background:#4fc2f7; }
.spark.mem .spb.v { background:#9fd89f; }
.spark.disk .spb.v { background:#f0c98a; }
.spark.net .spb.v { background:#b39af0; }
.spark.gpu .spb.v { background:#7fd0b0; }
.splbl { font-size:10px; color:#5d6775; white-space:nowrap; }
.pill { padding:4px 11px; border-radius:11px; font-size:12px; white-space:nowrap; }
.pill.running { background:#1d3a24; color:#9fd89f; }
.pill.stopped { background:#212933; color:#8a94a3; }
.pill.other { background:#3a2e1d; color:#f0c98a; }
.meta { font-size:12px; color:#5d6775; }
.empty { padding:40px; text-align:center; color:#5d6775; font-size:14px;
         border:1px dashed #2a313c; border-radius:8px; }
.btn { display:inline-block; padding:8px 15px; border-radius:4px; font-size:13px;
       background:#1d3547; color:#7fd0ff; border:1px solid #4fc2f7; margin-right:6px; }
.btn.sm { padding:4px 10px; font-size:12px; margin-right:5px; }
.btn:active { background:#2a4a63; }
.btn.warn { background:#3a2530; color:#f08aa8; border-color:#a04868; }
.btn.dim { background:#161b23; color:#8a94a3; border-color:#2a313c; }
.row { display:flex; gap:16px; align-items:center; margin-bottom:10px; }
.lbl { width:140px; font-size:13px; color:#8a94a3; }
input { background:#0b0e13; border:1px solid #2a313c; border-radius:4px; color:#e8ecf1;
        padding:8px 10px; font-size:14px; width:220px; }
input:focus { border-color:#4fc2f7; outline:none; }
.opts { display:flex; gap:6px; }
.opts.wrap { flex-wrap:wrap; max-width:680px; }
.opt { padding:7px 13px; border-radius:4px; font-size:13px; border:1px solid #2a313c;
       background:#161b23; color:#8a94a3; }
.opt.on { background:#2e4361; color:#7fd0ff; border-color:#4fc2f7; font-weight:bold; }
/* Flattened 45%-opacity equivalents — a real opacity layer would rasterize
   the label onto a transparent backdrop where LCD subpixel blending leaves
   colored fringes. */
.opt.dim { background:#161b23; color:#4a515d; border-color:#1f252e; }
.opt.sm { padding:4px 9px; font-size:12px; }
/* Apply-mode tags on the edit form while the VM runs: boot = frozen into
   QEMU's launch argv (needs restart), live = takes effect immediately. */
.aptag { font-size:10px; padding:1px 7px; border-radius:8px; white-space:nowrap; }
.aptag.boot { color:#f0c98a; border:1px solid #6b5527; }
.aptag.live { color:#9fd89f; border:1px solid #2f5233; }
.crumb { display:inline-block; font-size:12px; color:#7fd0ff; margin-bottom:10px; }
.sharebox { background:#161b23; border:1px solid #2a313c; border-radius:6px;
            padding:10px 14px 2px; margin-top:10px; }
.hint { font-size:12px; color:#5d6775; margin:-4px 0 10px 156px; max-width:560px; line-height:1.45; }
.hostsum { font-size:13px; color:#8a94a3; background:#161b23; border:1px solid #2a313c;
           border-radius:6px; padding:9px 12px; margin-bottom:14px; }
.hostsum b { color:#e8ecf1; }
.vdgrid { display:grid; gap:6px; }
.spinwrap { display:flex; flex-direction:column; align-items:center; justify-content:center;
            height:540px; gap:18px; }
.spinglyph { font-size:64px; color:#7fd0ff; }
.spinlbl { font-size:14px; color:#8a94a3; max-width:460px; text-align:center; line-height:1.5; }
.kv { display:grid; grid-template-columns:160px 1fr; gap:7px 16px; font-size:13px;
      margin-bottom:16px; }
.kv .k { color:#8a94a3; }
.docrow { display:flex; gap:10px; padding:9px 12px; font-size:13px; align-items:center; }
.docrow .ok { color:#9fd89f; font-weight:bold; width:40px; }
.docrow .bad { color:#f08aa8; font-weight:bold; width:40px; }
.docrow .fix { color:#5d6775; font-size:12px; }
.snap { display:inline-block; padding:5px 11px; margin:0 0 6px 0; font-size:12px;
        background:#212933; border-radius:11px 0 0 11px; color:#8a94a3; }
.snap.armed { background:#3a2e1d; color:#f0c98a; }
.snapdel { display:inline-block; padding:5px 9px; margin:0 8px 6px 0; font-size:12px;
        background:#212933; border-radius:0 11px 11px 0; color:#5d6775; }
.snapdel.armed { background:#3a1d1d; color:#f08aa8; }
.logbar { display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
/* On the logs route the scrollpane is a SIBLING of .content (see RouteParts)
   — patching .content's innerHTML would rebuild a nested .logpre on every
   poll, resetting its scroll offset and flashing the pane. A top-level
   scrollport patched via its own innerHTML keeps the node (and offset) alive. */
.content.logtop { flex:0 1 auto; max-height:55%; }
.logpre { flex:1; min-height:80px; margin:0 20px 12px;
          font-family:'Cruiser Mono',monospace; font-size:11px; line-height:1.5;
          background:#0b0e13; border:1px solid #2a313c; border-radius:6px;
          padding:10px 12px; overflow-y:scroll;
          scrollbar-color:#5d6a80 transparent; white-space:pre-wrap;
          word-break:break-all; color:#c8d2e0; }
.logmeta { font-size:11px; color:#5d6775; }
.logerr { color:#f08aa8; }
.unitlist { max-height:104px; overflow-y:scroll; scrollbar-color:#5d6a80 transparent;
            margin:0 0 10px 140px; }
.footer { height:28px; flex-shrink:0;
          background:#161b23; border-top:1px solid #2a313c; }
/* Status notifier — one severity-colored bar (dot + single-line text). */
.fbar { display:flex; align-items:center; gap:9px; height:100%; padding:0 18px;
        font-size:12px; color:#5d6775; }
.fbar .fdot { width:7px; height:7px; border-radius:4px; background:#4a515d; flex-shrink:0; }
.fbar.warn { color:#f0c98a; }
.fbar.warn .fdot { background:#f0c98a; }
.fbar.err { color:#f0b8c8; background:#331e27; }
.fbar.err .fdot { background:#f08aa8; }
.fbar .ftext { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
/* Term route: the .content scrollport becomes a fixed column — the head
   strip stays put and #termbox fills the rest. The embedded webui view
   composites over #termbox's rect (TermManager probes it post-layout). */
.content.termroute { display:flex; flex-direction:column; overflow:hidden; }
.termhead { display:flex; align-items:center; gap:12px; margin-bottom:10px;
            flex-shrink:0; }
.termhead .crumb { margin-bottom:0; }
#termbox { flex:1; min-height:80px; background:#0b0e13;
           border:1px solid #2a313c; border-radius:6px; }
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
    if (paused) parts.push(b("Resume", "vm-resume"));
    if (up || paused) parts.push(b("Stop", "vm-stop", "btn sm dim"));
    if (stopped) parts.push(b("Start", "vm-start"));
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

function vmRow(vm: VmSummary, s: CruiserState): string {
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
    const mode = [GPU_LABEL[vm.gpuMode] ?? vm.gpuMode, HEAD_LABEL[vm.headMode] ?? vm.headMode, ports,
        vm.encrypt !== "off" ? `luks ${vm.encrypt}${vm.diskLocked ? " · locked" : ""}` : ""]
        .filter(Boolean).join(" · ");
    return `<div class="vmrow">
        <div class="grow" data-action="nav" data-route="vm" data-vm="${esc(vm.name)}">
            <div class="vmname">${esc(vm.name)}</div>
            ${vm.description ? `<div class="vmmode">${esc(vm.description)}</div>` : ""}
            <div class="vmspecs">${esc(specs)}</div>
            <div class="vmmode">${esc(mode)}${vm.provisioned ? "" : ` · <span style="color:#f0c98a">not provisioned</span>`}${vm.pendingRestart?.length ? ` · <span style="color:#f0c98a">restart pending: ${esc(vm.pendingRestart.join(", "))}</span>` : ""}</div>
            ${diskParts ? `<div class="vmdisk">${esc(diskParts)}</div>` : ""}
        </div>
        <div class="pill ${pillClass(vm.state)}">${esc(vm.state)}</div>
        <div class="vmbtns">${vmBtns(vm, s)}</div>
        ${up ? sparksFor(vm) : ""}
    </div>`;
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
        grow: "grow the disk",
    } as Record<string, string>)[p.op] ?? p.op;
    return `<div class="hostsum" style="border-color:#6b5527;color:#f0c98a">
        <b>${esc(p.vm)}</b>: the disk is LUKS-encrypted — enter its passphrase to ${esc(opLabel)}.
        <div class="row" style="margin-top:8px">
            <input data-field="unlock-pw" value="${esc(s.unlockPw)}" style="width:240px" placeholder="disk passphrase">
            ${btn("Unlock", "unlock-go", attr("vm", p.vm), "btn sm")}
            ${btn("Cancel", "unlock-cancel", attr("vm", p.vm), "btn sm dim")}</div></div>`;
}

function home(s: CruiserState): string {
    const list = s.vms.length
        ? `<div class="vmlist">${s.vms.map((vm) => vmRow(vm, s)).join("")}</div>`
        : `<div class="empty">No VMs yet.
            <div style="margin-top:14px">${btn("+ New VM", "nav", attr("route", "create"))}</div></div>`;
    return `${unlockBanner(s)}${autoSnapBanner(s)}<div class="vmlist-head"><div class="h1">Virtual Machines</div>
        ${btn("+ New VM", "nav", attr("route", "create"))}</div>
        ${list}`;
}

// ── create wizard ──

function field(label: string, key: string, val: string | number, w = 220, tag = ""): string {
    return `<div class="row"><div class="lbl">${esc(label)}</div>
        <input data-field="${esc(key)}" value="${esc(String(val))}" style="width:${w}px">${tag}</div>`;
}

function optRow(label: string, key: string, cur: string, choices: [string, string][], action = "set-field", tag = ""): string {
    return `<div class="row"><div class="lbl">${esc(label)}</div><div class="opts">${
        choices.map(([v, l]) =>
            `<div class="opt${cur === v ? " on" : ""}" data-action="${action}" data-field="${esc(key)}" data-value="${esc(v)}">${esc(l)}</div>`).join("")
    }</div>${tag}</div>`;
}

function checkRow(label: string, key: string, cur: boolean, hint = "", tag = ""): string {
    return `<div class="row"><div class="lbl">${esc(label)}</div>
        <div class="opt${cur ? " on" : ""}" data-action="set-field" data-field="${esc(key)}" data-value="${!cur}">${cur ? "on" : "off"}</div>
        ${tag}${hint ? `<div class="meta">${esc(hint)}</div>` : ""}</div>`;
}

const PERSIST_HINT: Record<string, string> = {
    daemonize: "keeps running after you close cruiser — reattach anytime",
    owned: "shuts down when you close cruiser — the VM and its disk are kept",
    ephemeral: "shuts down and deletes the VM (config + disk) when you close cruiser",
};

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
        ? `<div class="hostsum">host — <b>${r.cpus}</b> CPUs · <b>${r.memGiB}</b> GiB RAM · <b>${r.diskFreeGiB}</b> GiB free at ${esc(f.diskDir || "default location")}</div>`
        : "";
    const memVal = f.memUnit === "GiB" ? Math.round((f.memMiB / 1024) * 100) / 100 : f.memMiB;
    const memRow = `<div class="row"><div class="lbl">Memory</div>
        <input data-field="memInput" value="${memVal}" style="width:100px">
        <div class="opts">${(["MiB", "GiB"] as const).map((u) =>
            `<div class="opt${f.memUnit === u ? " on" : ""}" data-action="set-field" data-field="memUnit" data-value="${u}">${u}</div>`).join("")}</div>
        ${r ? `<div class="meta">of ${r.memGiB} GiB</div>` : ""}${aptag("boot")}</div>`;
    const diskRow = `<div class="row"><div class="lbl">Disk GiB</div>
        <input data-field="diskGiB" value="${f.diskGiB}" style="width:100px">
        ${editing ? `<div class="meta">grow-only</div>` : r ? `<div class="meta">of ${r.diskFreeGiB} GiB free</div>` : ""}${aptag("boot")}</div>
        ${editing ? "" : `<div class="row"><div class="lbl">Disk location</div>
        <div class="meta" style="width:280px">${esc(f.diskDir || `${VMS_DIR}/‹name›/`)}</div>
        <div class="opt" data-action="pick-disk-dir">Choose…</div></div>`}`;
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
    const provRows =
        f.method === "cloudimg" ? `
            <div class="hint">A <b>cloud image</b> is a prebuilt disk published by the distro — cruiser downloads it once, resizes it to your disk size, and injects a cloud-init seed that creates your user, sets the password, and enables SSH/RDP. Fastest path to a working VM — no installer.</div>
            ${optRow("Guest OS", "distro", f.distro, [["ubuntu", "Ubuntu"], ["debian", "Debian"], ["fedora", "Fedora"]], "set-distro")}
            ${optRow("Release", "release", f.release, (DISTROS[f.distro as keyof typeof DISTROS]?.releases ?? []).map((r) => [r.id, r.label] as [string, string]))}` :
        f.method === "iso" ? `${field("ISO path or URL", "iso", f.iso, 340)}
            <div class="hint">Boots the ISO with a NoCloud autoinstall seed — slower (~20 min) but runs the real installer unattended. Ubuntu ISOs only for now.</div>` :
        f.method === "imported" ? `
            <div class="row"><div class="lbl">Image file</div>
                <input data-field="importPath" value="${esc(f.importPath)}" style="width:340px">
                <div class="opt" data-action="pick-import">Browse…</div></div>
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
        ${checkRow("SSH agent", "syncAgent", f.syncAgent, "forwards the host agent socket into the guest via ssh -R — held for the viewer session; guest processes can use your host keys")}
        ${checkRow("Git SSH key", "syncGitKey", f.syncGitKey, "installs a host private key into the guest (credentials.gitSshKeyPath, else ~/.ssh/<git email>) + an ssh config block for the common forges")}`;
    const usbSection = `<div class="h2">USB passthrough ${aptag("boot")}</div>
        ${s.usbDevices.length
            ? `<div class="opts wrap">${s.usbDevices.map((d) =>
                `<div class="opt${f.usb.includes(d.key) ? " on" : ""}${d.writable ? "" : " dim"}" data-action="usb-toggle" data-key="${esc(d.key)}">${esc(d.label)} <span class="meta">${d.vendorId}:${d.productId}${d.writable ? "" : " · no access"}</span></div>`).join("")}</div>
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
    return `<div class="h1">${editing ? `Edit ${esc(s.editVm ?? "")}` : "New VM"}</div>
        ${hostsum}
        ${importSection}
        ${editing
            ? `<div class="row"><div class="lbl">Name</div><div class="meta" style="color:#e8ecf1">${esc(s.editVm ?? "")}</div></div>
        <div class="row"><div class="lbl">Description</div>
            <input data-field="vm-desc" value="${esc(s.vmDesc)}" style="width:320px">${aptag("live")}</div>
        <div class="hint">exported with the config — a one-liner like "work dev box, cuda testing".</div>`
            : field("Name", "name", f.name)}
        <div class="h2">Resources</div>
        ${field("vCPUs", "cpus", f.cpus, 80, aptag("boot"))}
        ${memRow}
        ${diskRow}
        ${checkRow("Nested virtualization", "nestedVirt", f.nestedVirt, "pass the host's vmx/svm flag to the guest — run KVM inside the VM (needs the host kvm module's nested=1, see doctor)", aptag("boot"))}
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
        ${field("Disk password", "diskPassword", f.diskPassword)}
        ${f.encrypt !== "off" || f.method !== "imported" ? field("Repeat", "diskPassword2", f.diskPassword2) : ""}
        <div class="hint">unlocks the qcow2 image itself — separate from the guest login below, and
            <b>not recoverable</b> if lost.</div>`}`}
        <div class="h2">Graphics &amp; display</div>
        ${optRow("GPU mode", "gpu", f.gpu, [["venus", "Venus (Vulkan)"], ["virgl", "virgl (GL)"], ["software", "software"]], "set-field", aptag("boot"))}
        ${optRow("Head mode", "headMode", f.headMode, [["virtual-desktop", "virtual desktop"], ["fullscreen-monitor", "fullscreen monitor"], ["windowed", "windowed"], ["app", "app-only"]], "set-field", aptag("live"))}
        ${vdPicker}
        ${optRow("Persist", "persist", f.persist, [["daemonize", "survives app"], ["owned", "stops with app"], ["ephemeral", "deleted on exit"]], "set-field", aptag("live"))}
        <div class="hint">${PERSIST_HINT[f.persist] ?? ""}</div>
        <div class="h2">Snapshots ${aptag("live")}</div>
        ${optRow("Auto snapshot", "snapAuto", f.snapAuto, [["off", "off"], ["daily", "daily"], ["weekly", "weekly"], ["monthly", "monthly"]])}
        ${f.snapAuto === "off" ? "" : `
        ${optRow("Take it", "snapTrigger", f.snapTrigger, [["stop", "after shutdown"], ["start", "before start"], ["both", "both"]])}
        ${field("Keep", "snapKeep", f.snapKeep, 80)}
        <div class="hint">auto snapshots are named <b>auto-*</b> and rotate down to the keep count — manual snapshots are never pruned. Only a clean edge can snapshot (qemu-img needs the disk offline): a kill or a host power loss can't.</div>`}
        ${editing ? "" : `<div class="h2">Provisioning</div>
        ${optRow("Method", "method", f.method, [["none", "none"], ["cloudimg", "cloud image"], ["iso", "ISO autoinstall"], ["imported", "import existing"]])}
        ${provRows}
        ${f.method === "none" ? "" : `<div class="h2">Guest software</div>
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
        ${syncSection}
        ${usbSection}
        ${editing ? "" : `<div class="h2">Credentials</div>
        ${field("Username", "username", f.username)}
        ${field("Password", "password", f.password)}`}
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

function vmDetail(s: CruiserState): string {
    const vm = s.vms.find((v) => v.name === s.selectedVm);
    if (!vm) return `<div class="h1">${esc(s.selectedVm ?? "?")}</div><div class="empty">not found</div>`;
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
        ? `<div class="meta">snapshot list + restore appear when the VM is stopped</div>`
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
    // (selection is globally off otherwise).
    const pwRev = s.pwReveal?.vm === vm.name ? s.pwReveal.pw : null;
    const login = !vm.hasPassword
        ? `${esc(vm.username)} · <span class="meta">no password on record</span>`
        : pwRev !== null
            ? `${esc(vm.username)} · <b style="user-select:text">${esc(pwRev)}</b> ${btn("hide", "vm-pw", attr("vm", vm.name), "btn sm dim")}`
            : `${esc(vm.username)} · •••••••• ${btn("show password", "vm-pw", attr("vm", vm.name), "btn sm dim")}`;
    return `<div class="crumb" data-action="nav" data-route="home">‹ VMs</div>
        <div class="h1">${esc(vm.name)} <span class="pill ${pillClass(vm.state)}">${esc(vm.state)}</span></div>
        ${vm.description ? `<div class="meta" style="margin:-8px 0 12px">${esc(vm.description)}</div>` : ""}
        ${vm.pendingRestart?.length
            ? `<div class="hostsum" style="border-color:#6b5527;color:#f0c98a">restart pending — these changed while the VM was up and only apply at the next boot: <b>${esc(vm.pendingRestart.join(", "))}</b>. Stop &amp; start to apply.</div>`
            : ""}
        ${autoSnapBanner(s)}
        ${unlockBanner(s)}
        <div class="kv">
            <div class="k">resources</div><div>${vm.cpus} vCPU · ${Math.round(vm.memMiB / 1024)} GiB · ${vm.diskGiB} GiB disk${vm.nestedVirt ? " · nested virt" : ""}</div>
            ${diskDetail ? `<div class="k">disk usage</div><div>${esc(diskDetail)}</div>` : ""}
            <div class="k">gpu / head</div><div>${esc(vm.gpuMode)} / ${esc(vm.headMode)}</div>
            <div class="k">encryption</div><div>${vm.encrypt === "off" ? "off"
                : `qcow2 LUKS — ${vm.encrypt === "full" ? "full disk" : "/home volume"}`
                  + ` · ${vm.keyStorage === "prompt" ? "passphrase not stored" : "key stored"}${vm.diskLocked ? " · locked" : ""}`}</div>
            <div class="k">ports</div><div>ssh 127.0.0.1:${vm.sshPort ?? "–"} · rdp 127.0.0.1:${vm.rdpPort ?? "–"}</div>
            <div class="k">login</div><div>${login}</div>
            <div class="k">provisioned</div><div>${esc(vm.provisioned ?? "—")}</div>
            <div class="k">persist</div><div>${esc(vm.persist)}</div>
        </div>
        ${up ? `<div class="h2">Usage</div>${sparksFor(vm)}` : ""}
        <div style="margin:10px 0 18px">
            ${vmBtns(vm, s, true)}
        </div>
        <div class="h2">Portable config</div>
        <div class="row"><div class="lbl">Export / pull</div>
            ${btn("Export (yaml)", "vm-export", attr("vm", vm.name), "btn sm")}
            ${btn("Push to gist", "vm-gist-push", attr("vm", vm.name), "btn sm")}
            ${vm.origin ? btn("Pull", "vm-gist-pull", attr("vm", vm.name), "btn sm") : ""}
            <div class="meta">${vm.origin ? esc(vm.origin) : "gist/file origin set on push or import"}</div></div>
        <div class="hint">a *.cruiser.{yaml,toml,json} doc captures the whole spec — import one from the New VM screen</div>
        ${shareSection(vm, s, up)}
        <div class="h2">Snapshots</div>
        ${snapSection}`;
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
        return `<div class="vmrow">
            ${chip("enabled", String(!sh.enabled), sh.enabled ? "on" : "off", sh.enabled)}
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
            <div class="opt sm${armed ? " on" : ""}" data-action="share-rm" data-vm="${esc(vm.name)}" data-idx="${sh.idx}">${armed ? "remove?" : "✕"}</div>
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
            <div class="meta">${sf.mode === "mount" ? "mountpoint — default /mnt/<tag>" : "destination dir — default ~/cruiser-sync/<name>"}</div></div>
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

// ── logs ──

function logsView(s: CruiserState): string {
    const name = s.selectedVm ?? "?";
    const vm = s.vms.find((v) => v.name === name);
    const l = s.logs;
    const chip = (field: string, value: string, label: string, cur: string) =>
        `<div class="opt${cur === value ? " on" : ""}" data-action="log-set" data-field="${esc(field)}" data-value="${esc(value)}">${esc(label)}</div>`;
    const srcTabs = `<div class="opts">${chip("source", "runner", "runner log", l.source)}${chip("source", "journal", "guest journal", l.source)}</div>`;
    const linesSel = `<div class="opts">${[100, 300, 1000, 3000].map((n) => chip("lines", String(n), String(n), String(l.lines))).join("")}</div>`;
    const follow = `<div class="opt${l.follow ? " on" : ""}" data-action="log-set" data-field="follow" data-value="${!l.follow}">follow</div>`;

    const controls = l.source === "runner"
        ? `<div class="row"><div class="lbl">File</div><div class="opts wrap">${l.files.length
            ? l.files.map((f) =>
                `<div class="opt${l.file === f.id ? " on" : ""}${f.exists ? "" : " dim"}" data-action="log-set" data-field="file" data-value="${esc(f.id)}">${esc(f.name)}${f.exists ? ` <span class="meta">${fmtSmall(f.sizeBytes)}</span>` : ""}</div>`).join("")
            : `<span class="meta">probing…</span>`}</div></div>`
        : `${vm?.state === "running" ? "" : `<div class="hint" style="margin-left:0">the guest isn't running — start it to read its journal</div>`}
            <div class="row"><div class="lbl">Unit</div>
                <input data-field="log-unit" value="${esc(l.unit)}" style="width:260px">
                ${l.unit ? `<div class="opt" data-action="log-set" data-field="unit" data-value="">clear</div>` : ""}</div>
            ${l.units.length ? `<div class="opts wrap unitlist">${l.units.slice(0, 80).map((u) =>
                `<div class="opt${l.unit === u ? " on" : ""}" data-action="log-set" data-field="unit" data-value="${esc(u)}">${esc(u)}</div>`).join("")}</div>` : ""}
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
                <div class="meta">regex filter (journalctl -g)</div></div>`;

    const meta = [
        l.fetchedAt ? `fetched ${Math.max(0, Math.round((Date.now() - l.fetchedAt) / 1000))}s ago` : "",
        l.transport ? `via ${l.transport}` : "",
        l.loading ? "fetching…" : "",
    ].filter(Boolean).join(" · ");

    // .logpre is NOT emitted here — it's a sibling of .content patched
    // through the RouteParts.log region so the scrollport node survives
    // content patches (see applyHtml).
    return `<div class="crumb" data-action="nav" data-route="vm" data-vm="${esc(name)}">‹ ${esc(name)}</div>
        <div class="h1">${esc(name)} logs <span class="pill ${pillClass(vm?.state ?? "")}">${esc(vm?.state ?? "?")}</span></div>
        <div class="logbar">${srcTabs}<span class="meta">lines</span>${linesSel}${follow}${btn("Refresh", "log-refresh", "", "btn sm")}</div>
        ${controls}
        <div class="logmeta" style="margin-bottom:6px">${esc(meta)}</div>`;
}

/** Inner markup of the logs scrollpane — patched into .logpre directly so
 *  the scrollport node (and its scroll offset) survives content updates.
 *  .logend is the bottom sentinel the shell probes for "is pinned"
 *  (a class, not an id — scroll events report the nearest ancestor id and
 *  we want them to keep resolving to #logpane). */
function logPaneInner(s: CruiserState): string {
    const l = s.logs;
    const body = l.error ? `<span class="logerr">${esc(l.error)}</span>` : esc(l.text || "(empty)");
    return `${body}<div class="logend" style="height:1px"></div>`;
}

// ── term ──

/** Term route — a head strip + the empty #termbox the webui terminal view
 *  composites over. Sessions outlive the route (TermManager); the head
 *  shows the connect status and offers reconnect / host-window escapes. */
function termView(s: CruiserState): string {
    const name = s.selectedVm ?? "?";
    const vm = s.vms.find((v) => v.name === name);
    return `<div class="termhead">
        <div class="crumb" data-action="nav" data-route="vm" data-vm="${esc(name)}">‹ ${esc(name)}</div>
        <span class="pill ${pillClass(vm?.state ?? "")}">${esc(vm?.state ?? "?")}</span>
        <div class="meta">terminal · ${esc(s.termLine || "…")}</div>
        <div style="flex:1"></div>
        ${btn("Reconnect", "vm-term-reconnect", attr("vm", name), "btn sm dim")}
        ${btn("Open in window", "vm-term-host", attr("vm", name), "btn sm dim")}
    </div>
    <div id="termbox"></div>`;
}

// ── settings / doctor ──

function settings(s: CruiserState): string {
    const h = s.host;
    const hostBlock = h ? `<div class="kv">
            <div class="k">session</div><div>${esc(h.session)}</div>
            <div class="k">wm adapter</div><div>${esc(h.adapterId)}</div>
            <div class="k">monitors</div><div>${h.monitors.map((m) => `${esc(m.name)} ${m.w}x${m.h}@${m.x},${m.y}${m.primary ? "*" : ""}`).join(" · ") || "none"}</div>
            <div class="k">desktops</div><div>${h.desktops.map((d) => `${d.index}${d.name ? ` ${d.name}` : ""}${d.current ? "*" : ""}`).join("  ") || "none"}</div>
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
        ? s.usbDevices.map((d) => `<div class="docrow"><div class="${d.writable ? "ok" : "bad"}">${d.writable ? " ok" : "ro"}</div>
            <div style="flex:1">${esc(d.label)}</div><div class="fix">${d.vendorId}:${d.productId}</div></div>`).join("")
        : `<div class="empty">no USB devices found</div>`;
    const blocked = s.usbDevices.filter((d) => !d.writable).length;
    const docRows = s.doctor === null
        ? ""
        : s.doctor.map((d) => `<div class="docrow"><div class="${d.ok ? "ok" : "bad"}">${d.ok ? " ok" : "FAIL"}</div><div style="flex:1">${esc(d.label)}</div><div class="fix">${esc(d.fix)}</div></div>`).join("");
    return `<div class="h1">Settings &amp; Doctor</div>
        <div class="h2">Host session</div>
        ${hostBlock}
        <div class="h2">Host resources</div>
        ${res}
        <div class="h2">Runtime &amp; toolchain</div>
        ${sysBlock}
        <div class="h2">Paths</div>
        ${pathBlock}
        <div class="h2">USB devices ${blocked ? `<span class="meta">(${blocked} need permission — run doctor for the udev fix)</span>` : ""}</div>
        ${usbBlock}
        <div class="h2">Doctor</div>
        ${btn("Run doctor", "doctor")}${docRows ? `<div style="margin-top:8px">${docRows}</div>` : `<div class="meta" style="display:inline-block;margin-left:10px">not run</div>`}`;
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
    const body =
        s.busy && s.route === "create" ? spinner :
        s.route === "home" ? home(s) :
        s.route === "create" ? create(s) :
        s.route === "vm" ? vmDetail(s) :
        s.route === "logs" ? logsView(s) :
        s.route === "term" ? termView(s) : settings(s);
    const topbar = `<div class="brand">cruiser</div>
        <div class="nav">${nav("home", "VMs", ["home", "create", "vm", "logs", "term"].includes(s.route))}${nav("settings", "Settings")}</div>
        <div style="flex:1"></div>`;
    const fcls = s.statusKind === "error" ? " err" : s.statusKind === "warn" ? " warn" : "";
    const footer = `<div class="fbar${fcls}"><div class="fdot"></div><div class="ftext">${esc(s.status)}</div></div>`;
    const log = s.route === "logs" ? logPaneInner(s) : null;
    return {
        topbar, content: body, footer, log,
        html: `<html><head><style>${fontFaceCss()}${CSS}</style></head><body>
        <div class="topbar">${topbar}</div>
        <div class="content${log !== null ? " logtop" : ""}${s.route === "term" ? " termroute" : ""}">${body}</div>
        ${log !== null ? `<div class="logpre" id="logpane">${log}</div>` : ""}
        <div class="footer">${footer}</div>
    </body></html>`,
    };
}

export function renderRoute(s: CruiserState): string {
    return renderRouteParts(s).html;
}
