// ============================================================================
// notify.ts — guest → host notification forwarding.
//
// A held ssh child runs `busctl --user monitor` in the guest, snooping the
// user's session bus for org.freedesktop.Notifications traffic — a monitor
// peer needs no guest-side install and no daemon takeover (in-guest popups
// still show). busctl is guaranteed on every supported guest (all systemd);
// --json=short emits one JSON object per message:
//
//   method_call   member=Notify              data [app,id,icon,sum,body,actions,hints,timeout]
//   method_return sender=org.f…Notifications data [id]   reply_cookie keys the call
//   signal        member=NotificationClosed  data [id, reason]
//
// The method_return pairing is how guest notification ids map to host ids —
// an app's replaces_id refers to the daemon-assigned id, which only the
// reply carries. Host side: `notify-send -p` posts and prints the host id;
// CloseNotification goes through `busctl --user call`. Actions can't be
// forwarded (a host click can't reach back into the guest) — they're
// dropped; the guest daemon still owns them for in-guest clicks.
//
// Lifetime is the viewer session's, like AgentForward/FileSyncs — respawns
// with backoff so guest reboots and user-bus restarts self-heal.
// ============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import type { VmHandle } from "../../vm-core/src/lifecycle/vm";
import type { VmSpec } from "../../vm-core/src/config/schema";
import { sshArgv } from "../../vm-core/src/ssh";
import { run, which } from "../../sys/src/exec";

/** One busctl --json=short monitor line, decoded. */
export interface BusMsg {
    type?: string;
    sender?: string;
    destination?: string;
    cookie?: number;
    reply_cookie?: number;
    interface?: string;
    member?: string;
    payload?: { type?: string; data?: unknown[] };
}

/** A Notify call decoded into the fields the host popup needs. */
export interface GuestNotify {
    /** app_name (arg 0). */
    appName: string;
    /** replaces_id (arg 1) — a guest daemon id, 0 = new notification. */
    replacesId: number;
    summary: string;
    body: string;
    /** hints["urgency"] byte — 0 low / 1 normal / 2 critical, null = unset. */
    urgency: number | null;
    /** expire_timeout (arg 7) ms — -1 = server default. */
    expireMs: number;
    /** pending-map key: "<sender>:<cookie>" — matches the method_return's
     *  destination + reply_cookie. */
    key: string;
}

const NOTIFY_IFACE = "org.freedesktop.Notifications";

/** Variant-wrapped hint value: busctl emits {"type":"y","data":1}; accept a
 *  bare number too for tolerance. */
function hintNum(v: unknown): number | null {
    if (typeof v === "number") return v;
    if (v && typeof v === "object" && typeof (v as { data?: unknown }).data === "number")
        return (v as { data: number }).data;
    return null;
}

/** method_call member=Notify → the popup fields; null for anything else. */
export function decodeNotify(m: BusMsg): GuestNotify | null {
    if (m.type !== "method_call" || m.interface !== NOTIFY_IFACE || m.member !== "Notify") return null;
    const d = m.payload?.data;
    if (!Array.isArray(d) || d.length < 8) return null;
    const hints = d[6] && typeof d[6] === "object" && !Array.isArray(d[6])
        ? d[6] as Record<string, unknown> : {};
    const u = hintNum(hints["urgency"]);
    return {
        appName: String(d[0] ?? ""),
        replacesId: Number(d[1] ?? 0),
        summary: String(d[3] ?? ""),
        body: String(d[4] ?? ""),
        urgency: u === 0 || u === 1 || u === 2 ? u : null,
        expireMs: Number(d[7] ?? -1),
        key: `${m.sender}:${m.cookie}`,
    };
}

/**
 * The bridge: ssh → guest busctl monitor → host notify-send, respawned with
 * backoff until dispose. Owned by openVmSession; gated on
 * spec.display.notifications + CRUISER_NOTIFICATIONS.
 */
