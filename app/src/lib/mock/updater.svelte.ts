// App updater — FAKE driver, for the browser preview and the `?demo=` states. The real one is
// `TauriUpdater` ($lib/updater/tauri.svelte); both implement `Updater`.
import { version as APP_VERSION } from "../../../package.json";
import { isNewer, type AppUpdate, type Updater, type UpdaterState } from "$lib/updater/updater";

const MOCK_UPDATE: AppUpdate = {
	version: "1.1.0",
	firmwareVersion: "1.1.0",
	date: "2026-10-20",
	notes: [
		"Lights reconnect faster after a Wi-Fi drop",
		"New lights can be set up from inside the app",
		"Brightness changes apply instantly over ESP-NOW",
	],
	sizeBytes: 38_400_000,
};

export class MockUpdater implements Updater {
	currentVersion = $state(APP_VERSION);
	state = $state<UpdaterState>({ status: "idle" });
	lastChecked = $state<Date | null>(null);

	#available: boolean;
	#failDownload: boolean;
	#timer: ReturnType<typeof setInterval> | undefined;

	/**
	 * `available` — whether the release server has a newer version. When set, the mock starts
	 * as if the launch-time check already found it (the real app checks quietly on launch).
	 */
	constructor(opts: { available?: boolean; failDownload?: boolean } = {}) {
		this.#available = opts.available ?? false;
		this.#failDownload = opts.failDownload ?? false;
		if (this.#available) {
			this.state = { status: "available", update: MOCK_UPDATE };
			this.lastChecked = new Date();
		}
	}

	check(): void {
		if (this.state.status === "checking" || this.state.status === "downloading") return;
		this.state = { status: "checking" };
		setTimeout(() => {
			this.lastChecked = new Date();
			this.state =
				this.#available && isNewer(MOCK_UPDATE.version, this.currentVersion)
					? { status: "available", update: MOCK_UPDATE }
					: { status: "current" };
		}, 1400);
	}

	download(): void {
		const s = this.state;
		const update = "update" in s ? s.update : null;
		if (!update || s.status === "downloading") return;
		clearInterval(this.#timer);
		const fail = this.#failDownload;
		this.#failDownload = false; // a retry succeeds
		let received = 0;
		this.state = { status: "downloading", update, received };
		this.#timer = setInterval(() => {
			received = Math.min(update.sizeBytes, received + update.sizeBytes / 40);
			if (fail && received > update.sizeBytes * 0.55) {
				clearInterval(this.#timer);
				this.state = { status: "error", message: "The download was interrupted. Check this PC's internet connection and try again.", update };
				return;
			}
			if (received >= update.sizeBytes) {
				clearInterval(this.#timer);
				this.state = { status: "ready", update };
			} else {
				this.state = { status: "downloading", update, received };
			}
		}, 150);
	}

	restart(): void {
		if (this.state.status !== "ready") return;
		const update = this.state.update;
		this.state = { status: "restarting", update };
		// In a browser there's nothing to restart: pretend the new version came back up.
		setTimeout(() => {
			this.currentVersion = update.version;
			this.#available = false;
			this.state = { status: "current", justUpdated: update.version };
		}, 2800);
	}
}
