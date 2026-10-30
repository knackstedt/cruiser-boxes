// ============================================================================
// fragment-diff.ts — attr-level diffing between two generated markup fragments.
//
// contentPatch replaces a changed region/row via innerHtml, which recreates
// every node inside — a recreated node has no previous style, so CSS
// `transition:` declarations can never run through that path (the doc engine
// interpolates fine; it just needs the same node to survive the style flip).
// When prev/cur markup share the same element structure and differ only in
// attributes or leaf text, this emits `attr`/`rattr`/`text` mutations against
// nth-child path selectors instead — the live node keeps its old style and
// the transition runs. ANY structural difference (tag, child count, mixed-
// content text) falls back to the caller's innerHtml op — markup is
// machine-generated, so the common state-flip case is a pure attr diff.
// ============================================================================

import type { DocMutation } from "@downdraft/engine/modules/html-ui";

interface FNode {
    tag: string;
    attrs: Map<string, string>;
    kids: (FNode | string)[];
}

const VOID_TAGS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "source", "track", "wbr",
]);

const NAMED_ENTITIES: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeEntities(s: string): string {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e: string) => {
        if (e.startsWith("#")) {
            const n = e[1] === "x" || e[1] === "X"
                ? parseInt(e.slice(2), 16)
                : parseInt(e.slice(1), 10);
            return Number.isNaN(n) ? m : String.fromCodePoint(n);
        }
        return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** Conservative fragment parser for generated markup. Returns the top-level
 *  kid list on clean parse, null on anything unexpected (unbalanced tags,
 *  stray text after close, malformed attrs) — callers fall back to
 *  innerHtml, so misses are safe. */
function parseFragment(html: string): (FNode | string)[] | null {
    const root: FNode = { tag: "#root", attrs: new Map(), kids: [] };
    const stack = [root];
    const top = () => stack[stack.length - 1]!;
    let i = 0, textStart = 0;
    const flushText = () => {
        if (textStart < i) top().kids.push(decodeEntities(html.slice(textStart, i)));
        textStart = i;
    };
    while (i < html.length) {
        if (html[i] !== "<") { i++; continue; }
        if (html.startsWith("<!--", i)) {
            flushText();
            const end = html.indexOf("-->", i + 4);
            if (end < 0) return null;
            i = end + 3;
            textStart = i;
            continue;
        }
        if (html.startsWith("</", i)) {
            flushText();
            const m = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(html.slice(i));
            if (!m || m[1] !== top().tag || stack.length < 2) return null;
            stack.pop();
            i += m[0].length;
            textStart = i;
            continue;
        }
        const m = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(html.slice(i));
        if (!m) return null;
        flushText();
        const node: FNode = { tag: m[1]!.toLowerCase(), attrs: new Map(), kids: [] };
        const attrSrc = m[2]!;
        const attrRe = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|[^\s>]*))?/g;
        let am: RegExpExecArray | null;
        while ((am = attrRe.exec(attrSrc)))
            node.attrs.set(am[1], decodeEntities(am[2] ?? am[3] ?? am[4] ?? ""));
        // Anything the attr pass didn't consume must be whitespace plus at
        // most one self-close slash — anything else means the tag isn't the
        // well-formed shape this parser assumes.
        const rest = attrSrc.replace(attrRe, "");
        const selfClose = rest.includes("/");
        if (rest.replace("/", "").trim() !== "") return null;
        top().kids.push(node);
        i += m[0].length;
        if (!selfClose && !VOID_TAGS.has(node.tag)) stack.push(node);
        textStart = i;
    }
    flushText();
    if (stack.length !== 1) return null;
    return root.kids;
}

/**
 * Diff two generated fragments rooted at `sel`. Returns the attr/text ops
 * needed to turn prev's live subtree into cur, or null when the fragments
 * aren't shape-identical (caller then patches `sel` with innerHtml).
 */
export function diffFragmentOps(prevHtml: string, curHtml: string, sel: string): DocMutation[] | null {
    const a = parseFragment(prevHtml), b = parseFragment(curHtml);
    if (!a || !b) return null;
    const ops: DocMutation[] = [];

    const diffNode = (nodeSel: string, x: FNode, y: FNode): boolean => {
        if (x.tag !== y.tag) return false;
        new Set([...x.attrs.keys(), ...y.attrs.keys()]).forEach((name) => {
            const xv = x.attrs.get(name), yv = y.attrs.get(name);
            if (xv === yv) return;
            if (yv === undefined) ops.push({ op: "rattr", sel: nodeSel, name });
            else ops.push({ op: "attr", sel: nodeSel, name, value: yv });
        });
        if (x.kids.length !== y.kids.length) return false;
        let elIdx = 0;
        for (let i = 0; i < x.kids.length; i++) {
            const xk = x.kids[i]!, yk = y.kids[i]!;
            if (typeof xk !== typeof yk) return false;
            if (typeof xk === "string") {
                if (xk !== yk) {
                    // textContent op replaces ALL children — only safe on a
                    // leaf element whose sole kid is that text node.
                    if (x.kids.length !== 1) return false;
                    ops.push({ op: "text", sel: nodeSel, text: yk as string });
                }
            } else if (!diffNode(`${nodeSel} > :nth-child(${++elIdx})`, xk, yk as FNode)) {
                return false;
            }
        }
        return true;
    };

    if (a.length !== b.length) return null;
    let topEl = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i]!, y = b[i]!;
        if (typeof x !== typeof y) return null;
        if (typeof x === "string") {
            if (x !== y) return null; // stray top-level text — structural
        } else if (!diffNode(`${sel} > :nth-child(${++topEl})`, x, y as FNode)) {
            return null;
        }
    }
    return ops;
}
