// viewer-dd — Cruiser direct-display viewer.
//
// Connects to QEMU's D-Bus display backend (org.qemu.Display1, p2p), receives
// guest scanouts as dma-buf fds and presents them zero-copy through an EGL
// window surface (see egl.rs). Input is forwarded back over a second p2p
// channel (Display1.Keyboard / Display1.Mouse). ALL guest consoles render
// into ONE window — each console gets its monitor's rect inside the span,
// matching freerdp /multimon semantics (a single window covering the
// virtual desktop).
//
// Handshake (three socketpairs, all over the VM's QMP unix socket):
//   pair#1: QMP getfd + add_client "@dbus-display"  → QEMU serves VM/Console
//   pair#2: our listener end → Console.RegisterListener(fd)
//   pair#3: same as #1, dedicated to input (blocking zbus calls)
//
// QEMU gl-blocks the guest until each UpdateDMABUF method call replies, so
// the handlers only enqueue work — all GL happens on a dedicated worker
// thread that owns the EGL context.
use anyhow::{Context, Result};
use std::os::fd::{AsFd, AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
mod egl;
use zbus::connection;
use zvariant::Fd;

static DM_BUFS: AtomicU64 = AtomicU64::new(0);
static UPDATES: AtomicU64 = AtomicU64::new(0);
static MOUSE_VERBOSE: AtomicU64 = AtomicU64::new(0);

/// Per-console scanout dims — the window thread's input map needs them.
struct Dims { w: AtomicU64, h: AtomicU64 }

/// Shared head table: per-console scanout dims + that console's offset in
/// the guest's desktop composite (normalized host-monitor layout). The
/// virtio tablet has ONE absolute range mapped over the whole composite —
/// QEMU adds no console offset — so console-local px must be rescaled to
/// composite fraction × console size before SetAbsPosition.
struct Heads {
    dims: Vec<std::sync::Arc<Dims>>,
    offsets: Vec<(u32, u32)>,
}

/// GL-worker job — one shared channel for every console, so Fd carries
/// the console index.
struct ScanFd {
    ci: usize,
    fd: std::os::fd::OwnedFd,
    /// scanout subrect within the backing dmabuf (usually 0,0,w,h)
    x: u32, y: u32, w: u32, h: u32,
    /// plane-0 byte offset + pitch + backing dims
    poff: u32, stride: u32, bw: u32, bh: u32,
    fourcc: u32, modifier: u64, y0_top: bool,
}
/// CPU-path scanout payload — the fallback for consoles QEMU exports as
/// guest-RAM surfaces instead of dma-bufs (Windows virtio-2d, VGA boot,
/// software gpu). Raw Scanout carries the pixels inline; ScanoutMap hands
/// an fd+offset into shareable memory so the frame crosses p2p with no
/// copy — only the GL texture upload still costs one.
enum CpuSrc {
    Pixels(Vec<u8>),
    Mapped(std::os::fd::OwnedFd, u32),
}
struct CpuScan {
    ci: usize,
    src: CpuSrc,
    w: u32, h: u32, stride: u32, fmt: u32,
}
/// Damage on a CPU-path console: `data` = raw Update pixels covering just
/// the rect; None = UpdateMap (the rect is re-read from the stored mmap).
struct CpuDmg {
    ci: usize,
    x: i32, y: i32, w: i32, h: i32,
    stride: u32, fmt: u32,
    data: Option<Vec<u8>>,
}
enum XJob {
    Fd(ScanFd),
    /// Full CPU-frame scanout (raw Scanout or ScanoutMap) — replaces the
    /// console's texture.
    Cpu(CpuScan),
    /// Damage on a CPU-frame console (raw Update or UpdateMap).
    CpuDamage(CpuDmg),
    /// Damage rect on a console (scanout px) — QEMU emits one UpdateDMABUF
    /// per damaged region, so a frame's damage arrives as a serialized burst.
    Nudge(usize, i32, i32, i32, i32),
    /// Host-side repaint request (remap/expose/unobscure). The present path
    /// is damage-driven, but the X server discards an unmapped window's
    /// backing — VD switches unmap us, and the remapped window's fresh
    /// pixmap composites BLACK until the next swap, which an idle guest
    /// never schedules. Re-rasterizes from the held EGLImages — no QEMU
    /// traffic needed.
    Repaint,
}

/// Guest hardware cursor pushed by QEMU over the listener — CursorDefine
/// carries the sprite (ARGB32, same layout as XcursorPixel: a packed
/// 0xAARRGGBB u32 per pixel) and MouseSet carries visibility (virtio-gpu
/// binds `on` to whether the guest has a cursor plane bound) plus the
/// guest-side cursor position (console px) — the relative-capture mode
/// shadows the host pointer onto it. Applied as the host window's X
/// cursor so the pointer shape tracks what it hovers in the guest —
/// dropping it leaves the host arrow showing forever.
struct CurImg { w: u32, h: u32, hx: u32, hy: u32, px: Vec<u32> }
enum CurJob { Define(usize, CurImg), Show(usize, i32, i32, bool) }

/// Per-console cursor slot: latest sprite + its built X cursor (freed on
/// replace), visibility, and a generation counter the apply path uses to
/// skip redundant XDefineCursor calls.
#[derive(Default)]
struct CurSlot { seen: bool, on: bool, gen: u64, img: Option<CurImg>, xc: u64 }

fn fourcc_str(f: u32) -> String {
    String::from_utf8_lossy(&[(f & 0xFF) as u8, ((f >> 8) & 0xFF) as u8,
        ((f >> 16) & 0xFF) as u8, ((f >> 24) & 0xFF) as u8]).into_owned()
}

/// Open a display channel — the ddproxy socket when --proxy is live, else a
/// direct QMP getfd/add_client "@dbus-display" channel (ddproto owns the
/// QEMU side).
fn open_chan(monitor: &str, proxy: Option<&str>) -> Result<UnixStream> {
    match proxy {
        Some(s) => UnixStream::connect(s).with_context(|| format!("proxy conn {s}")),
        None => ddproto::open_dbus_channel(monitor),
    }
}

/// open_chan + the p2p handshake — the fallback boundary covers both so a
/// proxy that accepts and dies mid-handshake still falls back.
async fn display_conn(monitor: &str, proxy: Option<&str>, what: &str) -> Result<zbus::Connection> {
    let s = open_chan(monitor, proxy).with_context(|| format!("{what} channel"))?;
    s.set_nonblocking(true)?;
    connection::Builder::unix_stream(tokio::net::UnixStream::from_std(s)?)
        .p2p().build().await.with_context(|| format!("{what} p2p"))
}

// ── D-Bus listener events QEMU (or ddproxy) calls into ──
// The wire skeletons live in ddproto — this sink is the viewer's side.

struct ViewerConsole {
    tx: std::sync::mpsc::Sender<XJob>,
    ctx: std::sync::mpsc::Sender<CurJob>,
    dims: std::sync::Arc<Dims>,
    id: u32,
    idx: usize,
}

impl ddproto::ConsoleEvents for ViewerConsole {
    /// Raw (non-dmabuf) scanout — pixels inline in the method call.
    fn scanout(&mut self, w: u32, h: u32, stride: u32, fmt: u32, data: Vec<u8>) {
        let resized = self.dims.w.swap(w as u64, Ordering::Relaxed) != w as u64
            || self.dims.h.swap(h as u64, Ordering::Relaxed) != h as u64;
        static NS: AtomicU64 = AtomicU64::new(0);
        let n = NS.fetch_add(1, Ordering::Relaxed) + 1;
        if n % 120 == 1 || resized {
            eprintln!("[listener:{}] Scanout#{n} {w}x{h} stride={stride} fmt={fmt:#x} bytes={}",
                self.id, data.len());
        }
        let _ = self.tx.send(XJob::Cpu(CpuScan {
            ci: self.idx, src: CpuSrc::Pixels(data), w, h, stride, fmt }));
    }
    /// Raw damage — `data` covers just the rect at `stride`.
    fn update(&mut self, x: i32, y: i32, w: i32, h: i32, stride: u32, fmt: u32,
              data: Vec<u8>) {
        UPDATES.fetch_add(1, Ordering::Relaxed);
        let _ = self.tx.send(XJob::CpuDamage(CpuDmg {
            ci: self.idx, x, y, w, h, stride, fmt, data: Some(data) }));
    }
    /// memfd/mmap scanout — the frame lives in shared memory (guest-RAM
    /// memfd), only the GL upload costs a copy.
    fn scanout_map(&mut self, fd: zvariant::OwnedFd, off: u32, w: u32, h: u32,
                   stride: u32, fmt: u32) {
        let resized = self.dims.w.swap(w as u64, Ordering::Relaxed) != w as u64
            || self.dims.h.swap(h as u64, Ordering::Relaxed) != h as u64;
        static NM: AtomicU64 = AtomicU64::new(0);
        let n = NM.fetch_add(1, Ordering::Relaxed) + 1;
        if n % 120 == 1 || resized {
            eprintln!("[listener:{}] ScanoutMap#{n} off={off} {w}x{h} stride={stride} fmt={fmt:#x}",
                self.id);
        }
        // dup before returning — the callback fd's backing can go stale
        let d = unsafe { std::os::fd::OwnedFd::from_raw_fd(libc::dup(fd.as_raw_fd())) };
        let _ = self.tx.send(XJob::Cpu(CpuScan {
            ci: self.idx, src: CpuSrc::Mapped(d, off), w, h, stride, fmt }));
    }
    /// Damage on the mapped scanout — no payload, the GL worker re-reads
    /// the rect out of its live mmap.
    fn update_map(&mut self, x: i32, y: i32, w: i32, h: i32) {
        UPDATES.fetch_add(1, Ordering::Relaxed);
        let _ = self.tx.send(XJob::CpuDamage(CpuDmg {
            ci: self.idx, x, y, w, h, stride: 0, fmt: 0, data: None }));
    }
    fn update_dmabuf(&mut self, x: i32, y: i32, w: i32, h: i32) {
        UPDATES.fetch_add(1, Ordering::Relaxed);
        // reply fast — QEMU gl-blocks the guest until this returns
        let _ = self.tx.send(XJob::Nudge(self.idx, x, y, w, h));
    }
    fn disable(&mut self) { eprintln!("[listener] Disable"); }
    fn mouse_set(&mut self, x: i32, y: i32, on: i32) {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed) + 1;
        if MOUSE_VERBOSE.load(Ordering::Relaxed) != 0 || n % 20 == 1 {
            eprintln!("[listener:{}] mouse_set {x},{y} on={on}", self.id);
        }
        let _ = self.ctx.send(CurJob::Show(self.idx, x, y, on != 0));
    }
    fn cursor_define(&mut self, w: i32, h: i32, hx: i32, hy: i32, data: Vec<u8>) {
        let (w, h) = (w.max(0) as u32, h.max(0) as u32);
        // reject nonsense — 4 bytes per pixel, sane sprite size
        if w == 0 || h == 0 || w as u64 * h as u64 > 65536
            || data.len() < w as usize * h as usize * 4 {
            return;
        }
        let px = data.chunks_exact(4).take((w * h) as usize)
            .map(|b| u32::from_ne_bytes(b.try_into().unwrap()))
            .collect();
        let _ = self.ctx.send(CurJob::Define(self.idx, CurImg {
            w, h,
            hx: hx.max(0) as u32, hy: hy.max(0) as u32,
            px,
        }));
    }
    fn scanout_dmabuf2(&mut self, dmabufs: Vec<zvariant::OwnedFd>, x: u32, y: u32, width: u32, height: u32,
                       offsets: Vec<u32>, strides: Vec<u32>, num_planes: u32, fourcc: u32,
                       backing_width: u32, backing_height: u32, modifier: u64, y0_top: bool) {
        let n = DM_BUFS.fetch_add(1, Ordering::Relaxed) + 1;
        let resized = self.dims.w.swap(width as u64, Ordering::Relaxed) != width as u64
            || self.dims.h.swap(height as u64, Ordering::Relaxed) != height as u64;
        if n % 120 == 1 || resized {
            eprintln!("[listener:{}] ScanoutDMABUF2#{n} planes={num_planes} {width}x{height} strides={strides:?} fourcc={} modifier=0x{modifier:x} backing={backing_width}x{backing_height} y0_top={y0_top}",
                self.id, fourcc_str(fourcc));
        }
        if dmabufs.is_empty() || num_planes == 0 { return; }
        if num_planes > 1 { return; } // multi-plane not supported
        // hand the fd to the GL worker while it's live — QEMU fds can lose
        // their GEM backing within ~ms of the callback
        let d = unsafe { std::os::fd::OwnedFd::from_raw_fd(libc::dup(dmabufs[0].as_raw_fd())) };
        let _ = self.tx.send(XJob::Fd(ScanFd {
            ci: self.idx, fd: d, x, y, w: width, h: height,
            poff: offsets.first().copied().unwrap_or(0),
            stride: strides.first().copied().unwrap_or(0),
            bw: backing_width.max(width), bh: backing_height.max(height),
            fourcc, modifier, y0_top,
        }));
    }
    fn interfaces(&self) -> Vec<String> {
        // DMABUF2 for GL scanouts (venus/yttrium path); Unix.Map so QEMU
        // prefers the zero-copy-over-p2p memfd scanout for CPU consoles —
        // raw Scanout/Update on the base iface needs no advertisement.
        vec![ddproto::IFACE_LISTENER_DMABUF2.to_string(),
             ddproto::IFACE_LISTENER_MAP.to_string()]
    }
}

// ── clipboard bridging ──
// QEMU's -chardev qemu-vdagent lands guest clipboard state in QEMU's
// clipboard core; -display dbus exposes it as org.qemu.Display1.Clipboard.
// The interface is symmetric: we serve an object at
// /org/qemu/Display1/Clipboard, call Register on QEMU's skeleton (the call's
// sender = our conn), and from then on QEMU invokes Grab/Release/Request on
// our object while we invoke the same names on its side. Text only —
// QEMU's dbus clipboard knows one MIME.
const CLIP_MIME: &str = "text/plain;charset=utf-8";
const SEL_CLIPBOARD: u32 = 0;

enum ClipEv { GuestGrab(u32) }

#[derive(Default)]
struct ClipShared {
    /// last text synced to/from the host clipboard — echo guard for the
    /// poller (setting host text from a guest grab must not re-grab it)
    host_text: String,
    /// last text we grabbed toward QEMU — served to the guest by Request
    serving: Option<String>,
}

struct ViewerClip {
    st: std::sync::Arc<std::sync::Mutex<ClipShared>>,
    serial: std::sync::Arc<AtomicU64>,
    evtx: std::sync::mpsc::Sender<ClipEv>,
}

impl ddproto::ClipEvents for ViewerClip {
    /// QEMU resets the serial counter through our Register — both on our own
    /// Register call and any later session reset.
    fn register(&mut self) {
        self.serial.store(0, Ordering::Relaxed);
        // QEMU bounced the vdagent port: the guest's clipboard state reset
        // with the serial — it no longer holds whatever host text we last
        // grabbed. Clear the echo guards so the poller re-pushes it on the
        // next tick, or the guest stays silently empty until the host
        // copies something new.
        let mut st = self.st.lock().unwrap();
        st.host_text.clear();
        st.serving = None;
        eprintln!("[clip] serial reset by qemu");
    }
    /// Guest grabbed the clipboard — fetch the text on demand (worker thread,
    /// not here: QEMU's call is fire-and-forget, our Request is not).
    fn grab(&mut self, selection: u32, serial: u32, mimes: Vec<String>) {
        self.serial.fetch_max(serial as u64, Ordering::Relaxed);
        if selection == SEL_CLIPBOARD && mimes.iter().any(|m| m == CLIP_MIME) {
            let _ = self.evtx.send(ClipEv::GuestGrab(selection));
        }
    }
    /// Guest paste while we own — QEMU blocks its main loop on this reply, so
    /// it must never block on the worker: just read the parked text.
    fn request(&mut self, selection: u32, mimes: Vec<String>) -> zbus::fdo::Result<(String, Vec<u8>)> {
        if selection != SEL_CLIPBOARD || !mimes.iter().any(|m| m == CLIP_MIME) {
            return Err(zbus::fdo::Error::InvalidArgs("unsupported selection or mime".into()));
        }
        match self.st.lock().unwrap().serving.clone() {
            Some(t) => Ok((CLIP_MIME.to_string(), t.into_bytes())),
            None => Err(zbus::fdo::Error::Failed("no clipboard data".into())),
        }
    }
}

