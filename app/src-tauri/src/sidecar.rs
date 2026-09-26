//! Sidecar lifecycle: spawn the Node sidecar, pump its stdout, and respawn it if it dies.
//!
//! A supervisor thread owns the whole loop. When the child exits (crash, OOM, a stray
//! `kill`), the UI is told at once via `health` so it stops presenting the last-known
//! tally as live, and the sidecar is respawned after a capped exponential backoff. The
//! new process rebuilds its world the same way a cold start does — it reloads the config,
//! reconnects the ATEM, and WiFi/ESP-NOW lights find it again by discovery — with one
//! exception: USB devices were announced to the *old* process by the port threads, which
//! outlive it. So once the new sidecar first speaks, `usb::replay_connected` re-announces
//! every open USB device (which also re-asserts a designated ESP-NOW bridge).
//!
//! There is only ever one child and one stdout pump: the next spawn happens on this same
//! thread after the previous child is gone (killed first if its output closed without an
//! exit), so restarts never double up the sidecar or its bound ports.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;

use crate::{health, usb};

/// First restart delay; doubles per consecutive quick crash.
const BACKOFF_BASE: Duration = Duration::from_millis(500);
/// Ceiling on the restart delay, so a crash-looping sidecar still retries twice a minute.
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// A sidecar that ran at least this long before dying counts as healthy: the backoff
/// resets, so a rare crash in a long session restarts quickly.
const STABLE_UPTIME: Duration = Duration::from_secs(60);
/// Granularity for noticing app exit while waiting out a backoff.
const SLEEP_STEP: Duration = Duration::from_millis(100);

/// The running sidecar (`None` while it's down) and the exit flag that stops respawning.
pub struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    stopping: AtomicBool,
}

impl SidecarState {
    pub fn new() -> Self {
        Self { child: Mutex::new(None), stopping: AtomicBool::new(false) }
    }
}

/// Write one NDJSON line to the sidecar's stdin (a trailing newline is added if missing).
/// The single stdin writer — used by the `send_to_sidecar` UI command and by the USB port
/// threads relaying device messages. Errors if the sidecar isn't running.
pub(crate) fn write_line(app: &AppHandle, line: &str) -> Result<(), String> {
    let state = app.try_state::<SidecarState>().ok_or("sidecar state missing")?;
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    let child = guard.as_mut().ok_or("sidecar is not running")?;
    let mut bytes = line.as_bytes().to_vec();
    if bytes.last() != Some(&b'\n') {
        bytes.push(b'\n'); // NDJSON: one JSON object per line
    }
    child.write(&bytes).map_err(|e| e.to_string())
}

/// Start the supervisor thread (spawns the sidecar straight away). Returns immediately.
pub fn start(app: AppHandle) {
    thread::Builder::new()
        .name("sidecar-supervisor".into())
        .spawn(move || supervise(&app))
        .expect("spawn sidecar supervisor thread");
}

/// Stop respawning and kill the running sidecar. Called on app exit.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        state.stopping.store(true, Ordering::Relaxed);
        if let Some(child) = state.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

fn stopping(app: &AppHandle) -> bool {
    app.try_state::<SidecarState>()
        .map_or(true, |s| s.stopping.load(Ordering::Relaxed))
}

