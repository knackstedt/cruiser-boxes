// ============================================================================
// ddproxy — per-VM display broker for QEMU's @dbus-display backend.
//
// QEMU's p2p auth layer keeps effectively ONE client relationship and can
// wedge permanently ("EXTERNAL rejected") after viewer churn — once wedged,
// only a VM restart brings the console back. ddproxy owns the QEMU
// connection set (control + per-console listeners + input/clipboard) for
// the VM's whole lifetime and re-exports the same org.qemu.Display1 object
// tree to viewers on a plain unix socket, so viewer attach/detach/crash
// never reaches QEMU's auth surface.
//
//   QEMU ──(2 add_client conns + N RegisterListener fds, once at boot)──► ddproxy
//   viewer-dd ──(run/ddproxy.sock, unlimited reattach)──► ddproxy
//
// Extras over direct attach:
//   * damage decoupling — QEMU gl-blocks the guest until UpdateDMABUF
//     replies; the proxy replies instantly and streams to viewers async,
//     so a slow/hung viewer can't stall the guest
//   * state replay — last scanout/cursor/pointer per console is cached and
//     replayed on RegisterListener, so a mid-run attach isn't black
//   * multi-viewer — N viewers may attach; input is shared (last
//     clipboard Register wins, same as QEMU's own arbitration)
//
// Audio (RegisterOutListener/InListener) forwards the fd through to QEMU —
// unused until viewer-dd implements the audio interfaces.
// ============================================================================

use anyhow::{Context, Result};
use ddproto::{clip_ifaces, console_path, open_dbus_channel, qemu_boot_id,
              CLIP_PATH, IFACE_CLIP, IFACE_LISTENER, IFACE_LISTENER_DMABUF2,
              IFACE_LISTENER_MAP, LISTENER_PATH, VM_PATH};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use zbus::{connection, AuthMechanism};
use zvariant::{Fd, OwnedFd as ZOwnedFd};

const AUDIO_PATH: &str = "/org/qemu/Display1/Audio";
const IFACE_AUDIO: &str = "org.qemu.Display1.Audio";
const IFACE_CONSOLE: &str = "org.qemu.Display1.Console";
const IFACE_KBD: &str = "org.qemu.Display1.Keyboard";
const IFACE_MOUSE: &str = "org.qemu.Display1.Mouse";
const IFACE_MT: &str = "org.qemu.Display1.MultiTouch";

// ── per-console event bus + replay cache ──

/// ScanoutDMABUF2 args — fds held as Arc so the cached copy can be dup'd
/// per-viewer (SCM_RIGHTS is a dup, not a copy — still zero-copy). One fd
/// per plane — the viewer today uses plane 0, but the cache must keep the
/// whole set to forward faithfully.
#[derive(Clone)]
struct Scan2 {
    fds: Vec<Arc<OwnedFd>>,
    x: u32, y: u32, w: u32, h: u32,
    offsets: Vec<u32>, strides: Vec<u32>, planes: u32,
    fourcc: u32, bw: u32, bh: u32, modifier: u64, y0_top: bool,
}

#[derive(Clone)]
enum ConsoleEv {
    Scanout { w: u32, h: u32, stride: u32, fmt: u32, data: Arc<Vec<u8>> },
    Update { x: i32, y: i32, w: i32, h: i32, stride: u32, fmt: u32, data: Arc<Vec<u8>> },
    Dmabuf { fd: Arc<OwnedFd>, w: u32, h: u32, stride: u32, fourcc: u32, modifier: u64, y0_top: bool },
    Dmabuf2(Arc<Scan2>),
    UpdateDmabuf { x: i32, y: i32, w: i32, h: i32 },
    MapScanout { fd: Arc<OwnedFd>, off: u32, w: u32, h: u32, stride: u32, fmt: u32 },
    MapUpdate { x: i32, y: i32, w: i32, h: i32 },
    Disable,
    MouseSet { x: i32, y: i32, on: i32 },
    Cursor { w: i32, h: i32, hx: i32, hy: i32, data: Arc<Vec<u8>> },
}

#[derive(Default)]
struct ConsoleCache {
    /// last scanout-ish event (Dmabuf2 | Dmabuf | Scanout | MapScanout)
    scanout: Option<ConsoleEv>,
    cursor: Option<ConsoleEv>,
    mouseset: Option<ConsoleEv>,
    disabled: bool,
}

struct ConsoleState {
    id: u32,
    path: String,
    tx: broadcast::Sender<ConsoleEv>,
    cache: Mutex<ConsoleCache>,
}

