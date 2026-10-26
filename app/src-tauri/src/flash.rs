//! In-app firmware flashing: write the firmware bundled with this app to an ESP32-C3 on USB.
//!
//! The app only ever installs the image it was released with (`resources/firmware/`, staged by
//! `app/scripts/stage-firmware.mjs`), never "latest": an app and a firmware from different
//! releases can disagree on the protocol, so a newer firmware is reached by updating the app.
//!
//! A flash borrows the port from the USB layer (`usb::claim`), talks Espressif's ROM download
//! protocol through `espflash` (the native USB-Serial-JTAG reset puts the chip in download mode,
//! so no BOOT button is needed on a healthy board), then hands the port back. The chip resets
//! into the new firmware, its USB port re-enumerates, and the job waits for its HELLO.
//!
//! The light's settings survive a reflash: the merged image spans the NVS partition (as 0xFF
//! padding), so the image is written around it, using the image's own partition table.
//!
//! Progress goes to the UI as `"flash"` events (`FlashEvent`); the UI's driver
//! (`src/lib/flasher/tauri.svelte.ts`) turns them into the flasher dialog's state.

use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use espflash::connection::{Connection, ResetAfterOperation, ResetBeforeOperation};
use espflash::flasher::Flasher;
use espflash::image_format::Segment;
use espflash::target::{Chip, ProgressCallbacks};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::usb;

const IMAGE: &str = "firmware/tallybot-firmware-esp32c3.bin";
const MANIFEST: &str = "firmware/tallybot-firmware-esp32c3.json";
/// How long the port's comms thread gets to let go of it.
const CLAIM_TIMEOUT: Duration = Duration::from_secs(3);
/// From the reset to the light's HELLO on its re-enumerated port: boot, USB enumeration, the
/// supervisor's 1.5 s poll, and the HELLO probe, with room for a slow OS driver.
const REJOIN_TIMEOUT: Duration = Duration::from_secs(30);

/// The firmware this build bundles, from the manifest staged beside the image.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FirmwareInfo {
    pub version: String,
    pub sha256: String,
    pub size: u64,
}

/// The firmware this build installs, or null when it carries none (a dev build without
/// `pnpm firmware:stage`).
#[tauri::command]
pub fn firmware_info(app: AppHandle) -> Option<FirmwareInfo> {
    let path = resource(&app, MANIFEST)?;
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// One flash job's progress, as the UI sees it. `stage` names follow the dialog's stages.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FlashEvent {
    Running { stage: Stage, progress: f64 },
    /// `mac` is the light the board came back as.
    Done { mac: String },
    Failed { stage: Stage, failure: Failure, detail: String },
    Cancelled { stage: Stage },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Connect,
    Erase,
    Write,
    Verify,
    Restart,
    Rejoin,
}

/// The failures the dialog explains with a tailored fix; anything else is `Error`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Failure {
    /// The chip didn't answer in download mode (fix: hold BOOT while plugging in).
    NoResponse,
    /// Another program holds the port.
    PortBusy,
    /// The port vanished mid-flash.
    Unplugged,
    /// The board on the port isn't the light the user asked to update.
    WrongLight,
    Error,
}

/// The one flash that may run at a time, and its stop request.
#[derive(Default)]
pub struct FlashState {
    running: AtomicBool,
    cancel: Arc<AtomicBool>,
}

