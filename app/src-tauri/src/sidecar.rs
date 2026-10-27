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
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;

use crate::log::diag;
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

/// The running sidecar (`None` while it's down), the exit flag that stops respawning, and
/// the operator's restart request (respawn at once, without counting it as a crash).
pub struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    stopping: AtomicBool,
    restart_requested: AtomicBool,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            stopping: AtomicBool::new(false),
            restart_requested: AtomicBool::new(false),
        }
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

/// Kill the running sidecar so the supervisor respawns it straight away, with no backoff.
/// If it's already down and waiting out a backoff, the wait is cut short instead.
pub fn restart(app: &AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        state.restart_requested.store(true, Ordering::Relaxed);
        if let Some(child) = state.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

/// Consume a pending restart request.
fn take_restart(app: &AppHandle) -> bool {
    app.try_state::<SidecarState>()
        .is_some_and(|s| s.restart_requested.swap(false, Ordering::Relaxed))
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

        if take_restart(app) {
            // The operator asked for this: not a crash, so no backoff and no escalation.
            diag!("[sidecar] restart requested; restarting now");
            attempt = 0;
            health::set_sidecar_down(app, Some("restart requested".into()));
            continue;
        }

        attempt = next_attempt(attempt, started.elapsed());
        let delay = restart_delay(attempt);
        diag!("[sidecar] {reason}; restarting in {delay:?}");
        health::set_sidecar_down(app, Some(reason));

        let mut slept = Duration::ZERO;
        while slept < delay {
            if stopping(app) {
                return;
            }
            if take_restart(app) {
                attempt = 0;
                break;
            }
            thread::sleep(SLEEP_STEP);
            slept += SLEEP_STEP;
        }
    }
}

/// Which sidecar the shell runs, from `TALLYBOT_FAKE_ATEM` and the build profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SidecarMode {
    /// The fake-ATEM dev entry, run by the host's `node` from this checkout's source.
    Fake,
    /// The production sidecar, bundled beside the exe as an `externalBin`.
    Packaged,
}

/// The environment variable that picks the sidecar (`1` fake, `0` packaged; unset: by profile).
const FAKE_ATEM_ENV: &str = "TALLYBOT_FAKE_ATEM";

/// Parse `TALLYBOT_FAKE_ATEM`. Unset or empty follows the build: fake for a debug build
/// (`cargo tauri dev`), packaged for release. Any other value than `1`/`0` is refused rather
/// than silently ignored, and so is `1` on a release build: the fake entry is a path into the
/// build machine's checkout (`CARGO_MANIFEST_DIR`), which doesn't exist on a user's machine.
fn sidecar_mode(value: Option<&str>, debug_build: bool) -> Result<SidecarMode, String> {
    match value {
        None | Some("") if debug_build => Ok(SidecarMode::Fake),
        None | Some("") => Ok(SidecarMode::Packaged),
        Some("1") if debug_build => Ok(SidecarMode::Fake),
        Some("1") => Err(format!("{FAKE_ATEM_ENV}=1 needs a debug build (cargo tauri dev)")),
        Some("0") => Ok(SidecarMode::Packaged),
        Some(other) => Err(format!("{FAKE_ATEM_ENV}={other:?} isn't 1 or 0")),
    }
}

