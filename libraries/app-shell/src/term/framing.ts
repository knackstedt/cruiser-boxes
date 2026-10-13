// ============================================================================
// framing.ts — length-prefixed frame codec for the term-dd wire protocol.
// TS mirror of term-dd/src/framing.rs — keep the tag numbers in sync.
//
// Wire format (both directions):  [u32 LE len][u8 tag][payload]
//
//   host → term-dd:  0x01 DATA   raw bytes written to the PTY
//                    0x02 RESIZE u16le cols ++ u16le rows
//                    0x03 KILL   kill the spawned child
//
//   term-dd → host:  0x01 DATA   raw bytes read from the PTY
//                    0x02 EXIT   i32le exit status
//                    0x03 ERR    utf8 error message (spawn failures)
// ============================================================================

export const TAG_DATA = 0x01;
/** host→child: resize {u16 cols, u16 rows} · child→host: exit {i32 status} */
export const TAG_RESIZE = 0x02;
export const TAG_EXIT = 0x02;
/** host→child: kill · child→host: error (utf8) */
export const TAG_KILL = 0x03;
export const TAG_ERR = 0x03;

export function encodeFrame(tag: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(5 + payload.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, payload.length, true);
    out[4] = tag;
    out.set(payload, 5);
    return out;
}

export function encodeResize(cols: number, rows: number): Uint8Array {
    const p = new Uint8Array(4);
    const dv = new DataView(p.buffer);
    dv.setUint16(0, cols, true);
    dv.setUint16(2, rows, true);
    return encodeFrame(TAG_RESIZE, p);
}

export interface Frame {
    tag: number;
    payload: Uint8Array;
}

/** Incremental decoder — buffers partial frames across chunks. */
export class FrameDecoder {
    private buf: Uint8Array = new Uint8Array(0);

    push(chunk: Uint8Array): Frame[] {
        const merged = new Uint8Array(this.buf.length + chunk.length);
        merged.set(this.buf);
        merged.set(chunk, this.buf.length);
        this.buf = merged;
        const out: Frame[] = [];
        for (;;) {
            if (this.buf.length < 5) break;
            const len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(0, true);
            if (this.buf.length < 5 + len) break;
            out.push({ tag: this.buf[4]!, payload: this.buf.slice(5, 5 + len) });
            this.buf = this.buf.slice(5 + len);
        }
        return out;
    }
}

export function decodeExit(payload: Uint8Array): number {
    return new DataView(payload.buffer, payload.byteOffset).getInt32(0, true);
}
