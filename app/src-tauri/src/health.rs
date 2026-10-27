//! Shell-side health the operator must see: a dead sidecar, USB ports we can't open, and
//! boards on USB that aren't running TallyBot firmware — plus which port each wired light is
//! on, which only the shell knows and the flasher needs.
//!
//! None can travel over the `"sidecar"` event channel — one is the sidecar being gone,
//! the others are known only to the shell — so the shell keeps its own small snapshot and
//! pushes the whole thing to the webview as a `"health"` event on every change. The UI
//! also pulls it once via `shell_health` on mount, since Tauri doesn't buffer events for
//! listeners that don't exist yet (a port error found during start-up would be lost).
//! `revision` orders the two, so a pulled snapshot never overwrites a newer pushed one.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

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
    /// Lights detected on USB (they sent HELLO) and the port each is on, sorted by MAC.
    pub light_ports: Vec<LightPort>,
    /// Unflashed boards that are a known light: an install on that port stopped where it left the
    /// board without firmware (`flash.rs`), so it sends no HELLO and has no MAC of its own to show.
    /// Kept until the port is unplugged or a light speaks on it again.
    pub blank_lights: Vec<LightPort>,
    /// Set when the OS app-config dir couldn't be resolved: the sidecar then keeps its state in
    /// its own fallback location and `shell.log` isn't written. Operator-facing message.
    pub config_dir_missing: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LightPort {
    pub mac: String,
    pub port: String,
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

/// Record the port a light is on (`Some`), or that it left USB (`None`). Emits only on change.
/// A light speaking on a port means that port no longer holds a blanked light.
pub fn set_light_port(app: &AppHandle, mac: &str, port: Option<&str>) {
    update(app, |h| {
        let unblanked = match port {
            Some(p) => {
                let before = h.blank_lights.len();
                h.blank_lights.retain(|b| b.port != p && b.mac != mac);
                h.blank_lights.len() != before
            }
            None => false,
        };
        let existing = h.light_ports.iter().position(|l| l.mac == mac);
        unblanked | match (existing, port) {
            (Some(i), Some(p)) if h.light_ports[i].port == p => false,
            (Some(i), Some(p)) => {
                h.light_ports[i].port = p.to_string();
                true
            }
            (Some(i), None) => {
                h.light_ports.remove(i);
                true
            }
            (None, Some(p)) => {
                h.light_ports.push(LightPort { mac: mac.to_string(), port: p.to_string() });
                h.light_ports.sort_by(|a, b| a.mac.cmp(&b.mac));
                true
            }
            (None, None) => false,
        }
    });
}

/// Record that the board on `port` is the light `mac`, left without firmware (`Some`), or that the
/// port no longer holds one (`None`). Emits only on change.
pub fn set_blank_light(app: &AppHandle, port: &str, mac: Option<&str>) {
    update(app, |h| {
        let before = h.blank_lights.clone();
        h.blank_lights.retain(|b| b.port != port && mac.map_or(true, |m| b.mac != m));
        if let Some(m) = mac {
            h.blank_lights.push(LightPort { mac: m.to_string(), port: port.to_string() });
            h.blank_lights.sort_by(|a, b| a.port.cmp(&b.port));
        }
        h.blank_lights != before
    });
}

/// Report that the app-config dir couldn't be resolved (`lib.rs` setup). Emits only on change.
pub fn set_config_dir_missing(app: &AppHandle, message: Option<String>) {
    update(app, |h| {
        if h.config_dir_missing == message {
            return false;
        }
        h.config_dir_missing = message;
        true
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
    crate::report_event(app, "health", snapshot);
}
