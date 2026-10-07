// ============================================================================
// screens.ts — markup for each route. Plain HTML strings rasterized by the
// Blitz html-ui stack; interactivity via data-action + DOM events.
// ============================================================================

import type { CruiserState, VmSummary } from "./store";

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#10141a; color:#e8ecf1; font-family:sans-serif; overflow:hidden; }
.topbar { display:flex; align-items:center; gap:12px; padding:0 16px; height:52px;
          background:#161b23; border-bottom:1px solid #2a313c; }
.brand { font-size:16px; font-weight:bold; color:#7fd0ff; }
.nav { display:flex; gap:4px; }
.nav .item { padding:7px 14px; border-radius:4px; font-size:12px; color:#8a94a3; }
.nav .item.on { background:#2e4361; color:#7fd0ff; font-weight:bold; }
.content { padding:20px; }
.h1 { font-size:18px; font-weight:bold; margin-bottom:14px; }
.vmlist { display:flex; flex-direction:column; gap:8px; }
.vmrow { display:flex; align-items:center; gap:14px; padding:12px 16px;
         background:#161b23; border:1px solid #2a313c; border-radius:6px; }
.vmname { font-size:14px; font-weight:bold; width:180px; }
.pill { padding:3px 10px; border-radius:10px; font-size:11px; }
.pill.running { background:#1d3a24; color:#9fd89f; }
.pill.stopped { background:#212933; color:#8a94a3; }
.pill.other { background:#3a2e1d; color:#f0c98a; }
.meta { font-size:11px; color:#5d6775; }
.empty { padding:40px; text-align:center; color:#5d6775; font-size:13px;
         border:1px dashed #2a313c; border-radius:8px; }
.btn { display:inline-block; padding:8px 16px; border-radius:4px; font-size:12px;
       background:#1d3547; color:#7fd0ff; border:1px solid #4fc2f7; }
.btn:active { background:#2a4a63; }
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

function vmRow(vm: VmSummary): string {
    return `<div class="vmrow" data-action="nav" data-route="vm" data-vm="${esc(vm.name)}">
        <div class="vmname">${esc(vm.name)}</div>
        <div class="pill ${pillClass(vm.state)}">${esc(vm.state)}</div>
        <div class="meta">${esc(vm.gpuMode)} · ${esc(vm.headMode)}</div>
    </div>`;
}

function home(s: CruiserState): string {
    const list = s.vms.length
        ? `<div class="vmlist">${s.vms.map(vmRow).join("")}</div>`
        : `<div class="empty">No VMs yet. Use <b>cruiser create</b> (coming soon) or the wizard.</div>`;
    return `<div class="content"><div class="h1">Virtual Machines</div>${list}</div>`;
}

function create(): string {
    return `<div class="content"><div class="h1">New VM</div>
        <div class="empty">Create wizard — provisioning pipeline lands in phase 5.</div></div>`;
}

function vmDetail(s: CruiserState): string {
    const vm = s.vms.find((v) => v.name === s.selectedVm);
    return `<div class="content"><div class="h1">${esc(s.selectedVm ?? "vm")}</div>
        <div class="empty">${vm ? esc(vm.detail ?? "running") : "vm not found"}</div></div>`;
}

function settings(): string {
    return `<div class="content"><div class="h1">Settings</div>
        <div class="empty">Toolchain status, host integration, escape shortcuts — lands with host-int.</div></div>`;
}

export function renderRoute(s: CruiserState): string {
    const nav = (r: string, label: string) =>
        `<div class="item${s.route === r ? " on" : ""}" data-action="nav" data-route="${r}">${label}</div>`;
    const body =
        s.route === "home" ? home(s) :
        s.route === "create" ? create() :
        s.route === "vm" ? vmDetail(s) : settings();
    return `<html><head><style>${CSS}</style></head><body>
        <div class="topbar"><div class="brand">cruiser</div>
            <div class="nav">${nav("home", "VMs")}${nav("create", "New VM")}${nav("settings", "Settings")}</div>
        </div>
        ${body}
        <div class="footer">${esc(s.status)}</div>
    </body></html>`;
}
