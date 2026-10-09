// ============================================================================
// store.ts — cruiser app state. Zustand store; panels re-render on change.
// ============================================================================

import { createStore } from "zustand/vanilla";
import type { VmState } from "../../vm-core/src/lifecycle/vm";

export type { VmState };

export interface VmSummary {
    name: string;
    state: VmState;
    gpuMode: string;
    headMode: string;
    cpus: number;
    memMiB: number;
    diskGiB: number;
    sshPort?: number;
    rdpPort?: number;
    provisioned?: string;          // method or undefined
    persist: string;
    snapshots: string[];
    hostDiskBytes?: number;        // real size of the disk image on the host fs
    guestUsedBytes?: number;       // guest fs used (QGA root mount / sum)
    guestTotalBytes?: number;      // guest fs total (≈ diskGiB cap)
    cpu: number[];                 // recent cpu% samples (0–100), newest last
    mem: number[];                 // recent mem% samples
    error?: string;
}

export interface CreateForm {
    name: string;
    cpus: number;
    memMiB: number;
    diskGiB: number;
    gpu: string;                   // venus|virgl|software
    headMode: string;              // fullscreen-monitor|windowed|virtual-desktop|app
    persist: string;               // daemonize|owned|ephemeral
    method: string;                // none|cloudimg|iso|imported
    release: string;               // cloudimg release
    iso: string;                   // iso path/url
    importPath: string;            // imported: existing disk image (absolute)
    diskDir: string;               // "" = default (vms dir); else disk file's dir
    username: string;
    password: string;              // kept in-memory only; writePasswordFile persists to 0600
    memUnit: "MiB" | "GiB";        // UI-only — memMiB always stores MiB
    vd: number;                    // virtual-desktop head mode: desktop index (1-based)
    usb: string[];                 // "vid:pid:serial?" keys selected for boot-time passthrough
}

export interface DoctorRow { label: string; ok: boolean; fix: string }

export interface HostInfo {
    session: string;
    adapterId: string;
    caps: Record<string, boolean | string>;
    monitors: { name: string; x: number; y: number; w: number; h: number; primary: boolean }[];
    desktops: { index: number; id?: string; name?: string; current?: boolean }[];
}

/** Host resource totals shown on the create screen. */
export interface SysInfo {
    configDir: string;
    dataDir: string;
    cacheDir: string;
    vmsDir: string;
    isoDir: string;
    cloudimgDir: string;
    qemu: string | null;
    xfreerdp: string | null;
    qemuFromOpt: boolean;
    /** JS runtime the shell is executing under, e.g. "bun 1.4.2". */
    runtime: string;
    /** display env summary, e.g. "x11 · :0". */
    displayEnv: string;
    /** HTML doc backend in use (local in-process vs worker). */
    uiBackend: string;
}

export interface HostResources {
    cpus: number;
    memGiB: number;
    /** Free space (GiB) at the chosen disk directory. */
    diskFreeGiB: number;
}

/** USB device row for the passthrough picker (subset of vm-core UsbDevice). */
export interface UsbChoice {
    key: string;                   // "vid:pid:serial|"
    vendorId: string;
    productId: string;
    serial?: string;
    label: string;                 // "Vendor Product"
    writable: boolean;
}

export type Route = "home" | "create" | "vm" | "settings";

export interface CruiserState {
    route: Route;
    selectedVm: string | null;
    vms: VmSummary[];
    status: string;
    busy: boolean;                 // an async action is in flight
    create: CreateForm;
    doctor: DoctorRow[] | null;
    host: HostInfo | null;
    hostRes: HostResources | null;
    desktops: { index: number; name?: string; current?: boolean }[];
    vdRows: number;                // best-effort grid rows for the VD picker
    usbDevices: UsbChoice[];
    sysinfo: SysInfo | null;
}

export interface CruiserActions {
    setRoute(route: Route, vm?: string | null): void;
    setVms(vms: VmSummary[]): void;
    setStatus(status: string): void;
    setBusy(busy: boolean): void;
    setField<K extends keyof CreateForm>(k: K, v: CreateForm[K]): void;
    resetCreate(): void;
    setDoctor(rows: DoctorRow[] | null): void;
    setHost(h: HostInfo | null): void;
    setHostRes(r: HostResources | null): void;
    setDesktops(ds: { index: number; name?: string; current?: boolean }[], rows: number): void;
    setUsbDevices(ds: UsbChoice[]): void;
    toggleUsb(key: string): void;
    setSysinfo(si: SysInfo | null): void;
}

export type CruiserStore = CruiserState & CruiserActions;

const defaultCreate = (): CreateForm => ({
    name: "", cpus: 4, memMiB: 8192, diskGiB: 100,
    gpu: "venus", headMode: "virtual-desktop", persist: "daemonize",
    method: "cloudimg", release: "26.04", iso: "", importPath: "", diskDir: "",
    username: "cruiser", password: "",
    memUnit: "GiB", vd: 0, usb: [],
});

export function createCruiserStore() {
    return createStore<CruiserStore>((set) => ({
        route: "home",
        selectedVm: null,
        vms: [],
        status: "ready",
        busy: false,
        create: defaultCreate(),
        doctor: null,
        host: null,
        hostRes: null,
        desktops: [],
        vdRows: 1,
        usbDevices: [],
        sysinfo: null,
        setRoute: (route, vm = null) => set({ route, selectedVm: vm }),
        setVms: (vms) => set({ vms }),
        setStatus: (status) => set({ status }),
        setBusy: (busy) => set({ busy }),
        setField: (k, v) => set((s) => ({ create: { ...s.create, [k]: v } })),
        resetCreate: () => set({ create: defaultCreate() }),
        setDoctor: (doctor) => set({ doctor }),
        setHost: (host) => set({ host }),
        setHostRes: (hostRes) => set({ hostRes }),
        setDesktops: (desktops, vdRows) => set({ desktops, vdRows }),
        setUsbDevices: (usbDevices) => set({ usbDevices }),
        setSysinfo: (sysinfo) => set({ sysinfo }),
        toggleUsb: (key) => set((s) => ({
            create: {
                ...s.create,
                usb: s.create.usb.includes(key) ? s.create.usb.filter((k) => k !== key) : [...s.create.usb, key],
            },
        })),
    }));
}

export type Store = ReturnType<typeof createCruiserStore>;
