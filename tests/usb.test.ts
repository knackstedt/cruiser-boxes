import { describe, expect, test } from "bun:test";
import type { QmpClient } from "../libraries/vm-core/src/qmp/client";
import { usbAttached, usbAttachId } from "../libraries/vm-core/src/usb/usb";

const fakeQmp = (out: string) => ({ hmp: async () => out }) as unknown as QmpClient;

describe("usbAttached", () => {
    test("parses qmp ids + product labels out of 'info usb'", async () => {
        const q = fakeQmp([
            "  Device 0.1, Port 1, Speed 480 Mb/s, Product UT3 Drawing Pad, ID: usb-1bbb-0168-1-26",
            "  Device 0.2, Port 2, Speed 12 Mb/s, Product Generic Keypad, ID: usb-046d-c31c-1-4",
            "",
        ].join("\n"));
        expect(await usbAttached(q)).toEqual([
            { id: "usb-1bbb-0168-1-26", label: "UT3 Drawing Pad" },
            { id: "usb-046d-c31c-1-4", label: "Generic Keypad" },
        ]);
    });

    test("controller-only output (no passthrough devices) parses to []", async () => {
        const q = fakeQmp("  USB 3.0 XHCI Host Controller\n");
        expect(await usbAttached(q)).toEqual([]);
    });

    test("an id with no Product field falls back to the id as the label", async () => {
        const q = fakeQmp("  Device 0.3, Port 3, ID: usb-aaaa-bbbb-1-9\n");
        expect(await usbAttached(q)).toEqual([{ id: "usb-aaaa-bbbb-1-9", label: "usb-aaaa-bbbb-1-9" }]);
    });

    test("monitor failure → [] (a dead/starting VM reports nothing attached)", async () => {
        const q = { hmp: async () => { throw new Error("no monitor"); } } as unknown as QmpClient;
        expect(await usbAttached(q)).toEqual([]);
    });
});

describe("usbAttachId", () => {
    test("encodes bus+addr so a re-plugged device gets a fresh id", () => {
        expect(usbAttachId({ vendorId: "1bbb", productId: "0168", bus: 1, addr: 26 }))
            .toBe("usb-1bbb-0168-1-26");
        expect(usbAttachId({ vendorId: "1bbb", productId: "0168", bus: 1, addr: 27 }))
            .not.toBe("usb-1bbb-0168-1-26");
    });
});
