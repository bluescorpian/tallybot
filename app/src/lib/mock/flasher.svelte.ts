// Firmware flasher — FAKE driver for the UI mockup.
//
// The real driver (espflash in the Rust shell, docs/spec/usb-serial-protocol.md → Flashing)
// replaces `MockFlasher` with one that implements the same `Flasher` interface: the
// components only read `state` and call start / cancel / reset, so swapping the driver is a
// change to the page that constructs it, not to the flasher UI.
//
// Rule: the flasher only ever writes the firmware built for THIS app version
// (`firmwareVersion`), never "latest" — an app and a firmware from different releases can
// disagree on the protocol. A newer firmware is reached by updating the app.
import { version as APP_VERSION } from "../../../package.json";

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
 * The failures worth a tailored fix:
 *   no-response — the chip didn't enter download mode (fix: hold BOOT while plugging in)
 *   port-busy   — another program holds the serial port
 *   unplugged   — the cable came out mid-write (board left blank, recoverable)
 */
export type FlashFailure = "no-response" | "port-busy" | "unplugged";

export type FlashState =
	| { status: "idle" }
	/** `progress` is 0–1 within the `write` stage, and 0 elsewhere. */
	| { status: "running"; target: FlashTarget; stage: FlashStage; progress: number }
	/** `mac` is the light the board came back as (new for a blank board). */
	| { status: "done"; target: FlashTarget; mac: string }
	| { status: "failed"; target: FlashTarget; stage: FlashStage; failure: FlashFailure; detail: string }
	| { status: "cancelled"; target: FlashTarget; stage: FlashStage };

export interface Flasher {
	/** The firmware bundled with this app — the only version it flashes. */
	readonly firmwareVersion: string;
	readonly state: FlashState;
	start(target: FlashTarget): void;
	/** Abort a running flash. Leaves the board blank (recoverable by flashing again). */
	cancel(): void;
	/** Back to idle once the UI has shown the outcome. */
	reset(): void;
}

// Stage durations (ms). Write is the long one; the rest are realistic-ish but brisk.
const DURATION: Record<FlashStage, number> = {
	connect: 1400,
	erase: 2200,
	write: 14000,
	verify: 1300,
	restart: 1100,
	rejoin: 2600,
};

const DETAIL: Record<FlashFailure, string> = {
	"no-response": "espflash: Failed to connect to the chip (timed out waiting for packet header)",
	"port-busy": "espflash: Failed to open serial port: Device or resource busy",
	unplugged: "espflash: Serial port disconnected while writing (0x0002f000)",
};

export class MockFlasher implements Flasher {
	readonly firmwareVersion = APP_VERSION;
	state = $state<FlashState>({ status: "idle" });

	#timers: ReturnType<typeof setTimeout>[] = [];
	#tick: ReturnType<typeof setInterval> | undefined;
	/** A forced failure for the first attempt only — a retry then succeeds, as it would after the fix. */
	#failOnce: FlashFailure | null;

	constructor(opts: { failOnce?: FlashFailure | null } = {}) {
		this.#failOnce = opts.failOnce ?? null;
	}

	start(target: FlashTarget): void {
		this.#clear();
		const fail = this.#failOnce;
		this.#failOnce = null;
		let at = 0;
		for (const stage of FLASH_STAGES) {
			const begin = at;
			this.#later(begin, () => {
				this.state = { status: "running", target, stage, progress: 0 };
				if (stage === "write") this.#animateWrite(target, DURATION.write);
			});
			if (fail && failsAt(fail) === stage) {
				const failAfter = fail === "unplugged" ? DURATION.write * 0.43 : fail === "port-busy" ? 500 : 3200;
				this.#later(begin + failAfter, () => {
					this.#clear();
					this.state = { status: "failed", target, stage, failure: fail, detail: DETAIL[fail] };
				});
				return;
			}
			at += DURATION[stage];
		}
		this.#later(at, () => {
			const mac = target.kind === "light" ? target.mac : "30:ae:a4:00:e7:5b";
			this.state = { status: "done", target, mac };
		});
	}

	cancel(): void {
		if (this.state.status !== "running") return;
		const { target, stage } = this.state;
		this.#clear();
		this.state = { status: "cancelled", target, stage };
	}

	reset(): void {
		this.#clear();
		this.state = { status: "idle" };
	}

	#animateWrite(target: FlashTarget, ms: number) {
		const started = Date.now();
		this.#tick = setInterval(() => {
			const p = Math.min(1, (Date.now() - started) / ms);
			if (this.state.status === "running" && this.state.stage === "write") {
				this.state = { status: "running", target, stage: "write", progress: p };
			}
			if (p >= 1) clearInterval(this.#tick);
		}, 120);
	}

	#later(ms: number, fn: () => void) {
		this.#timers.push(setTimeout(fn, ms));
	}

	#clear() {
		for (const t of this.#timers) clearTimeout(t);
		this.#timers = [];
		clearInterval(this.#tick);
	}
}

function failsAt(f: FlashFailure): FlashStage {
	return f === "unplugged" ? "write" : "connect";
}
