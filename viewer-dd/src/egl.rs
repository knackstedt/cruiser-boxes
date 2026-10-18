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
    fn glClearColor(r: f32, g: f32, b: f32, a: f32);
    fn glClear(mask: u32);
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

/// Per-console scanout state — one texture + the EGLImage that refs the
/// current GEM. `img: None` until the console's first ScanoutDMABUF2.
struct HeadSlot {
    tex: u32,
    img: Option<egl::Image>,
    key: Option<ImgKey>,
    w: i32,
    h: i32,
    /// scanout subrect inside the EGLImage as texture coords:
    /// [u_left, v_bottom, u_right, v_top] (v in GL's bottom-up convention —
    /// !y0_top scanouts come out flipped).
    uv: [f32; 4],
    linear: bool,
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
    buffer_age: bool,
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
        let mut texs = vec![0u32; nheads];
        glGenTextures(nheads as i32, texs.as_mut_ptr());
        const GL_TEXTURE_EXTERNAL_OES: u32 = 0x8D65;
        for &tex in &texs {
            glBindTexture(GL_TEXTURE_EXTERNAL_OES, tex);
            glTexParameteri(GL_TEXTURE_EXTERNAL_OES, 0x2801, 0x2600);
            glTexParameteri(GL_TEXTURE_EXTERNAL_OES, 0x2800, 0x2600);
        }
        let pa = glGetAttribLocation(prog, c"aPos".as_ptr().cast());
        let pu = glGetAttribLocation(prog, c"aUV".as_ptr().cast());
        let f = inst.get_proc_address("glEGLImageTargetTexture2DOES").context("glEGLImageTargetTexture2DOES")?;
        IMG_TARGET = Some(std::mem::transmute::<extern "system" fn(), ImgTargetFn>(f));
        Ok(XEgl {
            xdisp: display, xwin: window,
            inst, dpy, surf, prog, pa, pu, buffer_age,
            heads: texs.into_iter().map(|tex| HeadSlot {
                tex, img: None, key: None, w: 0, h: 0,
                uv: [0.0, 0.0, 1.0, 1.0], linear: false,
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
        let old = head.img.replace(img);
        if let Some(oi) = old { let _ = e.inst.destroy_image(e.dpy, oi); }
    }
    Ok(())
}

/// Draw every console's scanout into its window-space rect (top-left
/// coords — glViewport's bottom-left origin is converted here) and swap.
/// `geom` is the current drawable size (the caller queries it once for its
/// layout math too). `need` bounds the repaint when non-empty (buffer-age
/// partial redraw — regions outside it keep the aged buffer's pixels).
/// `damage` (top-left window coords) feeds eglSwapBuffersWithDamageKHR so
/// the compositor only re-uploads what actually changed; empty = full swap.
/// Consoles with no imported scanout yet are left at the clear color.
/// Must be called from the GL thread.
pub fn x11_redraw(e: &mut XEgl, rects: &[(i32, i32, i32, i32)], geom: (i32, i32),
                  need: &[(i32, i32, i32, i32)], damage: &[(i32, i32, i32, i32)]) -> Result<()> {
    unsafe {
        let (_ww, wh) = geom;
        glClearColor(0.0, 0.0, 0.0, 1.0);
        if need.is_empty() { glClear(0x4000); } // GL_COLOR_BUFFER_BIT
        glUseProgram(e.prog);
        let (pa, pu, nh) = (e.pa, e.pu, e.heads.len());
        let heads = &mut e.heads;
        glEnableVertexAttribArray(pa as u32);
        glEnableVertexAttribArray(pu as u32);
        const GL_TEXTURE_EXTERNAL_OES: u32 = 0x8D65;
        const GL_SCISSOR_TEST: u32 = 0x0C11;
        const GL_LINEAR: i32 = 0x2601;
        const GL_NEAREST: i32 = 0x2600;
        let mut draw_head = |i: usize| {
            let Some(&(rx, ry, rw, rh)) = rects.get(i) else { return };
            let head = &mut heads[i];
            if rw <= 0 || rh <= 0 || head.img.is_none() { return; }
            let (vx, vy, vw, vh) = fit_viewport(rw as u32, rh as u32, head.w, head.h);
            glViewport(rx + vx, wh - (ry + vy) - vh, vw, vh);
            glBindTexture(GL_TEXTURE_EXTERNAL_OES, head.tex);
            // NEAREST is exact at 1:1 (span mode); anything scaled reads
            // better linear — swap filter only on transitions.
            let lin = vw != head.w || vh != head.h;
            if head.linear != lin {
                head.linear = lin;
                let f = if lin { GL_LINEAR } else { GL_NEAREST };
                glTexParameteri(GL_TEXTURE_EXTERNAL_OES, 0x2801, f);
                glTexParameteri(GL_TEXTURE_EXTERNAL_OES, 0x2800, f);
            }
            let [u0, v0, u1, v1] = head.uv;
            let quad: [f32; 16] = [
                -1.0, -1.0, u0, v0,
                 1.0, -1.0, u1, v0,
                -1.0,  1.0, u0, v1,
                 1.0,  1.0, u1, v1,
            ];
            glVertexAttribPointer(pa as u32, 2, 0x1406, 0, 16, quad.as_ptr() as *const c_void);
            glVertexAttribPointer(pu as u32, 2, 0x1406, 0, 16, quad.as_ptr().offset(2) as *const c_void);
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
