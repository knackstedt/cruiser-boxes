// ============================================================================
// usb.ts — host USB enumeration (/sys/bus/usb) + QMP hotplug passthrough.
//
// Permissions: device_add usb-host needs rw on /dev/bus/usb/BBB/DDD — the
// doctor/setup writes a udev rule (or the user chowns). We surface the
// permission state so the UI can offer a fix instead of a dead click.
// ============================================================================

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canAccess } from "../../../sys/src/exec";
import type { QmpClient } from "../qmp/client";

export interface UsbDevice {
    bus: number;
    addr: number;
    vendorId: string;
    productId: string;
    vendor?: string;
    product?: string;
    serial?: string;
    speed?: string;
    devNode: string;          // /dev/bus/usb/BBB/DDD
    writable: boolean;        // can we pass it through right now?
    attached?: boolean;       // currently attached to *this* VM (best effort)
}

const SYS_USB = "/sys/bus/usb/devices";

export async function listUsbDevices(): Promise<UsbDevice[]> {
    let entries: string[];
    try { entries = await readdir(SYS_USB); } catch { return []; }
    const out: UsbDevice[] = [];
    for (const e of entries) {
        // Entries look like "1-2" (bus-port) for devices; skip "usbN" roots + interfaces "1-2:1.0".
        if (!/^(\d+)-(\d+(?:\.\d+)*)$/.test(e)) continue;
        const dir = join(SYS_USB, e);
        const rd = async (n: string) => (await readFile(join(dir, n), "utf-8")).trim();
        let vendorId: string, productId: string;
        try { vendorId = await rd("idVendor"); productId = await rd("idProduct"); } catch { continue; }
        const bus = Number(await rd("busnum").catch(() => "0"));
        const addr = Number(await rd("devnum").catch(() => "0"));
        const devNode = `/dev/bus/usb/${String(bus).padStart(3, "0")}/${String(addr).padStart(3, "0")}`;
        out.push({
            bus, addr, vendorId, productId,
            vendor: await rd("manufacturer").catch(() => undefined),
            product: await rd("product").catch(() => undefined),
            serial: await rd("serial").catch(() => undefined),
            speed: await rd("speed").catch(() => undefined),
            devNode,
            writable: await canAccess(devNode, 2 /* W_OK */ | 4 /* R_OK */),
        });
    }
    return out.sort((a, b) => (a.vendor ?? "").localeCompare(b.vendor ?? "") || a.productId.localeCompare(b.productId));
}

export async function findUsb(vendorId: string, productId: string, serial?: string): Promise<UsbDevice | null> {
    const all = await listUsbDevices();
    return all.find((d) => d.vendorId === vendorId && d.productId === productId && (!serial || d.serial === serial)) ?? null;
}

/** Hotplug: QMP device_add usb-host by bus/addr (most precise) or vid/pid. */
export async function usbAttach(qmp: QmpClient, d: UsbDevice): Promise<string> {
    const id = `usb-${d.vendorId}-${d.productId}-${d.bus}-${d.addr}`;
    await qmp.deviceAdd("usb-host", { id, bus: "xhci.0", hostbus: d.bus, hostaddr: d.addr });
    return id;
}

export async function usbDetach(qmp: QmpClient, id: string): Promise<void> {
    await qmp.deviceDel(id);
}

/** Devices currently attached to the VM (QMP query-pci scan for usb-host). */
export async function usbAttached(qmp: QmpClient): Promise<{ id: string }[]> {
    try {
        const out = await qmp.hmp("info usb");
        return out.split("\n").filter((l) => l.includes("usb-host")).map((l) => ({ id: l.trim() }));
    } catch {
        return [];
    }
}
