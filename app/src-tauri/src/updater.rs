//! App self-update: check the latest release's `latest.json`, download its signed installer, and
//! install it — always on the operator's say-so, since installing restarts the engine and every
//! light drops for a few seconds.
//!
//! Runs on the updater plugin's Rust API rather than its JS bindings: on Windows the shell has to
//! stop the sidecar before the installer runs (`install` exits the process at once, skipping the
//! exit handler, and the installer can't replace a sidecar exe that's still running), and it
//! keeps the downloaded bytes until "Restart now".
//!
//! Only installer builds update in place (NSIS, MSI, AppImage). A portable exe has no bundle
//! type, and .deb/.rpm installs were kept to the release page by choice, so those check against
//! the installer build's entry and get `installable: false` (the UI links to the release).
//! `latest.json` is written at publish time by `.github/workflows/update-manifest.yml`, with a
//! `firmwareVersion` field the flasher uses to say a newer release has newer light firmware.
//!
//! The last failure is state ([`UpdateStatus`], pulled with `update_status`), not only a rejected
//! command: the UI that asked may have reloaded since, and an install failure outlives the process.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::utils::config::BundleType;
use time::format_description::well_known::Rfc3339;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::log::diag;
use crate::report_event;

/// The release page for `version`, derived from the updater endpoint in tauri.conf.json
/// (`<repo>/releases/latest/download/latest.json`) so the repo is named once.
/// `scripts/check-release.mjs` keeps the endpoint in that shape.
fn release_url(app: &AppHandle, version: &str) -> String {
    let endpoint = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("endpoints")?.get(0)?.as_str());
    match endpoint.and_then(|e| e.strip_suffix("/latest/download/latest.json")) {
        Some(releases) => format!("{releases}/tag/v{version}"),
        None => String::new(),
    }
}

/// The update found by the last check, its installer once downloaded, and the last failure.
#[derive(Default)]
pub struct UpdaterState {
    update: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
    status: Mutex<UpdateStatus>,
}

/// Which step of an update failed: it decides the dialog's title and what "Try again" does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Check,
    Download,
    Install,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFailure {
    pub phase: Phase,
    /// The version being fetched or installed; None for a failed check.
    pub version: Option<String>,
    pub message: String,
}

/// The updater's last failure, cleared by the next step that succeeds.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// Bumped on every change, so a late pull never overwrites a newer push.
    revision: u64,
    failure: Option<UpdateFailure>,
}

/// The updater's last failure, for a UI that (re)starts.
#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    app.state::<UpdaterState>().status.lock().unwrap().clone()
}

/// Replace the recorded failure, when `replace` says so given the current one, and push the change.
fn set_failure_if(app: &AppHandle, failure: Option<UpdateFailure>, replace: impl FnOnce(Option<&UpdateFailure>) -> bool) {
    let status = {
        let state = app.state::<UpdaterState>();
        let mut status = state.status.lock().unwrap();
        if !replace(status.failure.as_ref()) {
            return;
        }
        status.revision += 1;
        status.failure = failure;
        status.clone()
    };
    report_event(app, "update-status", status);
}

/// A step succeeded: drop a recorded failure it supersedes. A check supersedes only a failed check,
/// so the quiet launch check never hides why the last install failed; a download supersedes any.
fn succeeded(app: &AppHandle, phase: Phase) {
    set_failure_if(app, None, |current| match current {
        None => false,
        Some(f) => phase != Phase::Check || f.phase == Phase::Check,
    });
}

/// Record a failed step and hand its message back for the command's `Err`.
fn fail(app: &AppHandle, phase: Phase, version: Option<&str>, message: String) -> String {
    diag!("[updater] {phase:?} failed: {message}");
    let failure = UpdateFailure { phase, version: version.map(str::to_owned), message: message.clone() };
    // A failed check (offline at launch) never replaces a failed download or install: that is the
    // failure the operator still needs to hear about.
    set_failure_if(app, Some(failure), |current| phase != Phase::Check || current.map_or(true, |f| f.phase == Phase::Check));
    message
}

