import { describe, expect, test } from "bun:test";
import type { DocMutation } from "@downdraft/engine/modules/html-ui";
import { contentPatch, applySameRoute, type PatchTarget } from "../libraries/app-shell/src/content-patch";
import { renderRouteParts, type RouteParts } from "../libraries/app-shell/src/screens";
import { createCruiserStore } from "../libraries/app-shell/src/store";
import type { VmSummary } from "../libraries/app-shell/src/store";

// ── fixtures ──

function mkVm(name: string, over: Partial<VmSummary> = {}): VmSummary {
    return {
        name, state: "stopped", gpuMode: "venus", headMode: "virtual-desktop",
        cpus: 4, memMiB: 8192, diskGiB: 100, nestedVirt: false,
        persist: "daemonize", username: "cruiser", hasPassword: false,
        encrypt: "off", keyStorage: "store", diskLocked: false,
        description: "", shares: [], snapshots: [], snapAuto: "off",
        snapTrigger: "stop", snapKeep: 5, vd: 0, usbKeys: [], swVk: false, forwards: [],
        cpu: [], mem: [], disk: [], net: [], gpu: [],
        ...over,
    };
}

function stateWith(vms: VmSummary[], route: "home" | "vm" | "logs" | "term" = "home", sel?: string) {
    const store = createCruiserStore();
    store.setState({ vms, route, selectedVm: sel ?? vms[0]?.name ?? null });
    return store.getState();
}

/** Recording stand-in for UiPanelHandle's mutation surface. */
function fakePanel() {
    const calls: { kind: string; sel?: string; html?: string; ops?: DocMutation[] }[] = [];
    const target: PatchTarget = {
        setInnerHtml: (sel, html) => calls.push({ kind: "innerHtml", sel, html }),
        mutate: (ops) => calls.push({ kind: "mutate", ops }),
        scrollTo: (sel) => calls.push({ kind: "scrollTo", sel }),
    };
    return { calls, target };
}

/** Every mutation op the fake received, flattened. */
function allOps(calls: { kind: string; ops?: DocMutation[] }[]): DocMutation[] {
    return calls.flatMap((c) => c.ops ?? []);
}

function innerHtmlOf(op: DocMutation): string | undefined {
    return op.op === "innerHtml" ? op.html : undefined;
}

// ── contentPatch (pure) ──

