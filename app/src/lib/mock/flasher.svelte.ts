// Firmware flasher — FAKE driver, for the browser preview and the `?demo=` states. The real
// one is `TauriFlasher` ($lib/flasher/tauri.svelte); both implement `Flasher`.
import {
	canReset,
	canStart,
	FLASH_STAGES,
	type FlashFailure,
	type FlashStage,
	type FlashState,
	type FlashTarget,
	type Flasher,
	leavesBlank,
} from "$lib/flasher/flasher";

/**
 * The light firmware this mock app bundles: mirrors `firmware/VERSION`, which is versioned apart
 * from the app (a release can ship the same firmware as the last). Set it to null to preview a
 * build that bundles none (no in-app flasher).
 */
export const MOCK_BUNDLED_FIRMWARE: string | null = "1.1.0";

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

	#bundled: () => string | null;
	#boardMac: (port: string) => string | null;

	/**
	 * `bundled` reads the firmware version this app ships, so it can follow an app update (the
	 * mock app "updates" without reloading). `boardMac` names the
	 * light a blank board on `port` used to be (one left blank by an interrupted install), which
	 * comes back as that light, as the real bootloader-reported MAC would; otherwise a blank board
	 * comes back as a new light.
	 */
	constructor(
		opts: { failOnce?: FlashFailure | null; bundled?: () => string | null; boardMac?: (port: string) => string | null } = {},
	) {
		this.#failOnce = opts.failOnce ?? null;
		this.#bundled = opts.bundled ?? (() => MOCK_BUNDLED_FIRMWARE);
		this.#boardMac = opts.boardMac ?? (() => null);
	}

	get firmwareVersion(): string | null {
		return this.#bundled();
	}

	start(target: FlashTarget): void {
		if (!canStart(this.state)) return;
		this.#clear();
		const fail = this.#failOnce;
		this.#failOnce = null;
		const enter = (stage: FlashStage) => {
			this.state = { status: "running", target, stage, progress: 0 };
			if (stage === "write") this.#animateWrite(target, DURATION.write);
		};
		let at = 0;
		for (const stage of FLASH_STAGES) {
			const begin = at;
			// the first stage is entered at once, as the real driver does, so `running` holds from the call
			if (begin === 0) enter(stage);
			else this.#later(begin, () => enter(stage));
			if (fail && failsAt(fail) === stage) {
				const failAfter = fail === "unplugged" ? DURATION.write * 0.43 : fail === "port-busy" ? 500 : 3200;
				this.#later(begin + failAfter, () => {
					this.#clear();
					this.state = { status: "failed", target, stage, failure: fail, detail: DETAIL[fail], leavesBlank: leavesBlank(stage) };
				});
				return;
			}
			at += DURATION[stage];
		}
		this.#later(at, () => {
			// a blank board's MAC is known from the bootloader; the mock invents one for a new board
			const mac = target.kind === "light" ? target.mac : (this.#boardMac(target.port) ?? "30:ae:a4:00:e7:5b");
			this.state = { status: "done", target, mac };
		});
	}

	cancel(): void {
		if (this.state.status !== "running") return;
		const { target, stage } = this.state;
		this.#clear();
		this.state = { status: "cancelled", target, stage, leavesBlank: leavesBlank(stage) };
	}

	reset(): void {
		if (!canReset(this.state)) return;
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
