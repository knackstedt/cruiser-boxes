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
        NumLock => 0x45, ScrollLock => 0x46,
        NumPad7 => 0x47, NumPad8 => 0x48, NumPad9 => 0x49, NumPadMinus => 0x4a,
        NumPad4 => 0x4b, NumPad5 => 0x4c, NumPad6 => 0x4d, NumPadPlus => 0x4e,
        NumPad1 => 0x4f, NumPad2 => 0x50, NumPad3 => 0x51, NumPad0 => 0x52,
        NumPadDot => 0x53, NumPadAsterisk => 0x37, NumPadEnter => 0x9c,
        NumPadSlash => 0xb5,
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
enum EscAct { Desktop(u32), Cycle(i8), Ungrab, Noop, Cmd(String) }

#[derive(Clone)]
struct EscCombo {
    mods: u8,   /* 1=ctrl 2=alt 4=shift 8=meta */
    trig: u32,  /* qnum for the KbCb match path */
    xkey: u32,  /* X keycode for the root passive-grab match path */
    xmods: u32, /* X modifier mask (Shift|Control|Mod1|Mod4) */
    act: EscAct,
}

/// QEMU qnum → X keycode. XT scancodes are evdev-1 for the base block
/// (X keycode = evdev + 8); the e0-extended block maps back through the
/// same table qnum_for uses.
fn xkey_for(qnum: u32) -> Option<u32> {
    let ev = if qnum < 0x80 { qnum } else { match qnum {
        0x9c => 96, 0x9d => 97, 0xb5 => 98, 0xb8 => 100, 0xc7 => 102,
        0xc8 => 103, 0xc9 => 104, 0xcb => 105, 0xcd => 106, 0xcf => 107,
        0xd0 => 108, 0xd1 => 109, 0xd2 => 110, 0xd3 => 111, 0xdb => 125,
        0xdc => 126, _ => return None,
    }};
    Some(ev + 8)
}

/// our mod byte (1=ctrl 2=alt 4=shift 8=meta) → X modifier mask
/// (ShiftMask|ControlMask|Mod1Mask|Mod4Mask).
fn xmods_of(m: u8) -> u32 {
    (m as u32 & 1) << 2 | (m as u32 & 2) << 2 | (m as u32 & 4) >> 2 | (m as u32 & 8) << 3
}

/// Shared per-head escape state: the combo table is static, enabled
/// mirrors --grab (escape interception runs for every focused head so a
/// combo can't fall to the host during a grab gap — the kglobalaccel
/// copies are uninstalled under --grab, so nothing double-fires), and
/// ungrab_req carries the "ungrab" action from the input callback.
struct EscState {
    enabled: bool,
    combos: Vec<EscCombo>,
    grab_active: std::sync::atomic::AtomicBool,
    ungrab_req: std::sync::atomic::AtomicBool,
}

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
        "ungrab" => EscAct::Ungrab,
        "none" => EscAct::Noop,
        "command" => EscAct::Cmd(arg?.to_string()),
        _ => return None,
    };
    Some(EscCombo { mods, trig, xkey: xkey_for(trig)?, xmods: xmods_of(mods), act })
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

impl EscState {
    fn fire(&self, combo: &EscCombo, title: &str) {
        match &combo.act {
            EscAct::Ungrab => { self.ungrab_req.store(true, Ordering::Relaxed); }
            EscAct::Noop => { eprintln!("[+{}s][esc] combo → none ({title})", ts()); }
            EscAct::Cmd(c) => {
                let c = c.clone();
                let t = title.to_string();
                std::thread::spawn(move || {
                    eprintln!("[+{}s][esc] combo → sh -c `{c}` ({t})", ts());
                    let _ = std::process::Command::new("sh").args(["-c", &c]).spawn();
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
                    let mut ok = false;
                    for bin in ["qdbus6", "qdbus"] {
                        ok = run_quiet(bin, &[
                            "org.kde.kglobalaccel".to_string(),
                            "/component/kwin".to_string(),
                            "org.kde.kglobalaccel.Component.invokeShortcut".to_string(),
                            name.clone()]);
                        if ok { break; }
                    }
                    if !ok {
                        ok = run_quiet("gdbus", &[
                            "call".to_string(), "--session".to_string(),
                            "--dest".to_string(), "org.kde.kglobalaccel".to_string(),
                            "--object-path".to_string(), "/component/kwin".to_string(),
                            "--method".to_string(), "org.kde.kglobalaccel.Component.invokeShortcut".to_string(),
                            name.clone()]);
                    }
                    if !ok { ok = ewmh_switch(&a); }
                    eprintln!("[+{}s][esc] desktop nav '{name}' → {}", ts(), if ok { "ok" } else { "FAILED" });
                });
            }
        }
    }
}