/// Start flashing the board on `port`. `mac` is the light the user picked, if any: the flash
/// stops before writing anything when the board on the port turns out to be another one.
/// Progress arrives as `"flash"` events; this returns once the job has started.
#[tauri::command]
pub fn flash_start(app: AppHandle, port: String, mac: Option<String>) -> Result<(), String> {
    let state = app.state::<FlashState>();
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A firmware install is already running".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();
    let job_app = app.clone();
    thread::spawn(move || {
        let outcome = run(&job_app, &port, mac.as_deref(), &cancel);
        usb::release(&job_app, &port);
        let event = match outcome {
            Ok(mac) => match wait_for_rejoin(&job_app, &mac) {
                true => FlashEvent::Done { mac },
                false => FlashEvent::Failed {
                    stage: Stage::Rejoin,
                    failure: Failure::Error,
                    detail: format!("The firmware was installed, but {mac} didn't reconnect over USB."),
                },
            },
            Err(event) => event,
        };
        let _ = job_app.emit("flash", event);
        job_app.state::<FlashState>().running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// Ask the running flash to stop. Before the write starts nothing has changed; during it the
/// board is left without working firmware (flashing again recovers it); after it, the new
/// firmware is already in place and the stop is moot.
#[tauri::command]
pub fn flash_cancel(app: AppHandle) {
    app.state::<FlashState>().cancel.store(true, Ordering::SeqCst);
}

/// The flash itself, up to and including the reset. Returns the board's MAC.
fn run(app: &AppHandle, port: &str, expected: Option<&str>, cancel: &AtomicBool) -> Result<String, FlashEvent> {
    let failed = |stage, failure, detail: String| FlashEvent::Failed { stage, failure, detail };
    let emit = |stage, progress| {
        let _ = app.emit("flash", FlashEvent::Running { stage, progress });
    };
    emit(Stage::Connect, 0.0);

    let image = load_image(app).map_err(|e| failed(Stage::Connect, Failure::Error, e))?;
    if !usb::claim(app, port, CLAIM_TIMEOUT) {
        return Err(failed(Stage::Connect, Failure::PortBusy, format!("{port} is still in use by TallyBot")));
    }

    let mut flasher = connect(port).map_err(|(failure, detail)| failed(Stage::Connect, failure, detail))?;
    let mac = flasher
        .device_info()
        .ok()
        .and_then(|info| info.mac_address)
        .map(|m| m.to_lowercase())
        .ok_or_else(|| failed(Stage::Connect, Failure::Error, "The chip didn't report its MAC address".into()))?;
    if let Some(want) = expected {
        if !want.eq_ignore_ascii_case(&mac) {
            return Err(failed(Stage::Connect, Failure::WrongLight, format!("The board on {port} is {mac}")));
        }
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(FlashEvent::Cancelled { stage: Stage::Connect });
    }

    let segments = segments_around_nvs(&image);
    let mut progress = Progress::new(app, &segments, cancel);
    // espflash has no cancel hook, so a stop unwinds out of its progress callback (`Progress`);
    // dropping the flasher closes the port. The board is left half-written either way.
    let result = panic::catch_unwind(AssertUnwindSafe(|| flasher.write_bins_to_flash(&segments, &mut progress)));
    let stage = progress.stage;
    match result {
        Err(_) if cancel.load(Ordering::SeqCst) => return Err(FlashEvent::Cancelled { stage }),
        Err(_) => return Err(failed(stage, Failure::Error, "The flash stopped unexpectedly".into())),
        Ok(Err(e)) => {
            drop(flasher);
            let failure = if still_present(port) { Failure::Error } else { Failure::Unplugged };
            return Err(failed(stage, failure, format!("espflash: {e}")));
        }
        Ok(Ok(())) => {}
    }
    // `write_bins_to_flash` finishes with the hard reset (ResetAfterOperation::HardReset).
    emit(Stage::Restart, 0.0);
    drop(flasher);
    emit(Stage::Rejoin, 0.0);
    Ok(mac)
}

fn connect(port: &str) -> Result<Flasher, (Failure, String)> {
    let info = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .find(|p| p.port_name == port)
        .and_then(|p| match p.port_type {
            serialport::SerialPortType::UsbPort(info) => Some(info),
            _ => None,
        })
        .ok_or_else(|| (Failure::Unplugged, format!("{port} isn't connected")))?;
    let serial = serialport::new(port, 115_200).open_native().map_err(|e| {
        let failure = match e.kind() {
            serialport::ErrorKind::NoDevice => Failure::PortBusy,
            _ => Failure::Error,
        };
        (failure, format!("Couldn't open {port}: {e}"))
    })?;
    // The native USB-Serial-JTAG (PID 0x1001) gets espflash's USB reset into download mode.
    let connection = Connection::new(
        serial,
        info,
        ResetAfterOperation::HardReset,
        ResetBeforeOperation::DefaultReset,
        115_200,
    );
    Flasher::connect(connection, true, true, false, Some(Chip::Esp32c3), None)
        .map_err(|e| (Failure::NoResponse, format!("espflash: {e}")))
}

/// Read the bundled image and check it against its manifest.
fn load_image(app: &AppHandle) -> Result<Vec<u8>, String> {
    let info = firmware_info(app.clone()).ok_or("This build of TallyBot doesn't include light firmware")?;
    let path = resource(app, IMAGE).ok_or("The bundled firmware image is missing")?;
    let image = std::fs::read(&path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    let sha: String = Sha256::digest(&image).iter().map(|b| format!("{b:02x}")).collect();
    if sha != info.sha256 {
        return Err(format!("The bundled firmware image is damaged (sha256 {sha}, expected {})", info.sha256));
    }
    Ok(image)
}

fn resource(app: &AppHandle, rel: &str) -> Option<PathBuf> {
    let path = app.path().resource_dir().ok()?.join(rel);
    path.exists().then_some(path)
}

fn still_present(port: &str) -> bool {
    serialport::available_ports().unwrap_or_default().iter().any(|p| p.port_name == port)
}

fn wait_for_rejoin(app: &AppHandle, mac: &str) -> bool {
    let deadline = Instant::now() + REJOIN_TIMEOUT;
    while Instant::now() < deadline {
        if usb::has_device(app, mac) {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

/// Where a multi-segment write is: espflash reports chunks per segment, the dialog shows one 0–1
/// bar for the whole image, weighted by each segment's size.
struct WriteTally {
    /// (address, length) of each segment, in write order.
    segments: Vec<(u32, usize)>,
    total: usize,
    /// Bytes in segments already finished, and how many segments that is.
    done: usize,
    finished: usize,
    /// (length, chunk count) of the segment being written.
    current: Option<(usize, usize)>,
}

impl WriteTally {
    fn new(segments: Vec<(u32, usize)>) -> Self {
        let total = segments.iter().map(|(_, len)| len).sum();
        Self { segments, total, done: 0, finished: 0, current: None }
    }

    /// espflash's `init(addr, chunks)`: a segment starts.
    fn begin(&mut self, addr: u32, chunks: usize) {
        let len = self.segments.iter().find(|(a, _)| *a == addr).map_or(0, |(_, len)| *len);
        self.current = Some((len, chunks.max(1)));
    }

    /// espflash's `update(chunk)`: the whole image's progress, 0–1.
    fn progress(&self, chunk: usize) -> f64 {
        let Some((len, chunks)) = self.current else { return self.done as f64 / self.total.max(1) as f64 };
        let written = self.done + len * chunk.min(chunks) / chunks;
        written as f64 / self.total.max(1) as f64
    }

    /// espflash's `finish`: the current segment is written.
    fn end(&mut self) {
        if let Some((len, _)) = self.current.take() {
            self.done += len;
            self.finished += 1;
        }
    }

    fn on_first_segment(&self) -> bool {
        self.finished == 0
    }

    fn on_last_segment(&self) -> bool {
        self.finished + 1 >= self.segments.len()
    }
}

/// Feeds espflash's progress into `"flash"` events (through a [`WriteTally`]), and is where a stop
/// request takes effect (see [`run`]).
struct Progress<'a> {
    app: &'a AppHandle,
    cancel: &'a AtomicBool,
    tally: WriteTally,
    stage: Stage,
    last_emit: Instant,
}

impl<'a> Progress<'a> {
    fn new(app: &'a AppHandle, segments: &[Segment<'_>], cancel: &'a AtomicBool) -> Self {
        let tally = WriteTally::new(segments.iter().map(|s| (s.addr, s.data.len())).collect());
        Self { app, cancel, tally, stage: Stage::Erase, last_emit: Instant::now() }
    }

    fn emit(&mut self, stage: Stage, progress: f64) {
        self.stage = stage;
        let _ = self.app.emit("flash", FlashEvent::Running { stage, progress });
        self.last_emit = Instant::now();
    }

    fn check_cancel(&self) {
        if self.cancel.load(Ordering::SeqCst) {
            panic::resume_unwind(Box::new("flash cancelled"));
        }
    }
}

impl ProgressCallbacks for Progress<'_> {
    fn init(&mut self, addr: u32, chunks: usize) {
        self.check_cancel();
        self.tally.begin(addr, chunks);
        // The first segment's begin erases the flash ahead of its data.
        if self.tally.on_first_segment() {
            self.emit(Stage::Erase, 0.0);
        }
    }

    fn update(&mut self, chunk: usize) {
        self.check_cancel();
        if self.stage != Stage::Write || self.last_emit.elapsed() >= Duration::from_millis(100) {
            self.emit(Stage::Write, self.tally.progress(chunk));
        }
    }

    // espflash verifies each segment as it's written; the dialog's one Verify stage is the last's,
    // so the bar doesn't hop back from Verify to Write between segments.
    fn verifying(&mut self) {
        self.check_cancel();
        if self.tally.on_last_segment() {
            self.emit(Stage::Verify, 0.0);
        }
    }

    fn finish(&mut self, _skipped: bool) {
        self.tally.end();
    }
}

/// The merged image as segments that skip every NVS partition inside it, so a reflash keeps the
/// light's settings (Wi-Fi, transport). The ranges come from the image's own partition table
/// (0x8000), so they follow whatever partition scheme the firmware was built with. An image
/// without a readable table is written whole.
fn segments_around_nvs(image: &[u8]) -> Vec<Segment<'_>> {
    let mut skips = nvs_ranges(image);
    skips.sort();
    let mut segments = Vec::new();
    let mut at = 0usize;
    for (start, end) in skips {
        let (start, end) = (start.min(image.len()), end.min(image.len()));
        if start > at {
            segments.push(Segment::new(at as u32, &image[at..start]));
        }
        at = at.max(end);
    }
    if at < image.len() {
        segments.push(Segment::new(at as u32, &image[at..]));
    }
    segments
}

/// ESP-IDF partition table: 32-byte entries at 0x8000, each `[0xAA 0x50][type][subtype]
/// [offset u32 LE][size u32 LE][label 16][flags u32]`, ended by an MD5 entry or erased flash.
/// NVS is type 0x01 (data), subtype 0x02.
fn nvs_ranges(image: &[u8]) -> Vec<(usize, usize)> {
    const TABLE: usize = 0x8000;
    const ENTRY: usize = 32;
    let mut ranges = Vec::new();
    for i in 0..(0xC00 / ENTRY) {
        let at = TABLE + i * ENTRY;
        let Some(e) = image.get(at..at + ENTRY) else { break };
        if e[0] != 0xAA || e[1] != 0x50 {
            break;
        }
        if e[2] == 0x01 && e[3] == 0x02 {
            let offset = u32::from_le_bytes(e[4..8].try_into().unwrap()) as usize;
            let size = u32::from_le_bytes(e[8..12].try_into().unwrap()) as usize;
            ranges.push((offset, offset + size));
        }
    }
    ranges
}


#[cfg(test)]
mod tests {
    use super::*;

    /// One ESP-IDF partition table entry.
    fn entry(kind: u8, subtype: u8, offset: u32, size: u32) -> [u8; 32] {
        let mut e = [0u8; 32];
        e[..4].copy_from_slice(&[0xAA, 0x50, kind, subtype]);
        e[4..8].copy_from_slice(&offset.to_le_bytes());
        e[8..12].copy_from_slice(&size.to_le_bytes());
        e
    }

    /// A merged image of `len` bytes (every byte its index, so slices are distinguishable) with
    /// `entries` written as the partition table at 0x8000, followed by erased flash.
    fn image(len: usize, entries: &[[u8; 32]]) -> Vec<u8> {
        let mut img: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        let mut at = 0x8000;
        for e in entries {
            img[at..at + 32].copy_from_slice(e);
            at += 32;
        }
        img[at..at + 32].fill(0xFF);
        img
    }

    /// (address, length) of each segment, checking each carries the image's bytes at its address.
    fn layout(img: &[u8]) -> Vec<(usize, usize)> {
        segments_around_nvs(img)
            .iter()
            .map(|s| {
                let (addr, len) = (s.addr as usize, s.data.len());
                assert_eq!(&s.data[..], &img[addr..addr + len], "segment at {addr:#x} has the wrong bytes");
                (addr, len)
            })
            .collect()
    }

    #[test]
    fn every_nvs_partition_in_the_table_is_skipped_and_everything_else_written() {
        let img = image(
            0x40000,
            &[
                entry(0x01, 0x02, 0x9000, 0x5000),   // nvs
                entry(0x01, 0x01, 0xE000, 0x1000),   // phy_init (data, not NVS)
                entry(0x00, 0x00, 0x10000, 0x20000), // factory app
                entry(0x01, 0x02, 0x30000, 0x4000),  // a second nvs
            ],
        );
        assert_eq!(layout(&img), vec![(0x0, 0x9000), (0xE000, 0x22000), (0x34000, 0xC000)]);
    }

    #[test]
    fn the_table_ends_at_the_first_entry_without_the_magic() {
        let mut end = [0xEBu8; 32]; // the MD5 entry
        end[..2].copy_from_slice(&[0xEB, 0xEB]);
        let img = image(0x20000, &[entry(0x00, 0x00, 0x10000, 0x10000), end, entry(0x01, 0x02, 0x9000, 0x6000)]);
        assert_eq!(layout(&img), vec![(0x0, 0x20000)]);
    }

    #[test]
    fn an_image_without_a_readable_table_is_written_whole() {
        let erased = image(0x20000, &[]);
        assert_eq!(layout(&erased), vec![(0x0, 0x20000)]);
        let short: Vec<u8> = vec![0x5A; 0x4000]; // ends before 0x8000
        assert_eq!(layout(&short), vec![(0x0, 0x4000)]);
    }

    #[test]
    fn nvs_partitions_past_the_image_end_are_clipped() {
        // NVS straddles the end: only the bytes before it are written.
        let straddling = image(0xC000, &[entry(0x01, 0x02, 0x9000, 0x6000)]);
        assert_eq!(layout(&straddling), vec![(0x0, 0x9000)]);
        // NVS wholly past the end: nothing to skip.
        let beyond = image(0xC000, &[entry(0x01, 0x02, 0x3F0000, 0x6000)]);
        assert_eq!(layout(&beyond), vec![(0x0, 0xC000)]);
    }
}
