import { describe, expect, test } from "bun:test";
import { RenderGate } from "../libraries/app-shell/src/render-gate";

describe("RenderGate", () => {
    test("identical markup is a no-op (idle polls never touch the DOM)", () => {
        const applied: string[] = [];
        const g = new RenderGate("a", (h) => applied.push(h));
        g.render("a");
        g.render("a");
        expect(applied).toEqual([]);
    });

    test("changed markup applies immediately when not editing", () => {
        const applied: string[] = [];
        const g = new RenderGate("a", (h) => applied.push(h));
        g.render("b");
        expect(applied).toEqual(["b"]);
    });

    test("a focused input defers renders; blur reports the pending flush", () => {
        const applied: string[] = [];
        const g = new RenderGate("a", (h) => applied.push(h));
        g.focus("input");
        g.render("b");
        g.render("c");
        expect(applied).toEqual([]);
        expect(g.blur()).toBe(true);
        g.render("c"); // caller re-renders current state on flush
        expect(applied).toEqual(["c"]);
    });

    test("non-input focus does not defer", () => {
        const applied: string[] = [];
        const g = new RenderGate("a", (h) => applied.push(h));
        g.focus("div");
        g.render("b");
        expect(applied).toEqual(["b"]);
    });

    test("identical markup while editing does not arm a deferred render", () => {
        const g = new RenderGate("a", () => {});
        g.focus("input");
        g.render("a");
        expect(g.blur()).toBe(false);
    });

    test("blur→focus in the same batch keeps the render deferred", () => {
        const applied: string[] = [];
        const g = new RenderGate("a", (h) => applied.push(h));
        g.focus("input");
        g.render("b");
        expect(g.blur()).toBe(true);
        g.focus("textarea"); // moved to another field before flush ran
        g.render("b");
        expect(applied).toEqual([]);
    });
});