impl ConsoleState {
    fn push(&self, ev: ConsoleEv) {
        {
            let mut c = self.cache.lock().unwrap();
            match &ev {
                ConsoleEv::Dmabuf { .. } | ConsoleEv::Dmabuf2(_)
                | ConsoleEv::Scanout { .. } | ConsoleEv::MapScanout { .. } => {
                    c.scanout = Some(ev.clone());
                    c.disabled = false;
                }
                ConsoleEv::Cursor { .. } => c.cursor = Some(ev.clone()),
                ConsoleEv::MouseSet { .. } => c.mouseset = Some(ev.clone()),
                ConsoleEv::Disable => c.disabled = true,
                _ => {}
            }
        }
        let _ = self.tx.send(ev); // lagging/none receivers — fine
    }
}

// ── QEMU-side listener handler: QEMU calls → broadcast + cache ──

struct QemuSink {
    st: Arc<ConsoleState>,
}

impl ddproto::ConsoleEvents for QemuSink {
    fn scanout(&mut self, w: u32, h: u32, stride: u32, fmt: u32, data: Vec<u8>) {
        self.st.push(ConsoleEv::Scanout { w, h, stride, fmt, data: Arc::new(data) });
    }
    fn update(&mut self, x: i32, y: i32, w: i32, h: i32, stride: u32, fmt: u32, data: Vec<u8>) {
        self.st.push(ConsoleEv::Update { x, y, w, h, stride, fmt, data: Arc::new(data) });
    }
    fn scanout_dmabuf(&mut self, fd: ZOwnedFd, w: u32, h: u32, stride: u32,
                      fourcc: u32, modifier: u64, y0_top: bool) {
        self.st.push(ConsoleEv::Dmabuf { fd: Arc::new(fd.into()), w, h, stride, fourcc, modifier, y0_top });
    }
    fn update_dmabuf(&mut self, x: i32, y: i32, w: i32, h: i32) {
        self.st.push(ConsoleEv::UpdateDmabuf { x, y, w, h });
    }
    fn scanout_map(&mut self, fd: ZOwnedFd, off: u32, w: u32, h: u32, stride: u32, fmt: u32) {
        self.st.push(ConsoleEv::MapScanout { fd: Arc::new(fd.into()), off, w, h, stride, fmt });
    }
    fn update_map(&mut self, x: i32, y: i32, w: i32, h: i32) {
        self.st.push(ConsoleEv::MapUpdate { x, y, w, h });
    }
    fn scanout_dmabuf2(&mut self, fds: Vec<ZOwnedFd>, x: u32, y: u32, w: u32, h: u32,
                       offsets: Vec<u32>, strides: Vec<u32>, planes: u32, fourcc: u32,
                       bw: u32, bh: u32, modifier: u64, y0_top: bool) {
        if fds.is_empty() { return; }
        self.st.push(ConsoleEv::Dmabuf2(Arc::new(Scan2 {
            fds: fds.into_iter().map(|f| Arc::new(f.into())).collect(),
            x, y, w, h, offsets, strides, planes,
            fourcc, bw, bh, modifier, y0_top,
        })));
    }
    fn disable(&mut self) { self.st.push(ConsoleEv::Disable); }
    fn mouse_set(&mut self, x: i32, y: i32, on: i32) {
        self.st.push(ConsoleEv::MouseSet { x, y, on });
    }
    fn cursor_define(&mut self, w: i32, h: i32, hx: i32, hy: i32, data: Vec<u8>) {
        self.st.push(ConsoleEv::Cursor { w, h, hx, hy, data: Arc::new(data) });
    }
    fn interfaces(&self) -> Vec<String> {
        vec![IFACE_LISTENER_DMABUF2.to_string(), IFACE_LISTENER_MAP.to_string()]
    }
}

// ── shared broker state ──

struct Proxy {
    /// QEMU-side input conn — QEMU binds its object tree to the LAST
    /// add_client conn, which is this one. Every viewer call forwards here.
    qemu: zbus::Connection,
    consoles: Vec<Arc<ConsoleState>>,
    name: String,
    uuid: String,
    vm_ifaces: Vec<String>,
    guid: zbus::Guid<'static>,
    /// selfconn slot of the viewer that last called Clipboard.Register
    /// (QEMU arbitration is exclusive-register; the proxy relays its peer
    /// calls to the conn inside). Stored as the slot Arc so a detached
    /// viewer clears the delegate instead of leaving a dead conn.
    clip_delegate: ClipDelegate,
    /// QEMU→proxy listener conns — kept alive for the proxy's lifetime.
    _listener_conns: Vec<zbus::Connection>,
}

