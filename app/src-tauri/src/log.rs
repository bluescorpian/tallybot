//! The shell's own diagnostic log: every line goes to stderr and to a rotating `shell.log`
//! beside the sidecar's `state.json` and `sidecar.log`.
//!
//! A release build has no console (`windows_subsystem = "windows"` in `main.rs`), so stderr
//! alone loses exactly the lines that explain a show's fault after the fact: why the sidecar
//! restarted, a USB port that wouldn't open, a failed update install. The sidecar's stderr is
//! mirrored here too, because a Node crash (an uncaught exception, a module the packaged
//! binary failed to load) is printed by the runtime straight to stderr and never reaches the
//! sidecar's own log file.
//!
//! Like `app/sidecar/src/log-file.ts`, writing must never hurt the show it records. [`line`]
//! never blocks or fails: it hands the line to one writer thread over a bounded queue and drops
//! it if the queue is full (a stalled disk), so the sidecar's stdout pump and the USB threads
//! that log are never held up by the filesystem. Any write error drops that line; the file is
//! reopened on the next one.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::OnceLock;
use std::thread;

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// The log file's name, in the directory that holds `state.json`.
pub const FILE_NAME: &str = "shell.log";
/// Rotate once the live file would grow past this. The shell's own lines are rare; the bulk is
/// the mirrored sidecar stderr, which carries no per-device traffic (that goes to `sidecar.log`).
const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Rotated files (`.1` … `.KEEP`) kept beside the live one: at most ~8 MB in all.
const KEEP: u32 = 3;
/// Lines queued for the writer beyond which new ones are dropped.
const QUEUE: usize = 4096;

static SINK: OnceLock<SyncSender<String>> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);

/// Write one diagnostic line, `format!`-style: to stderr, and to `shell.log` once [`init`] ran.
macro_rules! diag {
    ($($arg:tt)*) => {
        $crate::log::line(&format!($($arg)*))
    };
}
pub(crate) use diag;

/// Start the file sink in `dir` (created if missing). Lines logged before this reach stderr only.
/// A second call is ignored.
pub fn init(dir: &Path) {
    let (tx, rx) = mpsc::sync_channel(QUEUE);
    if SINK.set(tx).is_err() {
        return;
    }
    let path = dir.join(FILE_NAME);
    let spawned = thread::Builder::new()
        .name("shell-log".into())
        .spawn(move || write_loop(&path, &rx));
    if let Err(e) = spawned {
        eprintln!("[log] no log file: couldn't start its writer ({e})");
    }
}

/// One diagnostic line (a trailing newline is trimmed and re-added). Never blocks, never fails.
pub fn line(text: &str) {
    let text = text.trim_end();
    eprintln!("{text}");
    let Some(tx) = SINK.get() else {
        return;
    };
    match tx.try_send(format!("{} {text}\n", timestamp())) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
        Err(TrySendError::Disconnected(_)) => {} // the writer couldn't start: stderr only
    }
}

fn write_loop(path: &Path, rx: &Receiver<String>) {
    let mut file: Option<(File, u64)> = None;
    for entry in rx {
        let dropped = DROPPED.swap(0, Ordering::Relaxed);
        let entry = if dropped > 0 {
            format!("{} [log] {dropped} line(s) dropped: write queue full\n{entry}", timestamp())
        } else {
            entry
        };
        if append(path, &mut file, entry.as_bytes()).is_err() {
            file = None; // drop the line; reopen (and relearn the size) on the next
        }
    }
}

fn append(path: &Path, file: &mut Option<(File, u64)>, bytes: &[u8]) -> std::io::Result<()> {
    let len = bytes.len() as u64;
    if file.is_none() {
        *file = Some(open(path)?);
    }
    if file.as_ref().is_some_and(|(_, size)| *size > 0 && *size + len > MAX_BYTES) {
        *file = None; // close it before the rename
        rotate(path);
        *file = Some(open(path)?);
    }
    let (f, size) = file.as_mut().expect("opened above");
    f.write_all(bytes)?;
    *size += len;
    Ok(())
}

/// Open the live file for appending, with its current size.
fn open(path: &Path) -> std::io::Result<(File, u64)> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let f = OpenOptions::new().create(true).append(true).open(path)?;
    let size = f.metadata()?.len();
    Ok((f, size))
}

/// Shift `shell.log` → `.1` → … → `.KEEP`, oldest first; a missing `.n` is normal. If the live
/// file can't move (Windows, another program holding it), appending carries on past the cap and
/// the next line retries: losing the log is worse than an oversized file.
fn rotate(path: &Path) {
    let numbered = |n: u32| PathBuf::from(format!("{}.{n}", path.display()));
    for n in (1..KEEP).rev() {
        let _ = fs::rename(numbered(n), numbered(n + 1));
    }
    let _ = fs::rename(path, numbered(1));
}

/// UTC, RFC 3339 (`2026-10-27T19:33:21.042Z`). The sidecar's log uses local time; the `time`
/// crate can't read the local offset soundly from a multi-threaded process on Unix, so the shell
/// stamps UTC rather than guess.
fn timestamp() -> String {
    let now = OffsetDateTime::now_utc();
    let now = now.replace_nanosecond(now.millisecond() as u32 * 1_000_000).unwrap_or(now);
    now.format(&Rfc3339).unwrap_or_default()
}
