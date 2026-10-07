// ============================================================================
// detect.ts — pick the WmAdapter for the current session.
// ============================================================================

import type { WmAdapter } from "./types";
import { genericX11, gnomeWayland, gnomeX11, kdeWayland, kdeX11 } from "./adapters";

export type SessionKind = "kde-x11" | "kde-wayland" | "gnome-x11" | "gnome-wayland" | "x11" | "unknown";

export function detectSession(env: NodeJS.ProcessEnv = process.env): SessionKind {
    const de = (env.XDG_CURRENT_DESKTOP ?? env.XDG_SESSION_DESKTOP ?? "").toLowerCase();
    const sess = (env.XDG_SESSION_TYPE ?? "").toLowerCase();
    const kde = de.includes("kde") || de.includes("plasma");
    const gnome = de.includes("gnome");
    if (sess === "wayland" || env.WAYLAND_DISPLAY) {
        if (kde) return "kde-wayland";
        if (gnome) return "gnome-wayland";
        return "unknown";
    }
    if (kde) return "kde-x11";
    if (gnome) return "gnome-x11";
    if (sess === "x11" || env.DISPLAY) return "x11";
    return "unknown";
}

export function detectAdapter(env: NodeJS.ProcessEnv = process.env): WmAdapter {
    switch (detectSession(env)) {
        case "kde-x11": return kdeX11();
        case "kde-wayland": return kdeWayland();
        case "gnome-x11": return gnomeX11();
        case "gnome-wayland": return gnomeWayland();
        default: return genericX11();
    }
}
