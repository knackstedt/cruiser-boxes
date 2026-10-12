// ============================================================================
// render-gate.ts — decides when a store change may hit the document. A full
// setHtml rebuilds the DOM and destroys a focused <input>, so pushes are
// dropped when the markup is identical and deferred while a text field
// holds focus (the store already holds the typed value, so nothing is lost).
// ============================================================================

export class RenderGate {
    private last: string;
    private editing = false;
    private pressed = false;
    private deferred = false;

    constructor(initial: string, private apply: (html: string) => void) {
        this.last = initial;
    }

    /** Push fresh markup. Identical markup is dropped; while a text field
     *  holds focus — or a pointer press is in flight — the push is deferred
     *  so the focused/pressed node survives the gesture. */
    render(html: string): void {
        if (html === this.last) return;
        if (this.editing || this.pressed) { this.deferred = true; return; }
        this.deferred = false;
        this.last = html;
        try {
            this.apply(html);
        } catch (e) {
            // Apply failed — reset so the next push isn't deduped away.
            this.last = "";
            throw e;
        }
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

    /** A pointer press started on the panel — rebuilds wait for release so
     *  the pressed element (and any focus the down lands) survives. */
    pressDown(): void { this.pressed = true; }

    /** Returns true when a render was deferred during the press. */
    pressUp(): boolean {
        this.pressed = false;
        const d = this.deferred;
        this.deferred = false;
        return d;
    }
}