#[link(name = "X11")]
extern "C" {
    fn XOpenDisplay(name: *const u8) -> *mut std::ffi::c_void;
    fn XCloseDisplay(d: *mut std::ffi::c_void) -> i32;
    fn XInternAtom(d: *mut std::ffi::c_void, name: *const u8, only_if_exists: i32) -> u64;
    fn XChangeProperty(d: *mut std::ffi::c_void, w: u64, prop: u64, typ: u64,
                       fmt: i32, mode: i32, data: *const u8, nelem: i32);
    fn XFlush(d: *mut std::ffi::c_void);
    fn XkbGetNamedIndicator(d: *mut std::ffi::c_void, device_spec: u32, name: u64,
                            ndx: *mut i32, state: *mut i32, map: *mut std::ffi::c_void) -> i32;
    fn XGrabKeyboard(d: *mut std::ffi::c_void, grab_window: u64, owner_events: i32,
                     pointer_mode: i32, keyboard_mode: i32, time: u64) -> i32;
    fn XUngrabKeyboard(d: *mut std::ffi::c_void, time: u64) -> i32;
    fn XSelectInput(d: *mut std::ffi::c_void, w: u64, mask: i64);
    fn XPending(d: *mut std::ffi::c_void) -> i32;
    fn XNextEvent(d: *mut std::ffi::c_void, ev: *mut XEvBuf) -> i32;
    fn XPeekEvent(d: *mut std::ffi::c_void, ev: *mut XEvBuf) -> i32;
    fn XGetInputFocus(d: *mut std::ffi::c_void, w: *mut u64, revert: *mut i32) -> i32;
    fn XSendEvent(d: *mut std::ffi::c_void, w: u64, propagate: i32,
                  mask: i64, ev: *mut XEvBuf) -> i32;
    fn XGrabKey(d: *mut std::ffi::c_void, keycode: i32, modifiers: u32,
                grab_window: u64, owner_events: i32, pointer_mode: i32,
                keyboard_mode: i32);
    fn XRootWindow(d: *mut std::ffi::c_void, screen: i32) -> u64;
}

/// 192-byte XEvent union — only the leading type/serial/send_event fields
/// are read; the rest is re-sent verbatim.
#[repr(C)]
union XEvBuf { any: XAnyEv, key: XKeyEv, _pad: [u64; 24] }

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

