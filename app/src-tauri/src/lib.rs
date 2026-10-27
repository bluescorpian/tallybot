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
//!
//! The `flash` module installs the firmware bundled with this app onto a board on USB,
//! borrowing its port from the `usb` module for the duration; `updater` updates the app itself.
//! Every diagnostic line goes through `log::diag!`, which also keeps it in `shell.log`: a release
//! build has no console.

mod flash;
mod health;
mod log;
mod sidecar;
mod updater;
mod usb;

use tauri::{Manager, RunEvent};

use flash::FlashState;
use health::HealthState;
use sidecar::SidecarState;
use updater::UpdaterState;
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

/// Push an event to the webview. Best effort by design: the state behind each push can also be
/// pulled (`shell_health`, `flash_status`, `update_status`, the sidecar's `requestState`), so a
/// lost push is recovered by the UI's next pull; only a sidecar `notice` is one-shot. A failure is
/// logged, not dropped silently.
pub(crate) fn report_event<S: serde::Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: S) {
    use tauri::Emitter;
    if let Err(e) = app.emit(event, payload) {
        log::diag!("[shell] couldn't send the {event:?} event to the window: {e}");
    }
}

/// Kill the sidecar (and stop respawning it), and signal the USB threads to wind down.
/// Called on app exit so no orphan process or open serial port survives.
pub(crate) fn shutdown(app: &tauri::AppHandle) {
    if let Some(usb) = app.try_state::<UsbState>() {
        usb.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    sidecar::shutdown(app);
}

/// WebKitGTK's DMA-BUF renderer crashes the window on NVIDIA + Wayland ("Error 71 (Protocol
/// error) dispatching to Wayland display", https://bugs.webkit.org/show_bug.cgi?id=280210).
/// Disable it on that setup only, so accelerated rendering is untouched elsewhere, and let an
/// explicit value win: the same gate the dev shell applies in `flake.nix`. It has to be set on
/// this process, which hosts the webview, before the builder starts WebKit or any thread.
#[cfg(target_os = "linux")]
fn work_around_webkit_dmabuf() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    let set = |name: &str| std::env::var_os(name).is_some_and(|v| !v.is_empty());
    if !set(VAR) && set("WAYLAND_DISPLAY") && std::path::Path::new("/sys/module/nvidia").is_dir() {
        std::env::set_var(VAR, "1");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    work_around_webkit_dmabuf();

    tauri::Builder::default()
        // First, so a second launch exits before it spawns an engine or opens a port: two
        // engines would fight over TCP 7000 and the serial ports. It surfaces this window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::Builder::new().build()) // Settings → "Launch on system startup"
        .plugin(tauri_plugin_updater::Builder::new().build()) // updater.rs; config in tauri.conf.json
        .manage(SidecarState::new())
        .manage(UsbState::new())
        .manage(HealthState::new())
        .manage(FlashState::default())
        .manage(UpdaterState::default())
        .setup(|app| {
            // The shell's log sits beside the sidecar's state and log (`log.rs`); first, so the
            // supervisors below have a file for their lines from the start.
            match app.path().app_config_dir() {
                Ok(dir) => log::init(&dir),
                Err(e) => {
                    log::diag!("[log] no app config dir ({e}); logging to stderr only");
                    // The sidecar falls back to its own state path too (sidecar.rs): say so.
                    health::set_config_dir_missing(
                        app.handle(),
                        Some(format!(
                            "TallyBot couldn't find its settings folder ({e}), so it keeps settings in a fallback location and doesn't write its shell log. Settings saved elsewhere before won't load."
                        )),
                    );
                }
            }
            updater::restore_install_failure(app.handle()); // a failed install's reason, before the UI pulls
            sidecar::start(app.handle().clone()); // spawn + respawn-on-crash supervisor
            usb::start(app.handle().clone()); // poll for ESP32-C3 serial ports + relay
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_to_sidecar,
            restart_sidecar,
            health::shell_health,
            flash::firmware_info,
            flash::flash_start,
            flash::flash_cancel,
            flash::flash_status,
            updater::update_check,
            updater::update_download,
            updater::update_install,
            updater::update_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                shutdown(app_handle);
            }
        });
}
