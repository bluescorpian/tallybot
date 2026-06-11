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

/// Shared shell-side USB state: per-device outbound queues + a global stop flag.
pub struct UsbState {
    /// mac → sender of payload bytes to that device's port thread (which COBS-frames + writes).
    senders: Mutex<HashMap<String, mpsc::Sender<Vec<u8>>>>,
    /// Flipped on app exit so the supervisor + port threads wind down.
    pub stop: Arc<AtomicBool>,
}

impl UsbState {
    pub fn new() -> Self {
        Self {
            senders: Mutex::new(HashMap::new()),
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
            if let Ok(senders) = state.senders.lock() {
                if let Some(tx) = senders.get(mac) {
                    let _ = tx.send(bytes);
                }
            }
        }
    }
    true
}

/// Register a device's outbound payload sender under its MAC (called when HELLO arrives).
fn register_sender(app: &AppHandle, mac: &str, tx: mpsc::Sender<Vec<u8>>) {
    if let Some(state) = app.try_state::<UsbState>() {
        if let Ok(mut senders) = state.senders.lock() {
            senders.insert(mac.to_string(), tx);
        }
    }
}

/// Drop a device's outbound sender (called on disconnect / thread exit).
fn deregister_sender(app: &AppHandle, mac: &str) {
    if let Some(state) = app.try_state::<UsbState>() {
        if let Ok(mut senders) = state.senders.lock() {
            senders.remove(mac);
        }
    }
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
