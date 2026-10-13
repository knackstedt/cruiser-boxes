import { describe, expect, test } from "bun:test";
import { detectTermEmu } from "../libraries/host-int/src/termemu";

/** Fake `which` — the returned set holds the emulators "on PATH". */
const finder = (have: string[]) => (bin: string) =>
    Promise.resolve(have.includes(bin) ? `/usr/bin/${bin}` : null);

describe("detectTermEmu", () => {
    test("KDE session prefers konsole", async () => {
        const env = { XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "x11" };
        const t = await detectTermEmu(env, finder(["konsole", "xterm"]));
        expect(t?.bin).toBe("konsole");
    });

    test("GNOME session prefers kgx over generic emulators", async () => {
        const env = { XDG_CURRENT_DESKTOP: "GNOME", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" };
        const t = await detectTermEmu(env, finder(["kgx", "alacritty", "xterm"]));
        expect(t?.bin).toBe("kgx");
    });

    test("unknown session falls to the generic list", async () => {
        const t = await detectTermEmu({}, finder(["foot", "xterm"]));
        expect(t?.bin).toBe("foot");
    });

    test("returns null when nothing is installed", async () => {
        expect(await detectTermEmu({}, finder([]))).toBeNull();
    });

    test("skips DE-preferred emulators that aren't installed", async () => {
        const env = { XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "x11" };
        const t = await detectTermEmu(env, finder(["xterm"]));
        expect(t?.bin).toBe("xterm");
    });
});
