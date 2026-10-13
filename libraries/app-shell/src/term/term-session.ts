// ============================================================================
// term-session.ts — a live term-dd child process speaking the framed wire
// protocol (term/framing.ts ⇄ term-dd/src/framing.rs).
//
// The session is transport-agnostic: it delivers raw PTY bytes and exit
// status; TermManager glues it to the webui view. Sessions survive route
// switches — a guest `apt upgrade` keeps running while you check logs.
// ============================================================================

import type { ChildProcess } from "node:child_process";
import type { VmSpec } from "../../../vm-core/src/config/schema";
import { sshArgv } from "../../../vm-core/src/ssh";
import { termDdPath } from "../../../host-int/src/termemu";
import { spawnChild } from "../../../sys/src/exec";
import { appendVmLog } from "../../../vm-core/src/logs";
import { vmPaths } from "../../../vm-core/src/paths";
import {
    decodeExit, encodeFrame, encodeResize,
    FrameDecoder, TAG_DATA, TAG_ERR, TAG_EXIT, TAG_KILL,
} from "./framing";

export type TermEvent =
    | { t: "data"; bytes: Uint8Array }
    | { t: "exit"; code: number }
    | { t: "err"; message: string };

export class TermSession {
    /** True once the helper reported the spawned command exited. */
    ended = false;
    private dec = new FrameDecoder();
    private listeners = new Set<(e: TermEvent) => void>();

    private constructor(private proc: ChildProcess, readonly vmName: string) {
        // Node surfaces a dead child's broken pipe as an async 'error'
        // event on stdin — without a listener it crashes the process.
        // Writes already guard synchronously; the exit path owns cleanup.
        proc.stdin!.on("error", () => {});
        proc.stdout!.on("data", (chunk: Buffer) => {
            for (const f of this.dec.push(chunk)) {
                if (f.tag === TAG_DATA) this.emit({ t: "data", bytes: f.payload });
                else if (f.tag === TAG_EXIT) { this.ended = true; this.emit({ t: "exit", code: decodeExit(f.payload) }); }
                else if (f.tag === TAG_ERR) { this.ended = true; this.emit({ t: "err", message: new TextDecoder().decode(f.payload) }); }
            }
        });
        proc.stderr?.on("data", (chunk: Buffer) => {
            const line = chunk.toString().trimEnd();
            if (line) void appendVmLog(vmPaths(vmName), `term-dd: ${line}`).catch(() => {});
        });
        proc.on("exit", (code, signal) => {
            if (!this.ended) { this.ended = true; this.emit({ t: "exit", code: code ?? (signal ? -1 : 0) }); }
        });
    }

    onEvent(cb: (e: TermEvent) => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    private emit(e: TermEvent): void {
        this.listeners.forEach((cb) => { try { cb(e); } catch { /* listener bug must not kill the pump */ } });
    }

    /** Bytes for the guest (keystrokes, paste). */
    write(bytes: Uint8Array): void {
        if (this.ended) return;
        try { this.proc.stdin!.write(encodeFrame(TAG_DATA, bytes)); } catch { /* dead */ }
    }

    resize(cols: number, rows: number): void {
        if (this.ended) return;
        try { this.proc.stdin!.write(encodeResize(cols, rows)); } catch { /* dead */ }
    }

    close(): void {
        if (!this.ended) {
            try { this.proc.stdin!.write(encodeFrame(TAG_KILL, new Uint8Array(0))); } catch { /* dead */ }
        }
        try { this.proc.stdin!.end(); } catch { /* dead */ }
        // Escalate if the child doesn't die promptly after KILL.
        setTimeout(() => { if (!this.proc.killed) this.proc.kill("SIGKILL"); }, 3_000).unref?.();
    }

    /**
     * Spawn term-dd running `ssh` into the guest over the hostfwd port.
     * `cmd` overrides the spawned command (dev-harness local shell).
     */
    static async open(spec: VmSpec | null, cmd?: string[]): Promise<TermSession> {
        const bin = await termDdPath();
        if (!bin) throw new Error("term-dd not found — cargo build --release in term-dd/ (or install it on PATH)");
        if (!spec && !cmd) throw new Error("no spec and no command");
        const a = cmd ?? ["ssh", ...(await sshArgv(spec!, { tty: true }))];
        // TERM=xterm-256color: the page is xterm.js; ssh forwards TERM to the
        // guest. Unset/dumb would degrade readline (Ctrl+L → raw \x0c).
        const proc = spawnChild(bin, ["--", ...a], {
            stdio: "pipe",
            env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
        });
        return new TermSession(proc, spec?.name ?? "local");
    }
}
