//! Shell-side health the operator must see: a dead sidecar, USB ports we can't open, and
//! boards on USB that aren't running TallyBot firmware.
//!
//! None can travel over the `"sidecar"` event channel — one is the sidecar being gone,
//! the others are known only to the shell — so the shell keeps its own small snapshot and
//! pushes the whole thing to the webview as a `"health"` event on every change. The UI
//! also pulls it once via `shell_health` on mount, since Tauri doesn't buffer events for
//! listeners that don't exist yet (a port error found during start-up would be lost).
//! `revision` orders the two, so a pulled snapshot never overwrites a newer pushed one.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    /// Bumped on every change.
    pub revision: u64,
    /// Why the sidecar isn't running, from its exit until the respawned one first speaks.
    /// `None` while it's running (or on first start, before it has had a chance to fail).
    pub sidecar_down: Option<String>,
    /// Ports that repeatedly fail to open, sorted by port. Operator-facing messages.
    pub usb_port_errors: Vec<UsbPortError>,
    /// Ports holding an ESP32-C3 that never sent HELLO (no TallyBot firmware), sorted. The
    /// shell has released each one so the web flasher can open it; cleared on unplug.
    pub unflashed_ports: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UsbPortError {
    pub port: String,
    pub message: String,
}

pub struct HealthState(Mutex<Health>);

impl HealthState {
    pub fn new() -> Self {
        Self(Mutex::new(Health::default()))
    }
}

/// The current snapshot, for the UI's initial pull.
#[tauri::command]
pub fn shell_health(state: tauri::State<'_, HealthState>) -> Health {
    state.0.lock().unwrap().clone()
}

/// Mark the sidecar down (with the reason) or back up (`None`). Emits only on change.
pub fn set_sidecar_down(app: &AppHandle, reason: Option<String>) {
    update(app, |h| {
        if h.sidecar_down == reason {
            return false;
        }
        h.sidecar_down = reason;
        true
    });
}

/// Record (or clear, with `None`) the open error for one port. Emits only on change.
pub fn set_usb_port_error(app: &AppHandle, port: &str, message: Option<String>) {
    update(app, |h| {
        let existing = h.usb_port_errors.iter().position(|e| e.port == port);
        match (existing, message) {
            (Some(i), Some(m)) if h.usb_port_errors[i].message == m => false,
            (Some(i), Some(m)) => {
                h.usb_port_errors[i].message = m;
                true
            }
            (Some(i), None) => {
                h.usb_port_errors.remove(i);
                true
            }
            (None, Some(m)) => {
                h.usb_port_errors.push(UsbPortError { port: port.to_string(), message: m });
                h.usb_port_errors.sort_by(|a, b| a.port.cmp(&b.port));
                true
            }
            (None, None) => false,
        }
    });
}

/// Mark a port as holding an unflashed board (`true`) or clear it. Emits only on change.
pub fn set_unflashed_port(app: &AppHandle, port: &str, unflashed: bool) {
    update(app, |h| {
        let existing = h.unflashed_ports.iter().position(|p| p == port);
        match (existing, unflashed) {
            (None, true) => {
                h.unflashed_ports.push(port.to_string());
                h.unflashed_ports.sort();
                true
            }
            (Some(i), false) => {
                h.unflashed_ports.remove(i);
                true
            }
            _ => false,
        }
    });
}

/// Apply `change`; if it reports a change, bump the revision and push the snapshot.
fn update(app: &AppHandle, change: impl FnOnce(&mut Health) -> bool) {
    let Some(state) = app.try_state::<HealthState>() else {
        return;
    };
    let snapshot = {
        let mut h = state.0.lock().unwrap();
        if !change(&mut h) {
            return;
        }
        h.revision += 1;
        h.clone()
    };
    let _ = app.emit("health", snapshot);
}
