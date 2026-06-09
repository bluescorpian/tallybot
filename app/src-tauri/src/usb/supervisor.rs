//! Port discovery: poll for ESP32-C3 serial ports and spawn one comms thread per port.
//!
//! There's no uniform cross-platform serial hotplug event, so we poll. Tracking by
//! port *path* and re-enumerating by VID:PID also handles the native-USB
//! re-enumeration gotcha (a flash/reset changes the path — a changed path reads as a
//! new device and gets a fresh thread).

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::{port, ESP32C3_PID, ESP32C3_VID, UsbState};

const POLL_INTERVAL: Duration = Duration::from_millis(1500);
const POLL_STEP: Duration = Duration::from_millis(100);

/// Start the discovery loop on a dedicated thread. Returns immediately.
pub fn start(app: AppHandle) {
    let stop = match app.try_state::<UsbState>() {
        Some(state) => state.stop.clone(),
        None => {
            eprintln!("[usb] UsbState not managed; serial disabled");
            return;
        }
    };

    thread::spawn(move || {
        // Port paths with a live comms thread — so we don't open the same port twice.
        let tracked: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

        while !stop.load(Ordering::Relaxed) {
            let ports = serialport::available_ports().unwrap_or_default();
            for info in ports {
                let serialport::SerialPortType::UsbPort(usb) = &info.port_type else {
                    continue;
                };
                if usb.vid != ESP32C3_VID || usb.pid != ESP32C3_PID {
                    continue;
                }
                let path = info.port_name.clone();
                {
                    let mut t = tracked.lock().unwrap();
                    if t.contains(&path) {
                        continue;
                    }
                    t.insert(path.clone());
                }
                let app = app.clone();
                let tracked = tracked.clone();
                let stop = stop.clone();
                thread::spawn(move || {
                    port::run(&app, &path, &stop);
                    tracked.lock().unwrap().remove(&path); // free it for re-open on replug
                });
            }

            let mut slept = Duration::ZERO;
            while slept < POLL_INTERVAL && !stop.load(Ordering::Relaxed) {
                thread::sleep(POLL_STEP);
                slept += POLL_STEP;
            }
        }
    });
}
