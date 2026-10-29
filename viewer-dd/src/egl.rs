// EGL/X11 zero-copy present path.
//
// QEMU exports the guest scanouts as dma-buf fds over the D-Bus display
// backend — one per console. We create an EGLImage per console
// (EGL_EXT_image_dma_buf_import + modifiers) on an EGL context that lives
// on the SAME GPU as QEMU's virgl rendernode (required — cross-vendor
// imports fail), bind each to its own GL_TEXTURE_EXTERNAL_OES texture,
// and draw each console into its rect of a single window surface. The
// EGLImages are held until the next scanout replaces them — the image
// refs the GEM so the buffer stays alive across damage-only UpdateDMABUF
// redraws.
use anyhow::{bail, Context, Result};
use khronos_egl as egl;
use std::ffi::c_void;
use std::os::fd::RawFd;

#[link(name = "GLESv2")]
extern "C" {
    fn glGenTextures(n: i32, textures: *mut u32);
    fn glBindTexture(target: u32, texture: u32);
    fn glCreateShader(t: u32) -> u32;
    fn glShaderSource(s: u32, n: i32, strs: *const *const u8, lens: *const i32);
    fn glCompileShader(s: u32);
    fn glGetShaderiv(s: u32, n: u32, out: *mut i32);
    fn glCreateProgram() -> u32;
    fn glAttachShader(p: u32, s: u32);
    fn glLinkProgram(p: u32);
    fn glGetProgramiv(p: u32, n: u32, out: *mut i32);
    fn glUseProgram(p: u32);
    fn glGetAttribLocation(p: u32, name: *const u8) -> i32;
    fn glVertexAttribPointer(i: u32, size: i32, t: u32, norm: u8, stride: i32, p: *const c_void);
    fn glEnableVertexAttribArray(i: u32);
    fn glViewport(x: i32, y: i32, w: i32, h: i32);
    fn glDrawArrays(mode: u32, first: i32, count: i32);
    fn glTexParameteri(t: u32, n: u32, v: i32);
    fn glTexImage2D(t: u32, level: i32, internal: i32, w: i32, h: i32,
                    border: i32, format: u32, ty: u32, pixels: *const c_void);
    fn glTexSubImage2D(t: u32, level: i32, xo: i32, yo: i32, w: i32, h: i32,
                       format: u32, ty: u32, pixels: *const c_void);
    fn glGetString(n: u32) -> *const u8;
    fn glClearColor(r: f32, g: f32, b: f32, a: f32);
    fn glClear(mask: u32);
    fn glReadPixels(x: i32, y: i32, w: i32, h: i32, fmt: u32, ty: u32, out: *mut c_void);
    fn glGetError() -> u32;
    fn glFinish();
    fn glEnable(cap: u32);
    fn glDisable(cap: u32);
    fn glScissor(x: i32, y: i32, w: i32, h: i32);
}

#[link(name = "X11")]
extern "C" {
    fn XGetGeometry(d: *mut c_void, w: u64, root: *mut u64, x: *mut i32, y: *mut i32,
                    wd: *mut u32, ht: *mut u32, bw: *mut u32, depth: *mut u32) -> i32;
    fn XResizeWindow(d: *mut c_void, w: u64, wd: u32, ht: u32);
    fn XFlush(d: *mut c_void);
}

/// Aspect-fit viewport of an `iw x ih` scanout inside a `ww x wh` rect —
/// shared by the GL viewport and the mouse coordinate map so they always
/// agree (letterbox offset + scale). Returned offsets are relative to the
/// rect's top-left corner.
pub fn fit_viewport(ww: u32, wh: u32, iw: i32, ih: i32) -> (i32, i32, i32, i32) {
    let (iw, ih) = (iw.max(1) as f32, ih.max(1) as f32);
    let sc = (ww as f32 / iw).min(wh as f32 / ih).max(0.001);
    let vw = (iw * sc).round().max(1.0) as i32;
    let vh = (ih * sc).round().max(1.0) as i32;
    ((ww as i32 - vw) / 2, (wh as i32 - vh) / 2, vw, vh)
}

type ImgTargetFn = unsafe extern "C" fn(u32, *mut c_void);
static mut IMG_TARGET: Option<ImgTargetFn> = None;

/// eglSwapBuffersWithDamageKHR — EGL display extension (Mesa supports it on
/// X11). Optional: falls back to a plain eglSwapBuffers. Display/surface
/// args are raw pointers — the egl newtypes aren't FFI-safe-typed.
type SwapDamageFn =
    unsafe extern "C" fn(*mut c_void, *mut c_void, *const i32, i32) -> u32;
static mut SWAP_DAMAGE: Option<SwapDamageFn> = None;

