// ============================================================================
// input-bus.ts — RendererInputBus for the cruiser shell.
//
// The production bus is normally owned by RendererModuleHost inside a game
// renderer; cruiser has no game renderer — the app owns input itself and
// feeds this bus from native surface/window listeners so HtmlUiHost's
// bindInput() runs its production code path.
// ============================================================================

import type {
    DragDelta,
    DragHandler,
    InputEventControl,
    KeyHandler,
    PointerHandler,
    RendererInputBus,
    WheelHandler,
} from "@downdraft/engine";
export type { InputEventControl, RendererInputBus };
export type { OsrDomEvent } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";

type Sub = { fn: (e: never, c: InputEventControl) => void; prio: number; seq: number };

export class InputBus implements RendererInputBus {
    private subs: Record<string, Sub[]> = {
        pmove: [], pdown: [], pup: [], wheel: [], kdown: [], kup: [], drag: [],
    };
    private seq = 0;
    /** Whether the last dispatched event was consumed (stopPropagation). */
    consumed = false;

    private add(kind: string, fn: (e: never, c: InputEventControl) => void, prio = 100) {
        const s: Sub = { fn, prio, seq: this.seq++ };
        const arr = this.subs[kind];
        arr.push(s);
        arr.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
        return () => { const i = arr.indexOf(s); if (i >= 0) arr.splice(i, 1); };
    }

    onPointerMove = (fn: PointerHandler, p?: number) => this.add("pmove", fn as never, p);
    onPointerDown = (fn: PointerHandler, p?: number) => this.add("pdown", fn as never, p);
    onPointerUp = (fn: PointerHandler, p?: number) => this.add("pup", fn as never, p);
    onWheel = (fn: WheelHandler, p?: number) => this.add("wheel", fn as never, p);
    onKeyDown = (fn: KeyHandler, p?: number) => this.add("kdown", fn as never, p);
    onKeyUp = (fn: KeyHandler, p?: number) => this.add("kup", fn as never, p);
    onDrag = (fn: DragHandler, p?: number) => this.add("drag", fn as never, p);

    private dispatch(kind: string, e: object): void {
        this.consumed = false;
        let consumed = false;
        const ctrl: InputEventControl = {
            stopPropagation: () => { consumed = true; this.consumed = true; },
            get propagationStopped() { return consumed; },
        };
        for (let _i = 0, _it = [...this.subs[kind]], _n = _it.length; _i < _n; _i++) { const s = _it[_i];
            if (ctrl.propagationStopped) break;
            (s.fn as (ev: object, c: InputEventControl) => void)(e, ctrl);
        }
    }

    destroy(): void {
        Object.keys(this.subs).forEach((k) => { this.subs[k] = []; });
    }

    pointerMove(x: number, y: number) { this.dispatch("pmove", { clientX: x, clientY: y }); }
    pointerDown(x: number, y: number, button = 0) { this.dispatch("pdown", { clientX: x, clientY: y, button }); }
    pointerUp(x: number, y: number, button = 0) { this.dispatch("pup", { clientX: x, clientY: y, button }); }
    wheel(x: number, y: number, dx: number, dy: number) { this.dispatch("wheel", { clientX: x, clientY: y, deltaX: dx, deltaY: dy }); }
    key(down: boolean, key: string, code: string) { this.dispatch(down ? "kdown" : "kup", { key, code }); }
    drag(_d: DragDelta) { /* synthetic drags not used */ }
}