/// Owns the host clipboard (arboard) and the outgoing half of the protocol.
/// Register failure = no vdagent backend on this QEMU (or another client got
/// there first) — log once and let the thread die; the flag off case is the
/// same as not passing the chardev.
fn clipboard_worker(iconn: std::sync::Arc<zbus::blocking::Connection>,
                    st: std::sync::Arc<std::sync::Mutex<ClipShared>>,
                    serial: std::sync::Arc<AtomicU64>,
                    rx: std::sync::mpsc::Receiver<ClipEv>) {
    let clip = match zbus::blocking::Proxy::new(&iconn, "org.qemu",
            "/org/qemu/Display1/Clipboard", "org.qemu.Display1.Clipboard") {
        Ok(p) => p,
        Err(e) => { eprintln!("[clip] proxy: {e} — clipboard sync off"); return; }
    };
    if let Err(e) = clip.call::<_, _, ()>("Register", &()) {
        eprintln!("[clip] register: {e} — clipboard sync off");
        return;
    }
    let mut host = match arboard::Clipboard::new() {
        Ok(c) => c,
        Err(e) => { eprintln!("[clip] host clipboard: {e} — clipboard sync off"); return; }
    };
    eprintln!("[clip] registered — host↔guest text sync active");
    let utf8 = vec![CLIP_MIME.to_string()];
    loop {
        // guest → host: QEMU reported a grab; pull the text by demand.
        while let Ok(ev) = rx.try_recv() {
            let ClipEv::GuestGrab(sel) = ev;
            match clip.call::<_, _, (String, Vec<u8>)>("Request", &(sel, utf8.clone())) {
                Ok((_mime, data)) => {
                    let text = String::from_utf8_lossy(&data).into_owned();
                    st.lock().unwrap().host_text = text.clone();
                    match host.set_text(text.clone()) {
                        Ok(()) => eprintln!("[clip] guest→host {} bytes", text.len()),
                        Err(e) => eprintln!("[clip] host set_text: {e}"),
                    }
                }
                Err(e) => eprintln!("[clip] request: {e}"),
            }
        }
        // host → guest: arboard has no change watcher — poll + diff.
        match host.get_text() {
            Ok(t) => {
                let changed = {
                    let mut s = st.lock().unwrap();
                    if t != s.host_text {
                        s.host_text = t.clone();
                        s.serving = Some(t);
                        true
                    } else { false }
                };
                if changed {
                    // serial space starts at 0 and is shared with the guest:
                    // spice-vdagentd discards grabs that aren't exactly its
                    // counter — first grab after a reset must be 0
                    let s = serial.fetch_add(1, Ordering::Relaxed) as u32;
                    match clip.call::<_, _, ()>("Grab", &(SEL_CLIPBOARD, s, utf8.clone())) {
                        Ok(()) => eprintln!("[clip] host→guest grabbed (serial {s})"),
                        Err(e) => eprintln!("[clip] grab: {e}"),
                    }
                }
            }
            Err(arboard::Error::ContentNotAvailable) => {}
            Err(e) => {
                static CE: AtomicU64 = AtomicU64::new(0);
                let n = CE.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 200 == 1 { eprintln!("[clip] host get_text x{n}: {e}"); }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}

// ── input forwarding: raw X11 keycodes -> D-Bus Display1.Keyboard/Mouse ──
// QEMU key numbers are XT scancodes (qnum table); mouse btns: 0=L,1=M,2=R.
// Move/Btn carry the console the pointer is over — all consoles share the
// one virtio tablet, but the D-Bus Mouse objects are per-console.
enum In {
    Move(usize, u32, u32),
    Btn(usize, u8, bool),
    Key(u32, bool),
    /// Relative deltas — RelMotion on console 0's Mouse proxy (REL events
    /// route to QEMU's relative handler regardless of console).
    Rel(i32, i32),
    /// Flip QEMU's active pointer handler: true → a REL device (the PS/2
    /// mouse, feeding guest pointer-lock raw deltas), false → the virtio
    /// tablet (absolute). Done via HMP mouse_set over QMP.
    Mode(bool),
}

/// X keycode → QEMU qnum. X keycodes are evdev codes +8, and evdev codes
/// ARE the XT set-1 scancode for the base block — so `~/`-tilde and every
/// other key maps positionally with no keysym table in the way. Extended
/// keys (evdev ≥ 96) map back through the e0 qnum encodings — the inverse
/// of xkey_for. Layout-independent by construction: QEMU wants physical
/// positions, which is exactly what keycodes describe.
fn qnum_for_keycode(xkey: u32) -> Option<u32> {
    let ev = xkey.checked_sub(8)?;
    Some(match ev {
        96 => 0x9c, 97 => 0x9d, 98 => 0xb5, 99 => 0xb7, 100 => 0xb8,
        102 => 0xc7, 103 => 0xc8, 104 => 0xc9, 105 => 0xcb, 106 => 0xcd,
        107 => 0xcf, 108 => 0xd0, 109 => 0xd1, 110 => 0xd2, 111 => 0xd3,
        113 => 0xa0, 114 => 0xae, 115 => 0xb0, 119 => 0xc5,
        125 => 0xdb, 126 => 0xdc, 127 => 0xdd,
        163 => 0x99, 164 => 0xa2, 165 => 0x90, 166 => 0xa4,
        _ if ev > 0 && ev < 0x80 => ev,
        _ => return None,
    })
}

// ── escape shortcuts under grab ──
// spec.display.escapeShortcuts are installed as host-global bindings
// (kglobalaccel/khotkeys) — all dead while we hold the keyboard grab, since
// the WM never sees the keys. So under --grab the viewer recognizes the
// combos in its own key stream and runs the action itself: kwin desktop
// nav via kglobalaccel's invokeShortcut (the same entry point the dead
// binding called), command: via sh -c, ungrab releases the grab until the
// next focus cycle. Combo spec = "<mods+key>=<action>" pairs, action the
// same grammar as the spec (host-desktop:N, desktop-cycle-left|right,
// ungrab, none, command:<cmdline> — {vm}/{cli} expanded by the caller).
const M_CTRL: [u32; 2] = [0x1d, 0x9d];   // LeftCtrl / RightCtrl
const M_ALT: [u32; 2] = [0x38, 0xb8];    // LeftAlt / RightAlt
const M_SHIFT: [u32; 2] = [0x2a, 0x36];  // LeftShift / RightShift
const M_META: [u32; 2] = [0xdb, 0xdc];   // LeftSuper / RightSuper

// elapsed-since-start prefix for grab/esc log lines — grab/ungrab flapping
// is only diagnosable with timing.
static T0: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
fn ts() -> u64 { T0.get_or_init(std::time::Instant::now).elapsed().as_secs() }

#[derive(Clone)]
enum EscAct { Desktop(u32), Cycle(i8), Kwin(String), Ungrab, Abort, RelGrab, Noop, Cmd(String) }

#[derive(Clone)]
struct EscCombo {
    xkey: u32,  /* X keycode — the combo's trigger (grab + intercept match) */
    xmods: u32, /* X modifier mask (Shift|Control|Mod1|Mod4) */
    act: EscAct,
}

/// QEMU qnum → X keycode. XT scancodes are evdev-1 for the base block
/// (X keycode = evdev + 8); the e0-extended block maps back through the
/// same table qnum_for uses.
fn xkey_for(qnum: u32) -> Option<u32> {
    let ev = if qnum < 0x80 { qnum } else { match qnum {
        0x9c => 96, 0x9d => 97, 0xb5 => 98, 0xb7 => 99, 0xb8 => 100,
        0xc7 => 102, 0xc8 => 103, 0xc9 => 104, 0xcb => 105, 0xcd => 106,
        0xcf => 107, 0xd0 => 108, 0xd1 => 109, 0xd2 => 110, 0xd3 => 111,
        0xa0 => 113, 0xae => 114, 0xb0 => 115, 0xc5 => 119,
        0xdb => 125, 0xdc => 126, 0xdd => 127,
        0x99 => 163, 0xa2 => 164, 0x90 => 165, 0xa4 => 166,
        _ => return None,
    }};
    Some(ev + 8)
}

/// our mod byte (1=ctrl 2=alt 4=shift 8=meta) → X modifier mask
/// (ShiftMask|ControlMask|Mod1Mask|Mod4Mask).
fn xmods_of(m: u8) -> u32 {
    (m as u32 & 1) << 2 | (m as u32 & 2) << 2 | (m as u32 & 4) >> 2 | (m as u32 & 8) << 3
}

/// Escape state: the combo table is static, enabled mirrors --grab
/// (escape interception runs while the window is focused so a combo
/// can't fall to the host during a grab gap — the kglobalaccel copies
/// are uninstalled under --grab, so nothing double-fires), and the
/// generation counters carry the ungrab/abort requests into the window
/// loop.
struct EscState {
    enabled: bool,
    combos: Vec<EscCombo>,
    /// Generation counters (fetch_add to request) — a swap()-cleared
    /// flag would race a concurrent bump.
    ungrab_gen: std::sync::atomic::AtomicU64,
    /// abort: release grabs + minimize the window.
    abort_gen: std::sync::atomic::AtomicU64,
    /// relgrab: toggle relative pointer capture (spec.display.pointerLock
    /// override for the current lock episode).
    rel_gen: std::sync::atomic::AtomicU64,
}

/// SIGUSR1 → abort. Signal handlers can only touch a static; the window
/// loop notices and bumps abort_gen. Needs no keyboard input — survives a
/// wedged grab (`pkill -USR1 -x viewer-dd`), as does a VT switch
/// (Ctrl+Alt+F3 runs below the grab).
static SIG_ABORT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
extern "C" fn sig_abort(_: i32) { SIG_ABORT.store(true, Ordering::Relaxed); }

/// Named key → QEMU XT scancode, for the escape-combo grammar (same
/// vocabulary kdeKeys maps for kglobalshortcutsrc).
fn qnum_named(k: &str) -> Option<u32> {
    Some(match k {
        "a" => 0x1e, "b" => 0x30, "c" => 0x2e, "d" => 0x20, "e" => 0x12,
        "f" => 0x21, "g" => 0x22, "h" => 0x23, "i" => 0x17, "j" => 0x24,
        "k" => 0x25, "l" => 0x26, "m" => 0x32, "n" => 0x31, "o" => 0x18,
        "p" => 0x19, "q" => 0x10, "r" => 0x13, "s" => 0x1f, "t" => 0x14,
        "u" => 0x16, "v" => 0x2f, "w" => 0x11, "x" => 0x2d, "y" => 0x15,
        "z" => 0x2c,
        "0" => 0x0b, "1" => 0x02, "2" => 0x03, "3" => 0x04, "4" => 0x05,
        "5" => 0x06, "6" => 0x07, "7" => 0x08, "8" => 0x09, "9" => 0x0a,
        "minus" | "-" => 0x0c, "equal" | "equals" | "=" => 0x0d,
        "backspace" => 0x0e, "tab" => 0x0f,
        "leftbracket" | "lbracket" | "[" => 0x1a, "rightbracket" | "rbracket" | "]" => 0x1b,
        "enter" | "return" => 0x1c, "semicolon" | ";" => 0x27,
        "apostrophe" | "quote" | "'" => 0x28, "backslash" | "\\" => 0x2b,
        "comma" | "," => 0x33, "period" | "." => 0x34, "slash" | "/" => 0x35,
        "space" => 0x39, "capslock" => 0x3a, "escape" | "esc" => 0x01,
        "home" => 0xc7, "up" => 0xc8, "pageup" | "pgup" => 0xc9,
        "left" => 0xcb, "right" => 0xcd, "end" => 0xcf, "down" => 0xd0,
        "pagedown" | "pgdn" => 0xd1, "insert" | "ins" => 0xd2,
        "delete" | "del" => 0xd3,
        "f1" => 0x3b, "f2" => 0x3c, "f3" => 0x3d, "f4" => 0x3e, "f5" => 0x3f,
        "f6" => 0x40, "f7" => 0x41, "f8" => 0x42, "f9" => 0x43, "f10" => 0x44,
        "f11" => 0x57, "f12" => 0x58,
        _ => return None,
    })
}

fn parse_escape(spec: &str) -> Option<EscCombo> {
    let (combo, act) = spec.split_once('=')?;
    let parts: Vec<String> = combo.split('+').map(|p| p.trim().to_lowercase()).collect();
    let trig = qnum_named(parts.last()?)?;
    let mut mods = 0u8;
    for m in &parts[..parts.len() - 1] {
        mods |= match m.as_str() {
            "ctrl" | "control" => 1, "alt" => 2,
            "shift" => 4, "meta" | "super" | "mod4" => 8,
            _ => return None,
        };
    }
    let i = act.find(':');
    let kind = i.map(|i| &act[..i]).unwrap_or(act);
    let arg = i.map(|i| &act[i + 1..]);
    let act = match kind {
        "host-desktop" => EscAct::Desktop(arg?.parse().ok()?),
        "desktop-cycle-left" => EscAct::Cycle(-1),
        "desktop-cycle-right" => EscAct::Cycle(1),
        "kwin" => EscAct::Kwin(arg?.to_string()),
        "ungrab" => EscAct::Ungrab,
        "abort" => EscAct::Abort,
        "relgrab" => EscAct::RelGrab,
        "none" => EscAct::Noop,
        "command" => EscAct::Cmd(arg?.to_string()),
        _ => return None,
    };
    Some(EscCombo { xkey: xkey_for(trig)?, xmods: xmods_of(mods), act })
}

fn run_quiet(bin: &str, args: &[String]) -> bool {
    std::process::Command::new(bin).args(args).status()
        .map(|s| s.success()).unwrap_or(false)
}

/// EWMH desktop switch via xdotool — the non-KDE fallback (mirrors
/// host-int runEscape's x11 path: 0-based _NET_CURRENT_DESKTOP).
fn ewmh_switch(action: &EscAct) -> bool {
    let target = match action {
        EscAct::Desktop(n) => n.saturating_sub(1) as i64,
        EscAct::Cycle(d) => {
            let out = std::process::Command::new("xdotool")
                .args(["get_desktop"]).output().ok()
                .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<i64>().ok());
            let num = std::process::Command::new("xdotool")
                .args(["get_num_desktops"]).output().ok()
                .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<i64>().ok());
            match (out, num) {
                (Some(cur), Some(n)) if n > 0 => (cur + *d as i64).rem_euclid(n),
                _ => return false,
            }
        }
        _ => return false,
    };
    run_quiet("xdotool", &["set_desktop".to_string(), target.to_string()])
}

/// Invoke a named kglobalaccel action on the kwin component — the same
/// entry point the user's own binding calls, so behavior (incl. Plasma 6
/// internal names) is identical to pressing the host's real shortcut.
fn kwin_invoke(name: &str) -> bool {
    for bin in ["qdbus6", "qdbus"] {
        if run_quiet(bin, &[
            "org.kde.kglobalaccel".to_string(),
            "/component/kwin".to_string(),
            "org.kde.kglobalaccel.Component.invokeShortcut".to_string(),
            name.to_string()]) {
            return true;
        }
    }
    run_quiet("gdbus", &[
        "call".to_string(), "--session".to_string(),
        "--dest".to_string(), "org.kde.kglobalaccel".to_string(),
        "--object-path".to_string(), "/component/kwin".to_string(),
        "--method".to_string(), "org.kde.kglobalaccel.Component.invokeShortcut".to_string(),
        name.to_string()])
}

impl EscState {
    fn fire(&self, combo: &EscCombo, title: &str) {
        match &combo.act {
            EscAct::Ungrab => { self.ungrab_gen.fetch_add(1, Ordering::Relaxed); }
            EscAct::Abort => { self.abort_gen.fetch_add(1, Ordering::Relaxed); }
            EscAct::RelGrab => { self.rel_gen.fetch_add(1, Ordering::Relaxed); }
            EscAct::Noop => { eprintln!("[+{}s][esc] combo → none ({title})", ts()); }
            EscAct::Cmd(c) => {
                let c = c.clone();
                let t = title.to_string();
                std::thread::spawn(move || {
                    eprintln!("[+{}s][esc] combo → sh -c `{c}` ({t})", ts());
                    let _ = std::process::Command::new("sh").args(["-c", &c]).spawn();
                });
            }
            EscAct::Kwin(name) => {
                let name = name.clone();
                let t = title.to_string();
                std::thread::spawn(move || {
                    let ok = kwin_invoke(&name);
                    eprintln!("[+{}s][esc] kwin '{name}' → {} ({t})", ts(), if ok { "ok" } else { "FAILED" });
                });
            }
            a @ (EscAct::Desktop(_) | EscAct::Cycle(_)) => {
                // KWin first (invokeShortcut — the dead binding's own entry
                // point), then EWMH set_desktop for other WMs.
                let name = match a {
                    EscAct::Desktop(n) => format!("Switch to Desktop {n}"),
                    EscAct::Cycle(d) => if *d > 0 {
                        "Switch One Desktop to the Right".to_string()
                    } else {
                        "Switch One Desktop to the Left".to_string()
                    },
                    _ => unreachable!(),
                };
                let a = a.clone();
                std::thread::spawn(move || {
                    let ok = kwin_invoke(&name) || ewmh_switch(&a);
                    eprintln!("[+{}s][esc] desktop nav '{name}' → {}", ts(), if ok { "ok" } else { "FAILED" });
                });
            }
        }
    }
}

#[link(name = "Xtst")]
#[link(name = "X11")]
extern "C" {
    fn XOpenDisplay(name: *const u8) -> *mut std::ffi::c_void;
    fn XCloseDisplay(d: *mut std::ffi::c_void) -> i32;
    fn XInternAtom(d: *mut std::ffi::c_void, name: *const u8, only_if_exists: i32) -> u64;
    fn XChangeProperty(d: *mut std::ffi::c_void, w: u64, prop: u64, typ: u64,
                       fmt: i32, mode: i32, data: *const u8, nelem: i32);
    fn XFlush(d: *mut std::ffi::c_void);
    // XkbGetNamedIndicator is the CORE-keyboard entry point — there is no
    // device_spec arg (that variant is XkbGetNamedDeviceIndicator). An extra
    // arg here once silently shifted every parameter one slot and made the
    // probe fail forever.
    fn XkbGetNamedIndicator(d: *mut std::ffi::c_void, name: u64,
                            ndx: *mut i32, state: *mut i32,
                            map: *mut std::ffi::c_void, real: *mut i32) -> i32;
    // XkbStateRec — only locked_mods (byte offset 9) is read.
    fn XkbGetState(d: *mut std::ffi::c_void, device_spec: u32, state: *mut XkbStateRec) -> i32;
    fn XGrabKeyboard(d: *mut std::ffi::c_void, grab_window: u64, owner_events: i32,
                     pointer_mode: i32, keyboard_mode: i32, time: u64) -> i32;
    fn XUngrabKeyboard(d: *mut std::ffi::c_void, time: u64) -> i32;
    fn XGrabPointer(d: *mut std::ffi::c_void, grab_window: u64, owner_events: i32,
                    event_mask: u32, pointer_mode: i32, keyboard_mode: i32,
                    confine_to: u64, cursor: u64, time: u64) -> i32;
    fn XUngrabPointer(d: *mut std::ffi::c_void, time: u64) -> i32;
    fn XGrabButton(d: *mut std::ffi::c_void, button: u32, modifiers: u32,
                   grab_window: u64, owner_events: i32, event_mask: u32,
                   pointer_mode: i32, keyboard_mode: i32,
                   confine_to: u64, cursor: u64);
    fn XIconifyWindow(d: *mut std::ffi::c_void, w: u64, screen: i32) -> i32;
    fn XSelectInput(d: *mut std::ffi::c_void, w: u64, mask: i64);
    fn XPending(d: *mut std::ffi::c_void) -> i32;
    fn XNextEvent(d: *mut std::ffi::c_void, ev: *mut XEvBuf) -> i32;
    fn XPeekEvent(d: *mut std::ffi::c_void, ev: *mut XEvBuf) -> i32;
    fn XGetInputFocus(d: *mut std::ffi::c_void, w: *mut u64, revert: *mut i32) -> i32;
    fn XQueryPointer(d: *mut std::ffi::c_void, w: u64, root: *mut u64, child: *mut u64,
                     root_x: *mut i32, root_y: *mut i32, win_x: *mut i32, win_y: *mut i32,
                     mask: *mut u32) -> i32;
    fn XSendEvent(d: *mut std::ffi::c_void, w: u64, propagate: i32,
                  mask: i64, ev: *mut XEvBuf) -> i32;
    fn XGrabKey(d: *mut std::ffi::c_void, keycode: i32, modifiers: u32,
                grab_window: u64, owner_events: i32, pointer_mode: i32,
                keyboard_mode: i32);
    fn XRootWindow(d: *mut std::ffi::c_void, screen: i32) -> u64;
    fn XMoveResizeWindow(d: *mut std::ffi::c_void, w: u64, x: i32, y: i32,
                         wd: u32, ht: u32);
    fn XFree(p: *mut std::ffi::c_void) -> i32;
    fn XGetWindowProperty(d: *mut std::ffi::c_void, w: u64, prop: u64,
                          off: i64, len: i64, delete: i32, req_type: u64,
                          actual_type: *mut u64, actual_fmt: *mut i32,
                          nitems: *mut u64, bytes_after: *mut u64,
                          prop_ret: *mut *mut u8) -> i32;
    fn XTestFakeButtonEvent(d: *mut std::ffi::c_void, button: u32,
                            is_press: i32, delay: u64) -> i32;
    fn XWarpPointer(d: *mut std::ffi::c_void, src_w: u64, dest_w: u64,
                    src_x: i32, src_y: i32, src_wd: u32, src_ht: u32,
                    dest_x: i32, dest_y: i32) -> i32;
    fn XDefineCursor(d: *mut std::ffi::c_void, w: u64, cursor: u64) -> i32;
    fn XUndefineCursor(d: *mut std::ffi::c_void, w: u64) -> i32;
    fn XFreeCursor(d: *mut std::ffi::c_void, cursor: u64) -> i32;
    fn XSetErrorHandler(h: Option<extern "C" fn(*mut std::ffi::c_void, *mut XErrEv) -> i32>)
        -> Option<extern "C" fn(*mut std::ffi::c_void, *mut XErrEv) -> i32>;
}

/// libXcursor image — the layout XcursorImageCreate/LoadCursor expect
/// (Xcursor.h: every field is a 32-bit XcursorUInt/XcursorDim + the
/// pixels pointer).
#[repr(C)]
struct XcursorImage {
    _version: u32, _size: u32, _width: u32, _height: u32,
    xhot: u32, yhot: u32, _delay: u32, pixels: *mut u32,
}

/// libXcursor — dlopen'd like libXinerama: present on every X desktop,
/// and its absence degrades to the host's default cursor rather than
/// failing the viewer.
struct Xcursor {
    create: unsafe extern "C" fn(i32, i32) -> *mut XcursorImage,
    load: unsafe extern "C" fn(*mut std::ffi::c_void, *const XcursorImage) -> u64,
    destroy: unsafe extern "C" fn(*mut XcursorImage),
    _lib: libloading::Library,
}

fn xcursor() -> Option<&'static Xcursor> {
    static XC: std::sync::OnceLock<Option<Xcursor>> = std::sync::OnceLock::new();
    XC.get_or_init(|| unsafe {
        let lib = libloading::Library::new("libXcursor.so.1")
            .or_else(|_| libloading::Library::new("libXcursor.so")).ok()?;
        Some(Xcursor {
            create: *lib.get(b"XcursorImageCreate\0").ok()?,
            load: *lib.get(b"XcursorImageLoadCursor\0").ok()?,
            destroy: *lib.get(b"XcursorImageDestroy\0").ok()?,
            _lib: lib,
        })
    }).as_ref()
}

