// The firmware flasher's contract: what the flasher UI reads and calls. Two drivers implement
// it — `TauriFlasher` (./tauri.svelte.ts: espflash in the Rust shell, `src-tauri/src/flash.rs`)
// and `MockFlasher` ($lib/mock: fake operations, for the browser preview and `?demo=` states).
//
// Rule: the flasher only ever writes the firmware bundled with THIS app (`firmwareVersion`),
// never "latest" — an app and a firmware from different releases can disagree on the protocol.
// A newer firmware is reached by updating the app.
import type { DeviceFirmware } from "$ipc";
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
 * The failures worth a tailored fix, plus a catch-all (`flash.rs` `Failure`, which classifies them):
 *   no-response — the chip didn't enter download mode (fix: hold BOOT while plugging in)
 *   port-busy   — another program holds the serial port
 *   unplugged   — the cable came out mid-write (board left blank, recoverable)
 *   wrong-light — the board on the port isn't the light being updated (nothing was written)
 *   wrong-chip  — the board isn't an ESP32-C3 TallyBot can install on (nothing was written)
 *   rejoin      — installed, but the light didn't come back over USB (its firmware is fine)
 *   error       — anything else; `detail` says what
 */
export type FlashFailure = "no-response" | "port-busy" | "unplugged" | "wrong-light" | "wrong-chip" | "rejoin" | "error";

export type FlashState =
	| { status: "idle" }
	/**
	 * `progress` is 0–1 within the `write` stage, and 0 elsewhere. `leavesBlank`: stopping now would
	 * leave the board without firmware.
	 */
	| { status: "running"; target: FlashTarget; stage: FlashStage; progress: number; leavesBlank?: boolean }
	/** `mac` is the light the board came back as (new for a blank board). */
	| { status: "done"; target: FlashTarget; mac: string }
	/**
	 * `leavesBlank`: it ended where the board has no working firmware now, as the shell decides it
	 * (`Stage::leaves_blank` in flash.rs). Every driver sets it; absent reads as false.
	 */
	| { status: "failed"; target: FlashTarget; stage: FlashStage; failure: FlashFailure; detail: string; leavesBlank?: boolean }
	| { status: "cancelled"; target: FlashTarget; stage: FlashStage; leavesBlank?: boolean };

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
	 * the state's `leavesBlank` says when.
	 */
	cancel(): void;
	/** Back to idle once the UI has shown the outcome. */
	reset(): void;
}

/**
 * Whether a light should be offered a firmware update: the app bundles firmware (`bundled`, null
 * when this build carries none) and the light runs an older one. Firmware too old to report its
 * version (`legacy`) is older than anything bundled; a light not yet heard from (`unknown`) isn't
 * flagged on a guess. A reported version that isn't x.y.z can't be compared, so it's offered the
 * bundled firmware rather than read as current.
 */
export function firmwareOutdated(bundled: string | null, firmware: DeviceFirmware): boolean {
	if (bundled === null) return false;
	switch (firmware.kind) {
		case "reported":
			return !/^\d+\.\d+\.\d+$/.test(firmware.version) || isNewer(bundled, firmware.version);
		case "legacy":
			return true;
		case "unknown":
			return false;
	}
}

/** Whether `start` may begin a flash: one runs at a time, and a call while one runs is ignored. */
export function canStart(state: FlashState): boolean {
	return state.status !== "running";
}

/** Whether `reset` may clear the state: a running flash is stopped with `cancel`, never reset. */
export function canReset(state: FlashState): boolean {
	return state.status !== "running";
}

