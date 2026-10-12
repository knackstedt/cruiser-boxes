// viewer-dd — Cruiser direct-display viewer.
//
// Connects to QEMU's D-Bus display backend (org.qemu.Display1, p2p), receives
// guest scanouts as dma-buf fds and presents them zero-copy through an EGL
// window surface (see egl.rs). Input is forwarded back over a second p2p
// channel (Display1.Keyboard / Display1.Mouse).
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
use std::io::{IoSlice, Read, Write};
use std::os::fd::{AsFd, AsRawFd, FromRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
mod egl;
use zbus::connection;
use zvariant::{Fd, OwnedFd as ZOwnedFd};

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

enum XJob {
    Fd(std::os::fd::OwnedFd, u32, u32, u32, u32, u64, bool),
    Nudge,
}

fn fourcc_str(f: u32) -> String {
    String::from_utf8_lossy(&[(f & 0xFF) as u8, ((f >> 8) & 0xFF) as u8,
        ((f >> 16) & 0xFF) as u8, ((f >> 24) & 0xFF) as u8]).into_owned()
}

fn qmp(mon: &mut UnixStream, cmd: &str, fd: Option<RawFd>) -> Result<String> {
    let msg = format!("{cmd}\n");
    if let Some(fd) = fd {
        let iov = [IoSlice::new(msg.as_bytes())];
        nix::sys::socket::sendmsg::<()>(
            mon.as_raw_fd(), &iov,
            &[nix::sys::socket::ControlMessage::ScmRights(&[fd])],
            nix::sys::socket::MsgFlags::empty(), None)?;
    } else {
        mon.write_all(msg.as_bytes())?;
    }
    let mut buf = vec![0u8; 4096];
    let n = mon.read(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf[..n]).into_owned())
}