fn fdo(e: impl std::fmt::Display) -> zbus::fdo::Error {
    zbus::fdo::Error::Failed(e.to_string())
}

/// Forward a typed call to QEMU's object conn.
async fn call<B, R>(qemu: &zbus::Connection, path: &str, iface: &str,
                    member: &str, body: &B) -> zbus::fdo::Result<R>
where
    B: serde::ser::Serialize + zvariant::DynamicType,
    R: serde::de::DeserializeOwned + zvariant::Type,
{
    let msg = qemu.call_method(Some("org.qemu"), path, Some(iface), member, body)
        .await.map_err(fdo)?;
    msg.body().deserialize::<R>().map_err(fdo)
}

/// Forward a typed call to a VIEWER conn (listener/clipboard callbacks).
async fn vcall<B, R>(conn: &zbus::Connection, path: &str, iface: &str,
                     member: &str, body: &B) -> zbus::Result<R>
where
    B: serde::ser::Serialize + zvariant::DynamicType,
    R: serde::de::DeserializeOwned + zvariant::Type,
{
    let msg = conn.call_method(None::<&str>, path, Some(iface), member, body).await?;
    msg.body().deserialize::<R>()
}

type ClipSlot = Arc<Mutex<Option<zbus::Connection>>>;
/// Which viewer conn (by its selfconn slot) holds Clipboard.Register.
type ClipDelegate = Arc<Mutex<Option<ClipSlot>>>;

/// The delegate viewer conn, or none — locks the slot so a conn the viewer
/// conn-thread cleared doesn't linger.
fn delegate_conn(delegate: &Mutex<Option<ClipSlot>>) -> Option<zbus::Connection> {
    delegate.lock().unwrap().as_ref().and_then(|s| s.lock().unwrap().clone())
}

/// Relay a QEMU peer call to the clipboard delegate (fire-and-forget —
/// QEMU's calls are async on its side).
async fn relay_clip(delegate: &Mutex<Option<ClipSlot>>, member: &str,
                    body: &(impl serde::ser::Serialize + zvariant::DynamicType + Sync)) {
    if let Some(c) = delegate_conn(delegate) {
        let _ = c.call_method(None::<&str>, CLIP_PATH, Some(IFACE_CLIP), member, body).await;
    }
}

/// Read a property off QEMU's object tree.
async fn get_prop<T>(qemu: &zbus::Connection, path: &str, iface: &str, name: &str)
                     -> zbus::fdo::Result<T>
where
    T: TryFrom<zvariant::OwnedValue>,
    T::Error: Into<zbus::Error>,
{
    let p = zbus::Proxy::new(qemu, "org.qemu", path, iface).await.map_err(fdo)?;
    p.get_property::<T>(name).await.map_err(fdo)
}

// ── viewer-facing objects ──

struct VmObj {
    sh: Arc<Proxy>,
}

#[zbus::interface(name = "org.qemu.Display1.VM")]
impl VmObj {
    #[zbus(property)]
    fn name(&self) -> String { self.sh.name.clone() }
    #[zbus(property, name = "UUID")]
    fn uuid(&self) -> String { self.sh.uuid.clone() }
    #[zbus(property, name = "ConsoleIDs")]
    fn console_ids(&self) -> Vec<u32> {
        self.sh.consoles.iter().map(|c| c.id).collect()
    }
    #[zbus(property)]
    fn interfaces(&self) -> Vec<String> { self.sh.vm_ifaces.clone() }
}

struct ConsoleObj {
    sh: Arc<Proxy>,
    ci: usize,
}

#[zbus::interface(name = "org.qemu.Display1.Console")]
impl ConsoleObj {
    /// Intercepted — the proxy owns the QEMU listener conns; this spawns a
    /// forwarder that calls the VIEWER's listener objects over the passed
    /// fd, replaying the cached console state first.
    fn register_listener(&mut self, fd: Fd) -> zbus::fdo::Result<()> {
        let owned: OwnedFd = fd.try_into().map_err(fdo)?;
        let st = self.sh.consoles[self.ci].clone();
        let guid = self.sh.guid.clone();
        tokio::spawn(async move {
            if let Err(e) = listener_forward(owned, st.clone(), guid).await {
                eprintln!("[console:{}] listener forwarder: {e:#}", st.id);
            }
        });
        Ok(())
    }

