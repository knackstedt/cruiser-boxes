// ddproto — shared QEMU org.qemu.Display1 p2p protocol plumbing, used by
// viewer-dd (direct attach) and ddproxy (display broker).
//
//   * qmp/qmp_run/open_dbus_channel — the getfd + add_client "@dbus-display"
//     handshake over the VM's QMP monitor socket.
//   * Listener/UnixMap/UnixDmabuf2 skeletons QEMU calls INTO (scanouts,
//     damage, cursor) — generic over a ConsoleEvents sink so both binaries
//     share the wire surface while routing events differently.
//   * ClipboardPeer — the symmetric org.qemu.Display1.Clipboard peer
//     skeleton, generic over ClipEvents.
//   * qemu_boot_id — pidfile + /proc starttime identity used by the
//     dead-QEMU watchdogs.

use anyhow::Result;
use std::io::{IoSlice, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::os::unix::net::UnixStream;
use zvariant::OwnedFd;

pub const CLIP_MIME: &str = "text/plain;charset=utf-8";
pub const SEL_CLIPBOARD: u32 = 0;
pub const CLIP_PATH: &str = "/org/qemu/Display1/Clipboard";
pub const VM_PATH: &str = "/org/qemu/Display1/VM";
pub const LISTENER_PATH: &str = "/org/qemu/Display1/Listener";
pub const IFACE_CLIP: &str = "org.qemu.Display1.Clipboard";
pub const IFACE_LISTENER: &str = "org.qemu.Display1.Listener";
pub const IFACE_LISTENER_MAP: &str = "org.qemu.Display1.Listener.Unix.Map";
pub const IFACE_LISTENER_DMABUF2: &str = "org.qemu.Display1.Listener.Unix.ScanoutDMABUF2";

/// `/org/qemu/Display1/Console_<id>` — QEMU numbers consoles by id.
pub fn console_path(id: u32) -> String {
    format!("/org/qemu/Display1/Console_{id}")
}

// ── QMP channel plumbing ──

pub fn qmp(mon: &mut UnixStream, cmd: &str, fd: Option<RawFd>) -> Result<String> {
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

/// One-shot QMP command: fresh monitor conn, caps negotiation, cmd.
pub fn qmp_run(monitor: &str, cmd: &str) -> Result<String> {
    let mut mon = UnixStream::connect(monitor)?;
    let mut g = vec![0u8; 2048];
    let _ = mon.read(&mut g); // greeting
    qmp(&mut mon, r#"{"execute":"qmp_capabilities"}"#, None)?;
    qmp(&mut mon, cmd, None)
}

/// Open a new p2p "@dbus-display" channel over the QMP monitor socket.
/// Each channel needs a unique QMP fdname — getfd names live in QEMU's
/// global monitor namespace, so concurrent opens under a shared "vdd" wire
/// the loser onto a stale fd (EPIPE at the p2p handshake).
pub fn open_dbus_channel(monitor: &str) -> Result<UnixStream> {
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

/// (pid, /proc starttime) of the QEMU that owns this display — None when the
/// pidfile is absent/unreadable or the process is gone.
pub fn qemu_boot_id(pidfile: &std::path::Path) -> Option<(u64, u64)> {
    let pid: u64 = std::fs::read_to_string(pidfile).ok()?.trim().parse().ok()?;
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // field 22 is starttime; comm (field 2) can contain spaces/parens — split
    // after the last ')' instead of naive whitespace splitting.
    let start: u64 = stat.rsplit(')').next()?.split_whitespace()
        .nth(19)?.parse().ok()?;
    Some((pid, start))
}

// ── Console listener skeletons (QEMU calls INTO these) ──

/// All events QEMU delivers on a console's listener conn, as a sink trait —
/// the skeleton structs are just wire adapters over it. `interfaces` reports
/// the optional listener ifaces the peer advertises (QEMU reads it to pick
/// ScanoutDMABUF2 over the legacy paths).
///
/// Signatures mirror QEMU's D-Bus wire shape — arity is the protocol.
#[allow(clippy::too_many_arguments)]
pub trait ConsoleEvents: Send {
    fn scanout(&mut self, _w: u32, _h: u32, _stride: u32, _fmt: u32, _data: Vec<u8>) {}
    fn update(&mut self, _x: i32, _y: i32, _w: i32, _h: i32, _stride: u32, _fmt: u32, _data: Vec<u8>) {}
    fn scanout_dmabuf(&mut self, _fd: OwnedFd, _w: u32, _h: u32, _stride: u32,
                      _fourcc: u32, _modifier: u64, _y0_top: bool) {}
    fn update_dmabuf(&mut self, _x: i32, _y: i32, _w: i32, _h: i32) {}
    fn scanout_map(&mut self, _fd: OwnedFd, _off: u32, _w: u32, _h: u32,
                   _stride: u32, _fmt: u32) {}
    fn update_map(&mut self, _x: i32, _y: i32, _w: i32, _h: i32) {}
    fn scanout_dmabuf2(&mut self, _fds: Vec<OwnedFd>, _x: u32, _y: u32, _w: u32, _h: u32,
                       _offsets: Vec<u32>, _strides: Vec<u32>, _planes: u32, _fourcc: u32,
                       _bw: u32, _bh: u32, _modifier: u64, _y0_top: bool) {}
    fn disable(&mut self) {}
    fn mouse_set(&mut self, _x: i32, _y: i32, _on: i32) {}
    fn cursor_define(&mut self, _w: i32, _h: i32, _hx: i32, _hy: i32, _data: Vec<u8>) {}
    fn interfaces(&self) -> Vec<String>;
}

/// One handler shared by every listener skeleton on the conn.
pub type SharedConsole = Arc<Mutex<dyn ConsoleEvents + Send>>;

pub fn shared_console<H: ConsoleEvents + Send + 'static>(h: H) -> SharedConsole {
    Arc::new(Mutex::new(h))
}

pub struct Listener {
    pub ev: SharedConsole,
}

#[zbus::interface(name = "org.qemu.Display1.Listener")]
#[allow(clippy::too_many_arguments)]
impl Listener {
    fn scanout(&mut self, w: u32, h: u32, stride: u32, fmt: u32, data: Vec<u8>) {
        self.ev.lock().unwrap().scanout(w, h, stride, fmt, data);
    }
    fn update(&mut self, x: i32, y: i32, w: i32, h: i32, stride: u32, fmt: u32, data: Vec<u8>) {
        self.ev.lock().unwrap().update(x, y, w, h, stride, fmt, data);
    }
    #[zbus(name = "ScanoutDMABUF")]
    fn scanout_dmabuf(&mut self, fd: OwnedFd, w: u32, h: u32, stride: u32,
                      fourcc: u32, modifier: u64, y0_top: bool) {
        self.ev.lock().unwrap().scanout_dmabuf(fd, w, h, stride, fourcc, modifier, y0_top);
    }
    #[zbus(name = "UpdateDMABUF")]
    fn update_dmabuf(&mut self, x: i32, y: i32, w: i32, h: i32) {
        // reply fast — QEMU gl-blocks the guest until this returns
        self.ev.lock().unwrap().update_dmabuf(x, y, w, h);
    }
    fn disable(&mut self) {
        self.ev.lock().unwrap().disable();
    }
    fn mouse_set(&mut self, x: i32, y: i32, on: i32) {
        self.ev.lock().unwrap().mouse_set(x, y, on);
    }
    fn cursor_define(&mut self, w: i32, h: i32, hx: i32, hy: i32, data: Vec<u8>) {
        self.ev.lock().unwrap().cursor_define(w, h, hx, hy, data);
    }
    #[zbus(property)]
    fn interfaces(&self) -> Vec<String> {
        self.ev.lock().unwrap().interfaces()
    }
}

pub struct UnixMap {
    pub ev: SharedConsole,
}

#[zbus::interface(name = "org.qemu.Display1.Listener.Unix.Map")]
impl UnixMap {
    #[zbus(name = "ScanoutMap")]
    fn scanout_map(&mut self, fd: OwnedFd, off: u32, w: u32, h: u32, stride: u32, fmt: u32) {
        self.ev.lock().unwrap().scanout_map(fd, off, w, h, stride, fmt);
    }
    #[zbus(name = "UpdateMap")]
    fn update_map(&mut self, x: i32, y: i32, w: i32, h: i32) {
        self.ev.lock().unwrap().update_map(x, y, w, h);
    }
}

pub struct UnixDmabuf2 {
    pub ev: SharedConsole,
}

#[zbus::interface(name = "org.qemu.Display1.Listener.Unix.ScanoutDMABUF2")]
impl UnixDmabuf2 {
    #[zbus(name = "ScanoutDMABUF2")]
    #[allow(clippy::too_many_arguments)]
    fn scanout_dmabuf2(&mut self, fds: Vec<OwnedFd>, x: u32, y: u32, w: u32, h: u32,
                       offsets: Vec<u32>, strides: Vec<u32>, planes: u32, fourcc: u32,
                       bw: u32, bh: u32, modifier: u64, y0_top: bool) {
        self.ev.lock().unwrap().scanout_dmabuf2(
            fds, x, y, w, h, offsets, strides, planes, fourcc, bw, bh, modifier, y0_top);
    }
}

// ── Clipboard peer skeleton ──
// QEMU's -chardev qemu-vdagent lands guest clipboard state in QEMU's
// clipboard core; -display dbus exposes it as org.qemu.Display1.Clipboard.
// Symmetric: we serve an object, call Register on QEMU's skeleton, and QEMU
// invokes Grab/Release/Request on ours while we invoke the same names back.

/// QEMU → peer calls. `request` must never block — QEMU stalls its main
/// loop on the reply.
pub trait ClipEvents: Send {
    /// QEMU resets the serial counter through our Register — both on our own
    /// Register call and any later session reset.
    fn register(&mut self) {}
    fn unregister(&mut self) {}
    fn grab(&mut self, _selection: u32, _serial: u32, _mimes: Vec<String>) {}
    fn release(&mut self, _selection: u32) {}
    fn request(&mut self, _selection: u32, _mimes: Vec<String>) -> zbus::fdo::Result<(String, Vec<u8>)> {
        Err(zbus::fdo::Error::Failed("no clipboard data".into()))
    }
}

pub struct ClipboardPeer {
    pub ev: Arc<Mutex<dyn ClipEvents + Send>>,
}

pub fn clip_peer<H: ClipEvents + Send + 'static>(h: H) -> ClipboardPeer {
    ClipboardPeer { ev: Arc::new(Mutex::new(h)) }
}

#[zbus::interface(name = "org.qemu.Display1.Clipboard")]
impl ClipboardPeer {
    fn register(&mut self) { self.ev.lock().unwrap().register(); }
    fn unregister(&mut self) { self.ev.lock().unwrap().unregister(); }
    fn grab(&mut self, selection: u32, serial: u32, mimes: Vec<String>) {
        self.ev.lock().unwrap().grab(selection, serial, mimes);
    }
    fn release(&mut self, selection: u32) { self.ev.lock().unwrap().release(selection); }
    fn request(&mut self, selection: u32, mimes: Vec<String>) -> zbus::fdo::Result<(String, Vec<u8>)> {
        self.ev.lock().unwrap().request(selection, mimes)
    }
}

/// Prop list both binaries advertise on the clipboard peer.
pub fn clip_ifaces() -> Vec<String> {
    vec![IFACE_CLIP.to_string()]
}
