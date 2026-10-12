import { describe, expect, test } from "bun:test";
import { defaultSpec, parseVmSpec } from "../libraries/vm-core/src/config/schema";
import {
    copyEntries, filesyncEnabled, guestFileSyncPrepScript, guestTarget, rsyncArgv,
} from "../libraries/provision/src/filesync";
import { guestSharesScript } from "../libraries/provision/src/sync";

const spec = () => {
    const s = defaultSpec("testvm");
    s.network.sshPort = 2222;
    s.credentials.username = "cruiser";
    return s;
};

const share = (o: Partial<import("../libraries/vm-core/src/config/schema").ShareSpec>) =>
    parseVmSpec({ name: "x", shares: [{ hostPath: "/h", tag: "t", ...o }] }).shares[0]!;

describe("copy-mode entries", () => {
    test("copyEntries picks enabled copy shares only", () => {
        const s = spec();
        expect(copyEntries(s)).toEqual([]);
        s.shares.push(share({ mode: "copy" }), share({ mode: "mount", tag: "m" }), share({ mode: "copy", tag: "off", enabled: false }));
        expect(copyEntries(s).map((x) => x.tag)).toEqual(["t"]);
    });
    test("env kills", () => {
        const e = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
        expect(filesyncEnabled({} as NodeJS.ProcessEnv)).toBe(true);
        expect(filesyncEnabled(e({ CRUISER_FILESYNC: "0" }))).toBe(false);
        expect(filesyncEnabled(e({ CRUISER_HOST_SYNC: "0" }))).toBe(false);
    });
    test("guestTarget: explicit guestPath wins; default is ~/cruiser-sync/<base>", () => {
        const s = spec();
        expect(guestTarget(s, share({ mode: "copy", guestPath: "/opt/x" }))).toBe("/opt/x");
        expect(guestTarget(s, share({ mode: "copy", hostPath: "/home/u/proj" }))).toBe("/home/cruiser/cruiser-sync/proj");
    });
});

describe("rsync argv", () => {
    const s = spec();
    const priv = "/k";
    test("push dir: contents into guest dir, host→guest authoritative", () => {
        const sh = share({ mode: "copy", direction: "host-to-guest", hostPath: "/h/dir", guestPath: "/g/dir" });
        const a = rsyncArgv(s, sh, "push", priv, true);
        expect(a).toContain("-az");
        expect(a).toContain("/h/dir/");
        expect(a[a.length - 1]).toBe("cruiser@127.0.0.1:/g/dir/");
        expect(a).not.toContain("--update");
        expect(a).not.toContain("--delete");
        expect(a.join(" ")).toContain("ssh -i /k -p 2222");
    });
    test("push with deletions adds --delete", () => {
        const sh = share({ mode: "copy", direction: "host-to-guest", deletions: true });
        expect(rsyncArgv(s, sh, "push", priv, true)).toContain("--delete");
    });
    test("bidirectional: --update both ways (newest wins, no deletes)", () => {
        const sh = share({ mode: "copy", direction: "both", hostPath: "/h/dir", guestPath: "/g/d" });
        const p = rsyncArgv(s, sh, "push", priv, true);
        const q = rsyncArgv(s, sh, "pull", priv, true);
        expect(p).toContain("--update"); expect(q).toContain("--update");
        expect(q[q.length - 2]).toBe("cruiser@127.0.0.1:/g/d/");
        expect(q[q.length - 1]).toBe("/h/dir/");
        expect(q).not.toContain("--delete");
    });
    test("single file: push file→dir, pull dir/file→file", () => {
        const sh = share({ mode: "copy", direction: "both", hostPath: "/h/f.conf", guestPath: "/g" });
        const p = rsyncArgv(s, sh, "push", priv, false);
        expect(p[p.length - 2]).toBe("/h/f.conf");
        expect(p[p.length - 1]).toBe("cruiser@127.0.0.1:/g/");
        const q = rsyncArgv(s, sh, "pull", priv, false);
        expect(q[q.length - 2]).toBe("cruiser@127.0.0.1:/g/f.conf");
        expect(q[q.length - 1]).toBe("/h/f.conf");
    });
    test("no ssh port → throw", () => {
        const s2 = spec(); s2.network.sshPort = undefined;
        expect(() => rsyncArgv(s2, share({ mode: "copy" }), "push", priv, true)).toThrow("hostfwd");
    });
});

describe("guest scripts", () => {
    test("prep: installs rsync, mkdirs + chowns targets, exits 0", () => {
        const s = spec();
        s.shares.push(share({ mode: "copy", guestPath: "/g/a" }), share({ mode: "copy", guestPath: "/g/b" }));
        const sh = guestFileSyncPrepScript(s);
        expect(sh).toContain("apt-get install -y rsync");
        expect(sh).toContain("mkdir -p '/g/a'");
        expect(sh).toContain("mkdir -p '/g/b'");
        expect(sh).toContain("chown 'cruiser':'cruiser' '/g/a'");
        expect(sh).toContain("exit 0");
    });

    test("shares reconcile: managed block, ro flag, custom guestPath", () => {
        const s = spec();
        s.shares.push(
            share({ mode: "mount", tag: "rw1", hostPath: "/h/a", direction: "both" }),
            share({ mode: "mount", tag: "ro1", hostPath: "/h/b", direction: "host-to-guest", guestPath: "/opt/shared" }),
            share({ mode: "copy", tag: "cp1", hostPath: "/h/c" }),          // not in fstab
        );
        const sh = guestSharesScript(s);
        expect(sh).toContain("# >>> cruiser-shares >>>");
        expect(sh).toContain("# <<< cruiser-shares <<<");
        expect(sh).toContain("rw1 /mnt/rw1 virtiofs rw,");
        expect(sh).toContain("rw1 /mnt/rw1 9p");
        expect(sh).not.toContain("ro1 /mnt/ro1 9p");        // guestPath overrode /mnt/<tag>
        expect(sh).toContain("ro1 /opt/shared virtiofs ro,");
        expect(sh).toContain("ro1 /opt/shared 9p trans=virtio,version=9p2000.L,msize=262144,_netdev,x-systemd.automount,x-systemd.idle-timeout=60,nofail,ro");
        expect(sh).not.toContain("cp1 ");
        expect(sh).toContain("umount -l");                  // stale mounts cleaned
        expect(sh).toContain("daemon-reload");
    });
    test("empty share list still reconciles (clears stale entries)", () => {
        const sh = guestSharesScript(spec());
        expect(sh).toContain("cruiser-shares");
        expect(sh).toContain("sed -i");
    });
    test("disabled shares are excluded", () => {
        const s = spec();
        s.shares.push(share({ mode: "mount", tag: "off1", enabled: false }));
        expect(guestSharesScript(s)).not.toContain("off1 /mnt/off1");
    });
});
