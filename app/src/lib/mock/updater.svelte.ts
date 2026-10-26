// App updater — FAKE driver for the UI mockup.
//
// The real driver (the Tauri updater plugin) replaces `MockUpdater` with one implementing
// the same `Updater` interface; the update UI only reads `state` / `currentVersion` and calls
// check / download / restart.
//
// Rule: nothing installs on its own. Downloading is harmless mid-show; installing restarts
// the app (and the engine, so every light drops for a few seconds), so it happens only when
// the user picks "Restart now", or on the next launch if they picked "Later".
import { version as APP_VERSION } from "../../../package.json";

export interface AppUpdate {
	version: string;
	/** The light firmware that release bundles (what its flasher would install). */
	firmwareVersion: string;
	/** Release date, ISO yyyy-mm-dd. */
	date: string;
	/** Short, user-facing release notes. */
	notes: string[];
	sizeBytes: number;
}

export type UpdaterState =
	| { status: "idle" }
	| { status: "checking" }
	/** Up to date. `justUpdated` is set on the first run after installing an update. */
	| { status: "current"; justUpdated?: string }
	| { status: "available"; update: AppUpdate }
	| { status: "downloading"; update: AppUpdate; received: number }
	/** Downloaded: installs on "Restart now", or on the next launch. */
	| { status: "ready"; update: AppUpdate }
	| { status: "restarting"; update: AppUpdate }
	| { status: "error"; message: string; update: AppUpdate | null };

export interface Updater {
	readonly currentVersion: string;
	readonly state: UpdaterState;
	check(): void;
	download(): void;
	/** Install now: restarts TallyBot (lights drop for a few seconds). */
	restart(): void;
}

/** True when semver `a` is newer than `b` (plain x.y.z). */
export function isNewer(a: string, b: string): boolean {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
	}
	return false;
}

/** The update that would bring newer light firmware than `firmwareVersion`, if any is known. */
export function newerFirmwareUpdate(state: UpdaterState, firmwareVersion: string): AppUpdate | null {
	const update = "update" in state ? state.update : null;
	return update && isNewer(update.firmwareVersion, firmwareVersion) ? update : null;
}

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
		if (this.#available) this.state = { status: "available", update: MOCK_UPDATE };
	}

	check(): void {
		if (this.state.status === "checking" || this.state.status === "downloading") return;
		this.state = { status: "checking" };
		setTimeout(() => {
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
				this.state = { status: "error", message: "The download was interrupted (connection reset).", update };
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
