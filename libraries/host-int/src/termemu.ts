// ============================================================================
// termemu.ts — host terminal emulator probing + launching.
//
// Two consumers: the CLI's `vm term` (term-dd --raw-tty attached to the
// controlling terminal) and the UI's Terminal fallback — when the webui
// backend isn't staged, the Terminal button opens a host terminal emulator
// running `ssh` into the guest instead of an embedded view.
// ============================================================================

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { sshArgv } from "../../vm-core/src/ssh";
import { spawnChild, which } from "../../sys/src/exec";
import { detectSession } from "./detect";

/** Resolve the term-dd binary: PATH → packaged appdir → repo target dirs.
 *  Same convention as ddViewerPath — releases stage it via
 *  `toolchain/stage-term-dd.mts` into native/dist/<plat>-<arch>/. */
export async function termDdPath(): Promise<string | null> {
    const onPath = await which("term-dd");
    if (onPath) return onPath;
    const packaged = join(dirname(process.execPath), "native", "term-dd");
    if (existsSync(packaged)) return packaged;
    // dev: libraries/host-int/src → repo root
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const rels = ["term-dd/target/release/term-dd", "term-dd/target/debug/term-dd"];
    for (let i = 0; i < rels.length; i++) {
        const abs = join(root, rels[i]!);
        if (existsSync(abs)) return abs;
    }
    return null;
}

// ── host terminal emulator fallback ──

interface TermEmu {
    bin: string;
    /** Flag prefixing the command to run inside the terminal. */
    execFlag: string;
}

/** Ordered probe list — DE-preferred emulators first. `execFlag` is the
 *  "run this command" switch for each emulator's syntax. */
function probeOrder(session: string): TermEmu[] {
    const kde: TermEmu[] = [{ bin: "konsole", execFlag: "-e" }];
    const gnome: TermEmu[] = [
        { bin: "kgx", execFlag: "--" },
        { bin: "ptyxis", execFlag: "--" },
        { bin: "gnome-terminal", execFlag: "--" },
    ];
    const generic: TermEmu[] = [
        { bin: "alacritty", execFlag: "-e" },
        { bin: "kitty", execFlag: "" },
        { bin: "foot", execFlag: "" },
        { bin: "xterm", execFlag: "-e" },
    ];
    if (session.startsWith("kde")) return [...kde, ...gnome, ...generic];
    if (session.startsWith("gnome")) return [...gnome, ...kde, ...generic];
    return [...generic, ...kde, ...gnome];
}

/** First available terminal emulator for this session, or null. */
export async function detectTermEmu(
    env: NodeJS.ProcessEnv = process.env,
    finder: (bin: string) => Promise<string | null> = which,
): Promise<TermEmu | null> {
    for (const t of probeOrder(detectSession(env))) {
        if (await finder(t.bin)) return t;
    }
    return null;
}

/**
 * Spawn a detached host terminal emulator running `ssh` into the guest.
 * Throws when no emulator is found.
 */
export async function openHostTerm(spec: VmSpec): Promise<void> {
    const emu = await detectTermEmu();
    if (!emu) throw new Error("no terminal emulator found (tried konsole, kgx, ptyxis, gnome-terminal, alacritty, kitty, foot, xterm)");
    const a = await sshArgv(spec, { tty: true });
    const child = spawnChild(emu.bin, [emu.execFlag, "ssh", ...a].filter(Boolean), { detached: true });
    child.unref();
}
