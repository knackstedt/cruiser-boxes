import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";

// Keys land under XDG_CONFIG_HOME — redirect before paths.ts evaluates.
process.env.XDG_CONFIG_HOME = mkdtempSync("/var/tmp/cruiser-test-cfg-");

const { sshArgv, sshTarget } = await import("../libraries/vm-core/src/ssh");
const { defaultSpec } = await import("../libraries/vm-core/src/config/schema");

function spec(mutate?: (s: ReturnType<typeof defaultSpec>) => void) {
    const s = defaultSpec("t1");
    s.network.sshPort = 2222;
    s.credentials.username = "alice";
    mutate?.(s);
    return s;
}

describe("sshArgv", () => {
    test("base argv: key, port, batch host-key opts, guest identity", async () => {
        const a = await sshArgv(spec());
        expect(a).toContain("-i");
        expect(a[a.indexOf("-i") + 1]).toContain("id_ed25519");
        expect(a).toContain("-p");
        expect(a[a.indexOf("-p") + 1]).toBe("2222");
        const opts = a.join(" ");
        expect(opts).toContain("BatchMode=yes");
        expect(opts).toContain("StrictHostKeyChecking=no");
        expect(opts).toContain("UserKnownHostsFile=/dev/null");
        expect(a[a.length - 1]).toBe("alice@127.0.0.1");
    });

    test("tty:true prepends -tt; remoteCmd lands after the destination", async () => {
        const a = await sshArgv(spec(), { tty: true, remoteCmd: ["journalctl", "-f"] });
        expect(a[0]).toBe("-tt");
        const dest = a.indexOf("alice@127.0.0.1");
        expect(a.slice(dest)).toEqual(["alice@127.0.0.1", "journalctl", "-f"]);
        // `--` must not appear — OpenSSH would treat it as part of the cmd.
        expect(a).not.toContain("--");
    });

    test("throws when the spec has no ssh hostfwd", async () => {
        await expect(sshArgv(spec((s) => { s.network.sshPort = 0; }))).rejects.toThrow("no SSH hostfwd");
    });

    test("sshTarget renders user@host:port", () => {
        expect(sshTarget(spec())).toBe("alice@127.0.0.1:2222");
    });
});
