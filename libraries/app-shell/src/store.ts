// ============================================================================
// store.ts — cruiser app state. Zustand store; panels re-render on change.
// ============================================================================

import { createStore } from "zustand/vanilla";
import type { VmState } from "../../vm-core/src/lifecycle/vm";
import { syncFormDefaults, type SyncFormKey } from "../../vm-core/src/config/sync-channels";

export type { VmState };
export type { SyncFormKey };

/** The flat sync* fields — keys derive from SYNC_CHANNELS.formKey, so the
 *  create form and spec.sync can never drift apart. */
export type SyncFormFields = { [K in SyncFormKey]: boolean };

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
    swVk: boolean;                 // spec.gpu.softwareVk — host lavapipe over Venus
    headMode: string;
    cpus: number;
    memMiB: number;
    diskGiB: number;
    nestedVirt: boolean;           // spec.resources.nestedVirt
    sshPort?: number;
    rdpPort?: number;
    provisioned?: string;          // method or undefined
    persist: string;
    autostart: boolean;            // spec.autostart — start with the app + at login
    netMode: string;               // spec.network.mode — nat|restricted|isolated|vmnet
    username: string;              // spec.credentials.username
    hasPassword: boolean;          // spec.credentials.passwordFile set
    encrypt: string;               // spec.disk.encrypt — off|full|home
    keyStorage: string;            // spec.disk.keyStorage — store|prompt
    /** encrypted && no key material on disk — a prompt-mode VM waiting on
     *  the unlock banner before any keyed op (start/snapshot/…). */
    diskLocked: boolean;
    description: string;           // spec.description
    origin?: string;               // "gist:<id>" / "file:<path>" when imported/pushed
    shares: ShareRow[];            // spec.shares
    snapshots: string[];
    snapAuto: string;              // spec.snapshots.auto — off|daily|weekly|monthly
    snapTrigger: string;           // spec.snapshots.trigger — start|stop|both
    snapKeep: number;              // spec.snapshots.keep
    vd: number;                    // display.virtualDesktop (edit form)
    usbKeys: string[];             // spec.usb.autoAttach as "vid:pid:serial" keys
    forwards: FwdRow[];            // spec.network.hostfwd (auto = the ssh/rdp pair)
    /** host mountpoint when the guest home is sshfs-mounted (default
     *  ~/.local/share/cruiser/mounts/<vm>), null when unmounted. */
    mount?: string | null;
    sync?: Record<string, boolean>; // spec.sync.* — feeds the edit form
    /** Spec sections changed while running that only apply at next boot
     *  (VmHandle.pendingRestart) — drives the "restart pending" marker. */
    pendingRestart?: string[];
    hostDiskBytes?: number;        // real size of the disk image on the host fs
    guestUsedBytes?: number;       // guest fs used (QGA root mount / sum)
    guestTotalBytes?: number;      // guest fs total (≈ diskGiB cap)
    cpu: number[];                 // recent cpu% samples (0–100), newest last
    mem: number[];                 // recent mem% samples
    disk: number[];                // disk io ops/s samples (auto-scaled bars)
    net: number[];                 // net bytes/s samples
    gpu: number[];                 // gpu engine busy% samples (0–100)
    gpuMemBytes?: number;          // latest DRM client memory total
    error?: string;
}

export type CreateForm = SyncFormFields & {
    name: string;
    cpus: number;
    memMiB: number;
    diskGiB: number;
    nestedVirt: boolean;           // pass vmx/svm through — run KVM inside the guest
    gpu: string;                   // venus|virgl|software
    swVk: boolean;                 // venus: expose host lavapipe (CPU Vulkan) to the guest
    headMode: string;              // fullscreen-monitor|windowed|virtual-desktop|app
    persist: string;               // daemonize|owned|ephemeral
    autostart: boolean;            // spec.autostart — boot unit + start with the app
    netMode: string;               // spec.network.mode — nat|restricted|isolated|vmnet
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
    // host → guest sync (spec.sync.*) fields come from SyncFormFields —
    // the credential channels are off by default
    iso: string;                   // iso path/url
    importPath: string;            // imported: existing disk image (absolute)
    importRef: string;             // config import: gist url/id or .cruiser.* file path
    diskDir: string;               // "" = default (vms dir); else disk file's dir
    username: string;
    password: string;              // kept in-memory only; writePasswordFile persists to 0600
    memUnit: "MiB" | "GiB";        // UI-only — memMiB always stores MiB
    vd: number;                    // virtual-desktop head mode: desktop index (1-based)
    usb: string[];                 // "vid:pid:serial?" keys selected for boot-time passthrough
    snapAuto: string;              // spec.snapshots.auto — off|daily|weekly|monthly
    snapTrigger: string;           // spec.snapshots.trigger — start|stop|both
    snapKeep: number;              // spec.snapshots.keep — auto-* rotation bound
    encrypt: string;               // spec.disk.encrypt — off|full|home (create-time only)
    keyStore: string;              // spec.disk.keyStorage — store|prompt
    homeGiB: number;               // spec.disk.homeGiB — encrypt=home volume size
    diskPassword: string;          // LUKS passphrase — in-memory only; provideDiskKey persists per keyStore
    diskPassword2: string;         // confirm entry
}

/** A keyed op parked behind the unlock banner: the VM's keyStorage=prompt
 *  disk has no passphrase on file, so the op is queued until the user
 *  enters it. `op` is a service dispatch tag ("start", "clone",
 *  "snapshot", "restore", "snapdel", "grow"); `arg` carries the snapshot
 *  name / GiB where the op needs one. */
