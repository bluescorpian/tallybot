//! The Tauri shell — spawns the Node sidecar and bridges its NDJSON stdio to the UI.
//!
//! The sidecar (the brain) is a long-lived child process speaking newline-delimited
//! JSON on its stdin/stdout (`app/sidecar/src/ipc.ts`). This shell:
//!   • spawns it on startup and respawns it (with backoff) if it dies — `sidecar.rs`,
//!   • forwards every stdout line to the webview as a `"sidecar"` event (`SidecarEvent`s),
//!   • reports what the operator must see but the sidecar can't say (the sidecar itself
//!     being down, a USB port it can't open) as a `"health"` event — `health.rs`,
//!   • exposes `send_to_sidecar`, a command the UI `invoke`s to push a `UiCommand` to stdin,
//!   • kills the child when the app exits, so no orphan `node` survives.
//!
//! See `app/sidecar/SIDECAR.md` ("The Rust bridge") for the design rationale.
//!
//! USB-serial provisioning (v1.2) extends this same bridge: the `usb` module owns the
//! serial port(s) on dedicated threads and exchanges `usb*` JSON messages with the
//! sidecar over the very stdin/stdout pipe used here — see `usb/mod.rs`.

mod health;
mod sidecar;
mod usb;

use tauri::{Manager, RunEvent};

use health::HealthState;
use sidecar::SidecarState;
use usb::UsbState;

/// Forward one already-serialized NDJSON `UiCommand` line to the sidecar's stdin.
/// The UI calls this via `invoke` for every command (assign, identify, setSource, …).
#[tauri::command]
fn send_to_sidecar(app: tauri::AppHandle, line: String) -> Result<(), String> {
    sidecar::write_line(&app, &line)
}

/// Settings → "Restart TallyBot Engine": replace the running sidecar with a fresh one.
#[tauri::command]
fn restart_sidecar(app: tauri::AppHandle) {
    sidecar::restart(&app);
}

/// Kill the sidecar (and stop respawning it), and signal the USB threads to wind down.
/// Called on app exit so no orphan process or open serial port survives.
fn shutdown(app: &tauri::AppHandle) {
    if let Some(usb) = app.try_state::<UsbState>() {
        usb.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    sidecar::shutdown(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::Builder::new().build()) // Settings → "Launch on system startup"
        .manage(SidecarState::new())
        .manage(UsbState::new())
        .manage(HealthState::new())
        .setup(|app| {
            sidecar::start(app.handle().clone()); // spawn + respawn-on-crash supervisor
            usb::start(app.handle().clone()); // poll for ESP32-C3 serial ports + relay
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send_to_sidecar, restart_sidecar, health::shell_health])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                shutdown(app_handle);
            }
        });
}