export class NotifyBridge {
    private child: ChildProcess | null = null;
    private disposed = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private buf = "";
    private queue: Promise<void> = Promise.resolve();
    /** "<sender>:<cookie>" of a Notify call awaiting its daemon reply → the
     *  host id we posted for it. Swept at 60s (an errored call never gets a
     *  method_return — error replies carry no id we'd want anyway). */
    private pending = new Map<string, { hostId: number | undefined; at: number }>();
    /** guest daemon-assigned id → host id. */
    private ids = new Map<number, number>();
    private spawnedAt = 0;
    private announced = false;
    private failLogged = false;

    constructor(
        private readonly h: VmHandle,
        private readonly log?: (msg: string) => void,
    ) {}

    /** spec + env gate — CRUISER_NOTIFICATIONS=0 kills like CRUISER_FILESYNC. */
    static enabled(spec: VmSpec, env: NodeJS.ProcessEnv = process.env): boolean {
        return spec.display.notifications && env.CRUISER_NOTIFICATIONS !== "0";
    }

    /**
     * The guest-side monitor — exported shape for tests. busctl check exits
     * 0 fast so a missing tool doesn't respawn-loop; the socket wait rides
     * out pre-login (user bus appears with systemd --user); monitor matches
     * cover calls, the daemon's id replies, and its close signals. A
     * well-known sender= in the match resolves to the current owner, so the
     * return match stays tight even when the daemon holds a unique name.
     */
    static monitorCmd(): string {
        return [
            "command -v busctl >/dev/null 2>&1 || exit 0",
            'export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"',
            'while [ ! -S "/run/user/$(id -u)/bus" ]; do sleep 5; done',
            "exec busctl --user monitor --json=short" +
                ` --match="type='method_call',interface='${NOTIFY_IFACE}'"` +
                ` --match="type='method_return',sender='${NOTIFY_IFACE}'"` +
                ` --match="type='signal',interface='${NOTIFY_IFACE}'"`,
        ].join("; ");
    }

    async start(): Promise<void> {
        if (!(await which("notify-send"))) {
            this.log?.("notifications: no notify-send on the host — bridge skipped");
            return;
        }
        this.spawn();
    }

    private spawn(): void {
        if (this.disposed) return;
        void (async () => {
            let argv: string[];
            try {
                argv = await sshArgv(this.h.spec, {
                    remoteCmd: [NotifyBridge.monitorCmd()],
                    extraOpts: ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"],
                });
            } catch (e) {
                this.log?.(`notifications: ${e instanceof Error ? e.message : e}`);
                return;
            }
            if (this.disposed) return;
            // ids are per-boot on the guest daemon — a respawn must not let a
            // new session's replaces_id hit a stale host id.
            this.pending.clear();
            this.ids.clear();
            this.buf = "";
            this.spawnedAt = Date.now();
            this.announced = false;
            const child = spawn("ssh", argv, { stdio: ["ignore", "pipe", "pipe"] });
            this.child = child;
            let errTail = "";
            child.stderr?.on("data", (d: Buffer) => { errTail = (errTail + d.toString()).slice(-800); });
            child.stdout?.on("data", (d: Buffer) => this.onData(d));
            child.on("error", () => {});
            child.on("exit", (code) => {
                this.child = null;
                if (this.disposed) return;
                // Quick exit 0 = the remote early-exit path (no busctl) —
                // respawning can't help. A monitor that ran then ended (bus
                // restart, session teardown) retries like any failure.
                if (code === 0 && Date.now() - this.spawnedAt < 15_000) {
                    this.log?.("notifications: guest has no busctl — bridge off for this session");
                    return;
                }
                // Log the first failure (and any exit after a working run),
                // then stay quiet — a rebooting guest conn-refuses into an
                // 8s respawn loop that would otherwise spam the log.
                if (this.announced || !this.failLogged) {
                    const tail = errTail.trim().split("\n").pop();
                    this.log?.(`notifications: monitor exited${tail ? ` — ${tail}` : ""}, retrying`);
                    this.failLogged = true;
                }
                this.timer = setTimeout(() => this.spawn(), 8_000);
            });
        })();
    }

