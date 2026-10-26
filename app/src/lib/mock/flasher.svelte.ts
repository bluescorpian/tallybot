// Firmware flasher — FAKE driver, for the browser preview and the `?demo=` states. The real
// one is `TauriFlasher` ($lib/flasher/tauri.svelte); both implement `Flasher`.
import { version as APP_VERSION } from "../../../package.json";
import { FLASH_STAGES, type FlashFailure, type FlashStage, type FlashState, type FlashTarget, type Flasher } from "$lib/flasher/flasher";

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
	"wrong-light": "The board on COM7 is 30:ae:a4:00:77:88",
	error: "espflash: Flash command failed",
};

export class MockFlasher implements Flasher {
	state = $state<FlashState>({ status: "idle" });

	#timers: ReturnType<typeof setTimeout>[] = [];
	#tick: ReturnType<typeof setInterval> | undefined;
	/** A forced failure for the first attempt only — a retry then succeeds, as it would after the fix. */
	#failOnce: FlashFailure | null;

	#bundled: () => string;

	/**
	 * `bundled` reads the firmware version this app ships. It's the app's version, so it
	 * follows an app update (the mock app "updates" without reloading).
	 */
	constructor(opts: { failOnce?: FlashFailure | null; bundled?: () => string } = {}) {
		this.#failOnce = opts.failOnce ?? null;
		this.#bundled = opts.bundled ?? (() => APP_VERSION);
	}

	get firmwareVersion(): string {
		return this.#bundled();
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
			// a blank board's MAC is known from the bootloader; the mock invents a new one
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