/// Identity of an imported buffer — (st_dev, st_ino) of the dma-buf fd plus
/// every import parameter. QEMU can re-export the same GEM on consecutive
/// frames; a hit skips the EGLImage create/destroy.
#[derive(PartialEq)]
struct ImgKey {
    dev: u64, ino: u64,
    x: u32, y: u32, w: u32, h: u32, poff: u32, stride: u32,
    fourcc: u32, bw: u32, bh: u32, modifier: u64, y0_top: bool,
}

/// Per-console scanout state — one external texture + the EGLImage that
/// refs the current GEM (zero-copy path), plus a plain GL_TEXTURE_2D for
/// the CPU path (raw Scanout / ScanoutMap consoles — Windows 2D virtio-gpu,
/// VGA boot, software gpu). `img: None` until the first ScanoutDMABUF2,
/// `cpu: None` until the first CPU scanout; `kind_cpu` picks which source
/// the draw samples — a console can flip kinds mid-run (VGA → virtio-gpu).
struct HeadSlot {
    tex: u32,
    ctex: u32,
    img: Option<egl::Image>,
    cpu: Option<CpuHead>,
    key: Option<ImgKey>,
    w: i32,
    h: i32,
    /// scanout subrect inside the source as texture coords:
    /// [u_left, v_bottom, u_right, v_top] (v in GL's bottom-up convention —
    /// !y0_top dmabufs and top-down cpu rows both come out flipped).
    uv: [f32; 4],
    linear: bool,
    kind_cpu: bool,
}

/// Live mmap of a ScanoutMap fd — kept per console so UpdateMap damage can
/// re-read the shared region without a new transfer. `adj` is the
/// sub-page offset of the surface data inside the mapping.
struct Mmap { base: *mut u8, len: usize, adj: usize }
impl Drop for Mmap {
    fn drop(&mut self) {
        unsafe { libc::munmap(self.base as *mut c_void, self.len); }
    }
}
unsafe impl Send for Mmap {}

/// Byte transform applied while packing source rows into the texture —
/// only ever needed on 32bpp layouts (see cpu_fmt).
#[derive(Clone, Copy)]
enum Swz { Noop, Swap02, Rev4, Shift1 }

/// CPU-scanout bookkeeping — the GL upload format/swizzle chosen at
/// scanout time (UpdateMap carries no fmt, so it's stored here) plus the
/// source stride + optional live mapping.
struct CpuHead {
    map: Option<Mmap>,
    gl_fmt: u32,
    gl_ty: u32,
    swz: Swz,
    bpp: usize,
    stride: usize,
}

/// Single-window EGL state — all guest consoles present into the one
/// window surface, each into its own subrect.
pub struct XEgl {
    xdisp: *mut c_void,
    xwin: u64,
    inst: egl::DynamicInstance<egl::EGL1_5>,
    dpy: egl::Display,
    surf: egl::Surface,
    prog: u32,
    pa: i32,
    pu: i32,
    /// CPU-path program — same vertex shader, sampler2D fragment.
    cprog: u32,
    cpa: i32,
    cpu_uv: i32,
    buffer_age: bool,
    /// GL_EXT_texture_format_BGRA8888 — decides direct-vs-swizzled upload
    /// for the byte layouts that don't have a core GLES2 format.
    has_bgra: bool,
    heads: Vec<HeadSlot>,
}

