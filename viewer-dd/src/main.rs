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
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
mod egl;
use zbus::connection;
use zvariant::{Fd, OwnedFd as ZOwnedFd};

static DM_BUFS: AtomicU64 = AtomicU64::new(0);
static UPDATES: AtomicU64 = AtomicU64::new(0);
static XJOB: once_cell::sync::OnceCell<std::sync::mpsc::Sender<XJob>> = once_cell::sync::OnceCell::new();

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
fn open_dbus_channel(monitor: &str) -> Result<UnixStream> {
    let (s, p) = UnixStream::pair()?;
    let mut mon = UnixStream::connect(monitor)?;
    let mut g = vec![0u8; 512];
    let _ = mon.read(&mut g); // greeting
    qmp(&mut mon, r#"{"execute":"qmp_capabilities"}"#, None)?;
    qmp(&mut mon, r#"{"execute":"getfd","arguments":{"fdname":"vdd"}}"#, Some(p.as_raw_fd()))?;
    qmp(&mut mon, r#"{"execute":"add_client","arguments":{"protocol":"@dbus-display","fdname":"vdd"}}"#, None)?;
    drop(mon);
    Ok(s)
}

// ── D-Bus listener objects QEMU calls into ──

struct Listener;
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
        if let Some(tx) = XJOB.get() { let _ = tx.send(XJob::Nudge); }
    }
    fn disable(&mut self) { eprintln!("[listener] Disable"); }
    fn mouse_set(&mut self, _x: i32, _y: i32, _on: i32) {}
    fn cursor_define(&mut self, _w: i32, _h: i32, _hx: i32, _hy: i32, _data: Vec<u8>) {}
    #[zbus(property)]
    fn interfaces(&self) -> Vec<String> {
        vec!["org.qemu.Display1.Listener.Unix.ScanoutDMABUF2".to_string()]
    }
}

struct UnixDmabuf2;
#[zbus::interface(name = "org.qemu.Display1.Listener.Unix.ScanoutDMABUF2")]
impl UnixDmabuf2 {
    #[zbus(name = "ScanoutDMABUF2")]
    #[allow(clippy::too_many_arguments)]
    fn scanout_dmabuf2(&mut self, dmabufs: Vec<ZOwnedFd>, _x: u32, _y: u32, width: u32, height: u32,
                       offsets: Vec<u32>, strides: Vec<u32>, num_planes: u32, fourcc: u32,
                       backing_width: u32, backing_height: u32, modifier: u64, y0_top: bool) {
        let n = DM_BUFS.fetch_add(1, Ordering::Relaxed) + 1;
        if n % 120 == 1 {
            eprintln!("[listener] ScanoutDMABUF2#{n} planes={num_planes} {width}x{height} strides={strides:?} fourcc={} modifier=0x{modifier:x} backing={backing_width}x{backing_height} y0_top={y0_top}",
                fourcc_str(fourcc));
        }
        if dmabufs.is_empty() || num_planes == 0 { return; }
        // hand the fd to the GL worker while it's live — QEMU fds can lose
        // their GEM backing within ~ms of the callback
        let d = unsafe { std::os::fd::OwnedFd::from_raw_fd(libc::dup(dmabufs[0].as_raw_fd())) };
        let off = offsets.first().copied().unwrap_or(0);
        if off != 0 && num_planes > 1 { return; } // multi-plane not supported
        if let Some(tx) = XJOB.get() {
            let _ = tx.send(XJob::Fd(d, width, height, strides[0], fourcc, modifier, y0_top));
        }
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
        Insert => 0xd2, Delete => 0xd3, LeftMeta => 0xdb, RightMeta => 0xdc,
        _ => return None,
    })
}

fn input_worker(s: UnixStream, path: String, rx: std::sync::mpsc::Receiver<In>) {
    let conn = zbus::blocking::connection::Builder::async_io_unix_stream(s)
        .p2p().build().expect("input conn");
    let kbd = zbus::blocking::Proxy::new(&conn, "org.qemu", path.as_str(),
        "org.qemu.Display1.Keyboard").expect("kbd proxy");
    let mouse = zbus::blocking::Proxy::new(&conn, "org.qemu", path.as_str(),
        "org.qemu.Display1.Mouse").expect("mouse proxy");
    while let Ok(ev) = rx.recv() {
        let r: Result<(), zbus::Error> = (|| match ev {
            In::Move(x, y) => mouse.call::<_, _, ()>("SetAbsPosition", &(x, y)),
            In::Btn(b, d) => mouse.call::<_, _, ()>(if d { "Press" } else { "Release" }, &(b as u32,)),
            In::Key(k, d) => kbd.call::<_, _, ()>(if d { "Press" } else { "Release" }, &(k,)),
        })();
        if let Err(e) = r { eprintln!("[input] {e}"); }
    }
}

