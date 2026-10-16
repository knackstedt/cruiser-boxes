import { describe, expect, test } from "bun:test";
import { defaultSpec } from "../libraries/vm-core/src/config/schema";
import { NotifyBridge, decodeNotify } from "../libraries/provision/src/notify";

const call = (sender: string, cookie: number, data: unknown[], member = "Notify") =>
    JSON.stringify({
        type: "method_call", sender, cookie, destination: ":1.30",
        interface: "org.freedesktop.Notifications", member,
        payload: { type: "susssasa{sv}i", data },
    });
const reply = (dest: string, replyCookie: number, data: unknown[]) =>
    JSON.stringify({ type: "method_return", sender: ":1.30", destination: dest, cookie: 500, reply_cookie: replyCookie, payload: { type: "u", data } });
const closed = (gid: number, reason = 1) =>
    JSON.stringify({
        type: "signal", sender: ":1.30", cookie: 600,
        interface: "org.freedesktop.Notifications", member: "NotificationClosed",
        payload: { type: "uu", data: [gid, reason] },
    });

describe("display.notifications", () => {
    test("schema flag defaults on", () => {
        expect(defaultSpec("n").display.notifications).toBe(true);
        expect(defaultSpec("n").display.notifications).toBe(true);
    });
    test("enabled gate: spec flag AND env kill", () => {
        const s = defaultSpec("n");
        expect(NotifyBridge.enabled(s, {})).toBe(true);
        expect(NotifyBridge.enabled(s, { CRUISER_NOTIFICATIONS: "0" })).toBe(false);
        s.display.notifications = false;
        expect(NotifyBridge.enabled(s, {})).toBe(false);
    });
});

describe("NotifyBridge.monitorCmd", () => {
    test("snoops calls + daemon replies + signals on the user bus", () => {
        const c = NotifyBridge.monitorCmd();
        expect(c).toContain("command -v busctl");
        expect(c).toContain("busctl --user monitor --json=short");
        expect(c).toContain("type='method_call',interface='org.freedesktop.Notifications'");
        expect(c).toContain("type='method_return',sender='org.freedesktop.Notifications'");
        expect(c).toContain("type='signal',interface='org.freedesktop.Notifications'");
        expect(c).toContain("/run/user/$(id -u)/bus");
    });
});

describe("decodeNotify", () => {
    test("extracts popup fields + variant-wrapped urgency hint", () => {
        const n = decodeNotify(JSON.parse(call(":1.9", 42, [
            "firefox", 0, "", "Download done", "file.pdf", [],
            { urgency: { type: "y", data: 2 }, "sender-pid": { type: "x", data: 123 } }, -1,
        ])))!;
        expect(n.appName).toBe("firefox");
        expect(n.replacesId).toBe(0);
        expect(n.summary).toBe("Download done");
        expect(n.body).toBe("file.pdf");
        expect(n.urgency).toBe(2);
        expect(n.expireMs).toBe(-1);
        expect(n.key).toBe(":1.9:42");
    });
    test("returns null for non-Notify messages and bare-number hints", () => {
        expect(decodeNotify(JSON.parse(reply(":1.9", 42, [7])))).toBeNull();
        expect(decodeNotify(JSON.parse(closed(1)))).toBeNull();
        const n = decodeNotify(JSON.parse(call(":1.9", 1, ["a", 0, "", "s", "b", [], {}, 5000])))!;
        expect(n.urgency).toBeNull();
        expect(n.expireMs).toBe(5000);
    });
});

describe("NotifyBridge id correlation", () => {
    function bridge() {
        const b = new NotifyBridge({ spec: defaultSpec("vm1") } as never);
        const posts: { summary: string; replaceHost: number | undefined }[] = [];
        const closes: number[] = [];
        let next = 50;
        b.postHost = async (n) => {
            const ids = (b as unknown as { ids: Map<number, number> }).ids;
            posts.push({ summary: n.summary, replaceHost: n.replacesId ? ids.get(n.replacesId) : undefined });
            return next++;
        };
        b.closeHost = async (id) => { closes.push(id); };
        return { b, posts, closes };
    }

    test("call → reply → replace → close round-trips ids", async () => {
        const { b, posts, closes } = bridge();
        await b.handleBusMessage(call(":1.5", 9, ["app", 0, "", "S", "B", [], {}, -1]));
        expect(posts).toHaveLength(1);
        expect(posts[0]!.replaceHost).toBeUndefined();
        // daemon assigns guest id 27 → binds to host id 50
        await b.handleBusMessage(reply(":1.5", 9, [27]));
        // app replaces id 27 — post sees the host id it maps to
        await b.handleBusMessage(call(":1.5", 10, ["app", 27, "", "S2", "B2", [], {}, -1]));
        expect(posts[1]!.replaceHost).toBe(50);
        await b.handleBusMessage(reply(":1.5", 10, [27]));
        // guest daemon closes it → CloseNotification on the host id
        await b.handleBusMessage(closed(27));
        expect(closes).toEqual([51]);
    });

    test("unrelated replies and closes are ignored", async () => {
        const { b, closes } = bridge();
        await b.handleBusMessage(reply(":1.5", 99, [1]));   // no pending call
        await b.handleBusMessage(closed(99));                // unknown guest id
        expect(closes).toEqual([]);
    });

    test("same cookie from a different sender doesn't collide", async () => {
        const { b, closes } = bridge();
        await b.handleBusMessage(call(":1.5", 9, ["a", 0, "", "s", "b", [], {}, -1]));
        await b.handleBusMessage(call(":1.7", 9, ["a", 0, "", "s", "b", [], {}, -1]));
        await b.handleBusMessage(reply(":1.7", 9, [30])); // :1.7's reply, not :1.5's
        await b.handleBusMessage(closed(30));
        expect(closes).toEqual([51]);                       // second post's host id
    });
});