/// Create the EGL X11 display/context/window-surface. `window` is the XID of
/// an already-created X window (the minifb window). `nheads` = guest console
/// count — one scanout texture each. Runs on the GL thread.
pub fn x11_present_init(window: u64, w: i32, h: i32, nheads: usize) -> Result<XEgl> {
    // own X connection — the window's owning Display* isn't safe across threads
    #[link(name = "X11")]
    extern "C" {
        fn XOpenDisplay(name: *const u8) -> *mut c_void;
        fn XInitThreads() -> i32;
    }
    unsafe { XInitThreads(); }
    let display = unsafe { XOpenDisplay(std::ptr::null()) };
    if display.is_null() { bail!("XOpenDisplay failed"); }
    let egl_lib = unsafe { libloading::Library::new("libEGL.so.1") }.context("libEGL")?;
    let inst = unsafe { egl::DynamicInstance::<egl::EGL1_5>::load_required_from(egl_lib) }
        .context("load egl")?;
    unsafe {
        const EGL_PLATFORM_X11_KHR: u32 = 0x31D5;
        let dpy = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
            inst.get_platform_display(EGL_PLATFORM_X11_KHR, display, &[egl::ATTRIB_NONE]))) {
            Ok(Ok(d)) => d,
            _ => inst.get_display(display as egl::NativeDisplayType).context("x11 egl display")?,
        };
        inst.initialize(dpy).context("eglInitialize x11")?;
        eprintln!("[xegl] vendor={:?}", inst.query_string(Some(dpy), egl::VENDOR)
            .map(|s| s.to_string_lossy().into_owned()));
        inst.bind_api(egl::OPENGL_ES_API).context("bind ES")?;
        let cfg_attrs = [egl::SURFACE_TYPE, egl::WINDOW_BIT, egl::RENDERABLE_TYPE,
            egl::OPENGL_ES2_BIT, egl::RED_SIZE, 8, egl::GREEN_SIZE, 8, egl::BLUE_SIZE, 8, egl::NONE];
        let mut cfgs: Vec<egl::Config> = Vec::with_capacity(8);
        inst.choose_config(dpy, &cfg_attrs, &mut cfgs).context("choose_config")?;
        let cfg = *cfgs.first().context("no window config")?;
        let surf = inst.create_window_surface(dpy, cfg, window as egl::NativeWindowType, None)
            .context("window surface")?;
        let ctx = inst.create_context(dpy, cfg, None,
            &[egl::CONTEXT_CLIENT_VERSION, 2, egl::NONE]).context("ctx")?;
        inst.make_current(dpy, Some(surf), Some(surf), Some(ctx)).context("current")?;
        // present immediately — vsync queueing would add a full frame of latency
        let _ = inst.swap_interval(dpy, 0);
        let exts = inst.query_string(Some(dpy), egl::EXTENSIONS)
            .map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let buffer_age = exts.contains("EGL_EXT_buffer_age");
        SWAP_DAMAGE = if exts.contains("EGL_KHR_swap_buffers_with_damage") {
            inst.get_proc_address("eglSwapBuffersWithDamageKHR")
                .map(|f| std::mem::transmute::<extern "system" fn(), SwapDamageFn>(f))
        } else { None };
        let has_swd = SWAP_DAMAGE;
        eprintln!("[xegl] current ok, swap_interval=0, heads={nheads} ({w}x{h}) \
            swap_damage={} buffer_age={buffer_age}", has_swd.is_some());

        let mk = |t: u32, src: &[u8]| -> u32 {
            let s = glCreateShader(t);
            glShaderSource(s, 1, &src.as_ptr(), std::ptr::null());
            glCompileShader(s);
            let mut ok = 0; glGetShaderiv(s, 0x8B81, &mut ok);
            if ok == 0 { eprintln!("[xegl] shader compile failed"); }
            s
        };
        let vs = mk(0x8B31, b"attribute vec2 aPos; attribute vec2 aUV; varying vec2 vUV; void main(){ vUV=aUV; gl_Position=vec4(aPos,0.,1.); }\0");
        let fs = mk(0x8B30, b"#version 100\n#extension GL_OES_EGL_image_external : require\nprecision mediump float; varying vec2 vUV; uniform samplerExternalOES uTex; void main(){ gl_FragColor=texture2D(uTex,vUV); }\0");
        let prog = glCreateProgram();
        glAttachShader(prog, vs); glAttachShader(prog, fs); glLinkProgram(prog);
        let mut ok = 0; glGetProgramiv(prog, 0x8B82, &mut ok);
        if ok == 0 { bail!("xegl program link failed"); }
        // CPU path — sampler2D variant sharing the vertex shader. Alpha is
        // forced: x8* guest formats leave the byte undefined.
        let cfs = mk(0x8B30, b"#version 100\nprecision mediump float; varying vec2 vUV; uniform sampler2D uTex; void main(){ vec4 c=texture2D(uTex,vUV); gl_FragColor=vec4(c.rgb,1.); }\0");
        let cprog = glCreateProgram();
        glAttachShader(cprog, vs); glAttachShader(cprog, cfs); glLinkProgram(cprog);
        glGetProgramiv(cprog, 0x8B82, &mut ok);
        if ok == 0 { bail!("xegl cpu program link failed"); }
        let ext_c = glGetString(0x1F03); // GL_EXTENSIONS
        let has_bgra = !ext_c.is_null()
            && std::ffi::CStr::from_ptr(ext_c as *const i8).to_string_lossy()
                .contains("GL_EXT_texture_format_BGRA8888");
        let mut texs = vec![0u32; 2 * nheads];
        glGenTextures(2 * nheads as i32, texs.as_mut_ptr());
        let ctexs = texs.split_off(nheads);
        const GL_TEXTURE_EXTERNAL_OES: u32 = 0x8D65;
        for &tex in &texs {
            glBindTexture(GL_TEXTURE_EXTERNAL_OES, tex);
            glTexParameteri(GL_TEXTURE_EXTERNAL_OES, 0x2801, 0x2600);
            glTexParameteri(GL_TEXTURE_EXTERNAL_OES, 0x2800, 0x2600);
        }
        let pa = glGetAttribLocation(prog, c"aPos".as_ptr().cast());
        let pu = glGetAttribLocation(prog, c"aUV".as_ptr().cast());
        let cpa = glGetAttribLocation(cprog, c"aPos".as_ptr().cast());
        let cpu_uv = glGetAttribLocation(cprog, c"aUV".as_ptr().cast());
        let f = inst.get_proc_address("glEGLImageTargetTexture2DOES").context("glEGLImageTargetTexture2DOES")?;
        IMG_TARGET = Some(std::mem::transmute::<extern "system" fn(), ImgTargetFn>(f));
        Ok(XEgl {
            xdisp: display, xwin: window,
            inst, dpy, surf, prog, pa, pu, cprog, cpa, cpu_uv, buffer_age, has_bgra,
            heads: texs.into_iter().zip(ctexs).map(|(tex, ctex)| HeadSlot {
                tex, ctex, img: None, cpu: None, key: None, w: 0, h: 0,
                uv: [0.0, 0.0, 1.0, 1.0], linear: false, kind_cpu: false,
            }).collect(),
        })
    }
}

