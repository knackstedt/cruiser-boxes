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
    // Entries look like "1-2" (bus-port) for devices; skip "usbN" roots + interfaces "1-2:1.0".
    const devs = entries.filter((e) => /^(\d+)-(\d+(?:\.\d+)*)$/.test(e));
    // All attribute reads for all devices in parallel — sysfs reads are
    // cheap but there are ~8 per device and this runs on every refresh.
    const out = await Promise.all(devs.map(async (e) => {
        const dir = join(SYS_USB, e);
        const rd = async (n: string) => (await readFile(join(dir, n), "utf-8")).trim();
        const attrs = await Promise.all([
            rd("idVendor"), rd("idProduct"),
            rd("busnum").catch(() => "0"), rd("devnum").catch(() => "0"),
            rd("manufacturer").catch(() => undefined), rd("product").catch(() => undefined),
            rd("serial").catch(() => undefined), rd("speed").catch(() => undefined),
        ]).catch(() => null);
        if (!attrs) return null;
        const [vendorId, productId, busnum, devnum, vendor, product, serial, speed] = attrs;
        if (!vendorId || !productId) return null;
        const bus = Number(busnum), addr = Number(devnum);
        const devNode = `/dev/bus/usb/${String(bus).padStart(3, "0")}/${String(addr).padStart(3, "0")}`;
        return {
            bus, addr, vendorId, productId, vendor, product, serial, speed,
            devNode,
            writable: await canAccess(devNode, 2 /* W_OK */ | 4 /* R_OK */),
        } as UsbDevice;
    }));
    return out.filter((d): d is UsbDevice => d !== null)
        .sort((a, b) => (a.vendor ?? "").localeCompare(b.vendor ?? "") || a.productId.localeCompare(b.productId));
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