/// CurImg → X Cursor XID via libXcursor. The pixel block copies straight
/// over — QEMU's ARGB32 wire data and XcursorPixel are the same layout.
unsafe fn build_xcursor(d: *mut std::ffi::c_void, img: &CurImg) -> Option<u64> {
    let xc = xcursor()?;
    let im = (xc.create)(img.w as i32, img.h as i32);
    if im.is_null() { return None; }
    (*im).xhot = img.hx.min(img.w - 1);
    (*im).yhot = img.hy.min(img.h - 1);
    std::ptr::copy_nonoverlapping(img.px.as_ptr(), (*im).pixels, img.px.len());
    let c = (xc.load)(d, im);
    (xc.destroy)(im);
    (c != 0).then_some(c)
}

/// Xinerama screen list — the index space _NET_WM_FULLSCREEN_MONITORS
/// uses (EWMH defines monitor indices as Xinerama order). dlopen'd: the
/// lib is ubiquitous but not guaranteed, and its absence only degrades
/// the span hint, never the window itself.
#[repr(C)]
struct XineramaScreenInfo { _screen: i32, x: i16, y: i16, w: i16, h: i16 }
type XineramaQueryScreensFn =
    unsafe extern "C" fn(*mut std::ffi::c_void, *mut i32) -> *mut XineramaScreenInfo;

/// XErrorEvent — async request errors (e.g. XGrabKey BadAccess when
/// kglobalacceld already owns a mirrored VD combo). Logged, never fatal:
/// the default handler is fine, but a quiet tagged line beats a mystery.
#[repr(C)]
struct XErrEv {
    _t: i32, _p0: i32, _dpy: u64, _resid: u64, _serial: u64,
    error_code: u8, request_code: u8, _minor: u8, _p1: u8,
}
extern "C" fn xerror_handler(_d: *mut std::ffi::c_void, e: *mut XErrEv) -> i32 {
    let (code, req) = unsafe { ((*e).error_code, (*e).request_code) };
    eprintln!("[x11] request error code={code} req={req} (ignored — likely a combo grab race)");
    0
}

/// 192-byte XEvent union — only the leading type/serial/send_event fields
/// are read; the rest is re-sent verbatim. `client` is written for the
/// _NET_WM_STATE fullscreen request.
#[repr(C)]
union XEvBuf { any: XAnyEv, key: XKeyEv, client: XClientMsgEv, _pad: [u64; 24] }

#[repr(C)]
#[derive(Clone, Copy)]
struct XAnyEv {
    t: i32,             // 2 = KeyPress, 3 = KeyRelease
    _p0: i32,
    _serial: u64,
    send_event: i32,    // nonzero → synthetic (our own reinjected copy)
}

#[repr(C)]
#[derive(Clone, Copy)]
struct XKeyEv {
    t: i32, _p0: i32, _serial: u64, send_event: i32, _p1: i32,
    _dpy: u64, _win: u64, _root: u64, _sub: u64, time: u64,
    _x: i32, _y: i32, _xr: i32, _yr: i32,
    state: u32, keycode: u32, _same: i32, _p2: i32,
}

/// XClientMessageEvent — used to ask the WM for _NET_WM_STATE_FULLSCREEN.
/// display/serial/send_event are filled by Xlib on send; data.l carries
/// [action=1, atom1, atom2, source=2].
#[repr(C)]
#[derive(Clone, Copy)]
struct XClientMsgEv {
    t: i32, _p0: i32, _serial: u64, _send_event: i32, _p1: i32,
    _dpy: u64, win: u64, msg_type: u64, fmt: i32, _p2: i32,
    data: [u64; 5],
}

#[repr(C)]
struct XkbStateRec([u8; 18]);

/// Host NumLock via the XKB "Num Lock" virtual indicator. Going through the
/// named indicator instead of locked_mods & Mod2 keeps working if the
/// numlock modifier got remapped; a keymap that never bound a name to the
/// indicator falls back to the Mod2 bit — a permanently dead probe means
/// the reconcile below never runs and the guest numpad stays inverted
/// forever.
fn host_numlock(dpy: *mut std::ffi::c_void, num_atom: u64) -> Option<bool> {
    if dpy.is_null() || num_atom == 0 { return None; }
    let mut ndx = 0i32;
    let mut st = 0i32;
    let mut real = 0i32;
    unsafe {
        if XkbGetNamedIndicator(dpy, num_atom, &mut ndx, &mut st,
                                std::ptr::null_mut(), &mut real) != 0 {
            return Some(st != 0);
        }
        let mut s = XkbStateRec([0; 18]);
        // XkbGetState returns a Status — 0 == Success.
        if XkbGetState(dpy, 0x0100 /* XkbUseCoreKbd */, &mut s) == 0 {
            return Some(s.0[9] & 0x10 != 0); // locked_mods & Mod2Mask
        }
        None
    }
}

// ── head layout: consoles → rects inside the single window ──

/// (x, y, w, h) rect — damage bookkeeping uses it in both scanout and
/// window space.
type WRect = (i32, i32, i32, i32);

/// Push a damage rect, collapsing the list to its bounding union past 8
/// entries — QEMU already merges damage coarsely, so beyond a handful of
/// rects the extra scissoring isn't worth it.
fn add_rect(list: &mut Vec<WRect>, r: WRect) {
    if r.2 <= 0 || r.3 <= 0 { return; }
    if list.len() < 8 { list.push(r); return; }
    let mut u = r;
    for &q in list.iter() {
        let x0 = u.0.min(q.0);
        let y0 = u.1.min(q.1);
        let x1 = (u.0 + u.2).max(q.0 + q.2);
        let y1 = (u.1 + u.3).max(q.1 + q.3);
        u = (x0, y0, x1 - x0, y1 - y0);
    }
    list.clear();
    list.push(u);
}

/// Fullscreen-span geometry built from --rects (picked host monitors,
/// absolute px, console order): the union rect the window covers plus the
/// same rects normalized to the union origin for the draw/input maps.
struct Span {
    union: (i32, i32, i32, i32),
    abs: Vec<(i32, i32, i32, i32)>,
    rects: Vec<(i32, i32, i32, i32)>,
}

/// A console's position in the guest composite — --offsets by console
/// order. Missing entries tile horizontally so a windowed composite still
/// lays out when the host has no monitor info to mirror.
fn head_offset(heads: &Heads, i: usize) -> (i64, i64) {
    if let Some(&(x, y)) = heads.offsets.get(i) { return (x as i64, y as i64); }
    let mut x = 0i64;
    for d in &heads.dims[..i.min(heads.dims.len())] {
        x += d.w.load(Ordering::Relaxed) as i64;
    }
    (x, 0)
}

/// Composite bounding box — max(offset + dims) over consoles.
fn composite_extent(heads: &Heads) -> (i64, i64) {
    let (mut cw, mut ch) = (1i64, 1i64);
    for (i, d) in heads.dims.iter().enumerate() {
        let (ox, oy) = head_offset(heads, i);
        cw = cw.max(ox + d.w.load(Ordering::Relaxed) as i64);
        ch = ch.max(oy + d.h.load(Ordering::Relaxed) as i64);
    }
    (cw, ch)
}

/// Window-space draw rect per console (top-left coords, (x,y,w,h)). A span
/// pins each head to its monitor rect — but only while the drawable is
/// union-sized; a WM that collapsed the fullscreen span gets the
/// composite-letterbox fallback instead of a cropped image. Without a span
/// the whole composite letterboxes uniformly into the window.
fn head_rects(heads: &Heads, span: Option<&Span>, ww: i32, wh: i32) -> Vec<(i32, i32, i32, i32)> {
    let n = heads.dims.len();
    if let Some(sp) = span {
        if (ww - sp.union.2).abs() <= 2 && (wh - sp.union.3).abs() <= 2 {
            return (0..n).map(|i| sp.rects.get(i).copied().unwrap_or((0, 0, 0, 0))).collect();
        }
    }
    let (cw, ch) = composite_extent(heads);
    let sc = ((ww as f64 / cw as f64).min(wh as f64 / ch as f64).max(0.001)) as f32;
    let vw = (cw as f32 * sc) as i32;
    let vh = (ch as f32 * sc) as i32;
    let bx = (ww - vw) / 2;
    let by = (wh - vh) / 2;
    (0..n).map(|i| {
        let (ox, oy) = head_offset(heads, i);
        let d = &heads.dims[i];
        (bx + (ox as f32 * sc) as i32, by + (oy as f32 * sc) as i32,
         (d.w.load(Ordering::Relaxed) as f32 * sc) as i32,
         (d.h.load(Ordering::Relaxed) as f32 * sc) as i32)
    }).collect()
}

/// _NET_WM_FULLSCREEN_MONITORS = [top, bottom, left, right] bounding
/// monitors as XINERAMA indices — match our absolute span rects against
/// XineramaQueryScreens geometry (exact match, else nearest center).
fn fullscreen_monitor_indices(dpy: *mut std::ffi::c_void,
                              rects: &[(i32, i32, i32, i32)]) -> Option<[u32; 4]> {
    let lib = unsafe { libloading::Library::new("libXinerama.so.1") }.ok()?;
    let qs: XineramaQueryScreensFn = unsafe {
        *lib.get::<XineramaQueryScreensFn>(b"XineramaQueryScreens").ok()?
    };
    let mut n = 0i32;
    let screens_ptr = unsafe { qs(dpy, &mut n) };
    if screens_ptr.is_null() || n <= 0 { return None; }
    let screens: Vec<(i32, i32, i32, i32)> = (0..n).map(|i| {
        let q = unsafe { &*screens_ptr.add(i as usize) };
        (q.x as i32, q.y as i32, q.w as i32, q.h as i32)
    }).collect();
    unsafe { XFree(screens_ptr.cast()); }
    let idx_of = |r: &(i32, i32, i32, i32)| -> u32 {
        if let Some((i, _)) = screens.iter().enumerate().find(|(_, s)| *s == r) {
            return i as u32;
        }
        let (cx, cy) = (r.0 + r.2 / 2, r.1 + r.3 / 2);
        screens.iter().enumerate()
            .min_by_key(|(_, s)| {
                let dx = s.0 + s.2 / 2 - cx;
                let dy = s.1 + s.3 / 2 - cy;
                dx * dx + dy * dy
            })
            .map(|(i, _)| i as u32).unwrap_or(0)
    };
    let mut fsm = [0u32; 4];
    let (mut ty, mut by, mut lx, mut rx) = (i32::MAX, i32::MIN, i32::MAX, i32::MIN);
    for r in rects {
        let i = idx_of(r);
        if r.1 < ty { ty = r.1; fsm[0] = i; }
        if r.1 + r.3 > by { by = r.1 + r.3; fsm[1] = i; }
        if r.0 < lx { lx = r.0; fsm[2] = i; }
        if r.0 + r.2 > rx { rx = r.0 + r.2; fsm[3] = i; }
    }
    Some(fsm)
}