/// Current drawable size — queried on the GL thread's own X conn.
pub fn x11_geom(e: &XEgl) -> (i32, i32) {
    unsafe {
        let mut root = 0u64; let mut x = 0i32; let mut y = 0i32;
        let mut ww = 0u32; let mut wh = 0u32; let mut bw = 0u32; let mut depth = 0u32;
        XGetGeometry(e.xdisp, e.xwin, &mut root, &mut x, &mut y,
                     &mut ww, &mut wh, &mut bw, &mut depth);
        (ww as i32, wh as i32)
    }
}

/// Resize the X window — windowed single-head mode tracks the guest
/// resolution like the old per-console windows did.
pub fn x11_resize(e: &XEgl, w: u32, h: u32) {
    unsafe {
        XResizeWindow(e.xdisp, e.xwin, w, h);
        XFlush(e.xdisp);
    }
}

/// EGL_BUFFER_AGE of the next back buffer, when EGL_EXT_buffer_age is
/// supported — the caller uses it to bound partial repaints.
pub fn x11_buffer_age(e: &XEgl) -> Option<i32> {
    if !e.buffer_age { return None; }
    const EGL_BUFFER_AGE_EXT: i32 = 0x313D;
    e.inst.query_surface(e.dpy, e.surf, EGL_BUFFER_AGE_EXT).ok()
}

/// Import a dmabuf → EGLImage on console `ci`'s texture. Draws nothing —
/// batch imports across consoles, then one x11_redraw + swap.
/// `x,y,w,h` is the scanout subrect within the `bw×bh` backing buffer;
/// `poff` is plane-0's byte offset into the dmabuf.
/// Must be called from the GL thread.
#[allow(clippy::too_many_arguments)]
pub fn x11_import(e: &mut XEgl, ci: usize, fd: RawFd, x: u32, y: u32, w: u32, h: u32,
                  poff: u32, stride: u32, fourcc: u32, bw: u32, bh: u32,
                  modifier: u64, y0_top: bool) -> Result<()> {
    let (bw, bh) = (bw.max(w), bh.max(h));
    let Some(head) = e.heads.get_mut(ci) else { return Ok(()) };
    // Skip a re-import of the same GEM — fstat's (dev,ino) identifies the
    // underlying dma-buf across dup'd fds.
    let key = unsafe {
        let mut st: libc::stat = std::mem::zeroed();
        (libc::fstat(fd, &mut st) == 0).then_some(ImgKey {
            dev: st.st_dev as u64, ino: st.st_ino as u64,
            x, y, w, h, poff, stride, fourcc, bw, bh, modifier, y0_top,
        })
    };
    if head.key.is_some() && head.key == key { return Ok(()); }
    unsafe {
        const EGL_LINUX_DMA_BUF_EXT: u32 = 0x3270;
        const EGL_WIDTH: i32 = 0x3057;
        const EGL_HEIGHT: i32 = 0x3056;
        const EGL_LINUX_DRM_FOURCC_EXT: i32 = 0x3271;
        const EGL_DMA_BUF_PLANE0_FD_EXT: i32 = 0x3272;
        const EGL_DMA_BUF_PLANE0_OFFSET_EXT: i32 = 0x3273;
        const EGL_DMA_BUF_PLANE0_PITCH_EXT: i32 = 0x3274;
        const EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT: i32 = 0x3443;
        const EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT: i32 = 0x3444;
        let attribs: Vec<usize> = vec![
            EGL_WIDTH as usize, bw as usize, EGL_HEIGHT as usize, bh as usize,
            EGL_LINUX_DRM_FOURCC_EXT as usize, fourcc as usize,
            EGL_DMA_BUF_PLANE0_FD_EXT as usize, fd as usize,
            EGL_DMA_BUF_PLANE0_OFFSET_EXT as usize, poff as usize,
            EGL_DMA_BUF_PLANE0_PITCH_EXT as usize, stride as usize,
            EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT as usize, (modifier & 0xFFFFFFFF) as usize,
            EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT as usize, (modifier >> 32) as usize,
            egl::ATTRIB_NONE,
        ];
        let img = e.inst.create_image(e.dpy, egl::Context::from_ptr(egl::NO_CONTEXT),
            EGL_LINUX_DMA_BUF_EXT, egl::ClientBuffer::from_ptr(std::ptr::null_mut()), &attribs)
            .context("eglCreateImage")?;
        const GL_TEXTURE_EXTERNAL_OES: u32 = 0x8D65;
        glBindTexture(GL_TEXTURE_EXTERNAL_OES, head.tex);
        IMG_TARGET.unwrap()(GL_TEXTURE_EXTERNAL_OES, img.as_ptr());
        head.w = w as i32;
        head.h = h as i32;
        // scanout subrect as texture coords: y0_top scanouts sample the
        // backing top-down (v_top=v(y)), !y0_top bottom-up (v_top=v(y+h)).
        let (bf, hf) = (bw as f32, bh as f32);
        let v = |py: u32| py as f32 / hf;
        let (vb, vt) = if y0_top { (v(y), v(y + h)) } else { (v(y + h), v(y)) };
        head.uv = [x as f32 / bf, vb, (x + w) as f32 / bf, vt];
        head.key = key;
        head.kind_cpu = false;
        let old = head.img.replace(img);
        if let Some(oi) = old { let _ = e.inst.destroy_image(e.dpy, oi); }
    }
    Ok(())
}