    async fn set_ui_info(&self, width_mm: u16, height_mm: u16,
                         xoff: i32, yoff: i32, width: u32, height: u32) -> zbus::fdo::Result<()> {
        call::<_, ()>(&self.sh.qemu, &self.sh.consoles[self.ci].path, IFACE_CONSOLE,
                     "SetUIInfo", &(width_mm, height_mm, xoff, yoff, width, height)).await
    }

    #[zbus(property)]
    async fn label(&self) -> zbus::fdo::Result<String> {
        get_prop(&self.sh.qemu, &self.sh.consoles[self.ci].path, IFACE_CONSOLE, "Label").await
    }
    #[zbus(property)]
    async fn head(&self) -> zbus::fdo::Result<u32> {
        get_prop(&self.sh.qemu, &self.sh.consoles[self.ci].path, IFACE_CONSOLE, "Head").await
    }
    #[zbus(property)]
    async fn r#type(&self) -> zbus::fdo::Result<String> {
        get_prop(&self.sh.qemu, &self.sh.consoles[self.ci].path, IFACE_CONSOLE, "Type").await
    }
    #[zbus(property)]
    async fn width(&self) -> zbus::fdo::Result<u32> {
        get_prop(&self.sh.qemu, &self.sh.consoles[self.ci].path, IFACE_CONSOLE, "Width").await
    }
    #[zbus(property)]
    async fn height(&self) -> zbus::fdo::Result<u32> {
        get_prop(&self.sh.qemu, &self.sh.consoles[self.ci].path, IFACE_CONSOLE, "Height").await
    }
    #[zbus(property)]
    async fn device_address(&self) -> zbus::fdo::Result<String> {
        get_prop(&self.sh.qemu, &self.sh.consoles[self.ci].path, IFACE_CONSOLE, "DeviceAddress").await
    }
    #[zbus(property)]
    async fn interfaces(&self) -> zbus::fdo::Result<Vec<String>> {
        get_prop(&self.sh.qemu, &self.sh.consoles[self.ci].path, IFACE_CONSOLE, "Interfaces").await
    }
}

struct KbdObj { qemu: zbus::Connection, path: String }

#[zbus::interface(name = "org.qemu.Display1.Keyboard")]
impl KbdObj {
    async fn press(&self, keycode: u32) -> zbus::fdo::Result<()> {
        call::<_, ()>(&self.qemu, &self.path, IFACE_KBD, "Press", &(keycode,)).await
    }
    async fn release(&self, keycode: u32) -> zbus::fdo::Result<()> {
        call::<_, ()>(&self.qemu, &self.path, IFACE_KBD, "Release", &(keycode,)).await
    }
    #[zbus(property)]
    async fn modifiers(&self) -> zbus::fdo::Result<u32> {
        get_prop(&self.qemu, &self.path, IFACE_KBD, "Modifiers").await
    }
}

struct MouseObj { qemu: zbus::Connection, path: String }

#[zbus::interface(name = "org.qemu.Display1.Mouse")]
impl MouseObj {
    async fn press(&self, button: u32) -> zbus::fdo::Result<()> {
        call::<_, ()>(&self.qemu, &self.path, IFACE_MOUSE, "Press", &(button,)).await
    }
    async fn release(&self, button: u32) -> zbus::fdo::Result<()> {
        call::<_, ()>(&self.qemu, &self.path, IFACE_MOUSE, "Release", &(button,)).await
    }
    async fn set_abs_position(&self, x: u32, y: u32) -> zbus::fdo::Result<()> {
        call::<_, ()>(&self.qemu, &self.path, IFACE_MOUSE, "SetAbsPosition", &(x, y)).await
    }
    async fn rel_motion(&self, dx: i32, dy: i32) -> zbus::fdo::Result<()> {
        call::<_, ()>(&self.qemu, &self.path, IFACE_MOUSE, "RelMotion", &(dx, dy)).await
    }
    #[zbus(property)]
    async fn is_absolute(&self) -> zbus::fdo::Result<bool> {
        get_prop(&self.qemu, &self.path, IFACE_MOUSE, "IsAbsolute").await
    }
}

struct MtObj { qemu: zbus::Connection, path: String }

#[zbus::interface(name = "org.qemu.Display1.MultiTouch")]
impl MtObj {
    async fn send_event(&self, kind: u32, num_slot: u64, x: f64, y: f64) -> zbus::fdo::Result<()> {
        call::<_, ()>(&self.qemu, &self.path, IFACE_MT, "SendEvent", &(kind, num_slot, x, y)).await
    }
    #[zbus(property)]
    async fn max_slots(&self) -> zbus::fdo::Result<i32> {
        get_prop(&self.qemu, &self.path, IFACE_MT, "MaxSlots").await
    }
}