/// True once a WM has managed the window — WM_STATE appears at manage
/// time (ICCCM). Gating property writes on this keeps hints off the
/// manage() path, where KWin 5.27 crashes evaluating them.
fn wm_managed(d: *mut std::ffi::c_void, xid: u64, wm_state: u64) -> bool {
    unsafe {
        let mut t = 0u64; let mut f = 0i32; let mut n = 0u64; let mut b = 0u64;
        let mut p: *mut u8 = std::ptr::null_mut();
        // len=0 reads no data — existence shows up in actual_type, not
        // nitems (absent property → actual_type None / t=0)
        let ok = XGetWindowProperty(d, xid, wm_state, 0, 0, 0, 0,
            &mut t, &mut f, &mut n, &mut b, &mut p);
        if !p.is_null() { XFree(p.cast()); }
        ok == 0 && t != 0
    }
}

/// Write _NET_WM_FULLSCREEN_MONITORS = [top,bottom,left,right] xinerama
/// indices. Dormant until the WM evaluates a fullscreen transition —
/// that's the session's job (wmctrl path), never ours: requesting
/// fullscreen ourselves at map time crashes KWin in manage().
fn set_fullscreen_monitors(d: *mut std::ffi::c_void, xid: u64, fsm: &[u32; 4]) {
    const XA_CARDINAL: u64 = 6;
    unsafe {
        XChangeProperty(d, xid,
            XInternAtom(d, c"_NET_WM_FULLSCREEN_MONITORS".as_ptr().cast(), 0),
            XA_CARDINAL, 32, 0, fsm.as_ptr() as *const u8, 4);
        XFlush(d);
    }
}

