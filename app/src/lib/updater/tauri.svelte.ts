// The real updater driver: the Tauri updater plugin, run from the Rust shell
// (`src-tauri/src/updater.rs`), which checks the release's latest.json, downloads and verifies
// the signed installer, and installs it after stopping the engine. Progress arrives as
// `"update-progress"` events.
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import {
	canCheck,
	downloadable,
	releaseNotes,
	type AppUpdate,
	type UpdatePhase,
	type Updater,
	type UpdaterState,
} from "./updater";

/** `updater.rs` `UpdateInfo`. */
interface UpdateInfo {
	version: string;
	date: string | null;
	notes: string | null;
	firmwareVersion: string | null;
	installable: boolean;
	releaseUrl: string;
}

/** `updater.rs` `UpdateStatus`: the shell's record of the last failed step. */
interface UpdateStatus {
	revision: number;
	failure: { phase: UpdatePhase; version: string | null; message: string } | null;
}

/** Last version this install ran, to say "updated to x" once after an update. */
const LAST_RUN_KEY = "tallybot.lastRunVersion";

export class TauriUpdater implements Updater {
	currentVersion = $state("");
	state = $state<UpdaterState>({ status: "idle" });
	lastChecked = $state<Date | null>(null);

	/**
	 * Learn the running version, then check quietly, as the app does on every launch. A download
	 * or install that failed before this webview started (a reload, or the Windows restart after a
	 * failed install) is then shown as the error it was, from the shell's record.
	 */
	async init(): Promise<void> {
		this.currentVersion = await getVersion();
		await listen<{ received: number; total: number | null }>("update-progress", ({ payload }) => {
			const s = this.state;
			if (s.status !== "downloading") return;
			this.state = {
				status: "downloading",
				update: { ...s.update, sizeBytes: payload.total ?? s.update.sizeBytes },
				received: payload.received,
			};
		});
		const last = readLastRun();
		writeLastRun(this.currentVersion);
		const justUpdated = last !== null && last !== this.currentVersion ? this.currentVersion : undefined;
		const { failure } = await invoke<UpdateStatus>("update_status");
		await this.#check(justUpdated);
		if (failure && failure.phase !== "check") {
			const update = "update" in this.state ? this.state.update : null;
			this.state = { status: "error", phase: failure.phase, message: failure.message, update };
		}
	}

	check(): void {
		if (!canCheck(this.state)) return;
		void this.#check();
	}

	async #check(justUpdated?: string): Promise<void> {
		this.state = { status: "checking" };
		try {
			const info = await invoke<UpdateInfo | null>("update_check");
			this.state = info ? { status: "available", update: toAppUpdate(info) } : { status: "current", justUpdated };
		} catch (err) {
			this.state = { status: "error", phase: "check", message: String(err), update: null };
		} finally {
			this.lastChecked = new Date();
		}
	}

	download(): void {
		const update = downloadable(this.state);
		if (!update) return;
		this.state = { status: "downloading", update, received: 0 };
		invoke("update_download").then(
			() => {
				const now = this.state;
				this.state = { status: "ready", update: "update" in now && now.update ? now.update : update };
			},
			async (err) => {
				// The shell knows which step it was (a signature failure isn't a download failure).
				const { failure } = await invoke<UpdateStatus>("update_status").catch(() => ({ failure: null }));
				const phase = failure?.phase === "verify" ? "verify" : "download";
				this.state = { status: "error", phase, message: String(err), update };
			},
		);
	}

	restart(): void {
		if (this.state.status !== "ready") return;
		const update = this.state.update;
		this.state = { status: "restarting", update };
		// On success this never returns: the shell stops the engine, installs and restarts.
		invoke("update_install").catch((err) => {
			this.state = { status: "error", phase: "install", message: String(err), update };
		});
	}
}

function toAppUpdate(info: UpdateInfo): AppUpdate {
	return {
		version: info.version,
		// A release without the field predates firmware versioning: treat it as no newer firmware.
		firmwareVersion: info.firmwareVersion ?? "0.0.0",
		date: info.date,
		notes: releaseNotes(info.notes ?? ""),
		sizeBytes: null,
		installable: info.installable,
		releaseUrl: info.releaseUrl,
	};
}

function readLastRun(): string | null {
	try {
		return localStorage.getItem(LAST_RUN_KEY);
	} catch {
		return null;
	}
}

function writeLastRun(version: string): void {
	try {
		localStorage.setItem(LAST_RUN_KEY, version);
	} catch {
		// no storage (private mode): the "updated" notice just doesn't show
	}
}
