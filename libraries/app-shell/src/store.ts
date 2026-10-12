// ============================================================================
// store.ts — cruiser app state. Zustand store; panels re-render on change.
// ============================================================================

import { createStore } from "zustand/vanilla";
import type { VmState } from "../../vm-core/src/lifecycle/vm";

export type { VmState };

/** A spec.shares entry as rendered on the vm detail screen. */
export interface ShareRow {
    idx: number;                   // index into spec.shares
    tag: string;
    hostPath: string;
    guestPath?: string;
    mode: string;                  // "mount" | "copy"
    direction: string;             // "both" | "host-to-guest"
    enabled: boolean;
    deletions: boolean;
}

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
    description: string;           // spec.description
    origin?: string;               // "gist:<id>" / "file:<path>" when imported/pushed
    shares: ShareRow[];            // spec.shares
    snapshots: string[];
    vd: number;                    // display.virtualDesktop (edit form)
    usbKeys: string[];             // spec.usb.autoAttach as "vid:pid:serial" keys
    sync?: Record<string, boolean>; // spec.sync.* — feeds the edit form
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
    distro: string;                // ubuntu|debian|fedora
    release: string;               // cloudimg release
    desktop: string;               // gnome|kde
    browser: string;               // none|firefox|chrome|chromium|vivaldi|brave
    snap: boolean;                 // install snapd (off → flatpak only)
    extraFonts: boolean;           // CJK + MS core fonts beyond the base bundle
    autologin: boolean;            // DM autologin into the desktop at boot
    preset: string;                // standard|developer — developer reveals the devtools menu
    devtools: string[];            // DevTool ids selected in the developer preset
    // host → guest sync (spec.sync.*) — the last four are off by default:
    // they push host credentials/identity/trust into the guest
    syncTheme: boolean;            // dark/light hint
    syncAccent: boolean;           // accent color
    syncContrast: boolean;         // high-contrast preference
    syncTimezone: boolean;         // host timezone
    syncLocale: boolean;           // host LANG
    syncKeyboard: boolean;         // host keymap
    syncMonitors: boolean;         // host monitor topology (GNOME guests)
    syncHostWallpaper: boolean;    // host wallpaper as composite source
    syncGit: boolean;              // ~/.gitconfig user.name/email
    syncProxy: boolean;            // host proxy config
    syncCa: boolean;               // host custom CA roots
    syncAgent: boolean;            // ssh -R agent socket forward
    syncShares: boolean;           // guest fstab/mount reconcile for spec.shares
    iso: string;                   // iso path/url
    importPath: string;            // imported: existing disk image (absolute)
    importRef: string;             // config import: gist url/id or .cruiser.* file path
    diskDir: string;               // "" = default (vms dir); else disk file's dir
    username: string;
    password: string;              // kept in-memory only; writePasswordFile persists to 0600
    memUnit: "MiB" | "GiB";        // UI-only — memMiB always stores MiB
    vd: number;                    // virtual-desktop head mode: desktop index (1-based)
    usb: string[];                 // "vid:pid:serial?" keys selected for boot-time passthrough
}

export interface DoctorRow { label: string; ok: boolean; fix: string }

/** In-flight action shown on the triggering VM's button (the ◐ glyph is
 *  animated by the shell's busy ticker via [data-spin]). */
export interface ActionState {
    vm: string | null;             // target VM; null = global op (create/doctor)
    verb: string;                  // "stopping" | "starting" | …
    at: number;                    // Date.now() — label derives elapsed seconds
}

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

export type Route = "home" | "create" | "vm" | "settings" | "logs";

/** Logs screen state — source picker + journal filters + fetched text. */
export interface LogsState {
    source: "runner" | "journal";
    file: string;                // runner log id ("cruiser" | "qemu" | "serial" | "install-serial")
    follow: boolean;             // poll the source while the screen is open
    lines: number;
    unit: string;
    priority: string;            // "" = all
    boot: string;                // "" = all boots, "0" current, "-1" previous…
    since: string;               // journalctl timespec, "" = unset
    grep: string;                // -g regex, "" = unset
    text: string;
    error: string | null;
    transport: string;           // "qga" | "ssh" | "" — last journal fetch
    files: { id: string; name: string; path: string; exists: boolean; sizeBytes: number }[];
    units: string[];             // _SYSTEMD_UNIT values from the current boot
    fetchedAt: number;
    loading: boolean;
}

export interface CruiserState {
    route: Route;
    selectedVm: string | null;
    vms: VmSummary[];
    status: string;
    busy: boolean;                 // an async action is in flight
    action: ActionState | null;    // which action — renders on its VM's button
    create: CreateForm;
    doctor: DoctorRow[] | null;
    host: HostInfo | null;
    hostRes: HostResources | null;
    desktops: { index: number; name?: string; current?: boolean }[];
    vdRows: number;                // best-effort grid rows for the VD picker
    usbDevices: UsbChoice[];
    sysinfo: SysInfo | null;
    /** Two-click confirm token for destructive actions ("vm-rm:<name>" etc.)
     *  — first click arms the button, second executes. */
    confirm: string | null;
    /** Name of the VM being edited in the create wizard (edit mode), or null. */
    editVm: string | null;
    logs: LogsState;
    /** Description edit buffer on the vm detail screen (loaded on nav). */
    vmDesc: string;
    /** The share-add form on the vm detail screen. */
    shareForm: ShareForm;
}

