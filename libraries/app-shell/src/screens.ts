// ============================================================================
// screens.ts — markup for each route. Plain HTML strings rasterized by the
// Blitz html-ui stack; interactivity via data-action + DOM input events.
// ============================================================================

import type { CruiserState, VmSummary } from "./store";

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#10141a; color:#e8ecf1; font-family:sans-serif; overflow:hidden; }
.topbar { display:flex; align-items:center; gap:12px; padding:0 16px; height:52px;
          background:#161b23; border-bottom:1px solid #2a313c; }
.brand { font-size:16px; font-weight:bold; color:#7fd0ff; }
.nav { display:flex; gap:4px; }
.nav .item { padding:7px 14px; border-radius:4px; font-size:12px; color:#8a94a3; cursor:default; }
.nav .item.on { background:#2e4361; color:#7fd0ff; font-weight:bold; }
.content { padding:20px; height:642px; overflow-y:scroll; }
.h1 { font-size:18px; font-weight:bold; margin-bottom:14px; }
.h2 { font-size:13px; font-weight:bold; margin:18px 0 8px; color:#8a94a3; }
.vmlist { display:flex; flex-direction:column; gap:8px; }
.vmrow { display:flex; align-items:center; gap:14px; padding:12px 16px;
         background:#161b23; border:1px solid #2a313c; border-radius:6px; }
.vmrow .grow { flex:1; }
.vmname { font-size:14px; font-weight:bold; min-width:140px; }
.pill { padding:3px 10px; border-radius:10px; font-size:11px; white-space:nowrap; }
.pill.running { background:#1d3a24; color:#9fd89f; }
.pill.stopped { background:#212933; color:#8a94a3; }
.pill.other { background:#3a2e1d; color:#f0c98a; }
.meta { font-size:11px; color:#5d6775; }
.empty { padding:40px; text-align:center; color:#5d6775; font-size:13px;
         border:1px dashed #2a313c; border-radius:8px; }
.btn { display:inline-block; padding:7px 14px; border-radius:4px; font-size:12px;
       background:#1d3547; color:#7fd0ff; border:1px solid #4fc2f7; margin-right:6px; }
.btn:active { background:#2a4a63; }
.btn.warn { background:#3a2530; color:#f08aa8; border-color:#a04868; }
.btn.dim { background:#161b23; color:#8a94a3; border-color:#2a313c; }
.row { display:flex; gap:16px; align-items:center; margin-bottom:10px; }
.lbl { width:130px; font-size:12px; color:#8a94a3; }
input { background:#0b0e13; border:1px solid #2a313c; border-radius:4px; color:#e8ecf1;
        padding:7px 10px; font-size:13px; width:220px; }
input:focus { border-color:#4fc2f7; outline:none; }
.opts { display:flex; gap:6px; }
.opt { padding:6px 12px; border-radius:4px; font-size:12px; border:1px solid #2a313c;
       background:#161b23; color:#8a94a3; }
.opt.on { background:#2e4361; color:#7fd0ff; border-color:#4fc2f7; font-weight:bold; }
.kv { display:grid; grid-template-columns:150px 1fr; gap:6px 16px; font-size:12px;
      margin-bottom:16px; }
.kv .k { color:#8a94a3; }
.docrow { display:flex; gap:10px; padding:8px 12px; font-size:12px; align-items:center; }
.docrow .ok { color:#9fd89f; font-weight:bold; width:40px; }
.docrow .bad { color:#f08aa8; font-weight:bold; width:40px; }
.docrow .fix { color:#5d6775; font-size:11px; }
.snap { display:inline-block; padding:4px 10px; margin:0 6px 6px 0; font-size:11px;
        background:#212933; border-radius:10px; color:#8a94a3; }
.footer { position:absolute; left:0; right:0; bottom:0; height:26px;
          display:flex; align-items:center; padding:0 16px;
          background:#161b23; border-top:1px solid #2a313c;
          font-size:11px; color:#5d6775; }
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

function vmRow(vm: VmSummary): string {
    const up = vm.state === "running";
    return `<div class="vmrow">
        <div class="vmname" data-action="nav" data-route="vm" data-vm="${esc(vm.name)}">${esc(vm.name)}</div>
        <div class="pill ${pillClass(vm.state)}">${esc(vm.state)}</div>
        <div class="meta grow">${esc(vm.gpuMode)} · ${esc(vm.headMode)} · ${vm.cpus}c/${Math.round(vm.memMiB / 1024)}G · ssh:${vm.sshPort ?? "-"} rdp:${vm.rdpPort ?? "-"}${vm.provisioned ? ` · ${esc(vm.provisioned)}` : " · unprovisioned"}</div>
        ${up
            ? btn("View", "vm-view", attr("vm", vm.name)) + btn("Stop", "vm-stop", attr("vm", vm.name), "btn dim")
            : btn("Start", "vm-start", attr("vm", vm.name))}
    </div>`;
}

function home(s: CruiserState): string {
    const list = s.vms.length
        ? `<div class="vmlist">${s.vms.map(vmRow).join("")}</div>`
        : `<div class="empty">No VMs yet — use <b>New VM</b> above.</div>`;
    return `<div class="h1">Virtual Machines</div>${list}`;
}

// ── create wizard ──

function field(label: string, key: string, val: string | number, w = 220): string {
    return `<div class="row"><div class="lbl">${esc(label)}</div>
        <input data-field="${esc(key)}" value="${esc(String(val))}" style="width:${w}px"></div>`;
}

function optRow(label: string, key: string, cur: string, choices: [string, string][]): string {
    return `<div class="row"><div class="lbl">${esc(label)}</div><div class="opts">${
        choices.map(([v, l]) =>
            `<div class="opt${cur === v ? " on" : ""}" data-action="set-field" data-field="${esc(key)}" data-value="${esc(v)}">${esc(l)}</div>`).join("")
    }</div></div>`;
}

function create(s: CruiserState): string {
    const f = s.create;
    const provRows = f.method === "cloudimg"
        ? field("Ubuntu release", "release", f.release)
        : f.method === "iso" ? field("ISO path or URL", "iso", f.iso, 340) : "";
    return `<div class="h1">New VM</div>
        ${field("Name", "name", f.name || "my-vm")}
        <div class="h2">Resources</div>
        ${field("vCPUs", "cpus", f.cpus, 80)}
        ${field("Memory MiB", "memMiB", f.memMiB, 100)}
        ${field("Disk GiB", "diskGiB", f.diskGiB, 100)}
        <div class="h2">Graphics &amp; display</div>
        ${optRow("GPU mode", "gpu", f.gpu, [["venus", "Venus (Vulkan)"], ["virgl", "virgl (GL)"], ["software", "software"]])}
        ${optRow("Head mode", "headMode", f.headMode, [["virtual-desktop", "virtual desktop"], ["fullscreen-monitor", "fullscreen monitor"], ["windowed", "windowed"], ["app", "app-only"]])}
        ${optRow("Persist", "persist", f.persist, [["daemonize", "survives app"], ["owned", "dies with app"]])}
        <div class="h2">Provisioning</div>
        ${optRow("Method", "method", f.method, [["none", "none"], ["cloudimg", "cloud image"], ["iso", "ISO autoinstall"]])}
        ${provRows}
        ${field("Username", "username", f.username)}
        ${field("Password", "password", f.password)}
        <div style="margin-top:18px">${btn("Create VM", "vm-create")}${btn("Cancel", "nav", attr("route", "home"), "btn dim")}</div>`;
}

// ── vm detail ──

function vmDetail(s: CruiserState): string {
    const vm = s.vms.find((v) => v.name === s.selectedVm);
    if (!vm) return `<div class="h1">${esc(s.selectedVm ?? "?")}</div><div class="empty">not found</div>`;
    const up = vm.state === "running";
    const snaps = vm.snapshots.length
        ? vm.snapshots.map((sn) => `<span class="snap" data-action="vm-restore" data-vm="${esc(vm.name)}" data-snap="${esc(sn)}">${esc(sn)}</span>`).join("")
        : `<span class="meta">none</span>`;
    return `<div class="h1">${esc(vm.name)} <span class="pill ${pillClass(vm.state)}">${esc(vm.state)}</span></div>
        <div class="kv">
            <div class="k">resources</div><div>${vm.cpus} vCPU · ${Math.round(vm.memMiB / 1024)} GiB · ${vm.diskGiB} GiB disk</div>
            <div class="k">gpu / head</div><div>${esc(vm.gpuMode)} / ${esc(vm.headMode)}</div>
            <div class="k">ports</div><div>ssh 127.0.0.1:${vm.sshPort ?? "–"} · rdp 127.0.0.1:${vm.rdpPort ?? "–"}</div>
            <div class="k">provisioned</div><div>${esc(vm.provisioned ?? "no")}</div>
            <div class="k">persist</div><div>${esc(vm.persist)}</div>
        </div>
        <div style="margin:10px 0 18px">
            ${up ? btn("View", "vm-view", attr("vm", vm.name)) + btn("Stop", "vm-stop", attr("vm", vm.name), "btn dim") + btn("Kill", "vm-kill", attr("vm", vm.name), "btn warn")
                 : btn("Start", "vm-start", attr("vm", vm.name)) + btn("Delete", "vm-rm", attr("vm", vm.name), "btn warn")}
        </div>
        <div class="h2">Snapshots</div>
        <div>${snaps}</div>
        <div style="margin-top:8px">${btn("Take snapshot", "vm-snap", attr("vm", vm.name))}</div>`;
}

// ── settings / doctor ──

function settings(s: CruiserState): string {
    const h = s.host;
    const hostBlock = h ? `<div class="kv">
            <div class="k">session</div><div>${esc(h.session)}</div>
            <div class="k">wm adapter</div><div>${esc(h.adapterId)}</div>
            <div class="k">monitors</div><div>${h.monitors.map((m) => `${esc(m.name)} ${m.w}x${m.h}@${m.x},${m.y}${m.primary ? "*" : ""}`).join(" · ") || "none"}</div>
            <div class="k">desktops</div><div>${h.desktops.map((d) => `${d.index}${d.current ? "*" : ""}`).join(" ") || "none"}</div>
            <div class="k">caps</div><div>${Object.entries(h.caps).filter(([k]) => k !== "notes").map(([k, v]) => `${k}:${v ? "yes" : "no"}`).join(" ")}</div>
        </div>` : `<div class="empty">probing host…</div>`;
    const docRows = s.doctor === null
        ? ""
        : s.doctor.map((d) => `<div class="docrow"><div class="${d.ok ? "ok" : "bad"}">${d.ok ? " ok" : "FAIL"}</div><div style="flex:1">${esc(d.label)}</div><div class="fix">${esc(d.fix)}</div></div>`).join("");
    return `<div class="h1">Settings &amp; Doctor</div>
        <div class="h2">Host session</div>
        ${hostBlock}
        <div class="h2">Doctor</div>
        ${btn("Run doctor", "doctor")}${docRows ? `<div style="margin-top:8px">${docRows}</div>` : `<div class="meta" style="display:inline-block;margin-left:10px">not run</div>`}`;
}

export function renderRoute(s: CruiserState): string {
    const nav = (r: string, label: string) =>
        `<div class="item${s.route === r ? " on" : ""}" data-action="nav" data-route="${r}">${label}</div>`;
    const body =
        s.route === "home" ? home(s) :
        s.route === "create" ? create(s) :
        s.route === "vm" ? vmDetail(s) : settings(s);
    return `<html><head><style>${CSS}</style></head><body>
        <div class="topbar"><div class="brand">cruiser</div>
            <div class="nav">${nav("home", "VMs")}${nav("create", "New VM")}${nav("settings", "Settings")}</div>
            <div style="flex:1"></div>
            ${s.busy ? `<div class="meta">working…</div>` : ""}
        </div>
        <div class="content">${body}</div>
        <div class="footer">${esc(s.status)}</div>
    </body></html>`;
}
