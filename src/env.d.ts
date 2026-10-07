// ============================================================================
// env.d.ts — ambient shims for typechecking against the engine's TS sources.
//
// DownDraft is runtime-agnostic: ffi-adapter.ts dynamically imports "bun:ffi"
// under Bun and koffi/Deno.dlopen elsewhere. The module only exists under Bun;
// for `tsc --noEmit` we declare it loosely so engine sources typecheck.
// ============================================================================

declare module "bun:ffi" {
    export const dlopen: any;
    export const ptr: any;
    export const toArrayBuffer: any;
    export const CString: any;
    export const FFIType: any;
    export type CFunction = any;
    const _default: any;
    export default _default;
}
