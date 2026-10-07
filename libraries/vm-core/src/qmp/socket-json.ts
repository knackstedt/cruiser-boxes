// ============================================================================
// socket-json.ts — line-delimited JSON over a unix socket (QMP + QGA share it).
// ============================================================================

import { connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";

export interface JsonSocketEvents {
    /** Pushed server-side messages (QMP "event" objects, QGA async). */
    event: (msg: any) => void;
    close: () => void;
    error: (e: Error) => void;
}

export class JsonSocket extends EventEmitter {
    private sock: Socket;
    private buf: Buffer = Buffer.alloc(0);
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    private nextId = 1;
    private handshake: ((first: any) => void) | null = null;
    private closed = false;

    protected constructor(sock: Socket) {
        super();
        this.sock = sock;
        sock.on("data", (d) => this.feed(d));
        sock.on("close", () => this.onClose());
        sock.on("error", (e) => { this.emit("error", e); });
    }

    static open(path: string, timeoutMs = 10_000): Promise<JsonSocket> {
        return new Promise((resolve, reject) => {
            const sock = connect({ path });
            const to = setTimeout(() => { sock.destroy(); reject(new Error(`connect ${path} timed out`)); }, timeoutMs);
            sock.once("connect", () => { clearTimeout(to); resolve(new JsonSocket(sock)); });
            sock.once("error", (e) => { clearTimeout(to); reject(e); });
        });
    }

    /** Called on each complete JSON message from the peer. */
    onMessage(_msg: any): void { /* overridden by clients */ }

    protected feed(d: Buffer): void {
        this.buf = Buffer.concat([this.buf, d]);
        // Messages are newline-delimited JSON; QGA prefixes sync replies with 0xFF.
        for (;;) {
            const nl = this.buf.indexOf(0x0a);
            if (nl < 0) break;
            let line = this.buf.subarray(0, nl);
            this.buf = this.buf.subarray(nl + 1);
            const ff = line.indexOf(0xff);
            if (ff >= 0) line = line.subarray(ff + 1);   // QGA sync marker
            const t = line.toString("utf-8").trim();
            if (!t) continue;
            let msg: any;
            try { msg = JSON.parse(t); } catch { continue; }
            this.dispatch(msg);
        }
    }

    private dispatch(msg: any): void {
        if (this.handshake) { const h = this.handshake; this.handshake = null; h(msg); return; }
        if (msg.id !== undefined && this.pending.has(Number(msg.id))) {
            const p = this.pending.get(Number(msg.id))!;
            this.pending.delete(Number(msg.id));
            if (msg.error) p.reject(new Error(`${msg.error.class ?? "qmp-error"}: ${msg.error.desc ?? JSON.stringify(msg.error)}`));
            else p.resolve(msg.return ?? msg);
            return;
        }
        this.onMessage(msg);
    }

    /** First message from peer (QMP greeting). */
    expectFirst(timeoutMs = 10_000): Promise<any> {
        return new Promise((resolve, reject) => {
            const to = setTimeout(() => reject(new Error("handshake timeout")), timeoutMs);
            this.handshake = (m) => { clearTimeout(to); resolve(m); };
        });
    }

    send(cmd: string, args?: Record<string, unknown>): Promise<any> {
        const id = this.nextId++;
        const pkt = JSON.stringify(args ? { execute: cmd, arguments: args, id } : { execute: cmd, id }) + "\n";
        return new Promise((resolve, reject) => {
            if (this.closed) return reject(new Error("socket closed"));
            this.pending.set(id, { resolve, reject });
            this.sock.write(pkt);
        });
    }

    private onClose(): void {
        this.closed = true;
        this.pending.forEach((p) => p.reject(new Error("socket closed")));
        this.pending.clear();
        this.emit("close");
    }

    close(): void { this.sock.destroy(); }
}
