//! Shell-side health the operator must see: a dead sidecar and USB ports we can't open.
//!
//! Neither can travel over the `"sidecar"` event channel — one is the sidecar being gone,
//! the other is known only to the shell — so the shell keeps its own small snapshot and
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