struct ClipObj {
    sh: Arc<Proxy>,
    /// own viewer conn — filled after build (objects are served before the
    /// conn exists). The delegate marker stores THIS slot so the detach
    /// path can drop the marker without holding a dead conn.
    selfconn: ClipSlot,
}

#[zbus::interface(name = "org.qemu.Display1.Clipboard")]
impl ClipObj {
    async fn register(&mut self) -> zbus::fdo::Result<()> {
        *self.sh.clip_delegate.lock().unwrap() = Some(self.selfconn.clone());
        call::<_, ()>(&self.sh.qemu, CLIP_PATH, IFACE_CLIP, "Register", &()).await
    }
    async fn unregister(&mut self) -> zbus::fdo::Result<()> {
        *self.sh.clip_delegate.lock().unwrap() = None;
        call::<_, ()>(&self.sh.qemu, CLIP_PATH, IFACE_CLIP, "Unregister", &()).await
    }
    async fn grab(&self, selection: u32, serial: u32, mimes: Vec<String>) -> zbus::fdo::Result<()> {
        call::<_, ()>(&self.sh.qemu, CLIP_PATH, IFACE_CLIP, "Grab", &(selection, serial, mimes)).await
    }
    async fn release(&self, selection: u32) -> zbus::fdo::Result<()> {
        call::<_, ()>(&self.sh.qemu, CLIP_PATH, IFACE_CLIP, "Release", &(selection,)).await
    }
    async fn request(&self, selection: u32, mimes: Vec<String>) -> zbus::fdo::Result<(String, Vec<u8>)> {
        call::<_, (String, Vec<u8>)>(&self.sh.qemu, CLIP_PATH, IFACE_CLIP, "Request", &(selection, mimes)).await
    }
    #[zbus(property)]
    fn interfaces(&self) -> Vec<String> { clip_ifaces() }
}

struct AudioObj { qemu: zbus::Connection }

#[zbus::interface(name = "org.qemu.Display1.Audio")]
impl AudioObj {
    /// fd passes straight through — QEMU then talks to the viewer's audio
    /// listener directly (audio channels aren't the wedge surface).
    async fn register_out_listener(&mut self, fd: Fd<'_>) -> zbus::fdo::Result<()> {
        call::<_, ()>(&self.qemu, AUDIO_PATH, IFACE_AUDIO, "RegisterOutListener", &(fd,)).await
    }
    async fn register_in_listener(&mut self, fd: Fd<'_>) -> zbus::fdo::Result<()> {
        call::<_, ()>(&self.qemu, AUDIO_PATH, IFACE_AUDIO, "RegisterInListener", &(fd,)).await
    }
    #[zbus(property, name = "NSamples")]
    async fn nsamples(&self) -> zbus::fdo::Result<u32> {
        get_prop(&self.qemu, AUDIO_PATH, IFACE_AUDIO, "NSamples").await
    }
}

// ── QEMU-facing clipboard peer (QEMU calls → relay to delegate viewer) ──

/// Served on the proxy's QEMU input conn — needs only the delegate slot,
/// so it's constructed BEFORE Shared exists (the delegate Arc is shared in).
struct QemuClip {
    delegate: ClipDelegate,
}

#[zbus::interface(name = "org.qemu.Display1.Clipboard")]
impl QemuClip {
    async fn register(&mut self) {
        relay_clip(&self.delegate, "Register", &()).await;
    }
    async fn unregister(&mut self) {
        relay_clip(&self.delegate, "Unregister", &()).await;
    }
    async fn grab(&mut self, selection: u32, serial: u32, mimes: Vec<String>) {
        relay_clip(&self.delegate, "Grab", &(selection, serial, mimes)).await;
    }
    async fn release(&mut self, selection: u32) {
        relay_clip(&self.delegate, "Release", &(selection,)).await;
    }
    /// Guest paste while a viewer owns — QEMU blocks on this reply, so it
    /// awaits the viewer's own Request reply and relays it back.
    async fn request(&mut self, selection: u32, mimes: Vec<String>) -> zbus::fdo::Result<(String, Vec<u8>)> {
        match delegate_conn(&self.delegate) {
            Some(c) => vcall::<_, (String, Vec<u8>)>(&c, CLIP_PATH, IFACE_CLIP, "Request",
                        &(selection, mimes)).await.map_err(fdo),
            None => Err(zbus::fdo::Error::Failed("no viewer registered".into())),
        }
    }
    #[zbus(property)]
    fn interfaces(&self) -> Vec<String> { clip_ifaces() }
}

