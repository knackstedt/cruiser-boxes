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

// Blitz-dom only fetches a @font-face source whose format is detectable —
// either an explicit format() hint or a file extension on the url. The urls
// therefore carry the resolved file's real extension; fontFaceCss() emits the
// rules so screens.ts picks up whatever was actually registered.
let regularUrl = "ui://cruiser-fonts/regular.ttf";
let boldUrl = "ui://cruiser-fonts/bold.ttf";

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

function fontExt(path: string): string {
    return path.match(/\.(ttf|otf|woff2?)$/i)?.[0] ?? ".ttf";
}

/** @font-face rules binding the registered faces as "Cruiser Sans". Emitted
 *  from module state so the urls always match what registerUiFonts() stored. */
export function fontFaceCss(): string {
    return (
        `@font-face { font-family:'Cruiser Sans'; font-weight:400; src:url('${regularUrl}'); }\n` +
        `@font-face { font-family:'Cruiser Sans'; font-weight:700; src:url('${boldUrl}'); }\n`
    );
}

/** Register system sans faces as `ui://` resources. Call before mount — the
 *  doc backend applies resources synchronously and in order. */
export function registerUiFonts(sink: ResourceSink): void {
    try {
        const regular = fcFontFile("sans-serif");
        if (!regular) return;
        regularUrl = `ui://cruiser-fonts/regular${fontExt(regular)}`;
        sink.registerResource(regularUrl, readFileSync(regular));
        // Register the bold url even when fc-match falls back to the regular
        // file — keeps weight:bold text in-family rather than dropping to the
        // embedded fallback.
        const bold = fcFontFile("sans-serif:weight=bold") ?? regular;
        boldUrl = `ui://cruiser-fonts/bold${fontExt(bold)}`;
        sink.registerResource(boldUrl, readFileSync(bold));
    } catch {
        // fc-match absent / unreadable font — the embedded fallback applies.
    }
}