/// query-mice → (relative handler index, absolute handler index). QEMU
/// keeps ONE active pointer handler per console: absolute events route
/// to the first ABS-masking handler (the virtio tablet), relative to
/// the first REL one (the PS/2 mouse) — and the D-Bus Mouse methods are
/// gated on which is "current". Field-by-field parse: the reply is a
/// flat [{name,index,current,absolute}] — good enough without a json dep.
fn mouse_indices(monitor: &str) -> (Option<i64>, Option<i64>) {
    let Ok(r) = ddproto::qmp_run(monitor, r#"{"execute":"query-mice"}"#) else { return (None, None) };
    let (mut rel, mut abs) = (None, None);
    for obj in r.split('{').skip(1) {
        let idx = obj.find("\"index\":").and_then(|i| {
            obj[i + 8..].trim_start().chars().take_while(|c| c.is_ascii_digit())
                .collect::<String>().parse::<i64>().ok()
        });
        let is_abs = obj.find("\"absolute\":")
            .map(|i| obj[i + 11..].trim_start().starts_with("true"));
        if let (Some(i), Some(a)) = (idx, is_abs) {
            if a { abs = Some(i) } else { rel = Some(i) }
        }
    }
    (rel, abs)
}

/// Flip QEMU's active pointer handler — `mouse_set` exists only as an
/// HMP command, invoked over QMP's human-monitor-command. rel → PS/2
/// (RelMotion accepted, SetAbsPosition rejected), abs → tablet (inverse).
fn mouse_set(monitor: &str, rel: bool) -> Result<()> {
    let (ri, ai) = mouse_indices(monitor);
    let idx = (if rel { ri } else { ai }).ok_or_else(|| anyhow::anyhow!(
        "no {} mouse handler in query-mice", if rel { "relative" } else { "absolute" }))?;
    let r = ddproto::qmp_run(monitor, &format!(
        r#"{{"execute":"human-monitor-command","arguments":{{"command-line":"mouse_set {idx}"}}}}"#))?;
    anyhow::ensure!(!r.contains("\"error\""), "mouse_set {idx}: {r}");
    Ok(())
}

/// One input worker for all consoles — QEMU's @dbus-display keeps a single
/// client channel, so every console's Keyboard/Mouse calls multiplex over
/// it. Keys always ride console 0's proxy (one physical keyboard in the
/// guest); pointer events go to the console the pointer is over. Also
/// owns the absolute↔relative handler flips (In::Mode) — a virtio-input
/// device activating during guest boot can steal the head handler back,
/// so a call that fails on mode grounds re-asserts the wanted mode.
fn input_worker(conn: std::sync::Arc<zbus::blocking::Connection>,
                paths: Vec<String>, rx: std::sync::mpsc::Receiver<In>, monitor: String) {
    let kbds: Vec<_> = paths.iter().map(|p|
        zbus::blocking::Proxy::new(&conn, "org.qemu", p.as_str(),
            "org.qemu.Display1.Keyboard").expect("kbd proxy")).collect();
    let mice: Vec<_> = paths.iter().map(|p|
        zbus::blocking::Proxy::new(&conn, "org.qemu", p.as_str(),
            "org.qemu.Display1.Mouse").expect("mouse proxy")).collect();
    let mut moves = 0u64;
    let mut want_rel = false;
    let mut last_mode_set = std::time::Instant::now() - std::time::Duration::from_secs(1);
    while let Ok(ev) = rx.recv() {
        if let In::Mode(rel) = ev {
            want_rel = rel;
            match mouse_set(&monitor, rel) {
                Ok(()) => eprintln!("[input] mouse mode → {}", if rel { "relative" } else { "absolute" }),
                Err(e) => eprintln!("[input] mouse_set({rel}) failed: {e:#}"),
            }
            last_mode_set = std::time::Instant::now();
            continue;
        }
        let r: Result<(), zbus::Error> = (|| match ev {
            In::Move(ci, x, y) => {
                moves += 1;
                if moves % 100 == 1 { eprintln!("[input] move#{moves} console={ci} guest={x},{y}"); }
                match mice.get(ci) {
                    Some(m) => m.call::<_, _, ()>("SetAbsPosition", &(x, y)),
                    None => Ok(()),
                }
            }
            In::Rel(dx, dy) => mice[0].call::<_, _, ()>("RelMotion", &(dx, dy)),
            In::Btn(ci, b, d) => match mice.get(ci) {
                Some(m) => m.call::<_, _, ()>(if d { "Press" } else { "Release" }, &(b as u32,)),
                None => Ok(()),
            },
            In::Key(k, d) => kbds[0].call::<_, _, ()>(if d { "Press" } else { "Release" }, &(k,)),
            In::Mode(_) => unreachable!(),
        })();
        if let Err(e) = r {
            match &e {
                // connection-level death (VM exit/restart) — the frozen
                // window outlives nothing; die rather than sit zombie.
                zbus::Error::InputOutput(_) | zbus::Error::Connection(..) => {
                    eprintln!("[input] channel lost ({e}) — exiting");
                    std::process::exit(1);
                }
                // transient call errors (e.g. "Mouse is not absolute" while
                // the BIOS owns the console) — drop the event, keep going.
                // A mode-mismatch error also means the active handler
                // flipped underneath us → re-assert the wanted mode
                // (throttled — a failing stream must not spin QMP conns).
                _ => {
                    static IN_ERRS: AtomicU64 = AtomicU64::new(0);
                    let n = IN_ERRS.fetch_add(1, Ordering::Relaxed) + 1;
                    if n % 50 == 1 { eprintln!("[input] call failed x{n}: {e}"); }
                    let msg = e.to_string();
                    if (msg.contains("not absolute") || msg.contains("not relative"))
                        && last_mode_set.elapsed().as_millis() > 400 {
                        last_mode_set = std::time::Instant::now();
                        match mouse_set(&monitor, want_rel) {
                            Ok(()) => eprintln!("[input] mouse mode re-asserted → {}",
                                if want_rel { "relative" } else { "absolute" }),
                            Err(e) => eprintln!("[input] mouse re-assert failed: {e:#}"),
                        }
                    }
                }
            }
        }
    }
}

/// spec.display.pointerLock → when to run relative pointer capture.
/// 'auto' engages when the guest hides its cursor while focused (the
/// pointer-lock signature); 'always' while focused; 'off' never.
#[derive(Clone, Copy, PartialEq)]
enum RelMode { Off, Auto, Always }

/// THE window — every guest console renders into its rect of this one
/// surface (a monitor rect in span mode, a slice of the letterboxed
/// composite in windowed mode). One focus domain, one grab pair, one
/// escape state.
#[allow(clippy::too_many_arguments)]
fn present_window(iconn: std::sync::Arc<zbus::blocking::Connection>,
                  console_paths: Vec<String>, title: &str, mut w: usize, mut h: usize,
                  jrx: std::sync::mpsc::Receiver<XJob>,
                  jtx: std::sync::mpsc::Sender<XJob>,
                  crx: std::sync::mpsc::Receiver<CurJob>,
                  heads: std::sync::Arc<Heads>, span: Option<Span>,
                  esc: std::sync::Arc<EscState>, rel_mode: RelMode,
                  monitor: String) -> Result<()> {
    use minifb::{Window, WindowOptions};
    let nheads = console_paths.len();
    let span = span.map(std::sync::Arc::new);
    if let Some(sp) = &span {
        w = sp.union.2.max(1) as usize;
        h = sp.union.3.max(1) as usize;
    }
    let mut win = Window::new(title, w, h, WindowOptions { resize: true, ..WindowOptions::default() })?;
    win.set_target_fps(500);

    // persistent X conn: EWMH identity sets at init, then polled for the
    // host's NumLock state in the event loop (see below)
    let mut xdpy: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut num_atom = 0u64;
    let mut wm_state_atom = 0u64;
    // _NET_WM_FULLSCREEN_MONITORS payload, written once the WM manages us
    let mut fsm_pending: Option<[u32; 4]> = None;
    // _NET_WM_BYPASS_COMPOSITOR — lets KWin unredirect the span window and
    // scan it out directly, skipping a compositor pass. Only meaningful in
    // --rects span mode; written with the same WM_STATE gating as the
    // fullscreen-monitors hint.
    let mut bypass_pending = span.is_some();
    let xwin_id;

    // GL worker owns the EGL context — all device calls are single-threaded
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let wh = win.window_handle().unwrap();
        if let RawWindowHandle::Xlib(xw) = wh.as_raw() {
            let xid = xw.window;
            xwin_id = xid;
            // EWMH identity: minifb never sets WM_CLASS or _NET_WM_PID, which
            // leaves the heads invisible to pid/class lookups (wmctrl -p,
            // xdotool --pid, KWin wmclass rules). A second X connection is
            // fine — property sets are server-side.
            unsafe {
                let d = XOpenDisplay(std::ptr::null());
                if !d.is_null() {
                    const XA_CARDINAL: u64 = 6;
                    const XA_STRING: u64 = 31;
                    const PROP_MODE_REPLACE: i32 = 0;
                    let pid = std::process::id();
                    XChangeProperty(d, xid,
                        XInternAtom(d, c"_NET_WM_PID".as_ptr().cast(), 0), XA_CARDINAL,
                        32, PROP_MODE_REPLACE, &pid as *const u32 as *const u8, 1);
                    const CLS: &[u8] = b"cruiser-dd\0cruiser-dd\0";
                    XChangeProperty(d, xid,
                        XInternAtom(d, c"WM_CLASS".as_ptr().cast(), 0), XA_STRING,
                        8, PROP_MODE_REPLACE, CLS.as_ptr(), CLS.len() as i32);
                    num_atom = XInternAtom(d, c"Num Lock".as_ptr().cast(), 0);
                    wm_state_atom = XInternAtom(d, c"WM_STATE".as_ptr().cast(), 0);
                    // Span placement (--rects): cover the union of picked
                    // monitors. The monitors hint is written LATER — once
                    // WM_STATE exists (see the event loop): a window born
                    // carrying _NET_WM_FULLSCREEN_MONITORS + a fullscreen
                    // state request crashes KWin 5.27 evaluating the
                    // xinerama topology inside manage()/adoption (observed
                    // 4x SIGSEGV loop until the window died). We never
                    // request fullscreen ourselves — the session's wmctrl
                    // toggle evaluates the dormant hint, freerdp-style.
                    if let Some(sp) = &span {
                        XMoveResizeWindow(d, xid, sp.union.0, sp.union.1,
                            sp.union.2 as u32, sp.union.3 as u32);
                        if sp.abs.len() > 1 {
                            fsm_pending = fullscreen_monitor_indices(d, &sp.abs);
                        }
                    }
                    // THE input path: raw keycodes selected on our own
                    // window. Focused-ungrabbed → delivered via this
                    // selection; grabbed → delivered to us as the grabbing
                    // client; unfocused → nothing (escape combos arrive via
                    // the root passive grabs below). minifb's callback path
                    // is unused — keysym translation is lossy (Backquote
                    // was missing entirely); keycodes are physical
                    // positions, exactly what QEMU's qnum expects. KEYS
                    // ONLY: ButtonPressMask is exclusive per window and
                    // minifb's conn already owns it — adding it here fails
                    // the whole select with BadAccess and blinds the grab
                    // path too (grab delivery still consults the mask).
                    // Buttons ride the pointer grab while grabbed; while
                    // ungrabbed L/M/R + wheel are minifb-polled and nav
                    // buttons 8/9 arrive via passive grabs (below).
                    // + Exposure|VisibilityChange|StructureNotify: a VD
                    // switch unmaps us and the remapped window needs a
                    // repaint kick (damage-driven presents never fire on
                    // their own) — the drain turns those into XJob::Repaint.
                    XSelectInput(d, xid, 0x38003); // Key|Exposure|Visibility|StructureNotify
                    XFlush(d);
                    xdpy = d;
                }
            }
            let t = title.to_string();
            let gh = heads.clone();
            let gspan = span.clone();
            std::thread::spawn(move || {
                let mut xegl = match egl::x11_present_init(xid, w as i32, h as i32, nheads) {
                    Ok(e) => e,
                    Err(e) => { eprintln!("[xegl] init failed: {e:#}"); return; }
                };
                eprintln!("[xegl] worker ready ({t})");
                let mut fps_n = 0u64;
                let mut fps_t = std::time::Instant::now();
                // newest scanout per console — one slot for both kinds so a
                // mid-run mode switch (VGA cpu → virtio-gpu dmabuf) applies
                // in wire order; coalescing collapses nudges and supersedes
                // stale scanouts so one redraw+swap serves all heads
                enum HeadSrc { Dmabuf(ScanFd), Cpu(CpuScan) }
                let mut latest: Vec<Option<HeadSrc>> = (0..nheads).map(|_| None).collect();
                // per-console damage queue in scanout px — merged/capped by add_rect
                let mut damage: Vec<Vec<WRect>> = (0..nheads).map(|_| Vec::new()).collect();
                // cpu-scanout damage needing a pixel re-upload — drained
                // after `latest` so a fresh scanout's texture exists first
                let mut cpu_dmg: Vec<CpuDmg> = Vec::new();
                let mut last_ext: Option<(i64, i64)> = None;
                let mut last_geom = (0i32, 0i32);
                let mut last_swap = std::time::Instant::now() - std::time::Duration::from_secs(1);
                // window-space damage of recent swaps — buffer-age partial repaints
                let mut hist: std::collections::VecDeque<Vec<WRect>> =
                    std::collections::VecDeque::new();
                // remap/expose → full repaint next present (see XJob::Repaint)
                let mut force_full = false;
                let pump = |first: Option<XJob>,
                                latest: &mut Vec<Option<HeadSrc>>,
                                damage: &mut Vec<Vec<WRect>>,
                                cpu_dmg: &mut Vec<CpuDmg>,
                                force_full: &mut bool| {
                    for j in first.into_iter().chain(std::iter::from_fn(|| jrx.try_recv().ok())) {
                        match j {
                            XJob::Fd(s) => {
                                if s.ci < nheads {
                                    // the whole image is replaced
                                    let iw = gh.dims[s.ci].w.load(Ordering::Relaxed)
                                        .min(i32::MAX as u64).max(1) as i32;
                                    let ih = gh.dims[s.ci].h.load(Ordering::Relaxed)
                                        .min(i32::MAX as u64).max(1) as i32;
                                    add_rect(&mut damage[s.ci], (0, 0, iw, ih));
                                    let ci = s.ci;
                                    latest[ci] = Some(HeadSrc::Dmabuf(s));
                                }
                            }
                            XJob::Cpu(s) => {
                                if s.ci < nheads {
                                    let iw = gh.dims[s.ci].w.load(Ordering::Relaxed)
                                        .min(i32::MAX as u64).max(1) as i32;
                                    let ih = gh.dims[s.ci].h.load(Ordering::Relaxed)
                                        .min(i32::MAX as u64).max(1) as i32;
                                    add_rect(&mut damage[s.ci], (0, 0, iw, ih));
                                    let ci = s.ci;
                                    latest[ci] = Some(HeadSrc::Cpu(s));
                                }
                            }
                            XJob::CpuDamage(d) => {
                                if d.ci < nheads {
                                    add_rect(&mut damage[d.ci], (d.x, d.y, d.w, d.h));
                                    cpu_dmg.push(d);
                                }
                            }
                            XJob::Nudge(ci, x, y, w, h) => {
                                if ci < nheads { add_rect(&mut damage[ci], (x, y, w, h)); }
                            }
                            XJob::Repaint => *force_full = true,
                        }
                    }
                };
                let import_all = |latest: &mut Vec<Option<HeadSrc>>,
                                      xegl: &mut egl::XEgl| -> bool {
                    let mut imported = false;
                    for (ci, slot) in latest.iter_mut().enumerate() {
                        let r = match slot.take() {
                            Some(HeadSrc::Dmabuf(s)) => egl::x11_import(xegl, ci,
                                s.fd.as_raw_fd(), s.x, s.y, s.w, s.h, s.poff,
                                s.stride, s.fourcc, s.bw, s.bh, s.modifier, s.y0_top),
                            Some(HeadSrc::Cpu(s)) => match s.src {
                                CpuSrc::Pixels(px) => egl::x11_cpu_upload(xegl, ci,
                                    Some(&px), None, s.w, s.h, s.stride, s.fmt),
                                CpuSrc::Mapped(fd, off) => egl::x11_cpu_upload(xegl, ci,
                                    None, Some((fd.as_raw_fd(), off)),
                                    s.w, s.h, s.stride, s.fmt),
                            },
                            None => continue,
                        };
                        if let Err(e) = r {
                            static XF: AtomicU64 = AtomicU64::new(0);
                            let n = XF.fetch_add(1, Ordering::Relaxed) + 1;
                            if n % 120 == 1 { eprintln!("[xegl] import failed x{n}: {e:#}"); }
                        }
                        imported = true;
                    }
                    imported
                };
                let apply_cpu_dmg = |cpu_dmg: &mut Vec<CpuDmg>, xegl: &mut egl::XEgl| {
                    for d in cpu_dmg.drain(..) {
                        if let Err(e) = egl::x11_cpu_update(xegl, d.ci, d.x, d.y,
                            d.w, d.h, d.stride, d.fmt, d.data.as_deref()) {
                            static CU: AtomicU64 = AtomicU64::new(0);
                            let n = CU.fetch_add(1, Ordering::Relaxed) + 1;
                            if n % 120 == 1 { eprintln!("[xegl] cpu update failed x{n}: {e:#}"); }
                        }
                    }
                };
                while let Ok(first) = jrx.recv() {
                    fps_n += 1;
                    if fps_t.elapsed().as_secs() >= 5 {
                        // fd telemetry: QEMU ships a dma-buf fd per frame —
                        // a leak in the import chain surfaces here (self) or
                        // system-wide (file-nr; kernel-pinned dma-buf/sync_file
                        // structs don't show in any /proc/<pid>/fd).
                        let fds = std::fs::read_dir("/proc/self/fd")
                            .map(|d| d.count()).unwrap_or(0);
                        let fnr = std::fs::read_to_string("/proc/sys/fs/file-nr")
                            .ok()
                            .and_then(|s| s.split_whitespace().next().map(str::to_owned))
                            .unwrap_or_else(|| "?".into());
                        eprintln!("[fps] {t}: {} frames/{:.0}s fds={fds} file-nr={fnr}",
                            fps_n, fps_t.elapsed().as_secs_f32());
                        fps_n = 0; fps_t = std::time::Instant::now();
                    }
                    // drain the burst — QEMU emits one UpdateDMABUF call per
                    // damage rect, serialized by its guest-side gl-block
                    pump(Some(first), &mut latest, &mut damage, &mut cpu_dmg,
                         &mut force_full);
                    let mut imported = import_all(&mut latest, &mut xegl);
                    apply_cpu_dmg(&mut cpu_dmg, &mut xegl);
                    // windowed single-head: track the guest resolution like
                    // the old per-console windows did — spans are
                    // monitor-locked and multi-head windowed letterboxes.
                    if gspan.is_none() && nheads == 1 && imported {
                        let ext = composite_extent(&gh);
                        if last_ext != Some(ext) {
                            last_ext = Some(ext);
                            egl::x11_resize(&xegl, ext.0.max(1) as u32, ext.1.max(1) as u32);
                        }
                    }
                    let dirty = force_full || damage.iter().any(|d| !d.is_empty());
                    if dirty {
                        // ~166Hz present cap: QEMU serializes a frame's damage
                        // rects over separate calls — absorbing stragglers here
                        // turns the burst into one present and bounds the swap
                        // rate. Imports stay eager; only the swap is paced.
                        const PACE: std::time::Duration = std::time::Duration::from_millis(6);
                        if let Some(rem) = PACE.checked_sub(last_swap.elapsed()) {
                            if !rem.is_zero() {
                                std::thread::sleep(rem);
                                pump(None, &mut latest, &mut damage, &mut cpu_dmg,
                                     &mut force_full);
                                imported = import_all(&mut latest, &mut xegl) || imported;
                                apply_cpu_dmg(&mut cpu_dmg, &mut xegl);
                            }
                        }
                        let (ww, wh) = egl::x11_geom(&xegl);
                        // a remap drops the presented image entirely — run
                        // the same full-repaint path as a resize
                        let resized = (ww, wh) != last_geom || std::mem::take(&mut force_full);
                        last_geom = (ww, wh);
                        let rects = head_rects(&gh, gspan.as_deref(), ww, wh);
                        // scanout-px damage → window px through the same
                        // letterbox math the draw/input map use
                        let mut dmg: Vec<WRect> = Vec::new();
                        if !resized {
                            for (ci, ds) in damage.iter_mut().enumerate() {
                                let Some(&(rx, ry, rw, rh)) = rects.get(ci) else { continue };
                                let iw = (gh.dims[ci].w.load(Ordering::Relaxed) as i32).max(1);
                                let ih = (gh.dims[ci].h.load(Ordering::Relaxed) as i32).max(1);
                                let (vx, vy, vw, vh) = egl::fit_viewport(
                                    rw.max(1) as u32, rh.max(1) as u32, iw, ih);
                                for &(x, y, w, h) in ds.iter() {
                                    let x = x.clamp(0, iw); let y = y.clamp(0, ih);
                                    let w = w.min(iw); let h = h.min(ih);
                                    let dx0 = rx + vx - 1 + (x as i64 * vw as i64 / iw as i64) as i32;
                                    let dy0 = ry + vy - 1 + (y as i64 * vh as i64 / ih as i64) as i32;
                                    let dx1 = rx + vx + 1 + (((x as i64 + w as i64) * vw as i64
                                        + iw as i64 - 1) / iw as i64) as i32;
                                    let dy1 = ry + vy + 1 + (((y as i64 + h as i64) * vh as i64
                                        + ih as i64 - 1) / ih as i64) as i32;
                                    let (cx0, cy0) = (dx0.max(0), dy0.max(0));
                                    let (cx1, cy1) = (dx1.min(ww), dy1.min(wh));
                                    if cx1 > cx0 && cy1 > cy0 {
                                        dmg.push((cx0, cy0, cx1 - cx0, cy1 - cy0));
                                    }
                                }
                            }
                        }
                        for ds in damage.iter_mut() { ds.clear(); }
                        if dmg.is_empty() { dmg.push((0, 0, ww, wh)); }
                        // buffer-age partial repaint: the back buffer is `age`
                        // swaps old, so it needs the union of that many
                        // frames' damage re-rasterized. Unsupported/unknown
                        // age or a resize → full repaint.
                        let need: Vec<WRect> = if resized { Vec::new() } else {
                            match egl::x11_buffer_age(&xegl) {
                                Some(age) if age >= 1
                                    && (age as usize) <= hist.len() + 1 => {
                                    let mut need = dmg.clone();
                                    for past in hist.iter().rev().take(age as usize - 1) {
                                        for &r in past { add_rect(&mut need, r); }
                                    }
                                    need
                                }
                                _ => Vec::new(),
                            }
                        };
                        if let Err(e) = egl::x11_redraw(&mut xegl, &rects, (ww, wh), &need, &dmg) {
                            static XF2: AtomicU64 = AtomicU64::new(0);
                            let n = XF2.fetch_add(1, Ordering::Relaxed) + 1;
                            if n % 120 == 1 { eprintln!("[xegl] redraw failed x{n}: {e:#}"); }
                        }
                        hist.push_back(dmg);
                        if hist.len() > 4 { hist.pop_front(); }
                        last_swap = std::time::Instant::now();
                    }
                }
            });
        } else {
            anyhow::bail!("viewer-dd currently requires an X11 window");
        }
    }

    // input events ride the shared channel — QEMU's @dbus-display only
    // keeps one client connection alive, extra add_client channels get
    // EPIPE'd at the p2p handshake
    let (itx, irx) = std::sync::mpsc::channel::<In>();
    {
        let ic2 = iconn.clone();
        let paths = console_paths.clone();
        std::thread::spawn(move || input_worker(ic2, paths, irx, monitor));
    }

    let mut mouse = (-1.0f32, -1.0f32);
    let mut last_pos_send = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let mut pending_abs: Option<(f32, f32)> = None;
    // console under the pointer — button events follow it even when no
    // position change is pending (all consoles share the virtio tablet,
    // so this picks the D-Bus object, not the device)
    let mut cur_ci = 0usize;
    // guest-button ids currently held (→ the console they went down on) —
    // released on focus loss, same as `pressed` for keys (a release the
    // guest never sees = phantom drag)
    let mut btns_down = std::collections::HashMap::<u8, usize>::new();
    // minifb's own reported button state — the ungrabbed poll diffs against
    // this (NOT btns_down): a grab-path release leaves minifb's state stale
    // until its conn sees a real event, and diffing that against guest
    // state would phantom-repress on ungrab.
    let mut mbtns = [false; 3];
    let mut scroll_acc = 0.0f32;

    // window px → guest SetAbsPosition units: find the head rect under the
    // pointer (nearest wins in dead space — letterbox gaps, unmonitored
    // union area), inverse its letterbox to console-local px, then rescale
    // to composite fraction × console size: qemu scales SetAbsPosition over
    // the console's surface, but the guest maps the single virtio tablet's
    // 0..0x7fff range over the WHOLE composite, so sending (ox+lx)*iw/W
    // makes the emitted fraction land on the right composite point.
    let to_guest = |win: &minifb::Window, mx: f32, my: f32| -> (usize, u32, u32) {
        let (ww, wh) = win.get_size();
        let rects = head_rects(&heads, span.as_deref(), ww as i32, wh as i32);
        if rects.is_empty() { return (0, 0, 0); }
        let mut best = 0usize;
        let mut bestd = f32::MAX;
        for (i, &(rx, ry, rw, rh)) in rects.iter().enumerate() {
            let dx = if mx < rx as f32 { rx as f32 - mx }
                else if mx > (rx + rw) as f32 { mx - (rx + rw) as f32 } else { 0.0 };
            let dy = if my < ry as f32 { ry as f32 - my }
                else if my > (ry + rh) as f32 { my - (ry + rh) as f32 } else { 0.0 };
            let d = dx * dx + dy * dy;
            if d < bestd { bestd = d; best = i; }
        }
        let (rx, ry, rw, rh) = rects[best];
        // a console with no scanout yet reports dims 0 — clamp would panic
        // on max < min, so floor the image size at 1 (guest sees 0,0)
        let iw = (heads.dims[best].w.load(Ordering::Relaxed) as i32).max(1);
        let ih = (heads.dims[best].h.load(Ordering::Relaxed) as i32).max(1);
        let (vx, vy, vw, vh) = egl::fit_viewport(rw.max(1) as u32, rh.max(1) as u32, iw, ih);
        let lx = ((mx - (rx + vx) as f32) / vw as f32 * iw as f32).clamp(0.0, iw as f32 - 1.0);
        let ly = ((my - (ry + vy) as f32) / vh as f32 * ih as f32).clamp(0.0, ih as f32 - 1.0);
        let (ox, oy) = head_offset(&heads, best);
        let (cw_total, ch_total) = composite_extent(&heads);
        let gx = ((ox as f32 + lx) * iw as f32 / cw_total as f32)
            .clamp(0.0, iw as f32 - 1.0);
        let gy = ((oy as f32 + ly) * ih as f32 / ch_total as f32)
            .clamp(0.0, ih as f32 - 1.0);
        (best, gx as u32, gy as u32)
    };

    // qnums the guest currently believes are held — drained into key-up
    // events on focus loss so the release half of a combo the WM consumed
    // (alt-tab et al.) can't leave a modifier stuck down in the guest.
    // Fed by the raw keycode path in the event drain below.
    let mut pressed = std::collections::HashSet::<u32>::new();
    // Escape-trigger keycodes whose press fired a combo — their release (and
    // autorepeat re-presses) are swallowed instead of forwarded. Cleared on
    // focus loss, else a release landing outside the window (VD switch
    // steals focus mid-combo) leaves the trigger dead forever.
    let mut swallowed = std::collections::HashSet::<u32>::new();
    // Buttons consumed inside the window while pointer-grabbed — their
    // releases belong to the guest even if the pointer left the window.
    let mut captured_btns = std::collections::HashSet::<u32>::new();

    // numlock reconcile — guest lock state is exposed as the Keyboard
    // "Modifiers" property (Scroll|Num|Caps = bits 0|1|2). NumLock presses
    // while focused ride the normal key path, but toggles made while
    // unfocused (and the guest's boot default) never reach the guest, so
    // poll host XKB state vs the property and inject a NumLock pulse when
    // they diverge. Console 0's keyboard object — NumLock is guest-global.
    let kbd_iface = zbus::blocking::Proxy::new(&iconn, "org.qemu",
        console_paths.first().map(String::as_str).unwrap_or(""),
        "org.qemu.Display1.Keyboard").ok();
    let mut last_num_sync = std::time::Instant::now() - std::time::Duration::from_secs(1);

    // Host-wide passive grabs for the escape combos — the same mechanism
    // global hotkeys use, so combos fire while the VM isn't focused (and
    // while focused-but-ungrabbed, where the passive grab consumes the
    // trigger before it reaches the window — never double-firing with the
    // active-grab path, which shadows passive grabs entirely). Four
    // registrations per combo cover numlock/capslock (LockMask|Mod2Mask)
    // states. A combo already grabbed by the WM loses with an async
    // BadAccess — logged, not fatal.
    if !xdpy.is_null() && !esc.combos.is_empty() {
        unsafe {
            let root = XRootWindow(xdpy, 0);
            XSelectInput(xdpy, root, 0x3);
            for c in &esc.combos {
                for lock in [0u32, 2, 16, 18] {
                    XGrabKey(xdpy, c.xkey as i32, c.xmods | lock, root, 0, 0, 0);
                }
            }
            XFlush(xdpy);
        }
    }
    // Passive grabs on buttons 8/9 (nav back/forward). Ungrabbed button
    // delivery belongs to minifb's conn (exclusive ButtonPressMask) and
    // minifb's MouseButton enum stops at L/M/R — without these grabs the
    // nav buttons are invisible in the default mode. A passive grab needs
    // no window mask: it activates on a press inside xwin (any modifier
    // state) and the press + release deliver to this conn exactly like an
    // active grab's events. While --grab/capture holds the pointer the
    // device is already grabbed, so these can never double-deliver.
    if !xdpy.is_null() {
        unsafe {
            for b in [8u32, 9] {
                // AnyModifier=1<<15, owner_events=0, Press|Release mask,
                // Async/Async — same constants as XGrabPointer below.
                XGrabButton(xdpy, b, 1 << 15, xwin_id, 0, 0xC, 1, 1, 0, 0);
            }
            XFlush(xdpy);
        }
    }
    // last fire time per passive-grab trigger — X autorepeat would otherwise
    // re-fire the action every repeat interval while the combo is held.
    let mut passive_last = std::collections::HashMap::<usize, std::time::Instant>::new();
    // Trigger keycodes still physically held after a passive-grab fire —
    // suppresses autorepeat re-fires until a real release. X emits repeats
    // either as press-only or as same-timestamp release+press pairs; the
    // release branch peeks for the pair so `held` survives fake releases.
    let mut passive_held = std::collections::HashSet::<u32>::new();

    // Keyboard + pointer grabs (--grab = spec.display.grabKeyboard):
    // while the window is focused we hold an X11 keyboard grab — host-global
    // combos (alt-tab, super, …) reach the guest instead of the WM,
    // matching freerdp +grab-keyboard semantics. ALL device modes are
    // GrabModeAsync — an ACTIVE Sync grab freezes the device on the first
    // event and queues it undelivered (the deliver-frozen-then-decide
    // contract only applies to PASSIVE grab activation), so a Sync
    // XGrabKeyboard = dead keyboard and a Sync XGrabPointer = dead mouse.
    // The keyboard grab ALONE can't stop KWin's passive BUTTON grabs
    // (super+drag move fires on Mod4 in the core modifier state, whatever
    // owns the keys), so an Async pointer grab rides alongside — an
    // active grab still shadows every passive grab on the device.
    // In-window clicks are forwarded to the guest; a click outside drops
    // the pointer grab and re-injects the press via XTEST, so it reaches
    // its host target (focus move, WM passive grabs) as if we never held
    // it. Focus loss ungrabs both; `ungrab`/`abort` escapes hold the
    // grabs off until the focus cycles (abort also iconifies the window).
    let mut grabbed = false;
    let mut pgrabbed = false;
    let mut grab_hold_off = false;
    let mut grab_held_since: Option<std::time::Instant> = None;
    let mut seen_ungrab = 0u64;
    let mut seen_abort = 0u64;
    let mut last_grab_try = std::time::Instant::now() - std::time::Duration::from_secs(1);

    // ── relative pointer capture (spec.display.pointerLock / --relmouse) ──
    // QEMU keeps ONE active pointer handler per console — the virtio
    // tablet (absolute) owns it normally and RelMotion is rejected while
    // it does ("Mouse is not relative" ↔ "Mouse is not absolute"). An app
    // grabbing the guest pointer (games via pointer-constraints/XInput)
    // needs EV_REL deltas, so capture mode flips the active handler to
    // the PS/2 mouse (input worker's QMP mouse_set), feeds RelMotion
    // deltas, and confines the host pointer to the window. While the
    // guest keeps its cursor visible we shadow it: each mouse_set report
    // warps the host pointer to the guest's own cursor spot, so the
    // guest sprite (applied as the X cursor) sits where the guest thinks
    // the pointer is. Triggering: 'always' = while focused; 'auto' = the
    // guest had a visible cursor and now hides it AND the cursor stays
    // hidden through real pointer motion (a locked app's tell — a
    // terminal's hide-while-typing episode re-shows on the first wiggle,
    // so it never accrues the travel and never captures). EscAct::RelGrab
    // toggles a per-episode override; ungrab/abort and focus loss release.
    const HIDE_TRAVEL_PX: f32 = 160.0; // 'auto' motion gate — see above
    let mut captured = false;
    let mut rel_override: Option<bool> = None;
    let mut rel_hold_off = false;
    let mut seen_rel = 0u64;
    // Hold-CapsLock ≥5s = the ungrab escape — a hatch needing no combo,
    // only the focused key stream. A sub-threshold release is an
    // ordinary caps toggle forwarded to the guest like any key.
    const CAPS_HOLD_MS: u128 = 5000;
    let caps_xkey = xkey_for(0x3a); // CAPS_LOCK qnum — always Some
    let mut caps_down_at: Option<std::time::Instant> = None;
    let mut rel_last: Option<(f32, f32)> = None; // last pointer sample (delta baseline)
    let mut rel_acc = (0.0f32, 0.0f32);          // fractional deltas pending send
    let mut rel_send = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let mut cursor_visible = false;
    let mut cursor_ever_visible = false;
    let mut hide_travel = 0.0f32; // host-px accrued while the guest cursor is hidden

    // numlock reconcile guard: a NumLock press forwarded to the guest
    // flips host state instantly but the guest's LED report lags — a poll
    // inside that window would pulse a spurious second toggle and leave
    // host/guest permanently opposed. Suppress briefly after a forwarded
    // press, and require the mismatch to persist across two polls.
    let mut num_suppress_until = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let mut num_mismatch = 0u32;
    let mut num_diag = 0u32;

    // Guest-cursor state — see the apply block at the bottom of the loop.
    let mut cur_slots: Vec<CurSlot> = (0..nheads).map(|_| CurSlot::default()).collect();
    let mut cur_dirty = true;
    let mut cur_applied: Option<(usize, u64, bool, bool)> = None;
    let mut blank_xc = 0u64;

    while win.is_open() {
        win.update(); // events only — EGL renders into this window directly
        let active = win.is_active();
        if !active { grab_hold_off = false; rel_hold_off = false; rel_override = None; hide_travel = 0.0; caps_down_at = None; }
        if !xdpy.is_null() {
            if SIG_ABORT.swap(false, Ordering::Relaxed) {
                // panic path — needs no keyboard; the generation bump
                // runs the abort below
                esc.abort_gen.fetch_add(1, Ordering::Relaxed);
                eprintln!("[+{}s][grab] SIGUSR1 → abort ({title})", ts());
            }
            let ungrab_g = esc.ungrab_gen.load(Ordering::Relaxed);
            let abort_g = esc.abort_gen.load(Ordering::Relaxed);
            let abort = abort_g != seen_abort;
            if ungrab_g != seen_ungrab || abort {
                seen_ungrab = ungrab_g;
                seen_abort = abort_g;
                grab_hold_off = true;
                rel_hold_off = true;
                rel_override = None;
                grab_held_since = None;
                if pgrabbed {
                    unsafe { XUngrabPointer(xdpy, 0); }
                    pgrabbed = false;
                    captured_btns.clear();
                }
                if grabbed {
                    unsafe { XUngrabKeyboard(xdpy, 0); XFlush(xdpy); }
                    grabbed = false;
                }
                eprintln!("[+{}s][grab] ungrabbed via escape ({title}) — re-grabs on refocus", ts());
            }
            if abort {
                unsafe { XIconifyWindow(xdpy, xwin_id, 0); XFlush(xdpy); }
                eprintln!("[+{}s][grab] abort — iconified ({title})", ts());
            }
            // Write the monitors/bypass hints only once managed — KWin reads
            // them at the session's setFullscreen transition, same as freerdp.
            // Give up after ~10s of WM_STATE absence (no WM → the hints are
            // useless anyway and the X roundtrip per loop is waste).
            if (fsm_pending.is_some() || bypass_pending)
                && wm_managed(xdpy, xwin_id, wm_state_atom) {
                if let Some(fsm) = fsm_pending.take() {
                    set_fullscreen_monitors(xdpy, xwin_id, &fsm);
                    eprintln!("[+{}s][xegl] fullscreen-monitors hint set ({title})", ts());
                }
                if bypass_pending {
                    bypass_pending = false;
                    unsafe {
                        const XA_CARDINAL: u64 = 6;
                        let bypass = 1u32;
                        XChangeProperty(xdpy, xwin_id,
                            XInternAtom(xdpy, c"_NET_WM_BYPASS_COMPOSITOR".as_ptr().cast(), 0),
                            XA_CARDINAL, 32, 0, &bypass as *const u32 as *const u8, 1);
                        XFlush(xdpy);
                    }
                    eprintln!("[+{}s][xegl] bypass-compositor hint set ({title})", ts());
                }
            } else if (fsm_pending.is_some() || bypass_pending) && ts() > 10 {
                fsm_pending = None;
                bypass_pending = false;
            }
        }
        if esc.enabled && !xdpy.is_null() {
            if grabbed && grab_held_since.map_or(false, |t| t.elapsed().as_secs() > 60) {
                // HARD CAP: bound how long a wedged grab can steal the host
                // keyboard — release, then the normal path re-grabs on the
                // next tick if the window is still focused. A healthy grab
                // sees a sub-second heartbeat gap once a minute; a dead
                // one can never strand host input longer than 60s.
                if pgrabbed { unsafe { XUngrabPointer(xdpy, 0); } pgrabbed = false; captured_btns.clear(); }
                unsafe { XUngrabKeyboard(xdpy, 0); XFlush(xdpy); }
                grabbed = false;
                grab_held_since = None;
                eprintln!("[+{}s][grab] 60s hold cap — released, re-grabbing if focused ({title})", ts());
            }
            if active && !grabbed && !grab_hold_off && last_grab_try.elapsed().as_millis() > 500 {
                // retry while focused — a grab attempt loses to any
                // transient server grab (e.g. KWin's own alt-tab tabbox)
                last_grab_try = std::time::Instant::now();
                // pointer_mode + keyboard_mode BOTH Async — a Sync mode
                // queues all that device's events without delivering until
                // an XAllowEvents nobody sends → dead input under grab.
                grabbed = unsafe { XGrabKeyboard(xdpy, xwin_id, 0, 1, 1, 0) } == 0;
                if grabbed {
                    // Pointer grab, Async/Async: Sync pointer_mode would
                    // freeze the device on the first event and queue it
                    // WITHOUT delivering (inspect-then-replay only works on
                    // PASSIVE grab activation) — we learned that as a dead
                    // mouse. Async delivers every button event; an active
                    // grab still shadows the WM's passive Mod4+Button grabs
                    // (super+drag). Outside clicks are re-injected via XTEST
                    // (a real device event — KWin sees it normally) after
                    // dropping the grab, instead of ReplayPointer.
                    pgrabbed = unsafe { XGrabPointer(xdpy, xwin_id, 0, 0xC, 1, 1, 0, 0, 0) } == 0;
                    grab_held_since = Some(std::time::Instant::now());
                    eprintln!("[+{}s][grab] keyboard grabbed ({title}) pointer={pgrabbed}", ts());
                }
            } else if active && grabbed && !pgrabbed && last_grab_try.elapsed().as_millis() > 500 {
                // keyboard held but pointer grab lost (e.g. raced a popup)
                // — keep retrying on the same cadence
                last_grab_try = std::time::Instant::now();
                pgrabbed = unsafe { XGrabPointer(xdpy, xwin_id, 0, 0xC, 1, 1, 0, 0, 0) } == 0;
                if pgrabbed { eprintln!("[+{}s][grab] pointer grabbed ({title})", ts()); }
            } else if !active && (grabbed || pgrabbed) {
                if pgrabbed { unsafe { XUngrabPointer(xdpy, 0); } pgrabbed = false; captured_btns.clear(); }
                if grabbed { unsafe { XUngrabKeyboard(xdpy, 0); } grabbed = false; }
                grab_held_since = None;
                unsafe { XFlush(xdpy); }
                eprintln!("[+{}s][grab] ungrabbed ({title})", ts());
            }
        }
        // relgrab toggle — a per-episode manual override (cleared on
        // unfocus, and under 'auto' when the lock episode ends — see the
        // cursor-visibility bookkeeping in the cursor drain below)
        if !xdpy.is_null() {
            let rg = esc.rel_gen.load(Ordering::Relaxed);
            if rg != seen_rel {
                seen_rel = rg;
                rel_override = Some(!captured);
                eprintln!("[+{}s][rel] toggle → {} ({title})", ts(),
                    if captured { "release" } else { "capture" });
            }
        }
        // Hold-caps escape: ≥CAPS_HOLD_MS held while a grab/capture is
        // live → the ungrab path (drops keyboard grab, pointer confine,
        // and rel capture until the next focus cycle). Gated on a held
        // state so a long caps press with nothing grabbed stays a plain
        // toggle.
        if caps_down_at.is_some_and(|t| t.elapsed().as_millis() >= CAPS_HOLD_MS)
            && (grabbed || pgrabbed || captured) {
            caps_down_at = None;
            esc.ungrab_gen.fetch_add(1, Ordering::Relaxed);
            eprintln!("[+{}s][esc] caps-lock held ≥{CAPS_HOLD_MS}ms — ungrab ({title})", ts());
        }
        // Capture decision → transition. Entering: flip QEMU's handler to
        // relative (In::Mode rides the input channel, so mouse_set lands
        // before the deltas that follow), confine the pointer to the
        // window via a grab (re-issued — a grab's confine can't be
        // amended), reset the delta baseline. Leaving: unconfine, restore
        // the tablet, and force the next abs sample to re-send so the
        // guest pointer resyncs to where the host cursor actually is.
        let want = active && !xdpy.is_null() && !rel_hold_off
            && rel_override.unwrap_or(match rel_mode {
                RelMode::Always => true,
                RelMode::Auto => cursor_ever_visible && !cursor_visible
                    && hide_travel >= HIDE_TRAVEL_PX,
                RelMode::Off => false,
            });
        if want != captured {
            captured = want;
            rel_last = None;
            rel_acc = (0.0, 0.0);
            let _ = itx.send(In::Mode(captured));
            unsafe {
                XUngrabPointer(xdpy, 0);
                pgrabbed = captured
                    && XGrabPointer(xdpy, xwin_id, 0, 0xC, 1, 1, xwin_id, 0, 0) == 0;
                if !captured {
                    captured_btns.clear();
                    pending_abs = None;
                    mouse = (-1.0, -1.0); // force an abs re-send
                }
                XFlush(xdpy);
            }
            eprintln!("[+{}s][rel] capture {} ({title})", ts(),
                if captured { "ON — relative motion" } else { "off" });
        }
        if captured && !pgrabbed && last_grab_try.elapsed().as_millis() > 500 {
            // confine grab lost (transient server grab won the race) —
            // retry on the same cadence as the --grab path
            last_grab_try = std::time::Instant::now();
            pgrabbed = unsafe { XGrabPointer(xdpy, xwin_id, 0, 0xC, 1, 1, xwin_id, 0, 0) == 0 };
            if pgrabbed { eprintln!("[+{}s][rel] pointer confined ({title})", ts()); }
        }
        // Drain xdpy — THE input path. Key events with window==xwin are
        // real input (selected delivery while focused-ungrabbed, grab
        // delivery while grabbed) → forwarded to the guest unless an
        // escape combo swallows them. window==root while ungrabbed = a
        // passive-grab combo firing. Button events arrive via the same
        // selection while ungrabbed, via the pointer grab while grabbed.
        // send_event = our own reinjections, filtered.
        if !xdpy.is_null() {
            while unsafe { XPending(xdpy) } > 0 {
                let mut ev: XEvBuf = unsafe { std::mem::zeroed() };
                unsafe { XNextEvent(xdpy, &mut ev); }
                let a = unsafe { ev.any };
                if a.send_event != 0 { continue; }
                // Expose(12) / VisibilityNotify(15) / MapNotify(19): the
                // window just (re)gained a visible pixmap — VD switches and
                // iconify unmap us, and the fresh backing composites black
                // until the next swap. Nothing else schedules a present
                // while the guest is idle, so kick the GL worker.
                if a.t == 12 || a.t == 15 || a.t == 19 {
                    let _ = jtx.send(XJob::Repaint);
                    continue;
                }
                if (a.t == 2 || a.t == 3) && unsafe { ev.key }._win == xwin_id {
                    let k = unsafe { ev.key };
                    let down = a.t == 2;
                    let Some(q) = qnum_for_keycode(k.keycode) else { continue };
                    if Some(k.keycode) == caps_xkey {
                        // caps-hold tracking, ahead of the swallowed/combo
                        // paths so neither can hide a press or release
                        if down {
                            if caps_down_at.is_none() {
                                caps_down_at = Some(std::time::Instant::now());
                            }
                        } else {
                            // same-timestamp release+press = autorepeat,
                            // still held (lock keys don't repeat by
                            // default, but `xset r` can enable it)
                            let mut still = false;
                            if unsafe { XPending(xdpy) } > 0 {
                                let mut pv: XEvBuf = unsafe { std::mem::zeroed() };
                                unsafe { XPeekEvent(xdpy, &mut pv); }
                                let p = unsafe { pv.key };
                                still = p.t == 2 && p.keycode == k.keycode && p.time == k.time;
                            }
                            if !still { caps_down_at = None; }
                        }
                    }
                    if swallowed.contains(&k.keycode) {
                        if !down { swallowed.remove(&k.keycode); }
                        continue;
                    }
                    if down && !esc.combos.is_empty() {
                        // held mods come straight from the event's state
                        // mask — cleaner than tracking key-up/down ourselves.
                        // Also runs ungrabbed: a combo event reaching xwin
                        // means no passive grab claimed it (BadAccess race),
                        // and dispatching beats leaking the trigger to the
                        // guest.
                        let held = k.state & 0x4d; // Shift|Control|Mod1|Mod4
                        if let Some(c) = esc.combos.iter()
                            .find(|c| c.xkey == k.keycode && c.xmods == held).cloned() {
                            swallowed.insert(k.keycode);
                            // lift the combo's forwarded halves so the guest
                            // isn't left with phantom held modifiers while
                            // we run the host action
                            for g in [M_CTRL, M_ALT, M_SHIFT, M_META] {
                                for kk in g { if pressed.remove(&kk) { let _ = itx.send(In::Key(kk, false)); } }
                            }
                            esc.fire(&c, title);
                            continue;
                        }
                    }
                    if down { pressed.insert(q); } else { pressed.remove(&q); }
                    if down && q == 0x45 {
                        // NumLock just forwarded — the reconcile poll can't
                        // trust guest LED state for a beat
                        num_suppress_until = std::time::Instant::now() + std::time::Duration::from_millis(900);
                    }
                    let _ = itx.send(In::Key(q, down));
                } else if a.t == 2 || a.t == 3 {
                    if grabbed { continue; }
                    let k = unsafe { ev.key };
                    let trig = esc.combos.iter().any(|c| c.xkey == k.keycode);
                    let mut consumed = false;
                    if a.t == 2 && trig {
                        let held = k.state & 0x4d; // Shift|Control|Mod1|Mod4
                        if passive_held.contains(&k.keycode) {
                            consumed = true; // autorepeat re-press of our trigger
                        } else if let Some(i) = esc.combos.iter()
                            .position(|c| c.xkey == k.keycode && c.xmods == held) {
                            if passive_last.get(&i).is_none_or(|t| t.elapsed().as_millis() > 300) {
                                passive_last.insert(i, std::time::Instant::now());
                                passive_held.insert(k.keycode);
                                eprintln!("[+{}s][esc] combo via host grab ({title})", ts());
                                esc.fire(&esc.combos[i].clone(), title);
                            }
                            consumed = true;
                        }
                    } else if a.t == 3 && trig && passive_held.contains(&k.keycode) {
                        // release of a fired trigger — but X autorepeat emits
                        // fake release+press pairs at the same timestamp; a
                        // paired press means the key is still held → eat both
                        consumed = true;
                        if unsafe { XPending(xdpy) } > 0 {
                            let mut pv: XEvBuf = unsafe { std::mem::zeroed() };
                            unsafe { XPeekEvent(xdpy, &mut pv); }
                            let p = unsafe { pv.key };
                            if p.t == 2 && p.keycode == k.keycode && p.time == k.time {
                                let mut sink: XEvBuf = unsafe { std::mem::zeroed() };
                                unsafe { XNextEvent(xdpy, &mut sink); }
                            } else {
                                passive_held.remove(&k.keycode);
                            }
                        } else {
                            passive_held.remove(&k.keycode);
                        }
                    }
                    if !consumed && (a.t == 2 || a.t == 3) {
                        // non-trigger event during an active passive grab —
                        // it belongs to whoever holds focus, not us
                        let (mut focus, mut revert) = (0u64, 0i32);
                        unsafe { XGetInputFocus(xdpy, &mut focus, &mut revert); }
                        if focus > 1 && focus != xwin_id { // not None(0)/PointerRoot(1)/ours
                            let m = if a.t == 2 { 1 } else { 2 };
                            unsafe { ev.key._win = focus; XSendEvent(xdpy, focus, 0, m, &mut ev); }
                        }
                    }
                } else if a.t == 4 || a.t == 5 {
                    // ButtonPress/Release. Two delivery paths, disjoint by
                    // grab state: the active pointer grab while pgrabbed,
                    // and the passive 8/9 nav grabs while ungrabbed — xwin's
                    // button-mask selection belongs to minifb (exclusive —
                    // see the XSelectInput note above), so the passive grabs
                    // are the ONLY ungrabbed source: the activating press,
                    // plus every button event while that grab is held.
                    // In-window clicks are consumed + forwarded to the
                    // guest; a click outside drops the grab and re-injects
                    // the press via XTEST — a real device event, so KWin's
                    // passive grabs and click-to-focus see it exactly as if
                    // we'd never grabbed.
                    let k = unsafe { ev.key };
                    let btn = k.keycode;
                    let down = a.t == 4;
                    // Panic chord: ctrl+alt+shift+right-click aborts.
                    // Works even if the keyboard path is dead —
                    // button events still reach us through the pointer grab,
                    // and the modifier state rides in the event itself.
                    if down && k.state & 0x4d == 0x0d && btn == 3 {
                        esc.abort_gen.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    let (ww, wh) = win.get_size();
                    let inside = k._x >= 0 && k._y >= 0
                        && (k._x as usize) < ww && (k._y as usize) < wh;
                    if down && !inside && !captured_btns.contains(&btn) {
                        // Outside press: release the grab and re-inject so
                        // the host sees a normal click (focus moves, passive
                        // grabs fire). Re-inject press; the physical release
                        // then delivers to the target on its own — except
                        // wheel "buttons" (4-7) which are transient pulses:
                        // pair them or the target could see a stuck press.
                        unsafe {
                            XUngrabPointer(xdpy, 0);
                            XTestFakeButtonEvent(xdpy, btn, 1, 0);
                            if btn >= 4 { XTestFakeButtonEvent(xdpy, btn, 0, 0); }
                            XFlush(xdpy);
                        }
                        pgrabbed = false;
                        captured_btns.clear();
                        for (b, ci) in btns_down.drain() { let _ = itx.send(In::Btn(ci, b, false)); }
                        eprintln!("[+{}s][grab] outside click — reinjected to host ({title})", ts());
                        continue; // press belongs to the host, not the guest
                    }
                    if down { captured_btns.insert(btn); } else { captured_btns.remove(&btn); }
                    // X button → guest button: 1,2,3 = L,M,R → 0,1,2;
                    // 8,9 = back,forward → 5,6. Wheel arrives as transient
                    // Button4/5 press+release — pulse on the press only.
                    let guest_btn = match btn {
                        1..=3 => Some(btn as u8 - 1),
                        8 => Some(5),
                        9 => Some(6),
                        _ => None,
                    };
                    if let Some((ax, ay)) = pending_abs.take() {
                        let (ci, gx, gy) = to_guest(&win, ax, ay);
                        cur_ci = ci;
                        let _ = itx.send(In::Move(ci, gx, gy));
                        last_pos_send = std::time::Instant::now();
                    }
                    if let Some(b) = guest_btn {
                        // releases go to the console the press went to —
                        // a boundary cross mid-drag would otherwise orphan
                        // the press on the original console
                        let ci = if down { btns_down.insert(b, cur_ci); cur_ci }
                            else { btns_down.remove(&b).unwrap_or(cur_ci) };
                        let _ = itx.send(In::Btn(ci, b, down));
                    } else if down && (btn == 4 || btn == 5) {
                        let b = if btn == 4 { 3u8 } else { 4u8 }; // wheel up/down
                        let _ = itx.send(In::Btn(cur_ci, b, true));
                        let _ = itx.send(In::Btn(cur_ci, b, false));
                    }
                }
            }
            unsafe { XFlush(xdpy); }
        }
        // Drain while unfocused, not just on the observed true→false edge:
        // a focus cycle that opens AND closes inside one `win.update()`
        // batch never shows the edge, yet a press delivered in that window
        // still lands on xdpy (autorepeat of a held mod mid VD-switch) and
        // would sit in `pressed` forever — the guest sees it held until a
        // later full focus cycle happens to drain it.
        if !active {
            swallowed.clear();
            for q in pressed.drain() { let _ = itx.send(In::Key(q, false)); }
            for (b, ci) in btns_down.drain() { let _ = itx.send(In::Btn(ci, b, false)); }
        }
        // Pointer position. While the pointer grab is held minifb's
        // event-fed state is stale (motion isn't in the grab mask), so
        // sample via XQueryPointer — a REQUEST, immune to grabs. Ungrabbed,
        // get_mouse_pos is live and free: no per-tick X round-trip.
        let ptr_pos: Option<(f32, f32)> = if pgrabbed && !xdpy.is_null() {
            let (mut rw, mut cw) = (0u64, 0u64);
            let (mut rx, mut ry, mut wx, mut wy) = (0i32, 0i32, 0i32, 0i32);
            let mut m = 0u32;
            if unsafe { XQueryPointer(xdpy, xwin_id, &mut rw, &mut cw,
                &mut rx, &mut ry, &mut wx, &mut wy, &mut m) } != 0 {
                Some((wx as f32, wy as f32))
            } else { None }
        } else {
            win.get_mouse_pos(minifb::MouseMode::Pass)
        };
        if let Some((mx, my)) = ptr_pos {
            {
                if captured {
                    // rel deltas vs the last sample. Our own warps rebase
                    // rel_last where they're issued, so they never count
                    // as user motion. If the confine grab lost we only
                    // count inside-window motion — an unconfined pointer
                    // roaming the host must not drive the guest — but the
                    // baseline still tracks outside positions so re-entry
                    // doesn't emit the jump.
                    let (ww, wh) = win.get_size();
                    if pgrabbed
                        || (mx >= 0.0 && my >= 0.0 && mx < ww as f32 && my < wh as f32) {
                        if let Some((lx, ly)) = rel_last {
                            rel_acc.0 += mx - lx;
                            rel_acc.1 += my - ly;
                        }
                    }
                    rel_last = Some((mx, my));
                    if pgrabbed && !cursor_visible {
                        // cursor hidden (a locked app) → park the pointer
                        // near the window center; confined at an edge it
                        // has no delta room left. A visible cursor is
                        // parked by the mouse_set warps instead.
                        let (cx, cy) = (ww as f32 / 2.0, wh as f32 / 2.0);
                        let (dx, dy) = (mx - cx, my - cy);
                        if dx * dx + dy * dy > (ww.min(wh) as f32 * 0.35).powi(2) {
                            unsafe {
                                XWarpPointer(xdpy, 0, xwin_id, 0, 0, 0, 0,
                                    cx as i32, cy as i32);
                                XFlush(xdpy);
                            }
                            rel_last = Some((cx, cy));
                        }
                    }
                } else {
                    let (ww, wh) = win.get_size();
                    if mx >= 0.0 && my >= 0.0 && mx < ww as f32 && my < wh as f32
                        && (mx, my) != mouse {
                        // 'auto' gate: a guest cursor that stays hidden
                        // through real motion is the lock signature — a
                        // hide-while-typing terminal re-shows on the first
                        // delta, so it never reaches the threshold.
                        if !cursor_visible && mouse.0 >= 0.0 {
                            hide_travel += (mx - mouse.0).hypot(my - mouse.1);
                        }
                        mouse = (mx, my);
                        pending_abs = Some((mx, my));
                    } else if !(mx >= 0.0 && my >= 0.0 && mx < ww as f32 && my < wh as f32) {
                        // left the window — re-entry must not count the
                        // jump toward hide_travel
                        mouse = (-1.0, -1.0);
                    }
                }
            }
        } else if !captured {
            // off-window sample — same re-entry jump guard as above
            mouse = (-1.0, -1.0);
        }
        // Buttons + wheel while UNGRABBED: those events deliver to minifb's
        // conn (ButtonPressMask selection is exclusively theirs), so its
        // event-fed state is live. While pgrabbed the raw drain owns
        // buttons and minifb is blind — skip the poll entirely.
        if !pgrabbed {
            for (i, b) in [minifb::MouseButton::Left, minifb::MouseButton::Middle,
                           minifb::MouseButton::Right].into_iter().enumerate() {
                let d = win.get_mouse_down(b);
                if d != mbtns[i] {
                    mbtns[i] = d;
                    if let Some((ax, ay)) = pending_abs.take() {
                        let (ci, gx, gy) = to_guest(&win, ax, ay);
                        cur_ci = ci;
                        let _ = itx.send(In::Move(ci, gx, gy));
                        last_pos_send = std::time::Instant::now();
                    }
                    let ci = if d { btns_down.insert(i as u8, cur_ci); cur_ci }
                        else { btns_down.remove(&(i as u8)).unwrap_or(cur_ci) };
                    let _ = itx.send(In::Btn(ci, i as u8, d));
                }
            }
            // wheel — QEMU models scroll as wheel-button pulses (up=3,
            // down=4; the virtio tablet only maps REL_WHEEL so horizontal
            // deltas drop). minifb gives ±1.0 per notch; accumulate so a
            // sub-notch delta still converges on a pulse.
            if let Some((_sx, sy)) = win.get_scroll_wheel() {
                scroll_acc += sy;
            }
        }
        while scroll_acc.abs() >= 1.0 {
            // land the pending position first — the wheel acts wherever
            // the tablet's abs pointer currently sits
            if let Some((ax, ay)) = pending_abs.take() {
                let (ci, gx, gy) = to_guest(&win, ax, ay);
                cur_ci = ci;
                let _ = itx.send(In::Move(ci, gx, gy));
                last_pos_send = std::time::Instant::now();
            }
            let b = if scroll_acc > 0.0 { 3u8 } else { 4u8 };
            let _ = itx.send(In::Btn(cur_ci, b, true));
            let _ = itx.send(In::Btn(cur_ci, b, false));
            scroll_acc -= scroll_acc.signum();
        }
        if let Some(kbd) = &kbd_iface {
            if last_num_sync.elapsed().as_millis() >= 500
                && num_suppress_until <= std::time::Instant::now() {
                last_num_sync = std::time::Instant::now();
                let host = host_numlock(xdpy, num_atom);
                let mods = kbd.get_property::<u32>("Modifiers").ok();
                // first reads are diagnostic — a failed host indicator or
                // Modifiers property otherwise fails silently forever
                if num_diag < 30 {
                    num_diag += 1;
                    if let (Some(h), Some(m)) = (host, mods) {
                        eprintln!("[input] numlock probe: host={h} guest-num={} (modifiers=0x{m:x})",
                            m & 0x2 != 0);
                        num_diag = 30;
                    } else if num_diag == 29 {
                        eprintln!("[input] numlock probe failing: host={host:?} guest={mods:?}");
                    }
                }
                if let (Some(host), Some(m)) = (host, mods) {
                    let guest = m & 0x2 != 0;
                    if host != guest {
                        num_mismatch += 1;
                        // debounce: two consecutive mismatches (~1s) before
                        // pulsing — a transient mismatch is a forwarded
                        // NumLock still in flight, not real divergence
                        if num_mismatch >= 2 {
                            num_mismatch = 0;
                            num_suppress_until = std::time::Instant::now()
                                + std::time::Duration::from_millis(900);
                            let _ = itx.send(In::Key(0x45, true));  // Q_KEY_CODE num_lock
                            let _ = itx.send(In::Key(0x45, false));
                            eprintln!("[input] numlock sync: host={host} guest={guest} — toggled");
                        }
                    } else {
                        num_mismatch = 0;
                    }
                }
            }
        }
        // rel deltas — trunc keeps the sub-pixel remainder accumulating,
        // the ~250Hz send gate matches the abs coalesce's pacing
        if captured && rel_send.elapsed().as_millis() > 4
            && (rel_acc.0.abs() >= 1.0 || rel_acc.1.abs() >= 1.0) {
            rel_send = std::time::Instant::now();
            let (dx, dy) = (rel_acc.0.trunc() as i32, rel_acc.1.trunc() as i32);
            rel_acc.0 -= dx as f32;
            rel_acc.1 -= dy as f32;
            let _ = itx.send(In::Rel(dx, dy));
        }
        // coalesce position events — ~120Hz is enough for absolute pointer
        if let Some((ax, ay)) = pending_abs {
            if last_pos_send.elapsed().as_millis() > 8 {
                pending_abs = None;
                last_pos_send = std::time::Instant::now();
                let (ci, gx, gy) = to_guest(&win, ax, ay);
                cur_ci = ci;
                let _ = itx.send(In::Move(ci, gx, gy));
            }
        }
        // Guest cursor state from the listener. Per console — a head
        // crossing swaps to that output's sprite. gen bumps per Define so
        // the apply below only touches X when the desired cursor changed.
        while let Ok(c) = crx.try_recv() {
            match c {
                CurJob::Define(ci, img) => {
                    if let Some(s) = cur_slots.get_mut(ci) {
                        s.seen = true;
                        s.gen += 1;
                        if s.xc != 0 && !xdpy.is_null() {
                            unsafe { XFreeCursor(xdpy, s.xc); }
                            s.xc = 0;
                        }
                        s.img = Some(img);
                        cur_dirty = true;
                    }
                }
                CurJob::Show(ci, mx, my, on) => {
                    if let Some(s) = cur_slots.get_mut(ci) {
                        s.seen = true;
                        if s.on != on { s.on = on; cur_dirty = true; }
                    }
                    if captured && pgrabbed && on {
                        // Shadow the guest cursor: warp the host pointer to
                        // the guest's own cursor spot (console px → window
                        // px through the same fit the input map inverts)
                        // so the guest sprite applied as the X cursor sits
                        // where the guest believes the pointer is. >2px
                        // gate: don't fight per-report jitter. Hidden-
                        // cursor reports skip this — parking is the
                        // recenter check's job. The pgrabbed gate matters:
                        // captured-but-unconfined means the confine grab
                        // lost a race (retried above) and the host pointer
                        // is roaming the desktop — warping then teleports
                        // the user's cursor into window coords on every
                        // guest report, offscreen window included.
                        let (ww, wh) = win.get_size();
                        let rects = head_rects(&heads, span.as_deref(), ww as i32, wh as i32);
                        if let Some(&(rx, ry, rw, rh)) = rects.get(ci) {
                            let iw = (heads.dims[ci].w.load(Ordering::Relaxed) as i32).max(1);
                            let ih = (heads.dims[ci].h.load(Ordering::Relaxed) as i32).max(1);
                            let (vx, vy, vw, vh) =
                                egl::fit_viewport(rw.max(1) as u32, rh.max(1) as u32, iw, ih);
                            if vw > 0 && vh > 0 {
                                let (wx, wy) = (rx + vx + mx * vw / iw, ry + vy + my * vh / ih);
                                let far = rel_last.is_none_or(|(lx, ly)|
                                    (wx as f32 - lx).abs() > 2.0 || (wy as f32 - ly).abs() > 2.0);
                                if far {
                                    unsafe {
                                        XWarpPointer(xdpy, 0, xwin_id, 0, 0, 0, 0, wx, wy);
                                        XFlush(xdpy);
                                    }
                                    rel_last = Some((wx as f32, wy as f32));
                                }
                            }
                        }
                    }
                }
            }
        }
        // 'auto' trigger bookkeeping: visible = any console shows a cursor
        // (virtio-gpu parks the pointer on one output's cursor plane — the
        // others legitimately report off). ever-visible is sticky so a
        // never-cursored boot doesn't masquerade as a lock, and each
        // visibility transition ends the current lock episode (and with
        // it any relgrab override).
        let vis = cur_slots.iter().any(|s| s.seen && s.on);
        if vis { cursor_ever_visible = true; hide_travel = 0.0; }
        if vis != cursor_visible && rel_mode == RelMode::Auto { rel_override = None; }
        cursor_visible = vis;
        if (cur_dirty || cur_applied.map(|a| a.0) != Some(cur_ci)) && !xdpy.is_null() {
            cur_dirty = false;
            if let Some(s) = cur_slots.get_mut(cur_ci) {
                let key = (cur_ci, s.gen, s.on, s.seen);
                if cur_applied != Some(key) {
                    cur_applied = Some(key);
                    unsafe {
                        if !s.seen || (s.on && s.img.is_none()) {
                            // nothing pushed yet / on but no sprite — the
                            // host's inherited default is the sane fallback
                            XUndefineCursor(xdpy, xwin_id);
                        } else if s.on {
                            if s.xc == 0 {
                                s.xc = build_xcursor(xdpy, s.img.as_ref().unwrap()).unwrap_or(0);
                            }
                            if s.xc != 0 {
                                XDefineCursor(xdpy, xwin_id, s.xc);
                            } else {
                                XUndefineCursor(xdpy, xwin_id);
                            }
                        } else {
                            // guest unbound its cursor sprite — a
                            // transparent cursor so no phantom arrow floats
                            // over a guest that draws (or hides) its own
                            if blank_xc == 0 {
                                blank_xc = build_xcursor(xdpy, &CurImg {
                                    w: 1, h: 1, hx: 0, hy: 0, px: vec![0],
                                }).unwrap_or(0);
                            }
                            if blank_xc != 0 {
                                XDefineCursor(xdpy, xwin_id, blank_xc);
                            } else {
                                XUndefineCursor(xdpy, xwin_id);
                            }
                        }
                        XFlush(xdpy);
                    }
                }
            }
        }
    }
    if !xdpy.is_null() { unsafe { XCloseDisplay(xdpy); } }
    Ok(())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let monitor = args.next().context("usage: viewer-dd <monitor.sock> [--title T] [--size WxH]")?;
    let mut title = "cruiser-dd".to_string();
    let mut w = 1920usize;
    let mut h = 1080usize;
    let mut offsets: Vec<(u32, u32)> = Vec::new();
    let mut rects: Vec<(i32, i32, i32, i32)> = Vec::new();
    let mut probes: Vec<String> = Vec::new();
    let mut clipboard = true;
    let mut grab = false;
    let mut rel_mode = RelMode::Off;
    let mut escapes: Vec<EscCombo> = Vec::new();
    // --proxy <ddproxy.sock> — attach via the per-VM display broker instead
    // of minting QMP @dbus-display channels; a dead/absent proxy falls back
    // to the direct channel so the viewer never regresses.
    let mut proxy: Option<String> = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--proxy" => proxy = args.next(),
            "--no-clipboard" => clipboard = false,
            // grab the keyboard while the window is focused (spec.display.grabKeyboard)
            "--grab" => grab = true,
            // spec.display.pointerLock — relative pointer capture policy
            "--relmouse" => {
                if let Some(s) = args.next() {
                    rel_mode = match s.as_str() {
                        "always" => RelMode::Always,
                        "auto" => RelMode::Auto,
                        _ => RelMode::Off,
                    };
                }
            }
            // "<mods+key>=<action>" — spec.display.escapeShortcuts, run by
            // the viewer while the grab makes the WM's bindings blind
            "--escape" => {
                if let Some(s) = args.next() {
                    match parse_escape(&s) {
                        Some(c) => escapes.push(c),
                        None => eprintln!("[esc] unparsable escape spec '{s}' — ignored"),
                    }
                }
            }
            "--title" => title = args.next().unwrap_or(title),
            "--size" => {
                if let Some(s) = args.next() {
                    if let Some((x, y)) = s.split_once('x') {
                        w = x.parse().unwrap_or(w);
                        h = y.parse().unwrap_or(h);
                    }
                }
            }
            // per-console position in the guest composite, console order:
            // --offsets "x0,y0 x1,y1 x2,y2"
            // --rects "x,y,w,h x,y,w,h" — each console's host-monitor rect
            // in absolute px (console order): the window spans their union
            // and each console draws into its monitor's rect.
            // --probe "ci,x,y" — inject one raw SetAbsPosition on console ci
            // at startup (input-mapping diagnostics; watch mouse_set logs).
            "--probe" => probes.extend(args.next().into_iter().collect::<Vec<_>>()),
            "--offsets" => {
                if let Some(s) = args.next() {
                    for part in s.split_whitespace() {
                        if let Some((x, y)) = part.split_once(',') {
                            if let (Ok(x), Ok(y)) = (x.parse::<u32>(), y.parse::<u32>()) {
                                offsets.push((x, y));
                            }
                        }
                    }
                }
            }
            "--rects" => {
                if let Some(s) = args.next() {
                    for part in s.split_whitespace() {
                        let v: Vec<i32> = part.split(',')
                            .filter_map(|t| t.parse().ok()).collect();
                        if v.len() == 4 { rects.push((v[0], v[1], v[2], v[3])); }
                    }
                }
            }
            _ => {}
        }
    }
    eprintln!("[*] monitor: {monitor} size={w}x{h} proxy={proxy:?}");

    // channel #1: control conn (VM/Console objects) — prefer the proxy; if
    // the socket is dead, fall straight back to the direct QMP channel.
    let conn = match display_conn(&monitor, proxy.as_deref(), "control").await {
        Ok(c) => c,
        Err(e) if proxy.is_some() => {
            eprintln!("[*] proxy attach failed ({e:#}) — direct qemu channel");
            proxy = None;
            display_conn(&monitor, None, "control").await.context("dbus channel")?
        }
        Err(e) => return Err(e).context("dbus channel"),
    };

    let vm = zbus::Proxy::new(&conn, "org.qemu", "/org/qemu/Display1/VM", "org.qemu.Display1.VM").await?;
    let name: String = vm.get_property("Name").await?;
    let consoles: Vec<u32> = vm.get_property("ConsoleIDs").await?;
    eprintln!("[*] VM name={name} consoles={consoles:?}");

    // Log the kill reason — the window-close path and a silent SIGTERM/SIGINT
    // are otherwise indistinguishable in the viewer log.
    tokio::spawn(async {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("sigterm handler");
        let mut int = signal(SignalKind::interrupt()).expect("sigint handler");
        tokio::select! {
            _ = term.recv() => eprintln!("[*] SIGTERM — exiting"),
            _ = int.recv() => eprintln!("[*] SIGINT — exiting"),
        }
        std::process::exit(0);
    });

    // Dead-QEMU watchdog: the control channel is transient (QEMU closes it
    // after listener registration), so liveness is the QEMU process itself —
    // qemu.pid sits beside monitor.sock. Match pid + /proc starttime so a VM
    // restart (new pid, or a reused one) counts as dead too: without this the
    // windows freeze on the last frame and a later `view` adopts a zombie.
    {
        let pidfile = std::path::Path::new(&monitor)
            .parent().unwrap_or(std::path::Path::new(".")).join("qemu.pid");
        let boot = ddproto::qemu_boot_id(&pidfile);
        if let Some((pid, start)) = boot {
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    if ddproto::qemu_boot_id(&pidfile) != Some((pid, start)) {
                        eprintln!("[*] qemu display channel lost — exiting");
                        std::process::exit(1);
                    }
                }
            });
        }
    }

    // --rects → one window spanning the union of the picked host monitors,
    // each console drawing into its monitor's rect (freerdp /multimon
    // semantics). Without it the window letterboxes the whole composite.
    let span = if rects.is_empty() { None } else {
        let ux = rects.iter().map(|r| r.0).min().unwrap_or(0);
        let uy = rects.iter().map(|r| r.1).min().unwrap_or(0);
        let uw = rects.iter().map(|r| r.0 + r.2).max().unwrap_or(0) - ux;
        let uh = rects.iter().map(|r| r.1 + r.3).max().unwrap_or(0) - uy;
        Some(Span {
            union: (ux, uy, uw.max(1), uh.max(1)),
            abs: rects.clone(),
            rects: rects.iter().map(|r| (r.0 - ux, r.1 - uy, r.2, r.3)).collect(),
        })
    };

    // All consoles feed ONE window — multi-head guests (virtio outputs[])
    // draw side-by-side inside it. Register every listener on the control
    // conn BEFORE opening the input channel — QEMU's @dbus-display drops
    // the enumeration conn once listeners are attached, and extra client
    // channels get EPIPE'd, so the single input conn must be opened last
    // and shared by all consoles.
    struct Pending { cpath: String, dims: std::sync::Arc<Dims> }
    let mut pending = Vec::new();
    let mut _lconns = Vec::new();
    let (jtx, jrx) = std::sync::mpsc::channel::<XJob>();
    let (ctx, crx) = std::sync::mpsc::channel::<CurJob>();
    for (idx, &ci) in consoles.iter().enumerate() {
        let cpath = zbus::zvariant::ObjectPath::try_from(format!("/org/qemu/Display1/Console_{ci}"))?;
        let console = zbus::Proxy::new(&conn, "org.qemu", cpath.clone(), "org.qemu.Display1.Console").await?;
        // default dims: the console's span rect if we have it — layout math
        // runs on these before the first scanout arrives
        let (dw, dh) = span.as_ref()
            .and_then(|s| s.rects.get(idx))
            .map(|r| (r.2.max(1) as u64, r.3.max(1) as u64))
            .unwrap_or((w as u64, h as u64));
        let dims = std::sync::Arc::new(Dims { w: AtomicU64::new(dw), h: AtomicU64::new(dh) });
        let (s2, p2) = UnixStream::pair()?;
        console.call::<_, _, ()>("RegisterListener", &(Fd::from(p2.as_fd()),)).await?;
        drop(p2);
        s2.set_nonblocking(true)?;
        let ev = ddproto::shared_console(ViewerConsole {
            tx: jtx.clone(), ctx: ctx.clone(), dims: dims.clone(), id: ci, idx,
        });
        let lc = connection::Builder::unix_stream(tokio::net::UnixStream::from_std(s2)?)
            .serve_at(ddproto::LISTENER_PATH, ddproto::Listener { ev: ev.clone() })?
            .serve_at(ddproto::LISTENER_PATH, ddproto::UnixMap { ev: ev.clone() })?
            .serve_at(ddproto::LISTENER_PATH, ddproto::UnixDmabuf2 { ev })?
            .p2p().build().await?;
        _lconns.push(lc);
        pending.push(Pending { cpath: cpath.to_string(), dims });
    }

    // One shared conn for every console's Keyboard/Mouse calls — built async
    // (blocking::build() would block_on inside the tokio runtime and panic),
    // then wrapped for the sync input workers. On the direct channel this is
    // the LAST add_client, so QEMU binds its object tree to it — which makes
    // it the only place the Clipboard skeleton is reachable; via ddproxy the
    // peer object rides this conn the same way (the proxy relays Clipboard
    // calls to the conn that called Register).
    let (clip_tx, clip_rx) = std::sync::mpsc::channel::<ClipEv>();
    let clip_state = std::sync::Arc::new(std::sync::Mutex::new(ClipShared::default()));
    let clip_serial = std::sync::Arc::new(AtomicU64::new(0));
    // The input conn carries the clipboard peer object — build it through
    // the same transport, serving the skeleton before the handshake.
    let si = match open_chan(&monitor, proxy.as_deref()) {
        Ok(s) => s,
        Err(e) if proxy.is_some() => {
            eprintln!("[*] proxy input conn failed ({e:#}) — direct qemu channel");
            open_chan(&monitor, None).context("input dbus channel")?
        }
        Err(e) => return Err(e).context("input dbus channel"),
    };
    si.set_nonblocking(true)?;
    let mut ib = connection::Builder::unix_stream(tokio::net::UnixStream::from_std(si)?).p2p();
    if clipboard {
        ib = ib.serve_at(ddproto::CLIP_PATH, ddproto::clip_peer(ViewerClip {
            st: clip_state.clone(), serial: clip_serial.clone(), evtx: clip_tx,
        }))?;
    }
    let ia = ib.build().await.context("input p2p conn")?;
    let iconn = std::sync::Arc::new(zbus::blocking::Connection::from(ia));
    if clipboard {
        let (ic, st, se) = (iconn.clone(), clip_state.clone(), clip_serial.clone());
        std::thread::spawn(move || clipboard_worker(ic, st, se, clip_rx));
    }

    // --probe diagnostics: fire raw SetAbsPosition calls after startup so the
    // guest's answer (listener mouse_set) reveals the real coordinate space.
    if !probes.is_empty() {
        MOUSE_VERBOSE.store(1, Ordering::Relaxed);
        let ic = iconn.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            for p in probes {
                let parts: Vec<&str> = p.split(',').collect();
                if parts.len() != 3 { continue; }
                let (ci, x, y) = (parts[0], parts[1], parts[2]);
                if let (Ok(x), Ok(y)) = (x.parse::<u32>(), y.parse::<u32>()) {
                    let path = format!("/org/qemu/Display1/Console_{ci}");
                    let m = zbus::blocking::Proxy::new(&ic, "org.qemu", path.as_str(),
                        "org.qemu.Display1.Mouse").expect("probe mouse proxy");
                    let r: Result<(), zbus::Error> = m.call("SetAbsPosition", &(x, y));
                    eprintln!("[probe] console {ci} SetAbsPosition({x},{y}) → {r:?}");
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        });
    }

    let heads = std::sync::Arc::new(Heads {
        dims: pending.iter().map(|p| p.dims.clone()).collect(),
        offsets,
    });

    if grab && !escapes.is_empty() {
        eprintln!("[*] {} escape combo(s) grabbed host-wide", escapes.len());
    }
    // Async X errors (BadAccess when kglobalacceld already owns a mirrored
    // VD combo, etc.) get a quiet tagged line instead of a mystery exit.
    unsafe { XSetErrorHandler(Some(xerror_handler)); }
    let esc = std::sync::Arc::new(EscState {
        enabled: grab,
        combos: escapes.clone(),
        ungrab_gen: std::sync::atomic::AtomicU64::new(0),
        abort_gen: std::sync::atomic::AtomicU64::new(0),
        rel_gen: std::sync::atomic::AtomicU64::new(0),
    });
    // Panic exits — none of these need working keyboard delivery:
    //   · move focus elsewhere (grabs release on FocusOut)
    //   · SIGUSR1 → abort (`pkill -USR1 -x viewer-dd`)
    //   · ctrl+alt+shift+right-click → abort (travels on the pointer grab)
    //   · Ctrl+Alt+F3 VT switch runs below any X grab
    //   · a continuously held grab self-releases after 60s
    unsafe { libc::signal(libc::SIGUSR1, sig_abort as *const () as libc::sighandler_t); }
    eprintln!("[*] input safety: click away to ungrab · `pkill -USR1 -x viewer-dd` or ctrl+alt+shift+right-click aborts · 60s grab cap · Ctrl+Alt+F3 always works");
    eprintln!("[*] {} console(s) registered — spawning window", _lconns.len());
    let paths: Vec<String> = pending.iter().map(|p| p.cpath.clone()).collect();
    // present_window makes zbus::blocking calls (block_on internally) — it
    // must live on a plain OS thread: running it on the #[tokio::main]
    // future panics "Cannot start a runtime from within a runtime" on the
    // first proxy call. Spawned tasks (watchdog, signals) keep running on
    // the runtime's workers while we join.
    let t = title.clone();
    let wh = std::thread::spawn(move ||
        present_window(iconn, paths, &t, w, h, jrx, jtx, crx, heads, span, esc, rel_mode, monitor));
    let r = wh.join().unwrap_or_else(|_| Err(anyhow::anyhow!("window thread panicked")));
    eprintln!("[*] window closed — {r:?}");
    Ok(())
}