export interface ShareForm {
    hostPath: string;
    guestPath: string;
    mode: "mount" | "copy";
    direction: "both" | "host-to-guest";
}

export interface CruiserActions {
    setRoute(route: Route, vm?: string | null): void;
    setVms(vms: VmSummary[]): void;
    setStatus(status: string): void;
    setBusy(busy: boolean): void;
    setAction(a: ActionState | null): void;
    setField<K extends keyof CreateForm>(k: K, v: CreateForm[K]): void;
    resetCreate(): void;
    setDoctor(rows: DoctorRow[] | null): void;
    setHost(h: HostInfo | null): void;
    setHostRes(r: HostResources | null): void;
    setDesktops(ds: { index: number; name?: string; current?: boolean }[], rows: number): void;
    setUsbDevices(ds: UsbChoice[]): void;
    toggleUsb(key: string): void;
    toggleDevtool(id: string): void;
    setSysinfo(si: SysInfo | null): void;
    setConfirm(c: string | null): void;
    setEditVm(name: string | null): void;
    setLogs(p: Partial<LogsState>): void;
    setVmDesc(d: string): void;
    setShareForm(p: Partial<ShareForm>): void;
}

export type CruiserStore = CruiserState & CruiserActions;

const defaultLogs = (): LogsState => ({
    source: "runner", file: "cruiser", follow: false,
    lines: 300, unit: "", priority: "", boot: "0", since: "", grep: "",
    text: "", error: null, transport: "", files: [], units: [], fetchedAt: 0, loading: false,
});

const defaultCreate = (): CreateForm => ({
    name: "", cpus: 4, memMiB: 8192, diskGiB: 100,
    gpu: "venus", headMode: "virtual-desktop", persist: "daemonize",
    method: "cloudimg", distro: "ubuntu", release: "26.04", desktop: "gnome",
    browser: "none", snap: false, extraFonts: false, autologin: true,
    preset: "standard", devtools: [],
    syncTheme: true, syncAccent: true, syncContrast: true, syncTimezone: true,
    syncLocale: true, syncKeyboard: true, syncMonitors: true, syncHostWallpaper: true,
    syncGit: false, syncProxy: false, syncCa: false, syncAgent: false, syncShares: true,
    iso: "", importPath: "", importRef: "", diskDir: "",
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
        action: null,
        create: defaultCreate(),
        doctor: null,
        host: null,
        hostRes: null,
        desktops: [],
        vdRows: 1,
        usbDevices: [],
        sysinfo: null,
        confirm: null,
        editVm: null,
        logs: defaultLogs(),
        vmDesc: "",
        shareForm: { hostPath: "", guestPath: "", mode: "mount", direction: "both" },
        setRoute: (route, vm = null) => set({ route, selectedVm: vm, confirm: null, editVm: null }),
        setVms: (vms) => set({ vms }),
        setStatus: (status) => set({ status }),
        setBusy: (busy) => set({ busy }),
        setAction: (action) => set({ action }),
        setField: (k, v) => set((s) => ({ create: { ...s.create, [k]: v } })),
        resetCreate: () => set({ create: defaultCreate() }),
        setDoctor: (doctor) => set({ doctor }),
        setHost: (host) => set({ host }),
        setHostRes: (hostRes) => set({ hostRes }),
        setDesktops: (desktops, vdRows) => set({ desktops, vdRows }),
        setUsbDevices: (usbDevices) => set({ usbDevices }),
        setSysinfo: (sysinfo) => set({ sysinfo }),
        setConfirm: (confirm) => set({ confirm }),
        setEditVm: (editVm) => set({ editVm }),
        setLogs: (p) => set((s) => ({ logs: { ...s.logs, ...p } })),
        setVmDesc: (vmDesc) => set({ vmDesc }),
        setShareForm: (p) => set((s) => ({ shareForm: { ...s.shareForm, ...p } })),
        toggleUsb: (key) => set((s) => ({
            create: {
                ...s.create,
                usb: s.create.usb.includes(key) ? s.create.usb.filter((k) => k !== key) : [...s.create.usb, key],
            },
        })),
        toggleDevtool: (id) => set((s) => ({
            create: {
                ...s.create,
                devtools: s.create.devtools.includes(id)
                    ? s.create.devtools.filter((k) => k !== id)
                    : [...s.create.devtools, id],
            },
        })),
    }));
}

export type Store = ReturnType<typeof createCruiserStore>;