// ── CPU scanout path (raw Scanout + ScanoutMap) ──
// The fallback for consoles QEMU exports as guest-RAM surfaces rather
// than dma-bufs — Windows virtio-2d, VGA text boot, software gpu. QEMU
// reports PIXMAN format codes; we pack rows (with a byte transform for
// the layouts GLES2 has no direct format for) into a GL_TEXTURE_2D.

/// mmap `need` bytes of `fd` starting at `off` (rounded down to the page —
/// `adj` recovers the sub-page offset). fstat-verified so a bad QEMU
/// offset can't SIGBUS the GL thread.
fn mmap_region(fd: RawFd, off: usize, need: usize) -> Result<Mmap> {
    unsafe {
        let mut st: libc::stat = std::mem::zeroed();
        if libc::fstat(fd, &mut st) != 0 { bail!("fstat scanout fd"); }
        if st.st_size < 0 || (off + need) as u64 > st.st_size as u64 {
            bail!("scanout map out of bounds: off={off} need={need} size={}", st.st_size);
        }
        let moff = off & !0xfffusize;
        let adj = off - moff;
        let len = adj + need;
        let p = libc::mmap(std::ptr::null_mut(), len, libc::PROT_READ,
                           libc::MAP_PRIVATE, fd, moff as i64);
        if p == libc::MAP_FAILED { bail!("mmap scanout fd"); }
        Ok(Mmap { base: p as *mut u8, len, adj })
    }
}

/// PIXMAN_* code → (GL internal, GL format, GL type, byte transform,
/// bytes/px). The wire value is (bpp<<24|type<<16|a<<12|r<<8|g<<4|b);
/// only the 16/32bpp layouts a console actually emits are decoded —
/// anything else is logged and skipped rather than guessed.
fn cpu_fmt(fmt: u32, has_bgra: bool) -> Option<(i32, u32, u32, Swz, usize)> {
    const GL_BGRA_EXT: u32 = 0x80E1;
    const GL_RGBA_: u32 = 0x1908;
    const GL_RGB_: u32 = 0x1907;
    const GL_UNSIGNED_BYTE_: u32 = 0x1401;
    const GL_UNSIGNED_SHORT_5_6_5_: u32 = 0x8363;
    Some(match fmt {
        // a8r8g8b8 / x8r8g8b8 — LE bytes B G R A|X
        0x02028888 | 0x02020888 =>
            if has_bgra { (GL_RGBA_ as i32, GL_BGRA_EXT, GL_UNSIGNED_BYTE_, Swz::Noop, 4) }
            else { (GL_RGBA_ as i32, GL_RGBA_, GL_UNSIGNED_BYTE_, Swz::Swap02, 4) },
        // a8b8g8r8 / x8b8g8r8 — LE bytes R G B A|X
        0x02038888 | 0x02030888 =>
            (GL_RGBA_ as i32, GL_RGBA_, GL_UNSIGNED_BYTE_, Swz::Noop, 4),
        // b8g8r8a8 / b8g8r8x8 — LE bytes A|X R G B
        0x02088888 | 0x02080888 =>
            if has_bgra { (GL_RGBA_ as i32, GL_BGRA_EXT, GL_UNSIGNED_BYTE_, Swz::Rev4, 4) }
            else { (GL_RGBA_ as i32, GL_RGBA_, GL_UNSIGNED_BYTE_, Swz::Shift1, 4) },
        // r8g8b8a8 / r8g8b8x8 — LE bytes A|X B G R
        0x02098888 | 0x02090888 =>
            (GL_RGBA_ as i32, GL_RGBA_, GL_UNSIGNED_BYTE_, Swz::Rev4, 4),
        // r5g6b5
        0x01020565 =>
            (GL_RGB_ as i32, GL_RGB_, GL_UNSIGNED_SHORT_5_6_5_, Swz::Noop, 2),
        _ => return None,
    })
}