describe("contentPatch", () => {
    const parts = (regs: RouteParts["regions"], rows?: RouteParts["rowGroup"], content = "c"): RouteParts => ({
        topbar: "t", content, footer: "f", log: null, regions: regs, rowGroup: rows, html: "h",
    });

    test("identical surfaces emit zero ops", () => {
        const p = parts([{ sel: "#a", html: "1" }]);
        expect(contentPatch(p, { ...p })).toEqual([]);
    });

    test("changed region → one innerHtml op on its selector", () => {
        const prev = parts([{ sel: "#a", html: "1" }, { sel: "#b", html: "x" }]);
        const cur = parts([{ sel: "#a", html: "2" }, { sel: "#b", html: "x" }], undefined, "c2");
        expect(contentPatch(prev, cur)).toEqual([{ op: "innerHtml", sel: "#a", html: "2" }]);
    });

    test("region set/order mismatch → null (caller falls back)", () => {
        const a = parts([{ sel: "#a", html: "1" }]);
        expect(contentPatch(a, parts([{ sel: "#b", html: "1" }]))).toBeNull();
        expect(contentPatch(a, parts([{ sel: "#a", html: "1" }, { sel: "#b", html: "2" }]))).toBeNull();
        expect(contentPatch(a, parts(undefined))).toBeNull();
    });

    test("changed row → op only on that row's id", () => {
        const grp = (htmls: string[]) => ({
            container: "#vmlist", containerHtml: "x",
            rows: htmls.map((h, i) => ({ id: `vmrow-vm${i}`, html: h })),
        });
        const prev = parts([], grp(["a", "b"]));
        const cur = parts([], grp(["a", "B"]), "c2");
        expect(contentPatch(prev, cur)).toEqual([{ op: "innerHtml", sel: "#vmrow-vm1", html: "B" }]);
    });

    test("row add/remove/reorder → wholesale container patch", () => {
        const grp = (ids: string[], html = "x") => ({
            container: "#vmlist", containerHtml: html,
            rows: ids.map((id) => ({ id, html: id })),
        });
        const prev = parts([], grp(["a", "b"], "old"));
        // added
        expect(contentPatch(prev, parts([], grp(["a", "b", "c"], "new"))))
            .toEqual([{ op: "innerHtml", sel: "#vmlist", html: "new" }]);
        // removed
        expect(contentPatch(prev, parts([], grp(["a"], "new"))))
            .toEqual([{ op: "innerHtml", sel: "#vmlist", html: "new" }]);
        // reordered
        expect(contentPatch(prev, parts([], grp(["b", "a"], "new"))))
            .toEqual([{ op: "innerHtml", sel: "#vmlist", html: "new" }]);
    });

    test("empty→empty container body change still patches the container", () => {
        const grp = (html: string) => ({ container: "#vmlist", containerHtml: html, rows: [] });
        expect(contentPatch(parts([], grp("old-empty")), parts([], grp("new-empty"), "c2")))
            .toEqual([{ op: "innerHtml", sel: "#vmlist", html: "new-empty" }]);
    });

    test("rowGroup asymmetry / container rename → null", () => {
        const grp = { container: "#vmlist", containerHtml: "x", rows: [{ id: "a", html: "1" }] };
        const grp2 = { container: "#other", containerHtml: "x", rows: [{ id: "a", html: "1" }] };
        expect(contentPatch(parts([], grp), parts([]))).toBeNull();
        expect(contentPatch(parts([]), parts([], grp))).toBeNull();
        expect(contentPatch(parts([], grp), parts([], grp2, "c2"))).toBeNull();
    });
});

// ── renderRouteParts surface integrity ──

describe("route patch surfaces", () => {
    function selsInMount(parts: RouteParts): string[] {
        // every region sel + row id must resolve to a node in the mounted
        // markup — a patch targeting a missing node is a silent no-op.
        const sels = (parts.regions ?? []).map((r) => r.sel);
        const rows = (parts.rowGroup?.rows ?? []).map((r) => `#${r.id}`);
        if (parts.rowGroup) sels.push(parts.rowGroup.container);
        return [...sels, ...rows];
    }

    test("home: every patchable sel exists as an id in the mounted doc", () => {
        const s = stateWith([mkVm("vm-1"), mkVm("vm-2", { state: "running", cpu: [5] })]);
        const parts = renderRouteParts(s);
        for (const sel of selsInMount(parts)) {
            expect(sel.startsWith("#")).toBe(true);
            expect(parts.content).toContain(`id="${sel.slice(1)}"`);
        }
        expect(parts.content).toContain(`id="vmrow-vm-1"`);
        expect(parts.content).toContain(`id="vmrow-vm-2"`);
    });

    test("vm detail + logs + term mounts expose their regions", () => {
        const vm = mkVm("vm-1", { state: "running", cpu: [10] });
        for (const route of (["vm", "logs", "term"] as const).values()) {
            const parts = renderRouteParts(stateWith([vm], route, "vm-1"));
            for (const sel of selsInMount(parts))
                expect(parts.content).toContain(`id="${sel.slice(1)}"`);
        }
    });

    test("row inner markup never carries the wrapper's own tag", () => {
        const parts = renderRouteParts(stateWith([mkVm("vm-1")]));
        const row = parts.rowGroup!.rows[0]!;
        // innerHtml replaces children — the row html must be children only
        expect(row.html).not.toContain('class="vmrow"');
        expect(row.html).not.toContain(`id="vmrow-vm-1"`);
    });
});

// ── applySameRoute against a recording panel ──