// ── per-console listener forwarder: proxy → viewer listener conn ──

/// Send one console event as a listener method call on the viewer's conn.
async fn send_ev(conn: &zbus::Connection, ev: &ConsoleEv) -> Result<()> {
    match ev {
        ConsoleEv::Scanout { w, h, stride, fmt, data } =>
            vcall::<_, ()>(conn, LISTENER_PATH, IFACE_LISTENER, "Scanout",
                &(*w, *h, *stride, *fmt, (**data).clone())).await?,
        ConsoleEv::Update { x, y, w, h, stride, fmt, data } =>
            vcall::<_, ()>(conn, LISTENER_PATH, IFACE_LISTENER, "Update",
                &(*x, *y, *w, *h, *stride, *fmt, (**data).clone())).await?,
        ConsoleEv::Dmabuf { fd, w, h, stride, fourcc, modifier, y0_top } =>
            vcall::<_, ()>(conn, LISTENER_PATH, IFACE_LISTENER, "ScanoutDMABUF",
                &(Fd::from(fd.try_clone()?), *w, *h, *stride, *fourcc, *modifier, *y0_top)).await?,
        ConsoleEv::Dmabuf2(a) => {
            let fds: Vec<Fd> = a.fds.iter()
                .map(|f| Ok(Fd::from(f.try_clone()?))).collect::<Result<_>>()?;
            vcall::<_, ()>(conn, LISTENER_PATH, IFACE_LISTENER_DMABUF2, "ScanoutDMABUF2",
                &(fds, a.x, a.y, a.w, a.h,
                  a.offsets.clone(), a.strides.clone(), a.planes,
                  a.fourcc, a.bw, a.bh, a.modifier, a.y0_top)).await?
        }
        ConsoleEv::UpdateDmabuf { x, y, w, h } =>
            vcall::<_, ()>(conn, LISTENER_PATH, IFACE_LISTENER, "UpdateDMABUF",
                &(*x, *y, *w, *h)).await?,
        ConsoleEv::MapScanout { fd, off, w, h, stride, fmt } =>
            vcall::<_, ()>(conn, LISTENER_PATH, IFACE_LISTENER_MAP, "ScanoutMap",
                &(Fd::from(fd.try_clone()?), *off, *w, *h, *stride, *fmt)).await?,
        ConsoleEv::MapUpdate { x, y, w, h } =>
            vcall::<_, ()>(conn, LISTENER_PATH, IFACE_LISTENER_MAP, "UpdateMap",
                &(*x, *y, *w, *h)).await?,
        ConsoleEv::Disable =>
            vcall::<_, ()>(conn, LISTENER_PATH, IFACE_LISTENER, "Disable", &()).await?,
        ConsoleEv::MouseSet { x, y, on } =>
            vcall::<_, ()>(conn, LISTENER_PATH, IFACE_LISTENER, "MouseSet",
                &(*x, *y, *on)).await?,
        ConsoleEv::Cursor { w, h, hx, hy, data } =>
            vcall::<_, ()>(conn, LISTENER_PATH, IFACE_LISTENER, "CursorDefine",
                &(*w, *h, *hx, *hy, (**data).clone())).await?,
    }
    Ok(())
}

/// A viewer called RegisterListener: replay cached console state, then
/// stream the broadcast. The conn dies when the viewer disconnects.
async fn listener_forward(fd: OwnedFd, st: Arc<ConsoleState>, guid: zbus::Guid<'static>) -> Result<()> {
    let s = UnixStream::from(fd);
    s.set_nonblocking(true)?;
    // QEMU is auth-server on listener conns — the proxy mirrors that role.
    let conn = connection::Builder::unix_stream(tokio::net::UnixStream::from_std(s)?)
        .p2p().server(guid)?.build().await?;

    let replay: Vec<ConsoleEv> = {
        let c = st.cache.lock().unwrap();
        let mut v: Vec<ConsoleEv> = Vec::new();
        if let Some(e) = &c.scanout { v.push(e.clone()); }
        if let Some(e) = &c.cursor { v.push(e.clone()); }
        if let Some(e) = &c.mouseset { v.push(e.clone()); }
        if c.disabled { v.push(ConsoleEv::Disable); }
        v
    };
    for e in &replay { send_ev(&conn, e).await?; }

    let mut rx = st.tx.subscribe();
    loop {
        match rx.recv().await {
            Ok(e) => send_ev(&conn, &e).await?,
            Err(broadcast::error::RecvError::Lagged(n)) =>
                eprintln!("[console:{}] viewer lagged {n} events — continuing", st.id),
            Err(broadcast::error::RecvError::Closed) => return Ok(()),
        }
    }
}