/// Spawn the sidecar and store its handle. Returns its event stream.
fn spawn(app: &AppHandle) -> Result<Receiver<CommandEvent>, Box<dyn std::error::Error>> {
    // Development mode runs the sidecar against a fake ATEM (no switcher needed); the
    // board's input keys then drive the simulated program live onto real devices.
    let value = std::env::var(FAKE_ATEM_ENV).ok();
    let mode = sidecar_mode(value.as_deref(), cfg!(debug_assertions))?;

    // Dev runs Node directly on the TypeScript source (fake-ATEM entry from `tools/`),
    // resolved relative to this crate. A shippable build instead spawns the production
    // sidecar packaged as an `externalBin` (a single self-contained binary built with
    // `@yao-pkg/pkg` — see `binaries/` and `tauri.conf.json`). The pkg binary carries its
    // own Node runtime + `atem-connection` (incl. the `threadedclass`/`atemSocketChild`
    // worker), so no host Node is required on the user's machine.
    let cmd = match mode {
        SidecarMode::Fake => {
            let entry = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tools/src/sidecar-fake-main.ts")
                .to_string_lossy()
                .into_owned();
            diag!("[sidecar] spawning FAKE (dev) ATEM entry: {entry}");
            // No `TALLYBOT_STATE_FILE`: the dev entry keeps its state (and log) in the temp dir,
            // so dev assignments never clobber the installed app's config.
            app.shell()
                .command("node")
                .args(["--experimental-strip-types", &entry])
        }
        SidecarMode::Packaged => {
            diag!("[sidecar] spawning packaged sidecar binary (externalBin)");
            // Per Tauri docs: pass just the filename, not the configured `externalBin` path.
            // The CLI places `binaries/tallybot-sidecar-<triple>` next to the exe as
            // `tallybot-sidecar`; the resolver looks there (`<exe_dir>/tallybot-sidecar`).
            let mut cmd = app.shell().sidecar("tallybot-sidecar")?;
            // Persist config under the OS app-config dir (`%APPDATA%\com.tallybot.app` on
            // Windows, `~/.config/com.tallybot.app` on Linux, `~/Library/Application
            // Support/com.tallybot.app` on macOS) rather than next to the executable, so a
            // portable-zip update that replaces the app folder doesn't wipe the user's saved
            // ATEM/device config. The sidecar reads `TALLYBOT_STATE_FILE` first
            // (`app/sidecar/src/config.ts`); if we can't resolve the dir we don't set it and
            // the sidecar falls back to its own XDG-style default.
            match app.path().app_config_dir() {
                Ok(dir) => cmd = cmd.env("TALLYBOT_STATE_FILE", dir.join("state.json")),
                Err(e) => diag!("[sidecar] no app config dir ({e}); using sidecar default state path"),
            }
            cmd
        }
    };

    let (rx, child) = cmd.spawn()?;

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
/// Stdout lines become `"sidecar"` events; stderr goes to the shell's log. The sidecar's last
/// `fatal:` line (its own record of why it is exiting) is kept for the reason, so the banner
/// says what went wrong rather than only "exited with code 1".
fn pump(app: &AppHandle, mut rx: Receiver<CommandEvent>) -> String {
    let mut spoke = false;
    let mut fatal: Option<String> = None;
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
                    crate::report_event(app, "sidecar", text);
                }
            }
            CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line);
                diag!("[sidecar] {text}");
                if let Some(cause) = fatal_cause(&text) {
                    fatal = Some(cause);
                }
            }
            CommandEvent::Error(err) => diag!("[sidecar] error: {err}"),
            CommandEvent::Terminated(payload) => return with_cause(describe_exit(&payload), fatal.as_deref()),
            _ => {}
        }
    }
    with_cause("stopped responding".into(), fatal.as_deref())
}

/// The longest cause the down reason carries; the full text is in both logs.
const MAX_CAUSE_CHARS: usize = 160;

/// The cause from a sidecar `fatal: …` stderr line (`app/sidecar/src/diagnostics.ts` and the
/// entries' `main().catch` write them), trimmed to one short line; None for any other line.
fn fatal_cause(line: &str) -> Option<String> {
    let cause = line.trim().strip_prefix("fatal:")?.trim();
    if cause.is_empty() {
        return None;
    }
    let mut short: String = cause.chars().take(MAX_CAUSE_CHARS).collect();
    if short.len() < cause.len() {
        short.push('…');
    }
    Some(short)
}

/// An exit description with the sidecar's own last word appended, when it left one.
fn with_cause(exit: String, cause: Option<&str>) -> String {
    match cause {
        Some(cause) => format!("{exit}: {cause}"),
        None => exit,
    }
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

    #[test]
    fn sidecar_mode_follows_the_build_and_refuses_what_it_cannot_run() {
        use SidecarMode::{Fake, Packaged};
        // Unset or empty: fake for `cargo tauri dev`, packaged for a release build.
        assert_eq!(sidecar_mode(None, true), Ok(Fake));
        assert_eq!(sidecar_mode(Some(""), true), Ok(Fake));
        assert_eq!(sidecar_mode(None, false), Ok(Packaged));
        assert_eq!(sidecar_mode(Some(""), false), Ok(Packaged));
        // `0` forces packaged on either build.
        assert_eq!(sidecar_mode(Some("0"), true), Ok(Packaged));
        assert_eq!(sidecar_mode(Some("0"), false), Ok(Packaged));
        // `1` is fake on a debug build only; a release build has no checkout to run it from.
        assert_eq!(sidecar_mode(Some("1"), true), Ok(Fake));
        assert!(sidecar_mode(Some("1"), false).is_err());
        // Anything else is refused, never silently read as the default.
        for value in ["true", "yes", " 1", "2"] {
            assert!(sidecar_mode(Some(value), true).is_err(), "{value:?} on debug");
            assert!(sidecar_mode(Some(value), false).is_err(), "{value:?} on release");
        }
    }
}