/// Copy `h` rows of `w*bpp` pixels out of a strided source into a packed
/// Vec, applying the pixel transform for swizzled layouts.
fn pack_rows(src: &[u8], src_off: usize, stride: usize, w: usize, h: usize,
             bpp: usize, swz: Swz) -> Result<Vec<u8>> {
    let rb = w * bpp;
    let need = src_off + stride.saturating_mul(h.saturating_sub(1)) + rb;
    if src.len() < need { bail!("scanout data short: {} < {need}", src.len()); }
    let mut out = vec![0u8; rb * h];
    for y in 0..h {
        let so = src_off + y * stride;
        let d = &mut out[y * rb..(y + 1) * rb];
        let s = &src[so..so + rb];
        match swz {
            Swz::Noop => d.copy_from_slice(s),
            _ => for (dpx, spx) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
                dpx.copy_from_slice(&match swz {
                    Swz::Swap02 => [spx[2], spx[1], spx[0], spx[3]],
                    Swz::Rev4 => [spx[3], spx[2], spx[1], spx[0]],
                    Swz::Shift1 => [spx[1], spx[2], spx[3], spx[0]],
                    Swz::Noop => unreachable!(),
                });
            },
        }
    }
    Ok(out)
}

/// Replace console `ci`'s scanout with CPU-side pixels — `pixels` is a
/// raw Scanout's inline buffer, `map_fd` a ScanoutMap fd+offset into
/// shareable memory (guest-RAM memfd; the map is kept for UpdateMap).
/// Must run on the GL thread.
#[allow(clippy::too_many_arguments)]
pub fn x11_cpu_upload(e: &mut XEgl, ci: usize, pixels: Option<&[u8]>,
                      map_fd: Option<(RawFd, u32)>, w: u32, h: u32,
                      stride: u32, fmt: u32) -> Result<()> {
    let (internal, gl_fmt, gl_ty, swz, bpp) = cpu_fmt(fmt, e.has_bgra)
        .with_context(|| format!("unsupported pixman fmt {fmt:#x} (cpu scanout {w}x{h})"))?;
    let (w, h) = (w.max(1) as usize, h.max(1) as usize);
    let stride = (stride as usize).max(w * bpp);
    let map = match map_fd {
        Some((fd, off)) => Some(mmap_region(fd, off as usize, stride * h)?),
        None => None,
    };
    let packed = match (&map, pixels) {
        (Some(m), _) => pack_rows(unsafe { std::slice::from_raw_parts(m.base, m.len) },
                                 m.adj, stride, w, h, bpp, swz)?,
        (None, Some(px)) => pack_rows(px, 0, stride, w, h, bpp, swz)?,
        _ => bail!("cpu scanout with no pixel source"),
    };
    let Some(head) = e.heads.get_mut(ci) else { return Ok(()) };
    unsafe {
        const GL_TEXTURE_2D_: u32 = 0x0DE1;
        glBindTexture(GL_TEXTURE_2D_, head.ctex);
        glTexParameteri(GL_TEXTURE_2D_, 0x2801, 0x2600); // NEAREST min/mag
        glTexParameteri(GL_TEXTURE_2D_, 0x2800, 0x2600);
        glTexParameteri(GL_TEXTURE_2D_, 0x2802, 0x812F); // WRAP_S CLAMP_TO_EDGE
        glTexParameteri(GL_TEXTURE_2D_, 0x2803, 0x812F); // WRAP_T
        glTexImage2D(GL_TEXTURE_2D_, 0, internal, w as i32, h as i32, 0,
                     gl_fmt, gl_ty, packed.as_ptr() as *const c_void);
    }
    head.w = w as i32;
    head.h = h as i32;
    // texel row0 holds screen row0 → v flips vs the dmabuf bottom-up case
    head.uv = [0.0, 1.0, 1.0, 0.0];
    head.linear = false;
    head.kind_cpu = true;
    head.cpu = Some(CpuHead { map, gl_fmt, gl_ty, swz, bpp, stride });
    Ok(())
}

