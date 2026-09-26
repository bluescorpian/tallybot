//! USB-serial transport (v1.2 provisioning).
//!
//! The shell owns the serial port(s) for their whole life and acts as a near-dumb
//! byte pipe between a device and the Node sidecar (the tally *brain*): it does COBS
//! framing, parses only HELLO (for detection + outbound routing by MAC), and relays
//! everything else opaque over the **existing** shell↔sidecar NDJSON stdio bridge.
//!
//! Bridge vocabulary (all one-line JSON on the existing pipe):
//!   • shell → sidecar (written to the sidecar's stdin):
//!       {"type":"usbDeviceConnected","mac":..,"version":..}
//!       {"type":"usbDeviceDisconnected","mac":..}
//!       {"type":"usbFrame","mac":..,"payloadHex":..}   // STATUS/LOG/RELAY/other device→host payloads
//!       {"type":"unflashedDeviceDetected","port":..}
//!   • sidecar → shell (read off the sidecar's stdout, intercepted before the UI):
//!       {"type":"usbSend","mac":..,"payloadHex":..}     // SET_COLOR/SET_WIFI/SET_TRANSPORT/GET_STATUS/RELAY/SET_BRIDGE
//!
//! The v1.3 ESP-NOW bridge relays many lights behind one port, and the shell stays
//! out of it by construction: a RELAY-wrapped send is just a `usbSend` to the bridge's
//! MAC, and a RELAY uplink frame isn't an 8-byte HELLO so it forwards opaque as a
//! `usbFrame` — the relay envelope is encoded/decoded entirely in the sidecar.

pub mod protocol;
mod port;
mod supervisor;

pub use supervisor::start;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc, Mutex};

use tauri::{AppHandle, Manager};

/// Espressif ESP32-C3 native USB-JTAG/serial. Bare and flashed boards both enumerate
/// here — detection (HELLO vs silence) tells them apart, not the VID:PID.
pub const ESP32C3_VID: u16 = 0x303A;
pub const ESP32C3_PID: u16 = 0x1001;

/// A detected device's port thread, as seen from outside it.
struct UsbDevice {
    /// Sender of payload bytes to the port thread (which COBS-frames + writes them).
    tx: mpsc::Sender<Vec<u8>>,
    /// Protocol version from its HELLO — kept so the device can be re-announced.
    version: u8,
}

/// Shared shell-side USB state: per-device outbound queues + a global stop flag.
pub struct UsbState {
    /// mac → the device's port thread. Doubles as the list of detected devices.
    devices: Mutex<HashMap<String, UsbDevice>>,
    /// Flipped on app exit so the supervisor + port threads wind down.
    pub stop: Arc<AtomicBool>,
}

impl UsbState {
    pub fn new() -> Self {
        Self {
            devices: Mutex::new(HashMap::new()),
            stop: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Default for UsbState {
    fn default() -> Self {
        Self::new()
    }
}

/// Try to handle a sidecar→shell `usb*` stdout line. Returns true when the line was a
/// USB-targeted message (consumed here, not forwarded to the UI). `usbSend` is the only
/// shell-targeted type, so cheap-reject everything else by that substring before the
/// authoritative `type` check below parses JSON.
pub fn handle_outbound(app: &AppHandle, line: &str) -> bool {
    if !line.contains("usbSend") {
        return false;
    }
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return false,
    };
    if value.get("type").and_then(|t| t.as_str()) != Some("usbSend") {
        return false;
    }
    let mac = value.get("mac").and_then(|m| m.as_str()).unwrap_or_default();
    let hex = value.get("payloadHex").and_then(|h| h.as_str()).unwrap_or_default();
    if let Some(bytes) = from_hex(hex) {
        if let Some(state) = app.try_state::<UsbState>() {
            if let Ok(devices) = state.devices.lock() {
                if let Some(device) = devices.get(mac) {
                    let _ = device.tx.send(bytes);
                }
            }
        }
    }
    true
}

/// Register a detected device under its MAC and announce it to the sidecar (on HELLO).
fn register_device(app: &AppHandle, mac: &str, version: u8, tx: mpsc::Sender<Vec<u8>>) {
    if let Some(state) = app.try_state::<UsbState>() {
        if let Ok(mut devices) = state.devices.lock() {
            devices.insert(mac.to_string(), UsbDevice { tx, version });
        }
    }
    let _ = crate::sidecar::write_line(app, &connected_message(mac, version));
}

/// Drop a device and tell the sidecar it's gone (on port close / thread exit).
fn deregister_device(app: &AppHandle, mac: &str) {
    if let Some(state) = app.try_state::<UsbState>() {
        if let Ok(mut devices) = state.devices.lock() {
            devices.remove(mac);
        }
    }
    let msg = serde_json::json!({ "type": "usbDeviceDisconnected", "mac": mac });
    let _ = crate::sidecar::write_line(app, &msg.to_string());
}

/// Re-announce every detected device to the sidecar. Called when a (re)spawned sidecar
/// comes up: announcements sent to a sidecar that has since died are lost with it, but the
/// port threads — and the devices' sessions — outlive it. A duplicate announcement (a
/// device detected while the new sidecar was starting) is harmless: the sidecar treats a
/// repeat connect as a reconnect and re-pushes the device's state.
pub fn replay_connected(app: &AppHandle) {
    let Some(state) = app.try_state::<UsbState>() else {
        return;
    };
    // Snapshot first: don't hold the device map across writes to the sidecar.
    let lines: Vec<String> = match state.devices.lock() {
        Ok(devices) => devices.iter().map(|(mac, d)| connected_message(mac, d.version)).collect(),
        Err(_) => return,
    };
    for line in lines {
        let _ = crate::sidecar::write_line(app, &line);
    }
}

fn connected_message(mac: &str, version: u8) -> String {
    serde_json::json!({ "type": "usbDeviceConnected", "mac": mac, "version": version }).to_string()
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrips() {
        assert_eq!(to_hex(&[0x01, 0xab, 0x00, 0xff]), "01ab00ff");
        assert_eq!(from_hex("01ab00ff"), Some(vec![0x01, 0xab, 0x00, 0xff]));
        assert_eq!(from_hex(""), Some(vec![]));
        assert_eq!(from_hex("abc"), None); // odd length
        assert_eq!(from_hex("zz"), None); // non-hex
    }
}
