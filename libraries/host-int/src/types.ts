// ============================================================================
// types.ts — WmAdapter contract + shared types for host window/desktop plumbing.
// ============================================================================

export interface MonitorInfo {
    name: string;                 // "DP-1", "HDMI-0", X11 output name
    x: number; y: number;
    w: number; h: number;
    primary: boolean;
    /** Best-effort UI scale factor (1, 1.25, 2…) — absent where the
     *  session doesn't report one (plain X11 has no real concept). */
    scale?: number;
    /** Current refresh rate Hz — absent where probing doesn't report it. */
    refresh?: number;
}

export interface DesktopInfo {
    /** 1-based index (what the user calls "desktop 2"). */
    index: number;
    /** Backend identity: KWin UUID, GNOME index, EWMH id. */
    id?: string;
    name?: string;
    current?: boolean;
}

export interface WindowHandle {
    /** Adapter-native id: X11 hex wid, KWin internalId, etc. */
    id: string;
    title: string;
    wmClass?: string;
    pid?: number;
}

export interface WindowMatcher {
    /** Substring or regex matched against the window title. */
    title?: string | RegExp;
    wmClass?: string;
    /** Owning pid — the reliable way to find our own spawned viewer. */
    pid?: number;
}

export interface WindowRuleSpec {
    /** Regex matched against the window title. */
    titleRegex?: string;
    /** Exact WM_CLASS match. */
    wmClass?: string;
    /** Target desktop — adapter-native id (KWin VD uuid, …). */
    desktopId: string;
    /** Human-readable label for the WM's rules editor. */
    description?: string;
}

export type EscapeActionSpec =
    | { kind: "host-desktop"; index: number }
    | { kind: "desktop-cycle"; dir: 1 | -1 }
    | { kind: "ungrab" }
    | { kind: "abort" }                     // ungrab + minimize (viewer-side)
    | { kind: "kwin"; name: string }        // invoke a named kglobalaccel kwin action
    | { kind: "command"; argv: string[] };

export interface AdapterCaps {
    monitors: boolean;
    desktops: boolean;
    placeWindows: boolean;      // can move/fullscreen windows
    shortcuts: boolean;         // can install global escape shortcuts
    notes?: string;
}

export interface WmAdapter {
    readonly id: string;        // "kde-x11" | "kde-wayland" | "gnome-x11" | ...
    readonly caps: AdapterCaps;
    monitors(): Promise<MonitorInfo[]>;
    desktops(): Promise<DesktopInfo[]>;
    /** Poll for a matching window; null on timeout. */
    findWindow(m: WindowMatcher, timeoutMs?: number): Promise<WindowHandle | null>;
    /** desktop: 1-based index, or "all" for sticky. */
    moveToDesktop(w: WindowHandle, desktop: number | "all"): Promise<void>;
    setFullscreen(w: WindowHandle, on: boolean): Promise<void>;
    /** Position window on the named monitor (pre-fullscreen placement). */
    moveToMonitor(w: WindowHandle, monitor: string): Promise<void>;
    focus(w: WindowHandle): Promise<void>;
    /**
     * Bind a global escape shortcut ("ctrl+alt+delete") to an action.
     * Returns an uninstaller.
     */
    installEscapeShortcut(keys: string, action: EscapeActionSpec): Promise<() => Promise<void>>;
    /**
     * Install a WM window rule evaluated at map time (KWin window rules)
     * so a window lands on its target desktop before it is ever shown —
     * unlike moveToDesktop, which drags a visible window after the fact.
     * Optional; callers fall back to post-map placement. Returns an
     * uninstaller.
     */
    installWindowRule?(rule: WindowRuleSpec): Promise<() => Promise<void>>;
    /**
     * The user's own desktop-switch bindings as configured in the WM —
     * `{keys}` in the lowercase "ctrl+super+left" grammar, `action` an
     * escape action string ("kwin:<action name>" on KDE, where the exact
     * global-accel action is dispatched; "desktop-cycle-*"/"host-desktop:*"
     * elsewhere). viewer-dd mirrors these into its in-grab intercept table
     * so the user's real VD keys keep working while the guest holds the
     * keyboard grab. Optional; absent → no mirroring.
     */
    desktopSwitchBindings?(): Promise<{ keys: string; action: string }[]>;
}