fn supervise(app: &AppHandle) {
    let mut attempt = 0u32;
    loop {
        let started = Instant::now();
        let reason = match spawn(app) {
            Ok(rx) => pump(app, rx),
            Err(e) => format!("couldn't start ({e})"),
        };
        // The child is gone (or its output is): drop the handle so writes fail fast, and
        // kill it in case it's somehow still alive, so a respawn can't run beside it.
        if let Some(state) = app.try_state::<SidecarState>() {
            if let Some(child) = state.child.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
        if stopping(app) {
            return; // app exit killed it — don't restart
        }

        attempt = next_attempt(attempt, started.elapsed());
        let delay = restart_delay(attempt);
        eprintln!("[sidecar] {reason}; restarting in {delay:?}");
        health::set_sidecar_down(app, Some(reason));

        let mut slept = Duration::ZERO;
        while slept < delay {
            if stopping(app) {
                return;
            }
            thread::sleep(SLEEP_STEP);
            slept += SLEEP_STEP;
        }
    }
}

/// Spawn the sidecar and store its handle. Returns its event stream.
fn spawn(app: &AppHandle) -> Result<Receiver<CommandEvent>, Box<dyn std::error::Error>> {
    // Development mode runs the sidecar against a fake ATEM (no switcher needed); the
    // board's input keys then drive the simulated program live onto real devices. It's
    // on by default for debug builds (`cargo tauri dev`) and off for release
    // (`cargo tauri build`); `TALLYBOT_FAKE_ATEM=1`/`0` overrides either way.
    let dev = match std::env::var("TALLYBOT_FAKE_ATEM").as_deref() {
        Ok("1") => true,
        Ok("0") => false,
        _ => cfg!(debug_assertions),
    };

    // Dev runs Node directly on the TypeScript source (fake-ATEM entry from `tools/`),
    // resolved relative to this crate. A shippable build instead spawns the production
    // sidecar packaged as an `externalBin` (a single self-contained binary built with
    // `@yao-pkg/pkg` — see `binaries/` and `tauri.conf.json`). The pkg binary carries its
    // own Node runtime + `atem-connection` (incl. the `threadedclass`/`atemSocketChild`
    // worker), so no host Node is required on the user's machine.
    let cmd = if dev {
        let entry = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tools/src/sidecar-fake-main.ts")
            .to_string_lossy()
            .into_owned();
        eprintln!("[sidecar] spawning FAKE (dev) ATEM entry: {entry}");
        app.shell()
            .command("node")
            .args(["--experimental-strip-types", &entry])
    } else {
        eprintln!("[sidecar] spawning packaged sidecar binary (externalBin)");
        // Per Tauri docs: pass just the filename, not the configured `externalBin` path.
        // The CLI places `binaries/tallybot-sidecar-<triple>` next to the exe as
        // `tallybot-sidecar`; the resolver looks there (`<exe_dir>/tallybot-sidecar`).
        let mut cmd = app.shell().sidecar("tallybot-sidecar")?;
        // Persist config under the OS app-data dir (`%APPDATA%\com.tallybot.app` on
        // Windows, `~/.config/com.tallybot.app` on Linux, `~/Library/Application
        // Support/com.tallybot.app` on macOS) rather than next to the executable, so a
        // portable-zip update that replaces the app folder doesn't wipe the user's saved
        // ATEM/device config. The sidecar reads `TALLYBOT_STATE_FILE` first
        // (`sidecar/src/main.ts` → `stateFilePath()`); if we can't resolve the dir we
        // simply don't set it and the sidecar falls back to its own XDG-style default.
        match app.path().app_config_dir() {
            Ok(dir) => cmd = cmd.env("TALLYBOT_STATE_FILE", dir.join("state.json")),
            Err(e) => eprintln!("[sidecar] no app config dir ({e}); using sidecar default state path"),
        }
        cmd
    };

    let (rx, child) = cmd
        // NVIDIA + Wayland workaround for the shipped binary (CLAUDE.md). Harmless
        // elsewhere; the dev shell already sets this for the parent.
        .env("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
        .spawn()?;

    let state = app.state::<SidecarState>();
    // Checked under the lock `shutdown` takes, so an exit racing this spawn can't miss it.
    let mut guard = state.child.lock().unwrap();
    if state.stopping.load(Ordering::Relaxed) {
        let _ = child.kill();
    } else {
        guard.replace(child);
    }
    Ok(rx)
}

/// Pump one child's events until it exits; returns an operator-facing reason.
/// Stdout lines become `"sidecar"` events; stderr is mirrored to our own stderr.
fn pump(app: &AppHandle, mut rx: Receiver<CommandEvent>) -> String {
    let mut spoke = false;
    while let Some(event) = rx.blocking_recv() {
        match event {
            // The shell plugin delivers stdout one line at a time — one NDJSON
            // message per event. `usb*` messages are shell-targeted (route them to the
            // serial port threads); everything else is forwarded to the UI via `$ipc`.
            CommandEvent::Stdout(line) => {
                if !spoke {
                    // First output ⇒ the sidecar is wired up and reading stdin: it's up.
                    // Re-announce open USB devices (a no-op on a cold start, where none
                    // have been detected yet; essential after a restart).
                    spoke = true;
                    health::set_sidecar_down(app, None);
                    usb::replay_connected(app);
                }
                let text = String::from_utf8_lossy(&line).into_owned();
                if !usb::handle_outbound(app, &text) {
                    let _ = app.emit("sidecar", text);
                }
            }
            CommandEvent::Stderr(line) => {
                eprint!("[sidecar] {}", String::from_utf8_lossy(&line));
            }
            CommandEvent::Error(err) => eprintln!("[sidecar] error: {err}"),
            CommandEvent::Terminated(payload) => return describe_exit(&payload),
            _ => {}
        }
    }
    "stopped responding".into()
}

/// The consecutive-quick-crash count after a crash, given how long the sidecar had run.
fn next_attempt(attempt: u32, uptime: Duration) -> u32 {
    if uptime >= STABLE_UPTIME {
        0
    } else {
        attempt.saturating_add(1)
    }
}

/// Delay before respawning: `BACKOFF_BASE × 2^attempt`, capped at `BACKOFF_MAX`.
fn restart_delay(attempt: u32) -> Duration {
    BACKOFF_BASE
        .checked_mul(1u32.checked_shl(attempt).unwrap_or(u32::MAX))
        .map_or(BACKOFF_MAX, |d| d.min(BACKOFF_MAX))
}

fn describe_exit(payload: &TerminatedPayload) -> String {
    match (payload.code, payload.signal) {
        (_, Some(signal)) => format!("killed by signal {signal}"),
        (Some(code), None) => format!("exited with code {code}"),
        (None, None) => "exited".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_then_caps() {
        assert_eq!(restart_delay(0), Duration::from_millis(500));
        assert_eq!(restart_delay(1), Duration::from_secs(1));
        assert_eq!(restart_delay(3), Duration::from_secs(4));
        assert_eq!(restart_delay(6), BACKOFF_MAX); // 32 s → capped at 30 s
        assert_eq!(restart_delay(31), BACKOFF_MAX);
        assert_eq!(restart_delay(u32::MAX), BACKOFF_MAX); // no shift/multiply overflow
    }

    #[test]
    fn quick_crashes_escalate_and_a_stable_run_resets() {
        let quick = Duration::from_secs(2);
        let mut attempt = 0;
        attempt = next_attempt(attempt, quick);
        attempt = next_attempt(attempt, quick);
        assert_eq!(attempt, 2);
        assert_eq!(next_attempt(attempt, STABLE_UPTIME), 0);
        assert_eq!(next_attempt(u32::MAX, quick), u32::MAX);
    }

    #[test]
    fn exit_reasons_read_plainly() {
        let p = |code, signal| TerminatedPayload { code, signal };
        assert_eq!(describe_exit(&p(Some(1), None)), "exited with code 1");
        assert_eq!(describe_exit(&p(None, Some(9))), "killed by signal 9");
        assert_eq!(describe_exit(&p(None, None)), "exited");
    }
}
