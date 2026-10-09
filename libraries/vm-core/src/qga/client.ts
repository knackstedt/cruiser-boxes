// ============================================================================
// qga.ts — QEMU Guest Agent client over the virtserialport unix socket.
//
// Replaces the python heredocs in ~/devvm/devvm. guest-sync-delimited handles
// in-band resync; guest-exec captures output via poll of guest-exec-status.
// ============================================================================

import { JsonSocket } from "../qmp/socket-json";

export interface GuestExecResult {
    pid: number;
    exitcode: number;
    stdout: Buffer;
    stderr: Buffer;
}

export class QgaClient extends JsonSocket {
    static async connect(path: string, timeoutMs = 10_000): Promise<QgaClient> {
        const sock = await JsonSocket.open(path, timeoutMs);
        Object.setPrototypeOf(sock, QgaClient.prototype);
        const q = sock as QgaClient;
        try { await q.sync(timeoutMs); } catch (e) { q.close(); throw e; }
        return q;
    }

    /** guest-sync-delimited resync — establishes the response channel. */
    async sync(timeoutMs = 10_000): Promise<void> {
        // 0xFF sentinel resets the agent's parser before the sync request.
        this.sock.write("\xff");
        const id = Math.floor(Math.random() * 2 ** 31);
        const r = await this.send("guest-sync-delimited", { id }, timeoutMs);
        if (Number(r) !== id) throw new Error(`qga sync mismatch: ${r} != ${id}`);
    }

    override onMessage(msg: any): void {
        this.emit("event", msg);
    }

    ping(timeoutMs = 5_000): Promise<any> { return this.send("guest-ping", undefined, timeoutMs); }

    async exec(path: string, arg: string[] = [], opts: { inputB64?: string; timeoutMs?: number } = {}): Promise<GuestExecResult> {
        const r = await this.send("guest-exec", {
            path, arg,
            "capture-output": true,
            ...(opts.inputB64 ? { "input-data": opts.inputB64 } : {}),
        });
        const pid = r.pid as number;
        const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
        for (;;) {
            await new Promise((res) => setTimeout(res, 300));
            const st = await this.send("guest-exec-status", { pid });
            if (st.exited) {
                return {
                    pid,
                    exitcode: st.exitcode ?? -1,
                    stdout: Buffer.from(st["out-data"] ?? "", "base64"),
                    stderr: Buffer.from(st["err-data"] ?? "", "base64"),
                };
            }
            if (Date.now() > deadline) throw new Error(`guest-exec ${path} pid ${pid} timed out`);
        }
    }

    /** Convenience: run a shell command inside the guest. */
    sh(script: string, opts?: { timeoutMs?: number }): Promise<GuestExecResult> {
        return this.exec("/bin/sh", ["-c", script], opts);
    }

    async readFile(path: string, maxBytes = 16 * 1024 * 1024, timeoutMs?: number): Promise<Buffer> {
        const h = await this.send("guest-file-open", { path, mode: "r" }, timeoutMs);
        const handle = h as number;
        try {
            const chunks: Buffer[] = [];
            for (;;) {
                const r = await this.send("guest-file-read", { handle, count: Math.min(maxBytes, 1 << 20) }, timeoutMs);
                const b = Buffer.from(r["buf-b64"] ?? "", "base64");
                chunks.push(b);
                if (r.eof || b.length === 0) break;
            }
            return Buffer.concat(chunks);
        } finally {
            await this.send("guest-file-close", { handle }, timeoutMs).catch(() => {});
        }
    }

    async writeFile(path: string, data: Buffer | string): Promise<void> {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const h = await this.send("guest-file-open", { path, mode: "w+" });
        const handle = h as number;
        try {
            for (let off = 0; off < buf.length; off += 1 << 20) {
                await this.send("guest-file-write", {
                    handle, "buf-b64": buf.subarray(off, off + (1 << 20)).toString("base64"),
                });
            }
        } finally {
            await this.send("guest-file-close", { handle }).catch(() => {});
        }
    }

    networkInterfaces(): Promise<any[]> { return this.send("guest-network-get-interfaces"); }
    getFsInfo(timeoutMs?: number): Promise<any[]> { return this.send("guest-get-fsinfo", undefined, timeoutMs); }
    getOsInfo(): Promise<any> { return this.send("guest-get-osinfo"); }
    getTime(): Promise<any> { return this.send("guest-get-time"); }
    shutdown(mode: "powerdown" | "reboot" | "halt" = "powerdown"): Promise<any> {
        return this.send("guest-shutdown", { mode });
    }
    setUserPassword(user: string, passwordB64: string, crypted = false): Promise<any> {
        return this.send("guest-set-user-password", { username: user, password: passwordB64, crypted });
    }
}
