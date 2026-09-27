//! One blocking thread per open serial port: detect the device, then pump frames both
//! ways. A short read timeout lets a single thread own the port and interleave reads
//! with draining the outbound queue — no shared port handle, no second thread.

use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serialport::SerialPort;
use tauri::AppHandle;

use super::protocol::{cobs_frame, parse_hello, CobsStream, MSG_GET_STATUS};
use super::{deregister_device, register_device, to_hex};

const BAUD: u32 = 115_200;
/// Read timeout — a timeout is the normal idle case, not an error. Short enough to keep
/// outbound writes responsive, long enough not to busy-spin.
const READ_TIMEOUT: Duration = Duration::from_millis(50);
/// No HELLO within this window ⇒ the board is unflashed, and its port is released. Firmware
/// re-announces HELLO every second until a host answers, so a flashed device speaks well
/// inside it even straight after boot; the margin is there because a misjudged device is
/// released and stays invisible until it's replugged.
const DETECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Why a comms thread ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The port went away (unplug), or the app is exiting.
    Closed,
    /// No HELLO within [`DETECT_TIMEOUT`]: not TallyBot firmware. The port has been closed so
    /// another program (the web flasher) can open it.
    Unflashed,
}

/// Open a port for a comms thread. Separate from [`run`] so the supervisor sees open
/// failures (it decides which are worth showing the operator).
pub fn open(path: &str) -> serialport::Result<Box<dyn SerialPort>> {
    // Open WITHOUT touching DTR/RTS: a live No-TX device must keep rendering tally, and the
    // ESP32-C3 native USB-JTAG doesn't reset on DTR anyway (the firmware also ignores DTR).
    serialport::new(path, BAUD).timeout(READ_TIMEOUT).open()
}

pub fn run(app: &AppHandle, path: &str, mut port: Box<dyn SerialPort>, stop: &AtomicBool) -> Outcome {
    // Outbound payloads queue here; registered under the device MAC once HELLO arrives.
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let mut mac: Option<String> = None;
    let mut stream = CobsStream::new();
    let opened = Instant::now();
    let mut buf = [0u8; 256];

    eprintln!("[usb] {path} opened");

    // Identity probe: a device that already saw a host stops its unsolicited HELLO loop, so
    // reopening the port (an app restart) would otherwise leave it undetected until its own
    // session timeout — long enough for a bridge to tear itself down. GET_STATUS makes the
    // firmware reply HELLO (then STATUS) at once, and the probe itself refreshes the device's
    // host-liveness clock so a quick restart never breaks the session. A bare board ignores it.
    if let Err(e) = port.write_all(&cobs_frame(&[MSG_GET_STATUS])) {
        eprintln!("[usb] probe {path} failed: {e}");
    }

    while !stop.load(Ordering::Relaxed) {
        // Drain outbound: COBS-frame each payload and write it.
        while let Ok(payload) = rx.try_recv() {
            if let Err(e) = port.write_all(&cobs_frame(&payload)) {
                eprintln!("[usb] write {path} failed: {e}");
            }
        }

        match port.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => {
                let mut frames: Vec<Vec<u8>> = Vec::new();
                stream.push(&buf[..n], |f| frames.push(f));
                for payload in frames {
                    handle_frame(app, path, payload, &mut mac, &tx);
                }
            }
            Err(ref e) if e.kind() == ErrorKind::TimedOut => {}
            Err(e) => {
                // Read error ⇒ the port went away (unplug). This is the host-side liveness
                // signal the protocol relies on (USB has no HEARTBEAT).
                eprintln!("[usb] {path} closed: {e}");
                break;
            }
        }

        // A bare board never sends HELLO. Let go of it: holding the port would lock out the
        // web flasher the UI points the operator at.
        if mac.is_none() && opened.elapsed() > DETECT_TIMEOUT {
            eprintln!("[usb] {path} sent no HELLO; unflashed, releasing the port");
            return Outcome::Unflashed;
        }
    }

    if let Some(m) = &mac {
        deregister_device(app, m);
    }
    eprintln!("[usb] {path} thread exiting");
    Outcome::Closed
}

/// Dispatch one decoded payload. Pre-HELLO we only watch for HELLO (to learn the MAC and
/// announce the device); afterwards every non-HELLO frame is forwarded opaque to the sidecar.
fn handle_frame(
    app: &AppHandle,
    path: &str,
    payload: Vec<u8>,
    mac: &mut Option<String>,
    tx: &mpsc::Sender<Vec<u8>>,
) {
    if mac.is_none() {
        if let Some(hello) = parse_hello(&payload) {
            register_device(app, &hello.mac, hello.version, tx.clone());
            eprintln!("[usb] {path} is {} (protocol v{})", hello.mac, hello.version);
            *mac = Some(hello.mac);
        }
        return; // pre-HELLO non-HELLO frames are ignored
    }

    if parse_hello(&payload).is_some() {
        return; // benign re-HELLO (device repeats it until a host frame arrives)
    }
    let m = mac.as_ref().unwrap();
    let msg = serde_json::json!({
        "type": "usbFrame",
        "mac": m,
        "payloadHex": to_hex(&payload),
    });
    let _ = crate::sidecar::write_line(app, &msg.to_string());
}
