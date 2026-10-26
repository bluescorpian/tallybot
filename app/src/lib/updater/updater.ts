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
	/** Download size; null until the download starts (latest.json doesn't carry it). */
	sizeBytes: number | null;
	/**
	 * Whether this install can update itself. Installer builds (Windows setup/MSI, AppImage) can;
	 * the portable zip, .deb and .rpm get the release page instead (`releaseUrl`).
	 */
	installable: boolean;
	/** The release's GitHub page. */
	releaseUrl: string;
}

/**
 * A release body as a short list: its bullet lines, without GitHub's generated "by @user in
 * <PR link>" suffix. Headings and the "Full Changelog" line are dropped.
 */
export function releaseNotes(body: string): string[] {
	return body
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => /^[-*] /.test(l))
		.map((l) => l.slice(2).replace(/ by @\S+ in \S+$/, "").trim())
		.filter(Boolean);
}

/** Download progress 0–1, or 0 while the size isn't known yet. */
export function downloadProgress(received: number, update: AppUpdate): number {
	return update.sizeBytes ? Math.min(1, received / update.sizeBytes) : 0;
}

export type UpdaterState =
	| { status: "idle" }
	| { status: "checking" }
	/** Up to date. `justUpdated` is set on the first run after installing an update. */
	| { status: "current"; justUpdated?: string }
	| { status: "available"; update: AppUpdate }
	| { status: "downloading"; update: AppUpdate; received: number }
	/** Downloaded: installs on "Restart now". Until then the titlebar pill keeps reminding. */
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
export function newerFirmwareUpdate(state: UpdaterState, firmwareVersion: string | null): AppUpdate | null {
	const update = "update" in state ? state.update : null;
	return update && firmwareVersion !== null && isNewer(update.firmwareVersion, firmwareVersion) ? update : null;
}
