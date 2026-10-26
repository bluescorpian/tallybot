// The firmware flasher's contract: what the flasher UI reads and calls. Two drivers implement
// it — `TauriFlasher` (./tauri.svelte.ts: espflash in the Rust shell, `src-tauri/src/flash.rs`)
// and `MockFlasher` ($lib/mock: fake operations, for the browser preview and `?demo=` states).
//
// Rule: the flasher only ever writes the firmware bundled with THIS app (`firmwareVersion`),
// never "latest" — an app and a firmware from different releases can disagree on the protocol.
// A newer firmware is reached by updating the app.
import { isNewer } from "../updater/updater";

/** What is being flashed: a board with no TallyBot firmware, or a known light. */
export type FlashTarget =
	| { kind: "blank"; port: string }
	| { kind: "light"; mac: string; label: string; port: string };

/**
 * The stages of one flash, in order. `rejoin` is the native-USB tail: the ESP32-C3 resets,
 * its USB port disappears and re-enumerates, and the light reconnects to the engine.
 */
export const FLASH_STAGES = ["connect", "erase", "write", "verify", "restart", "rejoin"] as const;
export type FlashStage = (typeof FLASH_STAGES)[number];

/**
 * The failures worth a tailored fix, plus a catch-all:
 *   no-response — the chip didn't enter download mode (fix: hold BOOT while plugging in)
 *   port-busy   — another program holds the serial port
 *   unplugged   — the cable came out mid-write (board left blank, recoverable)
 *   wrong-light — the board on the port isn't the light being updated (nothing was written)
 *   error       — anything else; `detail` says what
 */
export type FlashFailure = "no-response" | "port-busy" | "unplugged" | "wrong-light" | "error";

export type FlashState =
	| { status: "idle" }
	/** `progress` is 0–1 within the `write` stage, and 0 elsewhere. */
	| { status: "running"; target: FlashTarget; stage: FlashStage; progress: number }
	/** `mac` is the light the board came back as (new for a blank board). */
	| { status: "done"; target: FlashTarget; mac: string }
	| { status: "failed"; target: FlashTarget; stage: FlashStage; failure: FlashFailure; detail: string }
	| { status: "cancelled"; target: FlashTarget; stage: FlashStage };

export interface Flasher {
	/**
	 * The firmware bundled with this app — the only version it flashes. Null when this build
	 * carries none (a dev build that didn't stage one), and until the driver has asked.
	 */
	readonly firmwareVersion: string | null;
	readonly state: FlashState;
	start(target: FlashTarget): void;
	/**
	 * Stop a running flash. Mid-write it leaves the board blank (recoverable by flashing again);
	 * see `leavesBlank`.
	 */
	cancel(): void;
	/** Back to idle once the UI has shown the outcome. */
	reset(): void;
}

/** What firmware a light runs, as far as the app can tell. */
export interface LightFirmware {
	/** The version it reported, or null when it hasn't reported one. */
	version: string | null;
	/**
	 * Whether a null `version` means old firmware: the light connected this session without
	 * reporting one (firmware older than 1.1 doesn't). False when it just hasn't been heard from.
	 */
	known: boolean;
}

/**
 * Whether a light should be offered a firmware update: the app bundles firmware (`bundled`, null
 * when this build carries none) and the light runs an older one, or one too old to say.
 */
export function firmwareOutdated(bundled: string | null, light: LightFirmware): boolean {
	return bundled !== null && light.known && (light.version === null || isNewer(bundled, light.version));
}

/**
 * Whether stopping or failing at `stage` leaves the board without firmware. Before erase nothing
 * was touched; once the write is done the new firmware is in place and comes back on its own.
 */
export function leavesBlank(stage: FlashStage): boolean {
	return stage === "erase" || stage === "write";
}