fn present_window(monitor: &str, console_path: &str, title: &str, w: usize, h: usize,
                  jrx: std::sync::mpsc::Receiver<XJob>) -> Result<()> {
    use minifb::{Window, WindowOptions};
    let mut win = Window::new(title, w, h, WindowOptions { resize: true, ..WindowOptions::default() })?;
    win.limit_update_rate(Some(std::time::Duration::from_micros(2000)));

    // GL worker owns the EGL context — all device calls are single-threaded
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let wh = win.window_handle().unwrap();
        if let RawWindowHandle::Xlib(xw) = wh.as_raw() {
            let xid = xw.window;
            std::thread::spawn(move || {
                if let Err(e) = egl::x11_present_init(xid, w as i32, h as i32) {
                    eprintln!("[xegl] init failed: {e:#}");
                    return;
                }
                eprintln!("[xegl] worker ready");
                while let Ok(first) = jrx.recv() {
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
                        if let Err(e) = egl::x11_import_and_present(fd.as_raw_fd(), w2, h2, stride, fourcc, modifier, y0) {
                            static XF: AtomicU64 = AtomicU64::new(0);
                            let n = XF.fetch_add(1, Ordering::Relaxed) + 1;
                            if n % 120 == 1 { eprintln!("[xegl] import failed x{n}: {e:#}"); }
                        }
                    } else if dirty {
                        if let Err(e) = egl::x11_redraw() {
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

    // dedicated input channel
    let s3 = open_dbus_channel(monitor)?;
    let (itx, irx) = std::sync::mpsc::channel::<In>();
    let cp = console_path.to_string();
    std::thread::spawn(move || input_worker(s3, cp, irx));

    let mut mouse = (-1.0f32, -1.0f32);
    let mut btns = [false; 3];
    let mut last_pos_send = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let mut pending_abs: Option<(u32, u32)> = None;
    let (sw, sh) = (w as f32, h as f32);

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
            let inb = mx >= 0.0 && my >= 0.0 && mx < sw && my < sh;
            if inb && (mx, my) != mouse {
                mouse = (mx, my);
                pending_abs = Some((mx as u32, my as u32));
            }
        }
        for (i, b) in [minifb::MouseButton::Left, minifb::MouseButton::Middle,
                       minifb::MouseButton::Right].into_iter().enumerate() {
            let d = win.get_mouse_down(b);
            if d != btns[i] {
                btns[i] = d;
                if let Some((ax, ay)) = pending_abs.take() {
                    let _ = itx.send(In::Move(ax, ay));
                    last_pos_send = std::time::Instant::now();
                }
                let _ = itx.send(In::Btn(i as u8, d));
            }
        }
        // coalesce position events — ~30Hz is enough for absolute pointer
        if let Some((ax, ay)) = pending_abs {
            if last_pos_send.elapsed().as_millis() > 33 {
                pending_abs = None;
                last_pos_send = std::time::Instant::now();
                let _ = itx.send(In::Move(ax, ay));
            }
        }
    }
    Ok(())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 1)]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let monitor = args.next().context("usage: viewer-dd <monitor.sock> [--title T] [--size WxH]")?;
    let mut title = "cruiser-dd".to_string();
    let mut w = 1920usize;
    let mut h = 1080usize;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--title" => title = args.next().unwrap_or(title),
            "--size" => {
                if let Some(s) = args.next() {
                    if let Some((x, y)) = s.split_once('x') {
                        w = x.parse().unwrap_or(w);
                        h = y.parse().unwrap_or(h);
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

    // channel #2: our listener end → RegisterListener
    let cpath = zbus::zvariant::ObjectPath::try_from(format!("/org/qemu/Display1/Console_{}", consoles[0]))?;
    let console = zbus::Proxy::new(&conn, "org.qemu", cpath.clone(), "org.qemu.Display1.Console").await?;
    let (jtx, jrx) = std::sync::mpsc::channel::<XJob>();
    let _ = XJOB.set(jtx);
    let (s2, p2) = UnixStream::pair()?;
    console.call::<_, _, ()>("RegisterListener", &(Fd::from(p2.as_fd()),)).await?;
    drop(p2);
    eprintln!("[*] RegisterListener ok");

    s2.set_nonblocking(true)?;
    let _lconn = connection::Builder::unix_stream(tokio::net::UnixStream::from_std(s2)?)
        .serve_at("/org/qemu/Display1/Listener", Listener)?
        .serve_at("/org/qemu/Display1/Listener", UnixDmabuf2)?
        .p2p().build().await?;
    eprintln!("[*] listener served — waiting for frames");

    present_window(&monitor, &cpath.to_string(), &title, w, h, jrx)
}
