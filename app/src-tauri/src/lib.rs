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

use std::sync::Mutex;

use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the running sidecar so the `send_to_sidecar` command can write to its stdin and
/// the exit handler can kill it. `None` until spawned / after it's been taken to kill.
struct SidecarState(Mutex<Option<CommandChild>>);

/// Forward one already-serialized NDJSON `UiCommand` line to the sidecar's stdin.
/// The UI calls this via `invoke` for every command (assign, identify, setSource, …).
#[tauri::command]
fn send_to_sidecar(state: tauri::State<'_, SidecarState>, line: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let child = guard.as_mut().ok_or("sidecar is not running")?;
    let mut bytes = line.into_bytes();
    if bytes.last() != Some(&b'\n') {
        bytes.push(b'\n'); // NDJSON: one JSON object per line
    }
    child.write(&bytes).map_err(|e| e.to_string())
}

/// Spawn the sidecar and pump its output to the UI. Stdout lines become `"sidecar"`
/// events; stderr is mirrored to our own stderr for debugging.
fn spawn_sidecar(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // PACKAGING: in dev we run Node directly on the TypeScript source, resolved relative
    // to this crate. A shippable build will instead bundle the sidecar as `externalBin`
    // and spawn it with `app.shell().sidecar("tallybot-sidecar")` — deferred for now.
    let entry = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../sidecar/src/main.ts")
        .to_string_lossy()
        .into_owned();

    let (mut rx, child) = app
        .shell()
        .command("node")
        .args(["--experimental-strip-types", &entry])
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
                // message per event. Forward the raw line; the UI parses it via `$ipc`.
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line).into_owned();
                    let _ = handle.emit("sidecar", text);
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

/// Kill the sidecar if it's still running. Called on app exit so no orphan survives.
fn kill_sidecar(app: &tauri::AppHandle) {
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
        .setup(|app| {
            spawn_sidecar(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send_to_sidecar])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                kill_sidecar(app_handle);
            }
        });
}
