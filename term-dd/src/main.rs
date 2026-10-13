//! term-dd — PTY proxy for the cruiser embedded terminal.
//!
//! Spawns a command inside a PTY (portable-pty) and bridges it to one of two
//! transports:
//!
//!   default   — length-prefixed frames on stdin/stdout (see framing.rs);
//!               used by the app's TermSession, which forwards the byte
//!               stream to/from an xterm.js page in a webui view.
//!
//!   --raw-tty — raw byte bridge against the controlling terminal; stdin is
//!               put in raw mode, SIGWINCH resizes the PTY, termios is
//!               restored on exit. Used by `cruiser vm term <name>` so the
//!               CLI exercises the same PTY path as the embedded view.
//!
//! The command is whatever the caller supplies — the app passes
//! `ssh -tt -i <cruiser key> -p <hostfwd port> <user>@127.0.0.1`.

mod framing;

use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{IsTerminal, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

fn usage() -> ! {
    eprintln!("usage: term-dd [--raw-tty] [--cols N] [--rows M] -- <cmd> [args…]");
    std::process::exit(2);
}

struct Args {
    raw_tty: bool,
    cols: u16,
    rows: u16,
    cmd: Vec<String>,
}

fn parse_args() -> Result<Args> {
    let mut a = Args { raw_tty: false, cols: 80, rows: 24, cmd: vec![] };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--raw-tty" => a.raw_tty = true,
            "--cols" => a.cols = it.next().context("--cols needs a value")?.parse()?,
            "--rows" => a.rows = it.next().context("--rows needs a value")?.parse()?,
            "--" => {
                a.cmd = it.collect();
                break;
            }
            "-h" | "--help" => usage(),
            other => bail!("unknown arg '{other}' — term-dd -- <cmd> [args…]"),
        }
    }
    if a.cmd.is_empty() {
        usage();
    }
    Ok(a)
}

/// The four halves of an open PTY + spawned child.
type PtySession = (
    Box<dyn MasterPty + Send>,
    Box<dyn Child + Send + Sync>,
    Box<dyn Read + Send>,
    Box<dyn Write + Send>,
);

fn spawn_in_pty(size: PtySize, cmd: &[String]) -> Result<PtySession> {
    let pair = native_pty_system()
        .openpty(size)
        .context("openpty failed")?;
    let mut cb = CommandBuilder::new(&cmd[0]);
    cb.args(&cmd[1..]);
    // Portable-pty children start with an empty env — propagate ours like a
    // real emulator does (TERM/COLORTERM are how the host tells the shell
    // it's xterm.js; ssh forwards TERM to the guest automatically).
    for (k, v) in std::env::vars_os() {
        cb.env(k, v);
    }
    cb.cwd(std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_else(|| "/".into()));
    let child = pair.slave.spawn_command(cb).context("spawn failed")?;
    let reader = pair.master.try_clone_reader().context("pty reader clone failed")?;
    let writer = pair.master.take_writer().context("pty writer failed")?;
    Ok((pair.master, child, reader, writer))
}

fn main() -> Result<()> {
    let a = parse_args()?;
    let size = PtySize { rows: a.rows, cols: a.cols, pixel_width: 0, pixel_height: 0 };

    let (master, child, reader, writer) = match spawn_in_pty(size, &a.cmd) {
        Ok(v) => v,
        Err(e) if !a.raw_tty => {
            // Report spawn failures as an ERR frame so the host shows the
            // message inside the terminal instead of a bare exit code.
            let mut out = std::io::stdout();
            let _ = framing::write_frame(&mut out, framing::TAG_KILL, e.to_string().as_bytes());
            let _ = out.flush();
            std::process::exit(2);
        }
        Err(e) => return Err(e),
    };

    if a.raw_tty {
        run_raw_tty(master, child, reader, writer)
    } else {
        run_framed(master, child, reader, writer)
    }
}

// ── framed mode ──

