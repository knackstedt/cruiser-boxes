// EGL/X11 zero-copy present path.
//
// QEMU exports the guest scanout as a dma-buf over the D-Bus display
// backend. We create an EGLImage from it (EGL_EXT_image_dma_buf_import +
// modifiers) on an EGL context that lives on the SAME GPU as QEMU's virgl
// rendernode (required — cross-vendor imports fail), bind it to a
// GL_TEXTURE_EXTERNAL_OES texture, and draw a fullscreen quad into an EGL
// window surface. The EGLImage is held until the next scanout replaces it —
// the image refs the GEM so the buffer stays alive across damage-only
// UpdateDMABUF redraws.
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
}

#[link(name = "X11")]
extern "C" {
    fn XGetGeometry(d: *mut c_void, w: u64, root: *mut u64, x: *mut i32, y: *mut i32,
                    wd: *mut u32, ht: *mut u32, bw: *mut u32, depth: *mut u32) -> i32;
}

/// Aspect-fit viewport of an `iw x ih` scanout inside a `ww x wh` drawable —
/// shared by the GL viewport and the mouse coordinate map so they always
/// agree (letterbox offset + scale).
pub fn fit_viewport(ww: u32, wh: u32, iw: i32, ih: i32) -> (i32, i32, i32, i32) {
    let (iw, ih) = (iw.max(1) as f32, ih.max(1) as f32);
    let sc = (ww as f32 / iw).min(wh as f32 / ih).max(0.001);
    let vw = (iw * sc).round().max(1.0) as i32;
    let vh = (ih * sc).round().max(1.0) as i32;
    ((ww as i32 - vw) / 2, (wh as i32 - vh) / 2, vw, vh)
}

type ImgTargetFn = unsafe extern "C" fn(u32, *mut c_void);
static mut IMG_TARGET: Option<ImgTargetFn> = None;

/// Per-window EGL state — one instance per console head (multi-head guests
/// spawn a window + GL worker each).
pub struct XEgl {
    xdisp: *mut c_void,
    xwin: u64,
    inst: egl::DynamicInstance<egl::EGL1_5>,
    dpy: egl::Display,
    ctx: egl::Context,
    surf: egl::Surface,
    prog: u32,
    tex: u32,
    img: Option<egl::Image>,
    img_y0: bool,
    w: i32,
    h: i32,
}

/// Create the EGL X11 display/context/window-surface. `window` is the XID of
/// an already-created X window (the minifb window). Runs on the GL thread.
pub fn x11_present_init(window: u64, w: i32, h: i32) -> Result<XEgl> {
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
        eprintln!("[xegl] current ok, swap_interval=0");

        const GL_TEXTURE_EXTERNAL_OES: u32 = 0x8D65;
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
        let mut tex = 0u32; glGenTextures(1, &mut tex);
        let f = inst.get_proc_address("glEGLImageTargetTexture2DOES").context("glEGLImageTargetTexture2DOES")?;
        IMG_TARGET = Some(std::mem::transmute(f));
        Ok(XEgl {
            xdisp: display, xwin: window,
            inst, dpy, ctx, surf, prog, tex,
            img: None, img_y0: true, w, h,
        })
    }
}