/// Damage rect on a CPU scanout. `data` is a raw Update's payload (rows
/// at `stride`, covering just the rect); `None` = UpdateMap — the rect is
/// re-read from the stored mapping. Must run on the GL thread.
#[allow(clippy::too_many_arguments)]
pub fn x11_cpu_update(e: &mut XEgl, ci: usize, x: i32, y: i32, w: i32, h: i32,
                      stride: u32, fmt: u32, data: Option<&[u8]>) -> Result<()> {
    let (ctex, iw, ih) = match e.heads.get(ci) {
        Some(hd) if hd.kind_cpu => (hd.ctex, hd.w.max(0) as usize, hd.h.max(0) as usize),
        _ => return Ok(()),
    };
    let (x, y) = (x.max(0) as usize, y.max(0) as usize);
    // clamp to the uploaded image — damage can overshoot a resize
    let w = (w.max(0) as usize).min(iw.saturating_sub(x));
    let h = (h.max(0) as usize).min(ih.saturating_sub(y));
    if w == 0 || h == 0 { return Ok(()); }
    let cpu = match e.heads.get(ci).and_then(|hd| hd.cpu.as_ref()) {
        Some(c) => c,
        None => return Ok(()),
    };
    let packed = match data {
        Some(px) => {
            let Some((_, _, _, swz, bpp)) = cpu_fmt(fmt, e.has_bgra) else {
                bail!("unsupported pixman fmt {fmt:#x} (cpu update)")
            };
            pack_rows(px, 0, (stride as usize).max(w * bpp), w, h, bpp, swz)?
        }
        None => {
            let Some(map) = &cpu.map else { return Ok(()) };
            let src = unsafe { std::slice::from_raw_parts(map.base, map.len) };
            pack_rows(src, map.adj + y * cpu.stride + x * cpu.bpp, cpu.stride,
                      w, h, cpu.bpp, cpu.swz)?
        }
    };
    unsafe {
        const GL_TEXTURE_2D_: u32 = 0x0DE1;
        glBindTexture(GL_TEXTURE_2D_, ctex);
        glTexSubImage2D(GL_TEXTURE_2D_, 0, x as i32, y as i32, w as i32, h as i32,
                        cpu.gl_fmt, cpu.gl_ty, packed.as_ptr() as *const c_void);
    }
    Ok(())
}


/// coords — glViewport's bottom-left origin is converted here) and swap.
/// `geom` is the current drawable size (the caller queries it once for its
/// layout math too). `need` bounds the repaint when non-empty (buffer-age
/// partial redraw — regions outside it keep the aged buffer's pixels).
/// Rasterize every console's scanout into its rect — the shared draw half
/// of x11_redraw and x11_dump (which reads the back buffer pre-swap).
unsafe fn paint(e: &mut XEgl, rects: &[(i32, i32, i32, i32)], geom: (i32, i32),
                need: &[(i32, i32, i32, i32)]) {
    {
        let (_ww, wh) = geom;
        glClearColor(0.0, 0.0, 0.0, 1.0);
        if need.is_empty() { glClear(0x4000); } // GL_COLOR_BUFFER_BIT
        let (prog, pa, pu, cprog, cpa, cpu_uv, nh) =
            (e.prog, e.pa, e.pu, e.cprog, e.cpa, e.cpu_uv, e.heads.len());
        let heads = &mut e.heads;
        glEnableVertexAttribArray(pa as u32);
        glEnableVertexAttribArray(pu as u32);
        glEnableVertexAttribArray(cpa as u32);
        glEnableVertexAttribArray(cpu_uv as u32);
        const GL_TEXTURE_EXTERNAL_OES: u32 = 0x8D65;
        const GL_TEXTURE_2D_: u32 = 0x0DE1;
        const GL_SCISSOR_TEST: u32 = 0x0C11;
        const GL_LINEAR: i32 = 0x2601;
        const GL_NEAREST: i32 = 0x2600;
        let mut draw_head = |i: usize| {
            let Some(&(rx, ry, rw, rh)) = rects.get(i) else { return };
            let head = &mut heads[i];
            if rw <= 0 || rh <= 0 { return; }
            // cpu heads sample the GL_TEXTURE_2D + sampler2D program;
            // dmabuf heads the external texture + samplerExternalOES one.
            let (target, tex, pa2, pu2) = if head.kind_cpu {
                if head.cpu.is_none() { return }
                glUseProgram(cprog);
                (GL_TEXTURE_2D_, head.ctex, cpa, cpu_uv)
            } else {
                if head.img.is_none() { return }
                glUseProgram(prog);
                (GL_TEXTURE_EXTERNAL_OES, head.tex, pa, pu)
            };
            let (vx, vy, vw, vh) = fit_viewport(rw as u32, rh as u32, head.w, head.h);
            glViewport(rx + vx, wh - (ry + vy) - vh, vw, vh);
            glBindTexture(target, tex);
            // NEAREST is exact at 1:1 (span mode); anything scaled reads
            // better linear — swap filter only on transitions.
            let lin = vw != head.w || vh != head.h;
            if head.linear != lin {
                head.linear = lin;
                let f = if lin { GL_LINEAR } else { GL_NEAREST };
                glTexParameteri(target, 0x2801, f);
                glTexParameteri(target, 0x2800, f);
            }
            let [u0, v0, u1, v1] = head.uv;
            let quad: [f32; 16] = [
                -1.0, -1.0, u0, v0,
                 1.0, -1.0, u1, v0,
                -1.0,  1.0, u0, v1,
                 1.0,  1.0, u1, v1,
            ];
            glVertexAttribPointer(pa2 as u32, 2, 0x1406, 0, 16, quad.as_ptr() as *const c_void);
            glVertexAttribPointer(pu2 as u32, 2, 0x1406, 0, 16, quad.as_ptr().offset(2) as *const c_void);
            glDrawArrays(0x0005, 0, 4);
        };
        if need.is_empty() {
            for i in 0..nh { draw_head(i); }
        } else {
            // partial repaint — the aged buffer keeps its pixels outside
            // `need`, so the clear must be scissored too
            glEnable(GL_SCISSOR_TEST);
            for &(x, y, w, h) in need {
                glScissor(x, wh - y - h, w, h);
                glClear(0x4000);
                for i in 0..nh { draw_head(i); }
            }
            glDisable(GL_SCISSOR_TEST);
        }
    }
}

