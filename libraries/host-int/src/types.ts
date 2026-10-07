// ============================================================================
// types.ts — WmAdapter contract + shared types for host window/desktop plumbing.
// ============================================================================

export interface MonitorInfo {
    name: string;                 // "DP-1", "HDMI-0", X11 output name
    x: number; y: number;
    w: number; h: number;
    primary: boolean;
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

export type EscapeActionSpec =
    | { kind: "host-desktop"; index: number }
    | { kind: "desktop-cycle"; dir: 1 | -1 }
    | { kind: "ungrab" }
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
}