export interface UnlockPrompt {
    vm: string;
    op: string;
    arg?: string;
}

/** Low-disk-space decision parked on the user: an auto snapshot wanted to
 *  run but the host fs can't cover worst-case growth even after pruning.
 *  context "start" = a `vm start` is held until the user chooses. */
export interface AutoSnapPrompt {
    vm: string;
    needBytes: number;
    freeBytes: number;
    /** snapshot names that could still be deleted to make room. */
    remaining: string[];
    context: "start" | "stop";
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

export type Route = "home" | "create" | "vm" | "settings" | "logs" | "term";

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

/** Footer status severity — tints the notifier bar (dot + text). */
export type StatusKind = "info" | "warn" | "error";

export interface CruiserState {
    route: Route;
    selectedVm: string | null;
    vms: VmSummary[];
    status: string;
    statusKind: StatusKind;
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
    /** Description edit buffer on the vm edit screen (loaded by vm-edit). */
    vmDesc: string;
    /** Status line on the term route's head strip (connect state, exit). */
    termLine: string;
    /** The share-add form on the vm detail screen. */
    shareForm: ShareForm;
    /** The port-forward-add form on the vm detail screen. */
    fwdForm: FwdForm;
    /** Parked auto-snapshot low-space decision (null = none pending). */
    autoSnapPrompt: AutoSnapPrompt | null;
    /** Parked LUKS unlock — a prompt-mode VM waiting on its passphrase. */
    unlockPrompt: UnlockPrompt | null;
    /** Unlock-banner passphrase buffer — never rendered back into the input
     *  (typed in place, cleared on use/dismiss like create.password). */
    unlockPw: string;
    /** Detail-screen password reveal — keyed to the VM, cleared on nav. */
    pwReveal: { vm: string; pw: string } | null;
}

export interface ShareForm {
    hostPath: string;
    guestPath: string;
    mode: "mount" | "copy";
    direction: "both" | "host-to-guest";
    open: boolean;               // the add form is collapsed behind "+ Add share"
}

/** A spec.network.hostfwd entry as rendered on the vm detail screen. */
export interface FwdRow {
    proto: "tcp" | "udp";
    hostPort: number;
    guestPort: number;
    /** true for the create()-injected ssh/rdp pair — shown as labels, not
     *  removable (dropping them kills vm ssh / the rdp viewer). */
    auto: boolean;
}

export interface FwdForm {
    hostPort: string;
    guestPort: string;
    proto: "tcp" | "udp";
    open: boolean;
}

export interface CruiserActions {
    setRoute(route: Route, vm?: string | null): void;
    setVms(vms: VmSummary[]): void;
    setStatus(status: string, kind?: StatusKind): void;
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
    setTermLine(s: string): void;
    setShareForm(p: Partial<ShareForm>): void;
    setFwdForm(p: Partial<FwdForm>): void;
    setAutoSnapPrompt(p: AutoSnapPrompt | null): void;
    setUnlockPrompt(p: UnlockPrompt | null): void;
    setPwReveal(r: { vm: string; pw: string } | null): void;
}

export type CruiserStore = CruiserState & CruiserActions;

const defaultLogs = (): LogsState => ({
    source: "runner", file: "cruiser", follow: false,
    lines: 300, unit: "", priority: "", boot: "0", since: "", grep: "",
    text: "", error: null, transport: "", files: [], units: [], fetchedAt: 0, loading: false,
});

const defaultCreate = (): CreateForm => ({
    name: "", cpus: 4, memMiB: 8192, diskGiB: 100, nestedVirt: false,
    gpu: "venus", swVk: false, headMode: "virtual-desktop", persist: "daemonize",
    autostart: false, netMode: "nat",
    method: "cloudimg", distro: "ubuntu", release: "26.04", desktop: "gnome",
    browser: "none", snap: false, extraFonts: false, autologin: true,
    preset: "standard", devtools: [],
    ...syncFormDefaults(),
    iso: "", importPath: "", importRef: "", diskDir: "",
    username: "cruiser", password: "",
    memUnit: "GiB", vd: 0, usb: [],
    snapAuto: "off", snapTrigger: "stop", snapKeep: 5,
    encrypt: "off", keyStore: "store", homeGiB: 50,
    diskPassword: "", diskPassword2: "",
});

export function createCruiserStore() {
    return createStore<CruiserStore>((set) => ({
        route: "home",
        selectedVm: null,
        vms: [],
        status: "ready",
        statusKind: "info",
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
        termLine: "",
        shareForm: { hostPath: "", guestPath: "", mode: "mount", direction: "both", open: false },
        fwdForm: { hostPort: "", guestPort: "", proto: "tcp", open: false },
        autoSnapPrompt: null,
        unlockPrompt: null,
        unlockPw: "",
        pwReveal: null,
        setRoute: (route, vm = null) => set({ route, selectedVm: vm, confirm: null, editVm: null, pwReveal: null, unlockPrompt: null, unlockPw: "" }),
        setVms: (vms) => set({ vms }),
        setStatus: (status, kind = "info") => set({ status, statusKind: kind }),
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
        setTermLine: (termLine) => set({ termLine }),
        setShareForm: (p) => set((s) => ({ shareForm: { ...s.shareForm, ...p } })),
        setFwdForm: (p) => set((s) => ({ fwdForm: { ...s.fwdForm, ...p } })),
        setAutoSnapPrompt: (autoSnapPrompt) => set({ autoSnapPrompt }),
        setUnlockPrompt: (unlockPrompt) => set({ unlockPrompt }),
        setPwReveal: (pwReveal) => set({ pwReveal }),
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