describe("applySameRoute", () => {
    test("metrics tick on one running VM patches only that row", () => {
        const vms = [mkVm("vm-1"), mkVm("vm-2", { state: "running", cpu: [10], mem: [20] }), mkVm("vm-3")];
        const prev = renderRouteParts(stateWith(vms));
        const next = renderRouteParts(stateWith([
            vms[0]!, mkVm("vm-2", { state: "running", cpu: [10, 30], mem: [20, 22] }), vms[2]!,
        ]));
        const { calls, target } = fakePanel();
        applySameRoute(prev, next, target);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.kind).toBe("mutate");
        const ops = calls[0]!.ops!;
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ op: "innerHtml", sel: "#vmrow-vm-2" });
        // the changed row html really is the new row body
        expect(innerHtmlOf(ops[0]!)).toContain("cpu");
    });

    test("idle tick with no visible change emits zero DOM writes", () => {
        const vms = [mkVm("vm-1"), mkVm("vm-2", { state: "stopped" })];
        const prev = renderRouteParts(stateWith(vms));
        // new array, same rendered content — a summary refresh that moved nothing
        const next = renderRouteParts(stateWith([mkVm("vm-1"), mkVm("vm-2")]));
        const { calls, target } = fakePanel();
        applySameRoute(prev, next, target);
        expect(calls).toEqual([]);
    });

    test("VM add patches the list container once, not .content", () => {
        const prev = renderRouteParts(stateWith([mkVm("vm-1")]));
        const next = renderRouteParts(stateWith([mkVm("vm-1"), mkVm("vm-2")]));
        const { calls, target } = fakePanel();
        applySameRoute(prev, next, target);
        const ops = allOps(calls);
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ op: "innerHtml", sel: "#vmlist" });
        // container html carries BOTH row wrappers — no orphan survivors
        expect(innerHtmlOf(ops[0]!)).toContain('id="vmrow-vm-1"');
        expect(innerHtmlOf(ops[0]!)).toContain('id="vmrow-vm-2"');
        expect(calls.every((c) => c.sel !== ".content")).toBe(true);
    });

    test("empty→populated and populated→empty go through the container", () => {
        const empty = renderRouteParts(stateWith([]));
        const full = renderRouteParts(stateWith([mkVm("vm-1")]));
        const f1 = fakePanel();
        applySameRoute(empty, full, f1.target);
        expect(allOps(f1.calls).some((o) => o.op === "innerHtml" && o.sel === "#vmlist")).toBe(true);
        const f2 = fakePanel();
        applySameRoute(full, empty, f2.target);
        expect(allOps(f2.calls).some((o) => o.op === "innerHtml" && o.sel === "#vmlist"
            && innerHtmlOf(o)!.includes("No VMs yet"))).toBe(true);
    });

    test("vm detail tick patches #vmtop but never #vmrest", () => {
        const vm = (cpu: number[]) => mkVm("vm-1", { state: "running", cpu, shares: [
            { idx: 0, hostPath: "/h", tag: "h", mode: "mount", direction: "both", enabled: true, deletions: false },
        ] });
        const prev = renderRouteParts(stateWith([vm([10])], "vm", "vm-1"));
        const next = renderRouteParts(stateWith([vm([10, 40])], "vm", "vm-1"));
        const { calls, target } = fakePanel();
        applySameRoute(prev, next, target);
        const ops = allOps(calls);
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ op: "innerHtml", sel: "#vmtop" });
        expect(ops.every((o) => !(o.op === "innerHtml" && o.sel === "#vmrest"))).toBe(true);
        // the share form inputs live in #vmrest — untouched by metric ticks
    });

    test("logs route tick patches only #logmeta", () => {
        const mk = (fetchedAt: number) => {
            const s = stateWith([mkVm("vm-1")], "logs", "vm-1");
            return { ...s, logs: { ...s.logs, text: "line", fetchedAt } };
        };
        const prev = renderRouteParts(mk(0));
        const next = renderRouteParts(mk(Date.now()));
        const { calls, target } = fakePanel();
        applySameRoute(prev, next, target);
        const ops = allOps(calls);
        // meta line + the .logpre body may both move; controls must not
        expect(ops.every((o) => o.op !== "innerHtml" || o.sel !== "#logctl")).toBe(true);
        expect(ops.some((o) => o.op === "innerHtml" && o.sel === "#logmeta")).toBe(true);
    });

    test("term route: termLine tick touches #termhead, never #termbox", () => {
        const prev = renderRouteParts(stateWith([mkVm("vm-1")], "term", "vm-1"));
        const s2 = { ...stateWith([mkVm("vm-1")], "term", "vm-1"), termLine: "connected" };
        const next = renderRouteParts(s2);
        const { calls, target } = fakePanel();
        applySameRoute(prev, next, target);
        const ops = allOps(calls);
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ op: "innerHtml", sel: "#termhead" });
        // #termbox is composited over by the webui view — a patch targeting
        // it would blank the terminal for a frame
        expect(ops.every((o) => !(o.op === "innerHtml" && o.sel === "#termbox"))).toBe(true);
    });

    test("create route keeps the wholesale .content path", () => {
        const s1 = { ...stateWith([]), route: "create" as const };
        const prev = renderRouteParts(s1);
        const next = renderRouteParts({ ...s1, create: { ...s1.create, name: "typed" } });
        const { calls, target } = fakePanel();
        applySameRoute(prev, next, target);
        // footer status always moves with status; content must fall back
        expect(calls.some((c) => c.sel === ".content")).toBe(true);
    });
});

