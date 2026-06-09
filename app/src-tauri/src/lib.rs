//! The Tauri shell — spawns the Node sidecar and bridges its NDJSON stdio to the UI.
//!
//! The sidecar (the brain) is a long-lived child process speaking newline-delimited
//! JSON on its stdin/stdout (`app/sidecar/src/ipc.ts`). This shell:
//!   • spawns it on startup,
//!   • forwards every stdout line to the webview as a `"sidecar"` event (`SidecarEvent`s),
//!   • exposes `send_to_sidecar`, a command the UI `invoke`s to push a `UiCommand` to stdin,
//!   • kills the child when the app exits, so no orphan `node` survives.
//!
//! See `app/sidecar/SIDECAR.md` ("The Rust bridge") for the design rationale.
//!
//! USB-serial provisioning (v1.2) extends this same bridge: the `usb` module owns the
//! serial port(s) on dedicated threads and exchanges `usb*` JSON messages with the
//! sidecar over the very stdin/stdout pipe used here — see `usb/mod.rs`.

mod usb;

use std::sync::Mutex;

use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use usb::UsbState;

/// Holds the running sidecar so the `send_to_sidecar` command can write to its stdin and
/// the exit handler can kill it. `None` until spawned / after it's been taken to kill.
struct SidecarState(Mutex<Option<CommandChild>>);

/// Write one NDJSON line to the sidecar's stdin (a trailing newline is added if missing).
/// The single stdin writer — used by the `send_to_sidecar` UI command and by the USB port
/// threads relaying device messages. Errors if the sidecar isn't running.
pub(crate) fn write_sidecar_line(app: &tauri::AppHandle, line: &str) -> Result<(), String> {
    let state = app
        .try_state::<SidecarState>()
        .ok_or("sidecar state missing")?;
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let child = guard.as_mut().ok_or("sidecar is not running")?;
    let mut bytes = line.as_bytes().to_vec();
    if bytes.last() != Some(&b'\n') {
        bytes.push(b'\n'); // NDJSON: one JSON object per line
    }
    child.write(&bytes).map_err(|e| e.to_string())
}

/// Forward one already-serialized NDJSON `UiCommand` line to the sidecar's stdin.
/// The UI calls this via `invoke` for every command (assign, identify, setSource, …).
#[tauri::command]
fn send_to_sidecar(app: tauri::AppHandle, line: String) -> Result<(), String> {
    write_sidecar_line(&app, &line)
}

/// Spawn the sidecar and pump its output to the UI. Stdout lines become `"sidecar"`
/// events; stderr is mirrored to our own stderr for debugging.
fn spawn_sidecar(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
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

    let (mut rx, child) = cmd
        // NVIDIA + Wayland workaround for the shipped binary (CLAUDE.md). Harmless
        // elsewhere; the dev shell already sets this for the parent.
        .env("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
        .spawn()?;

    app.state::<SidecarState>().0.lock().unwrap().replace(child);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                // The shell plugin delivers stdout one line at a time — one NDJSON
                // message per event. `usb*` messages are shell-targeted (route them to the
                // serial port threads); everything else is forwarded to the UI via `$ipc`.
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line).into_owned();
                    if !usb::handle_outbound(&handle, &text) {
                        let _ = handle.emit("sidecar", text);
                    }
                }
                CommandEvent::Stderr(line) => {
                    eprint!("[sidecar] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(err) => eprintln!("[sidecar] error: {err}"),
                CommandEvent::Terminated(payload) => {
                    eprintln!("[sidecar] terminated: {payload:?}");
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Kill the sidecar if it's still running, and signal the USB threads to wind down.
/// Called on app exit so no orphan process or open serial port survives.
fn shutdown(app: &tauri::AppHandle) {
    if let Some(usb) = app.try_state::<UsbState>() {
        usb.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Some(child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .manage(UsbState::new())
        .setup(|app| {
            spawn_sidecar(app.handle())?;
            usb::start(app.handle().clone()); // poll for ESP32-C3 serial ports + relay
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send_to_sidecar])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                shutdown(app_handle);
            }
        });
}