fn run_framed(
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    mut reader: Box<dyn Read + Send>,
    mut writer: Box<dyn Write + Send>,
) -> Result<()> {
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let child = Arc::new(Mutex::new(child));

    // PTY → DATA frames
    {
        let out = stdout.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut o = match out.lock() {
                            Ok(o) => o,
                            Err(_) => break,
                        };
                        if framing::write_frame(&mut *o, framing::TAG_DATA, &buf[..n])
                            .and_then(|_| o.flush())
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        });
    }

    // Child exit → EXIT frame (tag 0x02, i32 status). Poll try_wait instead
    // of wait(): wait() would hold the child Mutex across waitpid, and the
    // stdin loop's KILL/EOF paths need that same lock — parking there makes
    // KILL undeliverable and deadlocks the stdin-EOF kill.
    {
        let out = stdout.clone();
        let child = child.clone();
        thread::spawn(move || {
            let status = loop {
                {
                    let mut g = child.lock().unwrap_or_else(|e| e.into_inner());
                    match g.try_wait() {
                        Ok(Some(s)) => break s.exit_code() as i32,
                        Ok(None) => {}
                        Err(_) => break -1,
                    }
                }
                thread::sleep(std::time::Duration::from_millis(25));
            };
            if let Ok(mut o) = out.lock().map_err(|e| e.into_inner()) {
                let _ = framing::write_frame(&mut *o, 0x02, &status.to_le_bytes());
                let _ = o.flush();
            }
        });
    }

    // stdin frames → PTY / resize / kill
    let mut dec = framing::Decoder::new();
    let mut stdin = std::io::stdin().lock();
    let mut buf = [0u8; 65536];
    'stdin: loop {
        let n = match stdin.read(&mut buf) {
            Ok(0) | Err(_) => break, // host gone / closed — kill below
            Ok(n) => n,
        };
        for (tag, payload) in dec.push(&buf[..n]) {
            match tag {
                framing::TAG_DATA => {
                    if writer.write_all(&payload).is_err() {
                        break 'stdin;
                    }
                }
                framing::TAG_RESIZE if payload.len() >= 4 => {
                    let cols = u16::from_le_bytes([payload[0], payload[1]]);
                    let rows = u16::from_le_bytes([payload[2], payload[3]]);
                    let _ = master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                framing::TAG_KILL => {
                    if let Ok(mut c) = child.lock().map_err(|e| e.into_inner()) {
                        let _ = c.kill();
                    }
                }
                _ => {}
            }
        }
    }

    // stdin EOF (host closed the pipe) — don't leave the child orphaned.
    if let Ok(mut c) = child.lock().map_err(|e| e.into_inner()) {
        let _ = c.kill();
    }
    Ok(())
}

// ── raw-tty mode ──

/// Current winsize of the controlling terminal (fd 0), for PTY sync.
fn tty_winsize() -> Option<PtySize> {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    if unsafe { libc::ioctl(0, libc::TIOCGWINSZ, &mut ws) } == 0 && ws.ws_col > 0 && ws.ws_row > 0 {
        Some(PtySize {
            rows: ws.ws_row,
            cols: ws.ws_col,
            pixel_width: ws.ws_xpixel,
            pixel_height: ws.ws_ypixel,
        })
    } else {
        None
    }
}

fn run_raw_tty(
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    mut reader: Box<dyn Read + Send>,
    mut writer: Box<dyn Write + Send>,
) -> Result<()> {
    use nix::sys::termios::{cfmakeraw, tcgetattr, tcsetattr, SetArg, Termios};

    let is_tty = std::io::stdin().is_terminal();
    struct Restore(Option<Termios>);
    impl Drop for Restore {
        fn drop(&mut self) {
            if let Some(t) = &self.0 {
                let _ = tcsetattr(std::io::stdin(), SetArg::TCSADRAIN, t);
            }
        }
    }
    let _restore = Restore(if is_tty {
        let orig = tcgetattr(std::io::stdin()).context("tcgetattr failed")?;
        let mut raw = orig.clone();
        cfmakeraw(&mut raw);
        tcsetattr(std::io::stdin(), SetArg::TCSADRAIN, &raw).context("tcsetattr raw failed")?;
        if let Some(ws) = tty_winsize() {
            let _ = master.resize(ws);
        }
        Some(orig)
    } else {
        None
    });

    // SIGWINCH → resize the PTY to the controlling terminal.
    let master = Arc::new(Mutex::new(master));
    if is_tty {
        let m = master.clone();
        thread::spawn(move || {
            let mut sigs = match signal_hook::iterator::Signals::new([signal_hook::consts::SIGWINCH]) {
                Ok(s) => s,
                Err(_) => return,
            };
            for _ in sigs.forever() {
                if let Some(ws) = tty_winsize() {
                    if let Ok(m) = m.lock().map_err(|e| e.into_inner()) {
                        let _ = m.resize(ws);
                    }
                }
            }
        });
    }

    // stdin → PTY
    let child = Arc::new(Mutex::new(child));
    {
        let child = child.clone();
        thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            let mut buf = [0u8; 65536];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        if let Ok(mut c) = child.lock().map_err(|e| e.into_inner()) {
                            let _ = c.kill();
                        }
                        break;
                    }
                    Ok(n) => {
                        if writer.write_all(&buf[..n]).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }

    // PTY → stdout (main thread — restores termios cleanly on child exit)
    {
        let mut stdout = std::io::stdout().lock();
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if stdout.write_all(&buf[..n]).is_err() {
                        break;
                    }
                    let _ = stdout.flush();
                }
            }
        }
    }

    // Same try_wait poll as framed mode — a blocking wait() here would park
    // the child Mutex and deadlock the stdin thread's EOF→kill.
    let status = loop {
        {
            let mut g = child.lock().unwrap_or_else(|e| e.into_inner());
            match g.try_wait() {
                Ok(Some(s)) => break s.exit_code() as i32,
                Ok(None) => {}
                Err(_) => break -1,
            }
        }
        thread::sleep(std::time::Duration::from_millis(25));
    };
    std::process::exit(status);
}
