// ============================================================================
// content-patch.ts — same-route .content diffing.
//
// Route renderers declare a fine-grained patch surface (regions + rowGroup).
// When prev and cur renders expose structurally identical surfaces we emit a
// batched mutate() covering only the regions/rows whose markup changed —
// the 3s metrics tick then reparses one changed row instead of the whole
// page. Any structural surprise (region list mismatch, row set/order
// change, one side lacking regions) falls back to patching .content
// wholesale — the behavior before fine patching existed.
// ============================================================================

import type { DocMutation } from "@downdraft/engine/modules/html-ui";
import { diffFragmentOps } from "./fragment-diff";
import type { RouteParts } from "./screens";

/** The slice of UiPanelHandle the patcher drives — structurally satisfied
 *  by the real panel; tests substitute a recording fake. */
export interface PatchTarget {
    setInnerHtml(sel: string, html: string): void;
    mutate(ops: DocMutation[]): void;
    scrollTo(sel: string, x: number, y: number): void;
}

const isSpinwrap = (html: string) => html.startsWith('<div class="spinwrap"');

/**
 * Decide how to apply cur's .content given prev's.
 *   DocMutation[] — apply via panel.mutate() ([] = nothing to do)
 *   null          — no fine surface or a structural mismatch; the caller
 *                   patches ".content" with cur.content directly.
 * Only called when cur.content !== prev.content.
 */
export function contentPatch(prev: RouteParts, cur: RouteParts): DocMutation[] | null {
    const hasSurface = (p: RouteParts) => !!(p.regions?.length || p.rowGroup);
    if (!hasSurface(prev) || !hasSurface(cur)) return null;

    // Regions must line up 1:1 (same selectors, same order) — a route
    // emitting a different region set between renders goes through the
    // wholesale path rather than guessing at stale targets.
    const pRegs = prev.regions ?? [];
    const cRegs = cur.regions ?? [];
    if (pRegs.length !== cRegs.length) return null;
    const ops: DocMutation[] = [];
    // Same-shape markup changes get attr/text mutations on the live nodes —
    // the node keeps its old style so CSS transitions actually run. Any
    // structural diff falls back to replacing the subtree's innerHtml.
    const patchFrag = (sel: string, prevHtml: string, curHtml: string) => {
        const fine = diffFragmentOps(prevHtml, curHtml, sel);
        if (fine) ops.push(...fine);
        else ops.push({ op: "innerHtml", sel, html: curHtml });
    };
    for (let i = 0; i < cRegs.length; i++) {
        if (cRegs[i]!.sel !== pRegs[i]!.sel) return null;
        if (cRegs[i]!.html !== pRegs[i]!.html) patchFrag(cRegs[i]!.sel, pRegs[i]!.html, cRegs[i]!.html);
    }

    const pg = prev.rowGroup;
    const cg = cur.rowGroup;
    if ((pg === undefined) !== (cg === undefined)) return null;
    if (pg && cg) {
        if (pg.container !== cg.container) return null;
        const pr = pg.rows, cr = cg.rows;
        const sameRows = pr.length === cr.length && cr.every((r, i) => r.id === pr[i]!.id);
        if (sameRows && cr.length) {
            // Same row set + order → patch just the rows whose markup moved.
            for (let i = 0; i < cr.length; i++) {
                if (cr[i]!.html !== pr[i]!.html) patchFrag(`#${cr[i]!.id}`, pr[i]!.html, cr[i]!.html);
            }
        } else if (cg.containerHtml !== pg.containerHtml) {
            // Add/remove/reorder — or the empty-state body itself changed.
            ops.push({ op: "innerHtml", sel: cg.container, html: cg.containerHtml });
        }
    }
    return ops;
}

/**
 * Same-route application: patch topbar/content/log/footer by region, using
 * fine-grained mutate() ops for .content when both renders expose the same
 * patch surface. Returns true when the log region changed (caller re-pins
 * the scrollpane if needed).
 */
export function applySameRoute(prev: RouteParts, parts: RouteParts, p: PatchTarget): boolean {
    if (parts.topbar !== prev.topbar) p.setInnerHtml(".topbar", parts.topbar);
    if (parts.content !== prev.content) {
        const ops = contentPatch(prev, parts);
        if (ops === null) {
            // No fine surface — diff the whole .content fragment: an
            // attr/text-only change still preserves nodes (so CSS
            // transitions can run) while structural changes get the
            // innerHtml rebuild they've always had.
            const fine = diffFragmentOps(prev.content, parts.content, ".content");
            if (fine) {
                if (fine.length) p.mutate(fine);
            } else {
                p.setInnerHtml(".content", parts.content);
                // The scrollport node survives the patch with its scroll
                // offset, and nothing re-clamps it when the content shrinks —
                // the Create button sits at the bottom of a long form, so the
                // form→spinner swap leaves a near-max offset pointing past the
                // end of the 540px .spinwrap and the pane paints empty. A
                // spinner↔content swap resets to the top.
                if (isSpinwrap(prev.content) !== isSpinwrap(parts.content))
                    p.scrollTo(".content", 0, 0);
            }
        } else if (ops.length) {
            p.mutate(ops);
        }
    }
    // .logpre is a sibling of .content patched through its own region —
    // the scrollport node (and its scroll offset) survives, so refreshes
    // don't reset or blank the pane.
    const logChanged = parts.log !== null && parts.log !== prev.log;
    if (logChanged) p.setInnerHtml(".logpre", parts.log!);
    if (parts.footer !== prev.footer) p.setInnerHtml(".footer", parts.footer);
    return logChanged;
}