/// `damage` (top-left window coords) feeds eglSwapBuffersWithDamageKHR so
/// the compositor only re-uploads what actually changed; empty = full swap.
/// Consoles with no imported scanout yet are left at the clear color.
/// Must be called from the GL thread.
pub fn x11_redraw(e: &mut XEgl, rects: &[(i32, i32, i32, i32)], geom: (i32, i32),
                  need: &[(i32, i32, i32, i32)], damage: &[(i32, i32, i32, i32)]) -> Result<()> {
    unsafe {
        paint(e, rects, geom, need);
        let (_ww, wh) = geom;
        if let Some(sd) = SWAP_DAMAGE {
            if !damage.is_empty() {
                // rects are bottom-left surface coords per the KHR spec —
                // `damage` arrives in top-left window coords
                let mut flat: Vec<i32> = Vec::with_capacity(damage.len() * 4);
                for &(x, y, w, h) in damage {
                    flat.extend_from_slice(&[x, wh - y - h, w, h]);
                }
                if sd(e.dpy.as_ptr(), e.surf.as_ptr(),
                      flat.as_ptr(), damage.len() as i32) != 0 {
                    return Ok(());
                }
            }
        }
        e.inst.swap_buffers(e.dpy, e.surf).context("swap")?;
    }
    Ok(())
}

/// Debug capture (--dump): paint the current scanouts into the back buffer
/// and glReadPixels it into a binary PPM. Called post-swap — the next
/// paint lands in the same back buffer, so the readback races nothing.
pub fn x11_dump(e: &mut XEgl, rects: &[(i32, i32, i32, i32)], geom: (i32, i32),
                path: &str) -> Result<()> {
    unsafe {
        paint(e, rects, geom, &[]);
        // readback sanity stripe — proves the RGB path end-to-end when a
        // head samples black (top-left 8px solid red)
        glEnable(0x0C11); // GL_SCISSOR_TEST
        glScissor(0, geom.1 - 8, 8, 8);
        glClearColor(1.0, 0.0, 0.0, 1.0);
        glClear(0x4000);
        glDisable(0x0C11);
        glFinish();
        let (ww, wh) = geom;
        let stride = ww.max(0) as usize * 4;
        let mut buf = vec![0u8; stride * wh.max(0) as usize];
        glReadPixels(0, 0, ww, wh, 0x1908, 0x1401, buf.as_mut_ptr() as *mut c_void); // RGBA/UBYTE
        let gerr = glGetError();
        let nz = buf.iter().filter(|&&b| b != 0).count();
        eprintln!("[dump] {ww}x{wh} glerr=0x{gerr:x} nonzero={nz}/{}", buf.len());
        let tmp = format!("{path}.tmp");
        let mut f = std::fs::File::create(&tmp).context("dump create")?;
        use std::io::Write;
        write!(f, "P6\n{ww} {wh}\n255\n")?;
        for row in (0..wh.max(0) as usize).rev() {
            let px = &buf[row * stride..(row + 1) * stride];
            let mut rgb = Vec::with_capacity(ww.max(0) as usize * 3);
            for c in px.chunks_exact(4) { rgb.extend_from_slice(&c[..3]); }
            f.write_all(&rgb)?;
        }
        std::fs::rename(&tmp, path).context("dump rename")?;
    }
    Ok(())
}