// ── viewer conn setup ──

/// Object-tree assembly for one viewer conn. Returns once the peer
/// disconnects.
async fn handle_viewer(stream: tokio::net::UnixStream, sh: Arc<Proxy>) -> Result<()> {
    // Skeleton objects get the conn handle back-filled after build — the
    // objects must be served before the conn exists.
    let selfconn: ClipSlot = Arc::new(Mutex::new(None));
    let mut b = connection::Builder::unix_stream(stream)
        .p2p()
        .server(sh.guid.clone())?
        .auth_mechanism(AuthMechanism::External)
        .serve_at(VM_PATH, VmObj { sh: sh.clone() })?
        .serve_at(CLIP_PATH, ClipObj { sh: sh.clone(), selfconn: selfconn.clone() })?
        .serve_at(AUDIO_PATH, AudioObj { qemu: sh.qemu.clone() })?;
    for (ci, c) in sh.consoles.iter().enumerate() {
        b = b.serve_at(c.path.as_str(), ConsoleObj { sh: sh.clone(), ci })?
            .serve_at(c.path.as_str(), KbdObj { qemu: sh.qemu.clone(), path: c.path.clone() })?
            .serve_at(c.path.as_str(), MouseObj { qemu: sh.qemu.clone(), path: c.path.clone() })?
            .serve_at(c.path.as_str(), MtObj { qemu: sh.qemu.clone(), path: c.path.clone() })?;
    }
    let conn = b.build().await?;
    *selfconn.lock().unwrap() = Some(conn.clone());
    eprintln!("[+] viewer attached (consoles={})", sh.consoles.len());
    conn.closed().await;
    // ClipObj marked this conn's slot as delegate on Register — drop the
    // marker so relays stop aiming at a dead conn.
    *selfconn.lock().unwrap() = None;
    if sh.clip_delegate.lock().unwrap().as_ref().is_some_and(|s| Arc::ptr_eq(s, &selfconn)) {
        *sh.clip_delegate.lock().unwrap() = None;
    }
    eprintln!("[-] viewer detached");
    Ok(())
}

// ── main ──

fn usage() -> ! {
    eprintln!("usage: ddproxy --monitor <qmp.sock> --sock <listen.sock> [--pidfile <path>]");
    std::process::exit(2);
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    let mut monitor: Option<String> = None;
    let mut sock: Option<String> = None;
    let mut pidfile: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--monitor" => monitor = Some(args.next().context("--monitor needs a path")?),
            "--sock" => sock = Some(args.next().context("--sock needs a path")?),
            "--pidfile" => pidfile = Some(args.next().context("--pidfile needs a path")?),
            _ => usage(),
        }
    }
    let monitor = monitor.unwrap_or_else(|| usage());
    let sock = sock.unwrap_or_else(|| usage());
    if let Some(p) = &pidfile {
        std::fs::write(p, format!("{}\n", std::process::id()))
            .with_context(|| format!("write pidfile {p}"))?;
    }

    // QEMU-side conn set — retry while the display backend comes up after
    // the QMP socket (machine init races the lifecycle's monitor wait).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let setup = loop {
        match qemu_setup(&monitor).await {
            Ok(v) => break v,
            Err(e) => {
                if std::time::Instant::now() >= deadline {
                    return Err(e).context("qemu display backend never came up");
                }
                eprintln!("[*] qemu attach: {e:#} — retrying");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    };
    let QemuSetup { input_conn, name, uuid, vm_ifaces, consoles, listener_conns, clip_delegate } = setup;
    eprintln!("[*] attached to qemu display: name={name} consoles={:?}",
        consoles.iter().map(|c| c.id).collect::<Vec<_>>());

    let sh = Arc::new(Proxy {
        qemu: input_conn,
        consoles,
        name, uuid, vm_ifaces,
        guid: zbus::Guid::generate(),
        clip_delegate,
        _listener_conns: listener_conns,
    });

    // Dead-QEMU watchdog — qemu.pid + /proc starttime beside monitor.sock
    // (catches restart too); all proxy conns die with the VM anyway.
    {
        let pidfile_path = std::path::Path::new(&monitor)
            .parent().unwrap_or(std::path::Path::new(".")).join("qemu.pid");
        if let Some((pid, start)) = qemu_boot_id(&pidfile_path) {
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    if qemu_boot_id(&pidfile_path) != Some((pid, start)) {
                        eprintln!("[*] qemu gone/restarted — exiting");
                        std::process::exit(1);
                    }
                }
            });
        }
    }

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

    let _ = std::fs::remove_file(&sock);
    let listener = tokio::net::UnixListener::bind(&sock)
        .with_context(|| format!("bind {sock}"))?;
    eprintln!("[*] listening on {sock}");
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let sh = sh.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_viewer(stream, sh).await {
                        eprintln!("[viewer] {e:#}");
                    }
                });
            }
            Err(e) => {
                eprintln!("[*] accept: {e} — exiting");
                return Ok(());
            }
        }
    }
}

