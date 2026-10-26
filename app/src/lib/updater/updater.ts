// The app updater's contract: what the update UI reads and calls. Two drivers implement it —
// `TauriUpdater` (./tauri.svelte.ts: the Tauri updater plugin) and `MockUpdater` ($lib/mock).
//
// Rule: nothing installs on its own. Downloading is harmless mid-show; installing restarts the
// app (and the engine, so every light drops for a few seconds), so it happens only when the user
// picks "Restart now".

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
	/** When the last check finished, or null if it hasn't run yet. */
	readonly lastChecked: Date | null;
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
