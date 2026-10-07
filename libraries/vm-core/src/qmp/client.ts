// ============================================================================
// qmp.ts — QMP client: handshake, execute, async events.
//
//   const q = await QmpClient.connect(paths.monitorSock);
//   await q.execute("query-status");                     // → {status:"running",…}
//   q.on("event", (e) => …);                             // SHUTDOWN, RESET, …
// ============================================================================

import { JsonSocket } from "./socket-json";

export interface QmpEvent {
    event: string;
    data?: Record<string, unknown>;
    timestamp?: { seconds: number; microseconds: number };
}

export class QmpClient extends JsonSocket {
    static async connect(path: string, timeoutMs = 10_000): Promise<QmpClient> {
        const sock = await JsonSocket.open(path, timeoutMs);
        Object.setPrototypeOf(sock, QmpClient.prototype);
        const q = sock as QmpClient;
        await q.expectFirst(timeoutMs);          // {"QMP": {"version": …}}
        await q.execute("qmp_capabilities");     // negotiate
        return q;
    }

    execute(cmd: string, args?: Record<string, unknown>): Promise<any> {
        return this.send(cmd, args);
    }

    override onMessage(msg: any): void {
        this.emit("event", msg as QmpEvent);
    }

    // ── convenience ──
    queryStatus(): Promise<{ running: boolean; singlestep: boolean; status: string }> {
        return this.execute("query-status");
    }
    systemPowerdown(): Promise<any> { return this.execute("system_powerdown"); }
    quit(): Promise<any> { return this.execute("quit"); }
    stop(): Promise<any> { return this.execute("stop"); }
    cont(): Promise<any> { return this.execute("cont"); }
    deviceAdd(driver: string, props: Record<string, unknown>): Promise<any> {
        return this.execute("device_add", { driver, ...props });
    }
    deviceDel(id: string): Promise<any> { return this.execute("device_del", { id }); }
    queryPci(): Promise<any> { return this.execute("query-pci"); }
    /** Human Monitor Protocol passthrough (e.g. `info usb`, savevm). */
    hmp(cmd: string): Promise<string> {
        return this.execute("human-monitor-command", { "command-line": cmd }).then((r) => String(r ?? ""));
    }
    /** Live snapshot-save (QEMU ≥6). Writes vmstate to a qcow2 target. */
    snapshotSave(vmstate: string, devices: string[] = []): Promise<any> {
        return this.execute("snapshot-save", { job_id: `snap-${Date.now()}`, vmstate, devices });
    }
    snapshotLoad(vmstate: string): Promise<any> {
        return this.execute("snapshot-load", { job_id: `snap-${Date.now()}`, vmstate });
    }
    blockdevBackup(jobId: string, device: string, target: string, sync = "full"): Promise<any> {
        return this.execute("blockdev-backup", { job_id: jobId, device, target, sync });
    }
    queryBlockJobs(): Promise<any[]> { return this.execute("query-block-jobs"); }
    jobDismiss(id: string): Promise<any> { return this.execute("job-dismiss", { id }); }
}
