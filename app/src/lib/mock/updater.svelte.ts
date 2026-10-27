// App updater — FAKE driver, for the browser preview and the `?demo=` states. The real one is
// `TauriUpdater` ($lib/updater/tauri.svelte); both implement `Updater`.
import { version as APP_VERSION } from "../../../package.json";
import { canCheck, downloadable, isNewer, type AppUpdate, type Updater, type UpdaterState } from "$lib/updater/updater";
import { MOCK_BUNDLED_FIRMWARE } from "./flasher.svelte";

/** The next minor release after `v` (plain x.y.z). */
function nextMinor(v: string): string {
	const [major = 0, minor = 0] = v.split(".").map(Number);
	return `${major}.${minor + 1}.0`;
}

// The release the mock finds: the next TallyBot, shipping newer light firmware than this one
// bundles (so `?demo=newerfw` can offer "Update TallyBot first"). Derived, so it stays newer as
// the real versions move.
const MOCK_VERSION = nextMinor(APP_VERSION);
const MOCK_UPDATE: AppUpdate = {
	version: MOCK_VERSION,
	firmwareVersion: nextMinor(MOCK_BUNDLED_FIRMWARE ?? "0.0.0"),
	date: "2026-10-20T09:00:00Z",
	notes: [
		"Lights reconnect faster after a Wi-Fi drop",
		"New lights can be set up from inside the app",
		"Brightness changes apply instantly over ESP-NOW",
	],
	sizeBytes: 38_400_000,
	installable: true,
	releaseUrl: `https://github.com/bluescorpian/tallybot/releases/tag/v${MOCK_VERSION}`,
};
const SIZE = 38_400_000;

export class MockUpdater implements Updater {
	currentVersion = $state(APP_VERSION);
	state = $state<UpdaterState>({ status: "idle" });
	lastChecked = $state<Date | null>(null);
	/** The light firmware the running mock app bundles; an install brings the update's. */
	bundledFirmware = $state<string | null>(MOCK_BUNDLED_FIRMWARE);

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
		if (!canCheck(this.state)) return;
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
		const update = downloadable(this.state);
		if (!update) return;
		clearInterval(this.#timer);
		const fail = this.#failDownload;
		this.#failDownload = false; // a retry succeeds
		let received = 0;
		this.state = { status: "downloading", update, received };
		this.#timer = setInterval(() => {
			received = Math.min(SIZE, received + SIZE / 40);
			if (fail && received > SIZE * 0.55) {
				clearInterval(this.#timer);
				this.state = { status: "error", message: "The download was interrupted. Check this PC's internet connection and try again.", update };
				return;
			}
			if (received >= SIZE) {
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
			this.bundledFirmware = update.firmwareVersion;
			this.#available = false;
			this.state = { status: "current", justUpdated: update.version };
		}, 2800);
	}
}
