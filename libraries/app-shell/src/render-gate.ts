// ============================================================================
// render-gate.ts — decides when a store change may hit the document. A full
// setHtml rebuilds the DOM and destroys a focused <input>, so pushes are
// dropped when the markup is identical and deferred while a text field
// holds focus (the store already holds the typed value, so nothing is lost).
// ============================================================================

export class RenderGate {
    private last: string;
    private editing = false;
    private deferred = false;

    constructor(initial: string, private apply: (html: string) => void) {
        this.last = initial;
    }

    /** Push fresh markup. Identical markup is dropped; while a text field
     *  holds focus the push is deferred so the focused node survives. */
    render(html: string): void {
        if (html === this.last) return;
        if (this.editing) { this.deferred = true; return; }
        this.deferred = false;
        this.last = html;
        this.apply(html);
    }

    focus(tag?: string): void {
        this.editing = tag === "input" || tag === "textarea";
    }

    /** Returns true when a render was deferred while editing — the caller
     *  should re-render current state and push it through render(). */
    blur(): boolean {
        this.editing = false;
        const d = this.deferred;
        this.deferred = false;
        return d;
    }
}
