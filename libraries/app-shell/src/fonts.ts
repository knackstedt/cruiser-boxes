// ============================================================================
// fonts.ts — bind the host's real system fonts into Blitz docs.
//
// The OSR rasterizer ships a single embedded DejaVu Sans as the fallback for
// every generic family — legible but rough (one weight, no hinting). Cruiser
// is Linux-only, where fontconfig is universal, so resolve the user's actual
// sans-serif regular+bold faces via fc-match and register them as `ui://`
// blobs; the stylesheet binds them with @font-face ("Cruiser Sans"). Any
// failure leaves the embedded fallback in place.
// ============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const UI_FONT_URL_REGULAR = "ui://cruiser-fonts/regular";
export const UI_FONT_URL_BOLD = "ui://cruiser-fonts/bold";

type ResourceSink = { registerResource(url: string, bytes: Uint8Array | ArrayBuffer): void };

/** `fc-match -f %{file}` for a fontconfig pattern; null when fc-match is
 *  absent or the match isn't a font file Blitz can load. */
function fcFontFile(pattern: string): string | null {
    try {
        const p = execFileSync("fc-match", ["-f", "%{file}", pattern], { timeout: 5000 }).toString().trim();
        return /\.(ttf|otf|woff2?)$/i.test(p) ? p : null;
    } catch {
        return null;
    }
}

/** Register system sans faces as `ui://` resources. Call before mount — the
 *  doc backend applies resources synchronously and in order. */
export function registerUiFonts(sink: ResourceSink): void {
    try {
        const regular = fcFontFile("sans-serif");
        if (!regular) return;
        sink.registerResource(UI_FONT_URL_REGULAR, readFileSync(regular));
        const bold = fcFontFile("sans-serif:weight=bold");
        if (bold && bold !== regular) sink.registerResource(UI_FONT_URL_BOLD, readFileSync(bold));
    } catch {
        // fc-match absent / unreadable font — the embedded fallback applies.
    }
}
