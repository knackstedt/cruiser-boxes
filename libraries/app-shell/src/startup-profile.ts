// ============================================================================
// startup-profile.ts — DD_STARTUP_PROFILE=1 boot timing marks.
//
// performance.now() is anchored at process start, so each mark's absolute t
// is "ms since launch". Paired with the marks inside createNativeHost
// (platform-native), this attributes boot time across runtime boot, module
// eval, host bring-up, UI mount, and service init.
// ============================================================================

const on = typeof process !== "undefined" && process.env?.DD_STARTUP_PROFILE === "1";

export function mark(label: string): void {
    if (!on) return;
    process.stderr.write(`[startup] ${label} t=${performance.now().toFixed(1)}ms\n`);
}