    private onData(d: Buffer): void {
        this.buf += d.toString();
        let i: number;
        while ((i = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            if (line) this.enqueue(line);
        }
    }

    /** Serialized handler queue — a method_return must wait for its call's
     *  notify-send (the pending entry posts after the popup does), and a
     *  follow-up Notify's replaces_id needs the reply's id mapping first.
     *  Stream order already guarantees both; the queue just preserves it. */
    private enqueue(line: string): void {
        this.queue = this.queue.then(() => this.handleBusMessage(line)).catch(() => {});
    }

    /** One decoded monitor line → host action. Public seam for tests. */
    async handleBusMessage(line: string): Promise<void> {
        let m: BusMsg;
        try { m = JSON.parse(line); } catch { return; }
        if (!this.announced) {
            this.announced = true;
            this.failLogged = false;
            this.log?.("notifications: forwarding guest → host");
        }
        const now = Date.now();
        for (const [k, v] of this.pending.entries()) if (now - v.at > 60_000) this.pending.delete(k);

        const n = decodeNotify(m);
        if (n) {
            const hostId = await this.postHost(n);
            this.pending.set(n.key, { hostId, at: now });
            return;
        }
        if (m.type === "method_return" && m.reply_cookie !== undefined && m.destination) {
            const key = `${m.destination}:${m.reply_cookie}`;
            const p = this.pending.get(key);
            if (p === undefined) return;
            this.pending.delete(key);
            const gid = Number(m.payload?.data?.[0]);
            if (Number.isInteger(gid) && p.hostId !== undefined) this.ids.set(gid, p.hostId);
            return;
        }
        if (m.type === "signal" && m.interface === NOTIFY_IFACE && m.member === "NotificationClosed") {
            const gid = Number(m.payload?.data?.[0]);
            const hid = this.ids.get(gid);
            this.ids.delete(gid);
            if (hid !== undefined) await this.closeHost(hid);
        }
    }

    /** notify-send one popup; returns the host id for id-mapping. The app
     *  name carries the vm name so the source is visible in the host
     *  notification history — guest icons aren't forwarded (paths and icon
     *  names wouldn't resolve host-side). Public seam for tests. */
    async postHost(n: GuestNotify): Promise<number | undefined> {
        const replaceHost = n.replacesId ? this.ids.get(n.replacesId) : undefined;
        const args = ["-p", "-a", `${this.h.spec.name} · ${n.appName || "app"}`];
        if (n.urgency !== null) args.push("-u", ["low", "normal", "critical"][n.urgency]!);
        if (n.expireMs >= 0) args.push("-t", String(n.expireMs));
        if (replaceHost !== undefined) args.push("-r", String(replaceHost));
        args.push(n.summary, n.body);
        const r = await run("notify-send", args, { noThrow: true });
        if (r.code !== 0) {
            this.log?.(`notifications: notify-send exited ${r.code}${r.stderr.trim() ? ` — ${r.stderr.trim().slice(0, 160)}` : ""}`);
            return replaceHost;
        }
        const hid = Number(r.stdout.trim());
        const hostId = Number.isInteger(hid) && hid > 0 ? hid : replaceHost;
        // An unmapped replaces_id (notification predates the bridge) still
        // records its slot so follow-up replaces land on the same popup.
        if (n.replacesId && hostId !== undefined) this.ids.set(n.replacesId, hostId);
        return hostId;
    }

    /** CloseNotification on the host daemon for a guest-dismissed id. */
    async closeHost(hostId: number): Promise<void> {
        if (!(await which("busctl"))) return;
        await run("busctl", ["--user", "call", NOTIFY_IFACE, `/${NOTIFY_IFACE.replaceAll(".", "/")}`,
            NOTIFY_IFACE, "CloseNotification", "u", String(hostId)], { noThrow: true });
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) clearTimeout(this.timer);
        this.child?.kill("SIGTERM");
        this.child = null;
    }
}
