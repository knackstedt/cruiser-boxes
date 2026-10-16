// xkeyprobe — standalone repro of viewer-dd's X11 input path:
// minifb window + second X conn selecting KeyPress|KeyRelease;
// XGrabKeyboard(Async)+XGrabPointer(Async) while is_active; outside
// clicks reinject via XTEST. Prints every event. AUTO-EXITS in 20s.
// Drive with: xdotool windowactivate $W; xdotool key a; click in/out.
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::ffi::c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct XAnyEv { t: i32, _p0: i32, _s: u64, send_event: i32 }
#[repr(C)]
#[derive(Clone, Copy)]
struct XKeyEv {
    t: i32, _p0: i32, _s: u64, send_event: i32, _p1: i32,
    _d: u64, win: u64, _r: u64, _sub: u64, _time: u64,
    x: i32, y: i32, _xr: i32, _yr: i32, state: u32, keycode: u32,
    _same: i32, _p2: i32,
}
#[repr(C)]
union XEvBuf { any: XAnyEv, key: XKeyEv, _pad: [u64; 24] }

#[link(name = "Xtst")]
#[link(name = "X11")]
extern "C" {
    fn XOpenDisplay(n: *const u8) -> *mut c_void;
    fn XSelectInput(d: *mut c_void, w: u64, mask: i64);
    fn XFlush(d: *mut c_void);
    fn XPending(d: *mut c_void) -> i32;
    fn XNextEvent(d: *mut c_void, ev: *mut XEvBuf) -> i32;
    fn XGrabKeyboard(d: *mut c_void, w: u64, oe: i32, pm: i32, km: i32, t: u64) -> i32;
    fn XUngrabKeyboard(d: *mut c_void, t: u64) -> i32;
    fn XGrabPointer(d: *mut c_void, w: u64, oe: i32, mask: u32, pm: i32, km: i32,
                    confine: u64, cur: u64, t: u64) -> i32;
    fn XUngrabPointer(d: *mut c_void, t: u64) -> i32;
    fn XTestFakeButtonEvent(d: *mut c_void, button: u32, is_press: i32, delay: u64) -> i32;
}

fn main() {
    let mut win = minifb::Window::new("xkeyprobe", 400, 300, minifb::WindowOptions::default()).unwrap();
    win.limit_update_rate(Some(std::time::Duration::from_millis(2)));
    let wh = win.window_handle().unwrap();
    let RawWindowHandle::Xlib(xw) = wh.as_raw() else { panic!("not x11") };
    let xid = xw.window;
    let xdpy = unsafe { XOpenDisplay(std::ptr::null()) };
    assert!(!xdpy.is_null());
    unsafe { XSelectInput(xdpy, xid, 0x3); XFlush(xdpy); } // keys only — ButtonPressMask is minifb's (exclusive)
    println!("xkeyprobe window=0x{xid:x} — focus it and type/click (auto-exits in 20s)");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut grabbed = false;
    let mut pgrabbed = false;
    while win.is_open() && std::time::Instant::now() < deadline {
        win.update();
        let active = win.is_active();
        let nog = std::env::var("NOGRAB").is_ok();
        if active && !grabbed && !nog {
            grabbed = unsafe { XGrabKeyboard(xdpy, xid, 0, 1, 1, 0) } == 0;
            if grabbed {
                pgrabbed = unsafe { XGrabPointer(xdpy, xid, 0, 0xC, 1, 1, 0, 0, 0) } == 0;
                println!("[grab] kbd grabbed ptr={pgrabbed}");
            }
        } else if !active && (grabbed || pgrabbed) {
            if pgrabbed { unsafe { XUngrabPointer(xdpy, 0) }; pgrabbed = false; }
            if grabbed { unsafe { XUngrabKeyboard(xdpy, 0) }; grabbed = false; }
            unsafe { XFlush(xdpy) };
            println!("[grab] ungrabbed");
        }
        while unsafe { XPending(xdpy) } > 0 {
            let mut ev: XEvBuf = unsafe { std::mem::zeroed() };
            unsafe { XNextEvent(xdpy, &mut ev) };
            let a = unsafe { ev.any };
            if a.send_event != 0 { println!("  (send_event) type={}", a.t); continue; }
            let k = unsafe { ev.key };
            match a.t {
                2 => println!("KEY DOWN  kc={} state=0x{:x} win=0x{:x}", k.keycode, k.state, k.win),
                3 => println!("KEY UP    kc={} state=0x{:x} win=0x{:x}", k.keycode, k.state, k.win),
                4 | 5 => {
                    let down = a.t == 4;
                    let inside = k.x >= 0 && k.y >= 0 && k.x < 400 && k.y < 300;
                    if down && !inside && pgrabbed {
                        unsafe {
                            XUngrabPointer(xdpy, 0);
                            XTestFakeButtonEvent(xdpy, k.keycode, 1, 0);
                            if k.keycode >= 4 { XTestFakeButtonEvent(xdpy, k.keycode, 0, 0); }
                            XFlush(xdpy);
                        }
                        pgrabbed = false;
                        println!("BTN {}  b={} xy={},{} OUTSIDE — reinjected, pgrab released",
                                 if down { "DOWN" } else { "UP" }, k.keycode, k.x, k.y);
                    } else {
                        println!("BTN {}  b={} xy={},{} win=0x{:x}",
                                 if down { "DOWN" } else { "UP" }, k.keycode, k.x, k.y, k.win);
                    }
                }
                t => println!("EV type={t} win=0x{:x}", k.win),
            }
        }
        unsafe { XFlush(xdpy) };
        std::io::Write::flush(&mut std::io::stdout()).ok();
    }
    if pgrabbed { unsafe { XUngrabPointer(xdpy, 0) }; }
    if grabbed { unsafe { XUngrabKeyboard(xdpy, 0) }; }
    unsafe { XFlush(xdpy) };
    println!("deadline — ungrabbed and exiting");
}