/// Open a new p2p "@dbus-display" channel over the QMP monitor socket.
/// Each channel needs a unique QMP fdname — getfd names live in QEMU's
/// global monitor namespace, so concurrent opens under a shared "vdd" wire
/// the loser onto a stale fd (EPIPE at the p2p handshake).
fn open_dbus_channel(monitor: &str) -> Result<UnixStream> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let fdname = format!("vdd{}", SEQ.fetch_add(1, Ordering::Relaxed));
    let (s, p) = UnixStream::pair()?;
    let mut mon = UnixStream::connect(monitor)?;
    let mut g = vec![0u8; 512];
    let _ = mon.read(&mut g); // greeting
    qmp(&mut mon, r#"{"execute":"qmp_capabilities"}"#, None)?;
    let r = qmp(&mut mon, &format!(
        r#"{{"execute":"getfd","arguments":{{"fdname":"{fdname}"}}}}"#), Some(p.as_raw_fd()))?;
    anyhow::ensure!(!r.contains("\"error\""), "qmp getfd: {r}");
    let r = qmp(&mut mon, &format!(
        r#"{{"execute":"add_client","arguments":{{"protocol":"@dbus-display","fdname":"{fdname}"}}}}"#), None)?;
    anyhow::ensure!(!r.contains("\"error\""), "qmp add_client: {r}");
    drop(mon);
    Ok(s)
}

// ── D-Bus listener objects QEMU calls into ──

struct Listener { tx: std::sync::mpsc::Sender<XJob>, id: u32 }
#[zbus::interface(name = "org.qemu.Display1.Listener")]
impl Listener {
    fn scanout(&mut self, _w: u32, _h: u32, _stride: u32, _fmt: u32, _data: Vec<u8>) {}
    fn update(&mut self, _x: i32, _y: i32, _w: i32, _h: i32, _stride: u32, _fmt: u32, _data: Vec<u8>) {}
    #[zbus(name = "ScanoutDMABUF")]
    fn scanout_dmabuf(&mut self, _fd: ZOwnedFd, _w: u32, _h: u32, _stride: u32,
                      _fourcc: u32, _modifier: u64, _y0_top: bool) {}
    #[zbus(name = "UpdateDMABUF")]
    fn update_dmabuf(&mut self, _x: i32, _y: i32, _w: i32, _h: i32) {
        UPDATES.fetch_add(1, Ordering::Relaxed);
        // reply fast — QEMU gl-blocks the guest until this returns
        let _ = self.tx.send(XJob::Nudge);
    }
    fn disable(&mut self) { eprintln!("[listener] Disable"); }
    fn mouse_set(&mut self, x: i32, y: i32, on: i32) {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed) + 1;
        if MOUSE_VERBOSE.load(Ordering::Relaxed) != 0 || n % 20 == 1 {
            eprintln!("[listener:{}] mouse_set {x},{y} on={on}", self.id);
        }
    }
    fn cursor_define(&mut self, _w: i32, _h: i32, _hx: i32, _hy: i32, _data: Vec<u8>) {}
    #[zbus(property)]
    fn interfaces(&self) -> Vec<String> {
        vec!["org.qemu.Display1.Listener.Unix.ScanoutDMABUF2".to_string()]
    }
}

struct UnixDmabuf2 { tx: std::sync::mpsc::Sender<XJob>, dims: std::sync::Arc<Dims>, id: u32 }
#[zbus::interface(name = "org.qemu.Display1.Listener.Unix.ScanoutDMABUF2")]
impl UnixDmabuf2 {
    #[zbus(name = "ScanoutDMABUF2")]
    #[allow(clippy::too_many_arguments)]
    fn scanout_dmabuf2(&mut self, dmabufs: Vec<ZOwnedFd>, _x: u32, _y: u32, width: u32, height: u32,
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
        // hand the fd to the GL worker while it's live — QEMU fds can lose
        // their GEM backing within ~ms of the callback
        let d = unsafe { std::os::fd::OwnedFd::from_raw_fd(libc::dup(dmabufs[0].as_raw_fd())) };
        let off = offsets.first().copied().unwrap_or(0);
        if off != 0 && num_planes > 1 { return; } // multi-plane not supported
        let _ = self.tx.send(XJob::Fd(d, width, height, strides[0], fourcc, modifier, y0_top));
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

struct ClipPeer {
    st: std::sync::Arc<std::sync::Mutex<ClipShared>>,
    serial: std::sync::Arc<AtomicU64>,
    evtx: std::sync::mpsc::Sender<ClipEv>,
}

#[zbus::interface(name = "org.qemu.Display1.Clipboard")]
impl ClipPeer {
    /// QEMU resets the serial counter through our Register — both on our own
    /// Register call and any later session reset.
    fn register(&mut self) {
        self.serial.store(0, Ordering::Relaxed);
        eprintln!("[clip] serial reset by qemu");
    }
    fn unregister(&mut self) {}
    /// Guest grabbed the clipboard — fetch the text on demand (worker thread,
    /// not here: QEMU's call is fire-and-forget, our Request is not).
    fn grab(&mut self, selection: u32, serial: u32, mimes: Vec<String>) {
        self.serial.fetch_max(serial as u64, Ordering::Relaxed);
        if selection == SEL_CLIPBOARD && mimes.iter().any(|m| m == CLIP_MIME) {
            let _ = self.evtx.send(ClipEv::GuestGrab(selection));
        }
    }
    fn release(&mut self, _selection: u32) {}
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

// ── input forwarding: minifb events -> D-Bus Display1.Keyboard/Mouse ──
// QEMU key numbers are XT scancodes (qnum table); mouse btns: 0=L,1=M,2=R.
enum In { Move(u32, u32), Btn(u8, bool), Key(u32, bool) }

fn qnum_for(k: minifb::Key) -> Option<u32> {
    use minifb::Key::*;
    Some(match k {
        A => 0x1e, B => 0x30, C => 0x2e, D => 0x20, E => 0x12, F => 0x21,
        G => 0x22, H => 0x23, I => 0x17, J => 0x24, K => 0x25, L => 0x26,
        M => 0x32, N => 0x31, O => 0x18, P => 0x19, Q => 0x10, R => 0x13,
        S => 0x1f, T => 0x14, U => 0x16, V => 0x2f, W => 0x11, X => 0x2d,
        Y => 0x15, Z => 0x2c,
        Key0 => 0x0b, Key1 => 0x02, Key2 => 0x03, Key3 => 0x04, Key4 => 0x05,
        Key5 => 0x06, Key6 => 0x07, Key7 => 0x08, Key8 => 0x09, Key9 => 0x0a,
        Minus => 0x0c, Equal => 0x0d, Backspace => 0x0e, Tab => 0x0f,
        LeftBracket => 0x1a, RightBracket => 0x1b, Enter => 0x1c, LeftCtrl => 0x1d,
        Semicolon => 0x27, Apostrophe => 0x28, LeftShift => 0x2a, Backslash => 0x2b,
        Comma => 0x33, Period => 0x34, Slash => 0x35, RightShift => 0x36,
        LeftAlt => 0x38, Space => 0x39, CapsLock => 0x3a,
        F1 => 0x3b, F2 => 0x3c, F3 => 0x3d, F4 => 0x3e, F5 => 0x3f, F6 => 0x40,
        F7 => 0x41, F8 => 0x42, F9 => 0x43, F10 => 0x44, F11 => 0x57, F12 => 0x58,
        Escape => 0x01,
        RightCtrl => 0x9d, RightAlt => 0xb8, Home => 0xc7, Up => 0xc8, PageUp => 0xc9,
        Left => 0xcb, Right => 0xcd, End => 0xcf, Down => 0xd0, PageDown => 0xd1,
        Insert => 0xd2, Delete => 0xd3, LeftSuper => 0xdb, RightSuper => 0xdc,
        _ => return None,
    })
}

/// (pid, /proc starttime) of the QEMU that owns this display — None when the
/// pidfile is absent/unreadable or the process is gone.
fn qemu_boot_id(pidfile: &std::path::Path) -> Option<(u64, u64)> {
    let pid: u64 = std::fs::read_to_string(pidfile).ok()?.trim().parse().ok()?;
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // field 22 is starttime; comm (field 2) can contain spaces/parens — split
    // after the last ')' instead of naive whitespace splitting.
    let start: u64 = stat.rsplit(')').next()?.split_whitespace()
        .nth(19)?.parse().ok()?;
    Some((pid, start))
}

fn input_worker(conn: std::sync::Arc<zbus::blocking::Connection>,
                path: String, rx: std::sync::mpsc::Receiver<In>) {
    let kbd = zbus::blocking::Proxy::new(&conn, "org.qemu", path.as_str(),
        "org.qemu.Display1.Keyboard").expect("kbd proxy");
    let mouse = zbus::blocking::Proxy::new(&conn, "org.qemu", path.as_str(),
        "org.qemu.Display1.Mouse").expect("mouse proxy");
    let mut moves = 0u64;
    while let Ok(ev) = rx.recv() {
        let r: Result<(), zbus::Error> = (|| match ev {
            In::Move(x, y) => {
                moves += 1;
                if moves % 100 == 1 { eprintln!("[input] move#{moves} guest={x},{y}"); }
                mouse.call::<_, _, ()>("SetAbsPosition", &(x, y))
            }
            In::Btn(b, d) => mouse.call::<_, _, ()>(if d { "Press" } else { "Release" }, &(b as u32,)),
            In::Key(k, d) => kbd.call::<_, _, ()>(if d { "Press" } else { "Release" }, &(k,)),
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
                _ => {
                    static IN_ERRS: AtomicU64 = AtomicU64::new(0);
                    let n = IN_ERRS.fetch_add(1, Ordering::Relaxed) + 1;
                    if n % 50 == 1 { eprintln!("[input] call failed x{n}: {e}"); }
                }
            }
        }
    }
}

fn present_window(iconn: std::sync::Arc<zbus::blocking::Connection>,
                  console_path: &str, console_idx: usize, title: &str, w: usize, h: usize,
                  jrx: std::sync::mpsc::Receiver<XJob>, dims: std::sync::Arc<Dims>,
                  heads: std::sync::Arc<Heads>) -> Result<()> {
    use minifb::{Window, WindowOptions};
    let mut win = Window::new(title, w, h, WindowOptions { resize: true, ..WindowOptions::default() })?;
    win.limit_update_rate(Some(std::time::Duration::from_micros(2000)));

    // GL worker owns the EGL context — all device calls are single-threaded
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let wh = win.window_handle().unwrap();
        if let RawWindowHandle::Xlib(xw) = wh.as_raw() {
            let xid = xw.window;
            let t = title.to_string();
            std::thread::spawn(move || {
                let mut xegl = match egl::x11_present_init(xid, w as i32, h as i32) {
                    Ok(e) => e,
                    Err(e) => { eprintln!("[xegl] init failed: {e:#}"); return; }
                };
                eprintln!("[xegl] worker ready ({t})");
                let mut fps_n = 0u64;
                let mut fps_t = std::time::Instant::now();
                while let Ok(first) = jrx.recv() {
                    fps_n += 1;
                    if fps_t.elapsed().as_secs() >= 5 {
                        eprintln!("[fps] {t}: {} frames/{:.0}s", fps_n, fps_t.elapsed().as_secs_f32());
                        fps_n = 0; fps_t = std::time::Instant::now();
                    }
                    // coalesce: newest fd wins, collapse nudges
                    let mut latest: Option<(std::os::fd::OwnedFd, u32, u32, u32, u32, u64, bool)> = None;
                    let mut dirty = false;
                    for j in std::iter::once(first).chain(std::iter::from_fn(|| jrx.try_recv().ok())) {
                        match j {
                            XJob::Fd(fd, w2, h2, s, f, m, y) => { latest = Some((fd, w2, h2, s, f, m, y)); dirty = true; }
                            XJob::Nudge => { dirty = true; }
                        }
                    }
                    if let Some((fd, w2, h2, stride, fourcc, modifier, y0)) = latest {
                        if let Err(e) = egl::x11_import_and_present(&mut xegl, fd.as_raw_fd(), w2, h2, stride, fourcc, modifier, y0) {
                            static XF: AtomicU64 = AtomicU64::new(0);
                            let n = XF.fetch_add(1, Ordering::Relaxed) + 1;
                            if n % 120 == 1 { eprintln!("[xegl] import failed x{n}: {e:#}"); }
                        }
                    } else if dirty {
                        if let Err(e) = egl::x11_redraw(&xegl) {
                            static XF2: AtomicU64 = AtomicU64::new(0);
                            let n = XF2.fetch_add(1, Ordering::Relaxed) + 1;
                            if n % 120 == 1 { eprintln!("[xegl] redraw failed x{n}: {e:#}"); }
                        }
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
    let cp = console_path.to_string();
    std::thread::spawn(move || input_worker(iconn, cp, irx));

    let mut mouse = (-1.0f32, -1.0f32);
    let mut btns = [false; 3];
    let mut last_pos_send = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let mut pending_abs: Option<(f32, f32)> = None;

    // window px → guest scanout px through the same letterbox viewport the
    // renderer uses — then console-local → composite fraction → rescaled
    // into console units: qemu scales SetAbsPosition over the console's
    // surface, but the guest maps the single virtio tablet's 0..0x7fff
    // range over the WHOLE composite, so sending (ox+lx)*cw/W makes the
    // emitted fraction land on the right composite point.
    let to_guest = |win: &minifb::Window, mx: f32, my: f32| -> (u32, u32) {
        let (ww, wh) = win.get_size();
        let iw = dims.w.load(Ordering::Relaxed) as i32;
        let ih = dims.h.load(Ordering::Relaxed) as i32;
        let (vx, vy, vw, vh) = egl::fit_viewport(ww as u32, wh as u32, iw, ih);
        let lx = ((mx - vx as f32) / vw as f32 * iw as f32).clamp(0.0, iw as f32 - 1.0);
        let ly = ((my - vy as f32) / vh as f32 * ih as f32).clamp(0.0, ih as f32 - 1.0);
        if heads.offsets.is_empty() || console_idx >= heads.offsets.len() {
            return (lx as u32, ly as u32);
        }
        let (ox, oy) = heads.offsets[console_idx];
        let mut cw_total = 0u64;
        let mut ch_total = 0u64;
        for (i, d) in heads.dims.iter().enumerate() {
            let (xo, yo) = heads.offsets.get(i).copied().unwrap_or((0, 0));
            cw_total = cw_total.max(xo as u64 + d.w.load(Ordering::Relaxed));
            ch_total = ch_total.max(yo as u64 + d.h.load(Ordering::Relaxed));
        }
        let gx = ((ox as f32 + lx) * iw as f32 / cw_total as f32)
            .clamp(0.0, iw as f32 - 1.0);
        let gy = ((oy as f32 + ly) * ih as f32 / ch_total as f32)
            .clamp(0.0, ih as f32 - 1.0);
        (gx as u32, gy as u32)
    };

    let itx2 = itx.clone();
    struct KbCb(std::sync::mpsc::Sender<In>);
    impl minifb::InputCallback for KbCb {
        fn add_char(&mut self, _c: u32) {}
        fn set_key_state(&mut self, key: minifb::Key, state: bool) {
            if let Some(q) = qnum_for(key) { let _ = self.0.send(In::Key(q, state)); }
        }
    }
    win.set_input_callback(Box::new(KbCb(itx2)));

    while win.is_open() {
        win.update(); // events only — EGL renders into this window directly
        if let Some((mx, my)) = win.get_mouse_pos(minifb::MouseMode::Pass) {
            let (ww, wh) = win.get_size();
            let inb = mx >= 0.0 && my >= 0.0 && mx < ww as f32 && my < wh as f32;
            if inb && (mx, my) != mouse {
                mouse = (mx, my);
                pending_abs = Some((mx, my));
            }
        }
        for (i, b) in [minifb::MouseButton::Left, minifb::MouseButton::Middle,
                       minifb::MouseButton::Right].into_iter().enumerate() {
            let d = win.get_mouse_down(b);
            if d != btns[i] {
                btns[i] = d;
                if let Some((ax, ay)) = pending_abs.take() {
                    let (gx, gy) = to_guest(&win, ax, ay);
                    let _ = itx.send(In::Move(gx, gy));
                    last_pos_send = std::time::Instant::now();
                }
                let _ = itx.send(In::Btn(i as u8, d));
            }
        }
        // coalesce position events — ~120Hz is enough for absolute pointer
        if let Some((ax, ay)) = pending_abs {
            if last_pos_send.elapsed().as_millis() > 8 {
                pending_abs = None;
                last_pos_send = std::time::Instant::now();
                let (gx, gy) = to_guest(&win, ax, ay);
                let _ = itx.send(In::Move(gx, gy));
            }
        }
    }
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
    let mut probes: Vec<String> = Vec::new();
    let mut clipboard = true;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--no-clipboard" => clipboard = false,
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
            _ => {}
        }
    }
    eprintln!("[*] monitor: {monitor} size={w}x{h}");

    // channel #1: control conn (VM/Console objects)
    let s1 = open_dbus_channel(&monitor).context("dbus channel")?;
    s1.set_nonblocking(true)?;
    let conn = connection::Builder::unix_stream(tokio::net::UnixStream::from_std(s1)?).p2p().build().await
        .context("p2p conn to qemu")?;

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
        let boot = qemu_boot_id(&pidfile);
        if let Some((pid, start)) = boot {
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    if qemu_boot_id(&pidfile) != Some((pid, start)) {
                        eprintln!("[*] qemu display channel lost — exiting");
                        std::process::exit(1);
                    }
                }
            });
        }
    }

    // One window thread per guest console — multi-head guests (virtio
    // outputs[]) span host monitors. The console id rides in the title
    // ("cruiser:<vm>:<i>") so the session can correlate window → monitor.
    let multi = consoles.len() > 1;
    // Register every listener on the control conn BEFORE opening the input
    // channel — QEMU's @dbus-display drops the enumeration conn once
    // listeners are attached, and extra client channels get EPIPE'd, so the
    // single input conn must be opened last and shared by all consoles.
    struct Pending { cpath: String, jrx: std::sync::mpsc::Receiver<XJob>,
                     dims: std::sync::Arc<Dims> }
    let mut pending = Vec::new();
    let mut _lconns = Vec::new();
    for &ci in &consoles {
        let cpath = zbus::zvariant::ObjectPath::try_from(format!("/org/qemu/Display1/Console_{ci}"))?;
        let console = zbus::Proxy::new(&conn, "org.qemu", cpath.clone(), "org.qemu.Display1.Console").await?;
        let (jtx, jrx) = std::sync::mpsc::channel::<XJob>();
        let dims = std::sync::Arc::new(Dims { w: AtomicU64::new(w as u64), h: AtomicU64::new(h as u64) });
        let (s2, p2) = UnixStream::pair()?;
        console.call::<_, _, ()>("RegisterListener", &(Fd::from(p2.as_fd()),)).await?;
        drop(p2);
        s2.set_nonblocking(true)?;
        let lc = connection::Builder::unix_stream(tokio::net::UnixStream::from_std(s2)?)
            .serve_at("/org/qemu/Display1/Listener", Listener { tx: jtx.clone(), id: ci })?
            .serve_at("/org/qemu/Display1/Listener", UnixDmabuf2 { tx: jtx, dims: dims.clone(), id: ci })?
            .p2p().build().await?;
        _lconns.push(lc);
        pending.push(Pending { cpath: cpath.to_string(), jrx, dims });
    }

    // One shared conn for every console's Keyboard/Mouse calls — built async
    // (blocking::build() would block_on inside the tokio runtime and panic),
    // then wrapped for the sync input workers. This is the LAST add_client
    // channel, so QEMU binds its object tree to it — which makes it the only
    // place the Clipboard skeleton is reachable: the clipboard peer object
    // rides this conn too (QEMU proxies Clipboard calls back to the conn the
    // Register came from).
    let (clip_tx, clip_rx) = std::sync::mpsc::channel::<ClipEv>();
    let clip_state = std::sync::Arc::new(std::sync::Mutex::new(ClipShared::default()));
    let clip_serial = std::sync::Arc::new(AtomicU64::new(0));
    let si = open_dbus_channel(&monitor).context("input dbus channel")?;
    si.set_nonblocking(true)?;
    let mut ib = connection::Builder::unix_stream(tokio::net::UnixStream::from_std(si)?).p2p();
    if clipboard {
        ib = ib.serve_at("/org/qemu/Display1/Clipboard", ClipPeer {
            st: clip_state.clone(), serial: clip_serial.clone(), evtx: clip_tx,
        })?;
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

    let mut joins = Vec::new();
    for (i, p) in pending.into_iter().enumerate() {
        let ci = p.cpath.rsplit('_').next().unwrap_or("0").to_string();
        let t = if multi { format!("{title}:{ci}") } else { title.clone() };
        let ic = iconn.clone();
        let hd = heads.clone();
        joins.push(std::thread::spawn(move || {
            let r = present_window(ic, &p.cpath, i, &t, w, h, p.jrx, p.dims, hd);
            eprintln!("[*] window closed ({t}) — {r:?}");
        }));
    }
    eprintln!("[*] {} console(s) registered — windows spawned", _lconns.len());
    for j in joins { let _ = j.join(); }
    eprintln!("[*] all windows closed — exiting");
    Ok(())
}
