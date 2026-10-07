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
    error?: string;
}

export interface CreateForm {
    name: string;
    cpus: number;
    memMiB: number;
    diskGiB: number;
    gpu: string;                   // venus|virgl|software
    headMode: string;              // fullscreen-monitor|windowed|virtual-desktop|app
    persist: string;               // daemonize|owned
    method: string;                // cloudimg|iso
    release: string;               // cloudimg release
    iso: string;                   // iso path/url
    username: string;
    password: string;              // kept in-memory only; writePasswordFile persists to 0600
}

export interface DoctorRow { label: string; ok: boolean; fix: string }

export interface HostInfo {
    session: string;
    adapterId: string;
    caps: Record<string, boolean | string>;
    monitors: { name: string; x: number; y: number; w: number; h: number; primary: boolean }[];
    desktops: { index: number; id?: string; name?: string; current?: boolean }[];
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
}

export type CruiserStore = CruiserState & CruiserActions;

const defaultCreate = (): CreateForm => ({
    name: "", cpus: 4, memMiB: 8192, diskGiB: 100,
    gpu: "venus", headMode: "virtual-desktop", persist: "daemonize",
    method: "cloudimg", release: "26.04", iso: "",
    username: "cruiser", password: "",
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
        setRoute: (route, vm = null) => set({ route, selectedVm: vm }),
        setVms: (vms) => set({ vms }),
        setStatus: (status) => set({ status }),
        setBusy: (busy) => set({ busy }),
        setField: (k, v) => set((s) => ({ create: { ...s.create, [k]: v } })),
        resetCreate: () => set({ create: defaultCreate() }),
        setDoctor: (doctor) => set({ doctor }),
        setHost: (host) => set({ host }),
    }));
}

export type Store = ReturnType<typeof createCruiserStore>;