/// What the UI shows about an available update.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    /// RFC 3339, when latest.json carries a `pub_date`.
    date: Option<String>,
    /// The release notes (latest.json `notes`, from the release body).
    notes: Option<String>,
    firmware_version: Option<String>,
    installable: bool,
    release_url: String,
}

#[derive(Clone, Serialize)]
struct Progress {
    received: usize,
    total: Option<u64>,
}

/// Whether this install can replace itself, and the latest.json entry to check against.
fn install_target() -> (bool, Option<&'static str>) {
    let installable = matches!(
        tauri::utils::platform::bundle_type(),
        Some(BundleType::Nsis | BundleType::Msi | BundleType::AppImage)
    );
    if installable {
        return (true, None); // the plugin picks the entry for this bundle type
    }
    let target = if cfg!(windows) { "windows-x86_64-nsis" } else { "linux-x86_64-appimage" };
    (false, Some(target))
}

/// Check for a newer release. Null when this is the latest.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let (installable, target) = install_target();
    let mut builder = app.updater_builder();
    if let Some(t) = target {
        builder = builder.target(t);
    }
    let checked = match builder.build() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    let found = checked.map_err(|e| fail(&app, Phase::Check, None, err(e)))?;
    succeeded(&app, Phase::Check);
    let state = app.state::<UpdaterState>();
    *state.bytes.lock().unwrap() = None;
    let info = found.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        date: u.date.and_then(|d| d.format(&Rfc3339).ok()),
        notes: u.body.clone(),
        firmware_version: u.raw_json.get("firmwareVersion").and_then(|v| v.as_str()).map(str::to_owned),
        installable,
        release_url: release_url(&app, &u.version),
    });
    *state.update.lock().unwrap() = found;
    Ok(info)
}

/// Download (and verify) the installer for the update the last check found. Progress arrives as
/// `"update-progress"` events; resolves once the installer is ready.
#[tauri::command]
pub async fn update_download(app: AppHandle) -> Result<(), String> {
    let update = app.state::<UpdaterState>().update.lock().unwrap().clone().ok_or("No update to download")?;
    let mut received = 0usize;
    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                received += chunk;
                report_event(&progress_app, "update-progress", Progress { received, total });
            },
            || {},
        )
        .await
        .map_err(|e| fail(&app, Phase::Download, Some(&update.version), err(e)))?;
    succeeded(&app, Phase::Download);
    *app.state::<UpdaterState>().bytes.lock().unwrap() = Some(bytes);
    Ok(())
}

/// Install the downloaded update and restart. On Windows the installer takes over (and relaunches
/// TallyBot); on Linux the AppImage is replaced in place and the app restarts into it.
#[tauri::command]
pub fn update_install(app: AppHandle) -> Result<(), String> {
    // Restarting mid-flash would leave that board half-written. The UI holds Restart back while
    // one runs; this is the backstop.
    if crate::flash::is_running(&app) {
        return Err("A light's firmware is being installed. Restart once it's finished.".into());
    }
    let state = app.state::<UpdaterState>();
    let update = state.update.lock().unwrap().clone().ok_or("No update to install")?;
    let bytes = state.bytes.lock().unwrap().take().ok_or("The update hasn't been downloaded")?;
    // Windows: stop the engine (and free the serial ports) before the installer replaces its exe.
    // Elsewhere the normal exit path does it when the app restarts.
    #[cfg(windows)]
    crate::shutdown(&app);
    if let Err(e) = update.install(bytes) {
        let message = fail(&app, Phase::Install, Some(&update.version), err(e));
        if cfg!(windows) {
            // The engine is already stopped, so come back up on the old version rather than
            // leave the board dead; the update is offered again on the next check.
            diag!("[updater] restarting on the old version");
            app.restart();
        }
        return Err(message);
    }
    app.restart();
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
