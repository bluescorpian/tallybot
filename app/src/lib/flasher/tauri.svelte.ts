// The real flasher driver: espflash in the Rust shell (`src-tauri/src/flash.rs`). The shell runs
// one flash at a time and reports it as `"flash"` events; this turns them into `FlashState`,
// adding the target (which the shell doesn't echo back).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FlashFailure, FlashStage, FlashState, FlashTarget, Flasher } from "./flasher";

/** `flash.rs` `FlashEvent`. */
type FlashEvent =
	| { status: "running"; stage: FlashStage; progress: number }
	| { status: "done"; mac: string }
	| { status: "failed"; stage: FlashStage; failure: FlashFailure; detail: string }
	| { status: "cancelled"; stage: FlashStage };

export class TauriFlasher implements Flasher {
	state = $state<FlashState>({ status: "idle" });
	firmwareVersion = $state<string | null>(null);

	/** Ask the shell which firmware this build bundles, and start listening for progress. */
	async init(): Promise<void> {
		const info = await invoke<{ version: string } | null>("firmware_info");
		this.firmwareVersion = info?.version ?? null;
		await listen<FlashEvent>("flash", (e) => this.#onEvent(e.payload));
	}

	start(target: FlashTarget): void {
		if (this.state.status === "running") return;
		this.state = { status: "running", target, stage: "connect", progress: 0 };
		invoke("flash_start", { port: target.port, mac: target.kind === "light" ? target.mac : null }).catch(
			(err) => {
				this.state = { status: "failed", target, stage: "connect", failure: "error", detail: String(err) };
			},
		);
	}

	/** The shell stops at its next progress step; the outcome arrives as a `cancelled` event. */
	cancel(): void {
		if (this.state.status === "running") void invoke("flash_cancel");
	}

	reset(): void {
		if (this.state.status !== "running") this.state = { status: "idle" };
	}

	#onEvent(e: FlashEvent): void {
		// Events only ever belong to the job this driver started; anything after a reset is stale.
		if (this.state.status !== "running") return;
		const { target } = this.state;
		this.state = { ...e, target } as FlashState;
	}
}
