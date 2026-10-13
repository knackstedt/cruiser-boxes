// ============================================================================
// page-entry.ts — bundling entry for the xterm.js terminal page.
//
// toolchain/build-term-page.mts bundles this into term-bundle.gen.ts as a
// single <script>-ready blob. Re-export the pieces the page's inline
// bootstrap uses via globals (the page script is a classic <script>, not
// a module).
// ============================================================================

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

(globalThis as Record<string, unknown>).Terminal = Terminal;
(globalThis as Record<string, unknown>).FitAddon = { FitAddon };
