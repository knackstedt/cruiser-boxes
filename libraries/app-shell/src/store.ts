// ============================================================================
// store.ts — cruiser app state. Zustand store; panels bind to slices and
// mutate via actions. vm-core feeds VmSummary updates in via setVms().
// ============================================================================

import { createStore } from "zustand/vanilla";

export type VmState =
    | "stopped" | "starting" | "running" | "stopping"
    | "paused" | "crashed" | "provisioning" | "unknown";

export interface VmSummary {
    name: string;
    state: VmState;
    gpuMode: string;
    headMode: string;
    detail?: string;
}

export type Route = "home" | "create" | "vm" | "settings";

export interface CruiserState {
    route: Route;
    /** Selected VM name when route === "vm". */
    selectedVm: string | null;
    vms: VmSummary[];
    /** One-line status/toast shown in the footer. */
    status: string;
}

export interface CruiserActions {
    setRoute(route: Route, vm?: string | null): void;
    setVms(vms: VmSummary[]): void;
    setStatus(status: string): void;
}

export type CruiserStore = CruiserState & CruiserActions;

export function createCruiserStore() {
    return createStore<CruiserStore>((set) => ({
        route: "home",
        selectedVm: null,
        vms: [],
        status: "ready",
        setRoute: (route, vm = null) => set({ route, selectedVm: vm }),
        setVms: (vms) => set({ vms }),
        setStatus: (status) => set({ status }),
    }));
}

export type Store = ReturnType<typeof createCruiserStore>;