/// Import a dmabuf → EGLImage, bind it, draw + swap. The EGLImage is kept
/// alive (it refs the GEM) until the next import replaces it.
/// Must be called from the GL thread.
pub fn x11_import_and_present(e: &mut XEgl, fd: RawFd, w: u32, h: u32, stride: u32, fourcc: u32, modifier: u64, y0_top: bool) -> Result<()> {
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
            EGL_WIDTH as usize, w as usize, EGL_HEIGHT as usize, h as usize,
            EGL_LINUX_DRM_FOURCC_EXT as usize, fourcc as usize,
            EGL_DMA_BUF_PLANE0_FD_EXT as usize, fd as usize,
            EGL_DMA_BUF_PLANE0_OFFSET_EXT as usize, 0,
            EGL_DMA_BUF_PLANE0_PITCH_EXT as usize, stride as usize,
            EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT as usize, (modifier & 0xFFFFFFFF) as usize,
            EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT as usize, (modifier >> 32) as usize,
            egl::ATTRIB_NONE,
        ];
        let img = e.inst.create_image(e.dpy, egl::Context::from_ptr(egl::NO_CONTEXT),
            EGL_LINUX_DMA_BUF_EXT, egl::ClientBuffer::from_ptr(std::ptr::null_mut()), &attribs)
            .context("eglCreateImage")?;
        const GL_TEXTURE_EXTERNAL_OES: u32 = 0x8D65;
        glBindTexture(GL_TEXTURE_EXTERNAL_OES, e.tex);
        IMG_TARGET.unwrap()(GL_TEXTURE_EXTERNAL_OES, img.as_ptr());
        glTexParameteri(GL_TEXTURE_EXTERNAL_OES, 0x2801, 0x2600);
        glTexParameteri(GL_TEXTURE_EXTERNAL_OES, 0x2800, 0x2600);
        if e.w != w as i32 || e.h != h as i32 {
            // guest resolution changed — grow the X window + EGL surface to fit
            #[link(name = "X11")]
            extern "C" { fn XResizeWindow(d: *mut c_void, w: u64, wd: u32, ht: u32); }
            XResizeWindow(e.xdisp, e.xwin, w, h);
        }
        e.img_y0 = y0_top;
        e.w = w as i32;
        e.h = h as i32;
        let old = e.img.replace(img);
        if let Some(oi) = old { let _ = e.inst.destroy_image(e.dpy, oi); }
        x11_redraw(e)
    }
}

/// Redraw + swap the currently bound scanout texture (damage-only updates).
/// Must be called from the GL thread.
pub fn x11_redraw(e: &XEgl) -> Result<()> {
    unsafe {
        // Fit the scanout inside whatever size the window is NOW — fullscreen
        // moves/resizes change the drawable with no new scanout, and a
        // scanout-sized viewport leaves the rest unpainted.
        let mut root = 0u64; let mut x = 0i32; let mut y = 0i32;
        let mut ww = 0u32; let mut wh = 0u32; let mut bw = 0u32; let mut depth = 0u32;
        XGetGeometry(e.xdisp, e.xwin, &mut root, &mut x, &mut y, &mut ww, &mut wh, &mut bw, &mut depth);
        let (vx, vy, vw, vh) = fit_viewport(ww, wh, e.w, e.h);
        glClearColor(0.0, 0.0, 0.0, 1.0);
        glClear(0x4000); // GL_COLOR_BUFFER_BIT
        glViewport(vx, vy, vw, vh);
        glUseProgram(e.prog);
        let (u0, u1) = if e.img_y0 { (0f32, 1f32) } else { (1f32, 0f32) };
        let quad: [f32; 16] = [
            -1.0, -1.0, 0.0, u0,
             1.0, -1.0, 1.0, u0,
            -1.0,  1.0, 0.0, u1,
             1.0,  1.0, 1.0, u1,
        ];
        let pa = glGetAttribLocation(e.prog, b"aPos\0".as_ptr());
        let pu = glGetAttribLocation(e.prog, b"aUV\0".as_ptr());
        glEnableVertexAttribArray(pa as u32);
        glEnableVertexAttribArray(pu as u32);
        glVertexAttribPointer(pa as u32, 2, 0x1406, 0, 16, quad.as_ptr() as *const c_void);
        glVertexAttribPointer(pu as u32, 2, 0x1406, 0, 16, quad.as_ptr().offset(2) as *const c_void);
        glDrawArrays(0x0005, 0, 4);
        e.inst.swap_buffers(e.dpy, e.surf).context("swap")?;
    }
    Ok(())
}