/// Host NumLock via the XKB "Num Lock" virtual indicator (XkbUseCoreKbd
/// device). Going through the named indicator instead of locked_mods &
/// Mod2 keeps working if the numlock modifier got remapped.
fn host_numlock(dpy: *mut std::ffi::c_void, num_atom: u64) -> Option<bool> {
    if dpy.is_null() || num_atom == 0 { return None; }
    let mut ndx = 0i32;
    let mut st = 0i32;
    unsafe {
        if XkbGetNamedIndicator(dpy, 0x0100, num_atom, &mut ndx, &mut st,
                                std::ptr::null_mut()) != 0 {
            Some(st != 0)
        } else {
            None
        }
    }
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

#[allow(clippy::too_many_arguments)]
fn present_window(iconn: std::sync::Arc<zbus::blocking::Connection>,
                  console_path: &str, console_idx: usize, title: &str, w: usize, h: usize,
                  jrx: std::sync::mpsc::Receiver<XJob>, dims: std::sync::Arc<Dims>,
                  heads: std::sync::Arc<Heads>, esc: std::sync::Arc<EscState>) -> Result<()> {
    use minifb::{Window, WindowOptions};
    let mut win = Window::new(title, w, h, WindowOptions { resize: true, ..WindowOptions::default() })?;
    win.limit_update_rate(Some(std::time::Duration::from_micros(2000)));

    // persistent X conn: EWMH identity sets at init, then polled for the
    // host's NumLock state in the event loop (see below)
    let mut xdpy: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut num_atom = 0u64;
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
                    XFlush(d);
                    xdpy = d;
                }
            }
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
    let ic2 = iconn.clone();
    std::thread::spawn(move || input_worker(ic2, cp, irx));

    let mut mouse = (-1.0f32, -1.0f32);
    let mut btns = [false; 3];
    let mut last_pos_send = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let mut pending_abs: Option<(f32, f32)> = None;
    let mut scroll_acc = 0.0f32;

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

    // qnums the guest currently believes are held — drained into key-up
    // events on focus loss so the release half of a combo the WM consumed
    // (alt-tab et al.) can't leave a modifier stuck down in the guest.
    let pressed = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::<u32>::new()));
    // Shared with KbCb: triggers whose press fired an escape get swallowed —
    // cleared on focus loss too, else a release that lands outside the
    // window (VD switch steals focus mid-combo) leaves the trigger dead
    // forever ("escape worked once, then nothing").
    let swallowed = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::<u32>::new()));
    let itx2 = itx.clone();
    let esc2 = esc.clone();
    let title2 = title.to_string();
    let swallowed2 = swallowed.clone();
    struct KbCb {
        tx: std::sync::mpsc::Sender<In>,
        pressed: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<u32>>>,
        /// triggers whose press fired an escape action — their release (and
        /// autorepeat re-presses) are swallowed instead of forwarded.
        swallowed: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<u32>>>,
        esc: std::sync::Arc<EscState>,
        title: String,
    }
    impl minifb::InputCallback for KbCb {
        fn add_char(&mut self, _c: u32) {}
        fn set_key_state(&mut self, key: minifb::Key, state: bool) {
            let Some(q) = qnum_for(key) else { return };
            // swallowed trigger: drop the release/repeat without forwarding
            {
                let mut sw = self.swallowed.lock().unwrap();
                if sw.contains(&q) {
                    if !state { sw.remove(&q); }
                    return;
                }
            }
            // Intercept whenever the viewer runs under --grab: the grab
            // can drop transiently (focus races, server grabs) and a combo
            // that slips through falls to the host's own bindings — worse
            // than dispatching ourselves. Under --grab the kglobalaccel
            // copies are never installed, so there's no double-fire.
            if state && self.esc.enabled {
                let combo = self.esc.combos.iter().find(|c| c.trig == q).and_then(|c| {
                    // held-modifier bitmask must equal the combo's exactly
                    let p = self.pressed.lock().unwrap();
                    let held = [M_CTRL, M_ALT, M_SHIFT, M_META].iter().enumerate()
                        .fold(0u8, |b, (i, g)| b | ((g.iter().any(|k| p.contains(k))) as u8) << i);
                    (held == c.mods).then(|| c.clone())
                });
                if let Some(c) = combo {
                    self.swallowed.lock().unwrap().insert(q);
                    // lift the combo's forwarded halves so the guest isn't
                    // left with phantom held modifiers while we run the
                    // host action
                    let mut p = self.pressed.lock().unwrap();
                    for g in [M_CTRL, M_ALT, M_SHIFT, M_META] {
                        for k in g { if p.remove(&k) { let _ = self.tx.send(In::Key(k, false)); } }
                    }
                    drop(p);
                    self.esc.fire(&c, &self.title);
                    return;
                }
            }
            {
                let mut p = self.pressed.lock().unwrap();
                if state { p.insert(q); } else { p.remove(&q); }
            }
            let _ = self.tx.send(In::Key(q, state));
        }
    }
    win.set_input_callback(Box::new(KbCb {
        tx: itx2, pressed: pressed.clone(), swallowed: swallowed2,
        esc: esc2, title: title2,
    }));

    // numlock reconcile — guest lock state is exposed as the Keyboard
    // "Modifiers" property (Scroll|Num|Caps = bits 0|1|2). NumLock presses
    // while focused ride the normal key path, but toggles made while
    // unfocused (and the guest's boot default) never reach the guest, so
    // poll host XKB state vs the property and inject a NumLock pulse when
    // they diverge. Console 0 only: NumLock is guest-global and N heads
    // reconciling could double-toggle inside one application window.
    let kbd_iface = if console_idx == 0 {
        zbus::blocking::Proxy::new(&iconn, "org.qemu", console_path,
            "org.qemu.Display1.Keyboard").ok()
    } else { None };
    let mut last_num_sync = std::time::Instant::now() - std::time::Duration::from_secs(1);

    // Host-wide passive grabs for the escape combos — the same mechanism
    // global hotkeys use, so combos fire while the VM isn't focused (and
    // while focused-but-ungrabbed, where the passive grab consumes the
    // trigger before it reaches the window — never double-firing with the
    // active-grab path, which shadows passive grabs entirely). Console 0
    // only: passive grabs are per-connection and extra heads would just
    // BadAccess. Four registrations per combo cover numlock/capslock
    // (LockMask|Mod2Mask) states. A combo already grabbed by the WM loses
    // with an async BadAccess — logged, not fatal.
    if console_idx == 0 && !xdpy.is_null() && !esc.combos.is_empty() {
        unsafe {
            let root = XRootWindow(xdpy, 0);
            XSelectInput(xdpy, root, 0x3);
            for c in &esc.combos {
                for lock in [0u32, 2, 16, 18] {
                    XGrabKey(xdpy, c.xkey as i32, c.xmods | lock, root, 0, 1, 1);
                }
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

    // Keyboard grab (--grab = spec.display.grabKeyboard on the dmabuf
    // viewer): minifb has no grab, so while a head is focused we hold an
    // X11 keyboard grab — host-global combos (alt-tab, super, …) reach the
    // guest instead of the WM, matching freerdp +grab-keyboard semantics.
    // Focus loss ungrabs (grab dies with the conn on exit anyway); the
    // `ungrab` escape action holds the grab off until the focus cycles.
    let mut was_active = false;
    let mut grabbed = false;
    let mut grab_hold_off = false;
    let mut last_grab_try = std::time::Instant::now() - std::time::Duration::from_secs(1);

    while win.is_open() {
        win.update(); // events only — EGL renders into this window directly
        let active = win.is_active();
        if !active { grab_hold_off = false; }
        if esc.enabled && !xdpy.is_null() {
            if esc.ungrab_req.swap(false, Ordering::Relaxed) {
                grab_hold_off = true;
                if grabbed {
                    unsafe {
                        XUngrabKeyboard(xdpy, 0);
                        XSelectInput(xdpy, xwin_id, 0);
                        XFlush(xdpy);
                    }
                    grabbed = false;
                    esc.grab_active.store(false, Ordering::Relaxed);
                }
                eprintln!("[+{}s][grab] ungrabbed via escape ({title}) — re-grabs on refocus", ts());
            }
            if active && !grabbed && !grab_hold_off && last_grab_try.elapsed().as_millis() > 500 {
                // retry while focused — a grab attempt loses to any
                // transient server grab (e.g. KWin's own alt-tab tabbox)
                last_grab_try = std::time::Instant::now();
                grabbed = unsafe { XGrabKeyboard(xdpy, xwin_id, 1, 1, 1, 0) } == 0;
                if grabbed {
                    // Grabbed keys are delivered ONLY to the grabbing client
                    // — xdpy owns no windows, so without this select+reinject
                    // every key vanishes into the grab. Forward each real
                    // event back to the window as a synthetic copy: send_event
                    // delivery ignores grabs, and minifb's conn processes it
                    // through KbCb like any normal key.
                    unsafe { XSelectInput(xdpy, xwin_id, 0x3); XFlush(xdpy); }
                    eprintln!("[+{}s][grab] keyboard grabbed ({title})", ts());
                }
                esc.grab_active.store(grabbed, Ordering::Relaxed);
            } else if !active && grabbed {
                unsafe {
                    XUngrabKeyboard(xdpy, 0);
                    XSelectInput(xdpy, xwin_id, 0);
                    XFlush(xdpy);
                }
                grabbed = false;
                esc.grab_active.store(false, Ordering::Relaxed);
                eprintln!("[+{}s][grab] keyboard ungrabbed ({title})", ts());
            }
        }
        // Drain xdpy whenever combos exist — not only under --grab: the
        // root passive grabs need servicing even when no head is grabbed.
        // While grabbed, real events are reinjected as synthetic copies;
        // ungrabbed, a real KeyPress here is a passive-grab fire → dispatch
        // the escape action. Our own send_event copies are filtered.
        if !xdpy.is_null() && !esc.combos.is_empty() {
            while unsafe { XPending(xdpy) } > 0 {
                let mut ev: XEvBuf = unsafe { std::mem::zeroed() };
                unsafe { XNextEvent(xdpy, &mut ev); }
                let a = unsafe { ev.any };
                if a.send_event != 0 { continue; }
                if grabbed && (a.t == 2 || a.t == 3) {
                    let m = if a.t == 2 { 1 } else { 2 }; // KeyPressMask|KeyReleaseMask
                    unsafe { XSendEvent(xdpy, xwin_id, 0, m, &mut ev); }
                } else if !grabbed {
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
                                esc.fire(&esc.combos[i].clone(), &title);
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
                        if focus > 1 { // not None(0)/PointerRoot(1)
                            let m = if a.t == 2 { 1 } else { 2 };
                            unsafe { XSendEvent(xdpy, focus, 0, m, &mut ev); }
                        }
                    }
                }
            }
            unsafe { XFlush(xdpy); }
        }
        if was_active && !active {
            swallowed.lock().unwrap().clear();
            let ups: Vec<u32> = pressed.lock().unwrap().drain().collect();
            for q in ups { let _ = itx.send(In::Key(q, false)); }
            for (i, d) in btns.iter_mut().enumerate() {
                if *d { *d = false; let _ = itx.send(In::Btn(i as u8, false)); }
            }
        }
        was_active = active;
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
        // wheel scroll — QEMU models scroll as wheel-button pulses (up=3,
        // down=4; see ui/dbus-display1.xml). The virtio tablet only maps
        // vertical (REL_WHEEL is its sole rel axis — REL_HWHEEL would log
        // "unmapped button"), so horizontal deltas are dropped. minifb
        // gives ±1.0 per notch on X11; accumulate so any sub-notch delta
        // still converges on a full pulse.
        if let Some((_sx, sy)) = win.get_scroll_wheel() {
            scroll_acc += sy;
        }
        while scroll_acc.abs() >= 1.0 {
            // land the pending position first — the wheel acts wherever
            // the tablet's abs pointer currently sits
            if let Some((ax, ay)) = pending_abs.take() {
                let (gx, gy) = to_guest(&win, ax, ay);
                let _ = itx.send(In::Move(gx, gy));
                last_pos_send = std::time::Instant::now();
            }
            let b = if scroll_acc > 0.0 { 3u8 } else { 4u8 };
            let _ = itx.send(In::Btn(b, true));
            let _ = itx.send(In::Btn(b, false));
            scroll_acc -= scroll_acc.signum();
        }
        if let Some(kbd) = &kbd_iface {
            if last_num_sync.elapsed().as_millis() >= 500 {
                last_num_sync = std::time::Instant::now();
                let mods = kbd.get_property::<u32>("Modifiers").ok();
                if let (Some(host), Some(m)) = (host_numlock(xdpy, num_atom), mods) {
                    if host != (m & 0x2 != 0) {
                        let _ = itx.send(In::Key(0x45, true));  // Q_KEY_CODE num_lock
                        let _ = itx.send(In::Key(0x45, false));
                        eprintln!("[input] numlock sync: host={host} guest={} — toggled",
                            m & 0x2 != 0);
                    }
                }
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
    let mut probes: Vec<String> = Vec::new();
    let mut clipboard = true;
    let mut grab = false;
    let mut escapes: Vec<EscCombo> = Vec::new();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--no-clipboard" => clipboard = false,
            // grab the keyboard while a head is focused (spec.display.grabKeyboard)
            "--grab" => grab = true,
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

    if grab && !escapes.is_empty() {
        eprintln!("[*] {} escape combo(s) grabbed host-wide", escapes.len());
    }
    let mut joins = Vec::new();
    for (i, p) in pending.into_iter().enumerate() {
        let ci = p.cpath.rsplit('_').next().unwrap_or("0").to_string();
        let t = if multi { format!("{title}:{ci}") } else { title.clone() };
        let ic = iconn.clone();
        let hd = heads.clone();
        let esc = std::sync::Arc::new(EscState {
            enabled: grab,
            combos: escapes.clone(),
            grab_active: std::sync::atomic::AtomicBool::new(false),
            ungrab_req: std::sync::atomic::AtomicBool::new(false),
        });
        joins.push(std::thread::spawn(move || {
            let r = present_window(ic, &p.cpath, i, &t, w, h, p.jrx, p.dims, hd, esc);
            eprintln!("[*] window closed ({t}) — {r:?}");
        }));
    }
    eprintln!("[*] {} console(s) registered — windows spawned", _lconns.len());
    for j in joins { let _ = j.join(); }
    eprintln!("[*] all windows closed — exiting");
    Ok(())
}
