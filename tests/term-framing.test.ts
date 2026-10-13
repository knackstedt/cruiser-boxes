import { describe, expect, test } from "bun:test";
import {
    decodeExit, encodeFrame, encodeResize, FrameDecoder,
    TAG_DATA, TAG_EXIT, TAG_RESIZE,
} from "../libraries/app-shell/src/term/framing";

const text = (s: string) => new TextEncoder().encode(s);

describe("term framing codec", () => {
    test("encode/decode roundtrip", () => {
        const dec = new FrameDecoder();
        const frames = dec.push(encodeFrame(TAG_DATA, text("hello")));
        expect(frames).toHaveLength(1);
        expect(frames[0]!.tag).toBe(TAG_DATA);
        expect(new TextDecoder().decode(frames[0]!.payload)).toBe("hello");
    });

    test("multiple frames in one chunk", () => {
        const dec = new FrameDecoder();
        const chunk = new Uint8Array([
            ...encodeFrame(TAG_DATA, text("ab")),
            ...encodeResize(120, 40),
            ...encodeFrame(TAG_EXIT, new Uint8Array([0, 0, 0, 0])),
        ]);
        const frames = dec.push(chunk);
        expect(frames.map((f) => f.tag)).toEqual([TAG_DATA, TAG_RESIZE, TAG_EXIT]);
        const dv = new DataView(frames[1]!.payload.buffer);
        expect(dv.getUint16(0, true)).toBe(120);
        expect(dv.getUint16(2, true)).toBe(40);
    });

    test("partial delivery buffers until the frame completes", () => {
        const dec = new FrameDecoder();
        const full = encodeFrame(TAG_DATA, text("0123456789"));
        expect(dec.push(full.slice(0, 3))).toHaveLength(0);   // short header
        expect(dec.push(full.slice(3, 7))).toHaveLength(0);   // short payload
        const rest = dec.push(full.slice(7));
        expect(rest).toHaveLength(1);
        expect(new TextDecoder().decode(rest[0]!.payload)).toBe("0123456789");
    });

    test("a split header + a following whole frame both decode", () => {
        const dec = new FrameDecoder();
        const a = encodeFrame(TAG_DATA, text("x"));
        const b = encodeFrame(TAG_EXIT, new Uint8Array([42, 0, 0, 0]));
        expect(dec.push(a.slice(0, 4))).toHaveLength(0);
        const frames = dec.push(new Uint8Array([...a.slice(4), ...b]));
        expect(frames).toHaveLength(2);
        expect(decodeExit(frames[1]!.payload)).toBe(42);
    });

    test("decodeExit reads signed i32", () => {
        const p = new Uint8Array(4);
        new DataView(p.buffer).setInt32(0, -1, true);
        expect(decodeExit(encodeFrame(TAG_EXIT, p).slice(5))).toBe(-1);
    });
});
