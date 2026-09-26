//! Port discovery: poll for ESP32-C3 serial ports and spawn one comms thread per port.
//!
//! There's no uniform cross-platform serial hotplug event, so we poll. Tracking by
//! port *path* and re-enumerating by VID:PID also handles the native-USB
//! re-enumeration gotcha (a flash/reset changes the path — a changed path reads as a
//! new device and gets a fresh thread).
//!
//! Ports are opened here, not in the comms thread, so open failures land in one place:
//! [`OpenFailures`] decides which reach the operator (via `health`) and keeps the 1.5 s
//! re-poll from repeating them.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::{port, ESP32C3_PID, ESP32C3_VID, UsbState};
use crate::health;

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

        let mut failures = OpenFailures::default();

        while !stop.load(Ordering::Relaxed) {
            let ports = serialport::available_ports().unwrap_or_default();
            let mut present = HashSet::new();
            for info in ports {
                let serialport::SerialPortType::UsbPort(usb) = &info.port_type else {
                    continue;
                };
                if usb.vid != ESP32C3_VID || usb.pid != ESP32C3_PID {
                    continue;
                }
                let path = info.port_name.clone();
                present.insert(path.clone());
                if tracked.lock().unwrap().contains(&path) {
                    continue;
                }
                let opened = match port::open(&path) {
                    Ok(p) => p,
                    Err(e) => {
                        let message = open_error_message(&path, &e);
                        match failures.fail(&path, &message) {
                            FailureAction::Log => eprintln!("[usb] open {path} failed: {e}"),
                            FailureAction::Surface => {
                                health::set_usb_port_error(&app, &path, Some(message))
                            }
                            FailureAction::None => {}
                        }
                        continue; // retried next poll
                    }
                };
                failures.clear(&path);
                health::set_usb_port_error(&app, &path, None);
                tracked.lock().unwrap().insert(path.clone());
                let app = app.clone();
                let tracked = tracked.clone();
                let stop = stop.clone();
                thread::spawn(move || {
                    port::run(&app, &path, opened, &stop);
                    tracked.lock().unwrap().remove(&path); // free it for re-open on replug
                });
            }
            // A port that failed and then went away (unplugged) is no longer a problem.
            for path in failures.retain_present(&present) {
                health::set_usb_port_error(&app, &path, None);
            }

            let mut slept = Duration::ZERO;
            while slept < POLL_INTERVAL && !stop.load(Ordering::Relaxed) {
                thread::sleep(POLL_STEP);
                slept += POLL_STEP;
            }
        }
    });
}

/// Consecutive open failures needed before the operator hears about a port. One failure
/// can be the unplug race (the port enumerated, then vanished before the open); a port
/// that is still there and still failing a poll later is a real problem.
const SURFACE_AFTER: u32 = 2;

#[derive(Debug, PartialEq, Eq)]
enum FailureAction {
    /// First failure with this message: log it, but don't bother the operator yet.
    Log,
    /// It persisted: show it (once — later repeats are silent).
    Surface,
    /// A repeat of something already logged/shown.
    None,
}

/// Per-port streak of identical open failures. A new message restarts the streak, so a
/// changed failure (busy → permission denied) is logged and surfaced afresh.
#[derive(Default)]
struct OpenFailures {
    by_port: HashMap<String, (String, u32)>,
}

impl OpenFailures {
    fn fail(&mut self, path: &str, message: &str) -> FailureAction {
        let entry = self.by_port.entry(path.to_string()).or_insert_with(|| (String::new(), 0));
        if entry.0 != message {
            *entry = (message.to_string(), 0);
        }
        entry.1 = entry.1.saturating_add(1);
        match entry.1 {
            1 => FailureAction::Log,
            SURFACE_AFTER => FailureAction::Surface,
            _ => FailureAction::None,
        }
    }

    fn clear(&mut self, path: &str) {
        self.by_port.remove(path);
    }

    /// Forget ports no longer enumerated; returns the ones forgotten.
    fn retain_present(&mut self, present: &HashSet<String>) -> Vec<String> {
        let gone: Vec<String> =
            self.by_port.keys().filter(|p| !present.contains(*p)).cloned().collect();
        for p in &gone {
            self.by_port.remove(p);
        }
        gone
    }
}

/// Operator-facing text for an open failure, with the fix when we know it.
fn open_error_message(path: &str, err: &serialport::Error) -> String {
    match err.kind() {
        // Linux: the tty is group-owned (dialout on Debian/Ubuntu/Fedora, uucp on Arch)
        // and the user isn't in that group. Membership applies from the next login.
        serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied) if cfg!(target_os = "linux") => {
            format!(
                "Can't open {path}: permission denied. Add your user to the dialout group \
                 (uucp on Arch), then log out and back in."
            )
        }
        // serialport reports a port held by another program (EBUSY / a failed exclusive
        // lock; Windows' access-denied) as NoDevice.
        serialport::ErrorKind::NoDevice => format!(
            "Can't open {path}: another program is using it (a serial monitor?). \
             Close it and TallyBot will connect."
        ),
        _ => format!("Can't open {path}: {}.", err.description.trim_end_matches('.')),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_surfaces_once_it_persists_and_only_once() {
        let mut f = OpenFailures::default();
        assert_eq!(f.fail("/dev/ttyACM0", "denied"), FailureAction::Log);
        assert_eq!(f.fail("/dev/ttyACM0", "denied"), FailureAction::Surface);
        assert_eq!(f.fail("/dev/ttyACM0", "denied"), FailureAction::None);
        assert_eq!(f.fail("/dev/ttyACM0", "denied"), FailureAction::None);
    }

    #[test]
    fn a_changed_failure_restarts_the_streak() {
        let mut f = OpenFailures::default();
        f.fail("/dev/ttyACM0", "busy");
        f.fail("/dev/ttyACM0", "busy");
        assert_eq!(f.fail("/dev/ttyACM0", "denied"), FailureAction::Log);
        assert_eq!(f.fail("/dev/ttyACM0", "denied"), FailureAction::Surface);
    }

    #[test]
    fn success_or_unplug_resets() {
        let mut f = OpenFailures::default();
        f.fail("/dev/ttyACM0", "busy");
        f.clear("/dev/ttyACM0");
        assert_eq!(f.fail("/dev/ttyACM0", "busy"), FailureAction::Log);

        f.fail("/dev/ttyACM1", "busy");
        let present: HashSet<String> = ["/dev/ttyACM0".to_string()].into();
        assert_eq!(f.retain_present(&present), vec!["/dev/ttyACM1".to_string()]);
        assert_eq!(f.fail("/dev/ttyACM1", "busy"), FailureAction::Log); // streak restarted
    }

    #[test]
    fn messages_name_the_fix() {
        use serialport::{Error, ErrorKind};
        let busy = open_error_message("/dev/ttyACM0", &Error::new(ErrorKind::NoDevice, "x"));
        assert!(busy.contains("another program"), "{busy}");
        let other = open_error_message("COM3", &Error::new(ErrorKind::Unknown, "Oops."));
        assert_eq!(other, "Can't open COM3: Oops.");
        let denied = open_error_message(
            "/dev/ttyACM0",
            &Error::new(ErrorKind::Io(std::io::ErrorKind::PermissionDenied), "Permission denied"),
        );
        if cfg!(target_os = "linux") {
            assert!(denied.contains("dialout"), "{denied}");
        } else {
            assert_eq!(denied, "Can't open /dev/ttyACM0: Permission denied.");
        }
    }
}