struct QemuSetup {
    /// the input conn — QEMU's object tree is bound to it.
    input_conn: zbus::Connection,
    name: String,
    uuid: String,
    vm_ifaces: Vec<String>,
    consoles: Vec<Arc<ConsoleState>>,
    /// QEMU→proxy listener conns — must stay alive for the proxy's life.
    listener_conns: Vec<zbus::Connection>,
    clip_delegate: ClipDelegate,
}

/// Build the QEMU-side conn set: control conn (enumerate + listener
/// registration), then the input conn LAST — QEMU binds its object tree to
/// the final add_client conn, which is where Keyboard/Mouse/Clipboard and
/// every property live.
async fn qemu_setup(monitor: &str) -> Result<QemuSetup> {
    let s1 = open_dbus_channel(monitor).context("dbus channel")?;
    s1.set_nonblocking(true)?;
    let conn = connection::Builder::unix_stream(tokio::net::UnixStream::from_std(s1)?)
        .p2p().build().await.context("p2p conn to qemu")?;

    let vm = zbus::Proxy::new(&conn, "org.qemu", VM_PATH, "org.qemu.Display1.VM").await?;
    let name: String = vm.get_property("Name").await?;
    let uuid: String = vm.get_property("UUID").await.unwrap_or_default();
    let vm_ifaces: Vec<String> = vm.get_property("Interfaces").await.unwrap_or_default();
    let console_ids: Vec<u32> = vm.get_property("ConsoleIDs").await?;

    // Register one listener conn per console BEFORE the input conn — QEMU
    // drops the enumeration conn once listeners attach, and the input conn
    // must be the last channel so the object tree binds to it.
    let mut consoles: Vec<Arc<ConsoleState>> = Vec::new();
    let mut listener_conns: Vec<zbus::Connection> = Vec::new();
    for &ci in &console_ids {
        let st = Arc::new(ConsoleState {
            id: ci,
            path: console_path(ci),
            tx: broadcast::channel(512).0,
            cache: Mutex::new(ConsoleCache::default()),
        });
        let console = zbus::Proxy::new(&conn, "org.qemu", st.path.as_str(),
                                     "org.qemu.Display1.Console").await?;
        let (s2, p2) = UnixStream::pair()?;
        console.call::<_, _, ()>("RegisterListener", &(Fd::from(p2.as_fd()),)).await?;
        drop(p2);
        s2.set_nonblocking(true)?;
        let ev = ddproto::shared_console(QemuSink { st: st.clone() });
        let lc = connection::Builder::unix_stream(tokio::net::UnixStream::from_std(s2)?)
            .serve_at(LISTENER_PATH, ddproto::Listener { ev: ev.clone() })?
            .serve_at(LISTENER_PATH, ddproto::UnixMap { ev: ev.clone() })?
            .serve_at(LISTENER_PATH, ddproto::UnixDmabuf2 { ev })?
            .p2p().build().await?;
        consoles.push(st);
        listener_conns.push(lc);
    }

    // Input conn LAST — QEMU binds its object tree here; serve the
    // clipboard peer on it (QEMU proxies clipboard calls back to the conn
    // that calls Register).
    let si = open_dbus_channel(monitor).context("input dbus channel")?;
    si.set_nonblocking(true)?;
    let clip_delegate: ClipDelegate = Arc::new(Mutex::new(None));
    let ia = connection::Builder::unix_stream(tokio::net::UnixStream::from_std(si)?)
        .serve_at(CLIP_PATH, QemuClip { delegate: clip_delegate.clone() })?
        .p2p().build().await.context("input p2p conn")?;

    Ok(QemuSetup {
        input_conn: ia, name, uuid, vm_ifaces, consoles, listener_conns, clip_delegate,
    })
}
