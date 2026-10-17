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
    protected sock: Socket;
    private parts: Buffer[] = [];
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    private nextId = 1;
    private handshake: { resolve: (first: any) => void; reject: (e: Error) => void } | null = null;
    private closed = false;

    protected constructor(sock: Socket) {
        super();
        this.sock = sock;
        sock.on("data", (d) => this.feed(d));
        sock.on("close", () => this.onClose());
        // Re-emitting "error" on an EventEmitter with no listener throws and
        // kills the process — reject in-flight ops instead (a reset socket is
        // expected whenever QEMU exits mid-op, e.g. stop while metrics polls).
        sock.on("error", (e) => this.onError(e));
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
        // Chunk queue, not a rolling concat: a 1MiB guest-file-read chunk
        // arrives as ~16 socket reads and concat-per-read is O(n²) copy.
        this.parts.push(d);
        // Messages are newline-delimited JSON; QGA prefixes sync replies with 0xFF.
        for (;;) {
            // locate the next newline, possibly spanning chunks
            let i = 0, pre = 0, nl = -1;
            for (; i < this.parts.length; i++) {
                nl = this.parts[i]!.indexOf(0x0a);
                if (nl >= 0) break;
                pre += this.parts[i]!.length;
            }
            if (nl < 0) return;
            let line: Buffer;
            if (i === 0) {
                // newline inside the head chunk — cheap slice, no copy
                line = this.parts[0]!.subarray(0, nl);
                const rest = this.parts[0]!.subarray(nl + 1);
                if (rest.length) this.parts[0] = rest; else this.parts.shift();
            } else {
                // spans chunks — concat the head only
                const head = Buffer.concat(this.parts.slice(0, i + 1));
                line = head.subarray(0, pre + nl);
                const rest = head.subarray(pre + nl + 1);
                this.parts.splice(0, i + 1);
                if (rest.length) this.parts.unshift(rest);
            }
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
        if (this.handshake) { const h = this.handshake; this.handshake = null; h.resolve(msg); return; }
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
            this.handshake = {
                resolve: (m) => { clearTimeout(to); resolve(m); },
                reject: (e) => { clearTimeout(to); reject(e); },
            };
        });
    }

    /** Every command gets a reply deadline — default 2min, generous for any
     *  synchronous QMP/QGA command (long work rides async jobs + events, not
     *  blocking replies). Without it a wedged agent leaves a pending entry
     *  that never resolves, and since VmHandle serializes ops on one chain,
     *  a single dead send wedges EVERY later op for that VM. */
    send(cmd: string, args?: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
        const id = this.nextId++;
        const pkt = JSON.stringify(args ? { execute: cmd, arguments: args, id } : { execute: cmd, id }) + "\n";
        return new Promise((resolve, reject) => {
            if (this.closed) return reject(new Error("socket closed"));
            let to: ReturnType<typeof setTimeout> | undefined;
            if (timeoutMs) to = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v: any) => { if (to) clearTimeout(to); resolve(v); },
                reject: (e: Error) => { if (to) clearTimeout(to); reject(e); },
            });
            this.sock.write(pkt);
        });
    }

    private onError(e: Error): void {
        this.closed = true;
        if (this.handshake) { const h = this.handshake; this.handshake = null; h.reject(e); }
        this.pending.forEach((p) => p.reject(e));
        this.pending.clear();
        if (this.listenerCount("error") > 0) this.emit("error", e);
    }

    private onClose(): void {
        this.closed = true;
        if (this.handshake) { const h = this.handshake; this.handshake = null; h.reject(new Error("socket closed")); }
        this.pending.forEach((p) => p.reject(new Error("socket closed")));
        this.pending.clear();
        this.emit("close");
    }

    close(): void { this.sock.destroy(); }
}