// ── stress / leak shape ──

describe("update storms", () => {
    test("2000 metric ticks stay bounded — one op per changed row, no drift", () => {
        let vms = [mkVm("vm-1", { state: "running", cpu: [1] }), mkVm("vm-2")];
        let prev = renderRouteParts(stateWith(vms));
        let totalOps = 0;
        let staleSel = false;
        for (let i = 0; i < 2000; i++) {
            vms = [mkVm("vm-1", { state: "running", cpu: [...vms[0]!.cpu.slice(-40), i % 100] }), vms[1]!];
            const next = renderRouteParts(stateWith(vms));
            const { calls, target } = fakePanel();
            applySameRoute(prev, next, target);
            const ops = allOps(calls);
            totalOps += ops.length;
            // every op must target a node that exists in the CURRENT doc
            ops.forEach((o) => {
                if (o.op === "innerHtml" && o.sel
                    && !next.content.includes(`id="${o.sel.slice(1)}"`)) staleSel = true;
            });
            // >1 region+row op per tick means we're patching more than moved
            expect(ops.length).toBeLessThanOrEqual(2);
            prev = next;
        }
        expect(staleSel).toBe(false);
        // 2000 ticks × 1 changed row = at most ~2000 ops + region churn —
        // if rows accumulated or the diff degenerated to .content we'd see
        // per-tick wholesale patches instead of bounded row ops
        expect(totalOps).toBeLessThanOrEqual(4100);
        expect(totalOps).toBeGreaterThan(1000); // sanity: patching happened
    });

    test("removed-row selectors are never re-targeted", () => {
        let vms = [mkVm("vm-1"), mkVm("vm-2"), mkVm("vm-3")];
        let prev = renderRouteParts(stateWith(vms));
        vms = [vms[0]!, vms[2]!]; // vm-2 deleted
        let { calls, target } = fakePanel();
        applySameRoute(prev, renderRouteParts(stateWith(vms)), target);
        expect(allOps(calls).some((o) => o.sel === "#vmrow-vm-2")).toBe(false); // container op instead
        prev = renderRouteParts(stateWith(vms));
        // later ticks never address the dead node
        vms = [mkVm("vm-1", { description: "x" }), vms[1]!];
        ({ calls, target } = fakePanel());
        applySameRoute(prev, renderRouteParts(stateWith(vms)), target);
        for (const o of allOps(calls))
            expect(o.sel === "#vmrow-vm-2").toBe(false);
    });
});
