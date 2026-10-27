// The real flasher driver: espflash in the Rust shell (`src-tauri/src/flash.rs`). The shell runs
// one flash at a time and keeps its state (`FlashStatus`), pushed as `"flash"` events and pulled
// with `flash_status`; this turns it into `FlashState`, keeping the target the UI picked.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { shortMac } from "$lib/boardState";
import { canReset, canStart, type FlashFailure, type FlashStage, type FlashState, type FlashTarget, type Flasher } from "./flasher";

/** `flash.rs` `FlashEvent`. */
type FlashEvent =
	| { status: "running"; stage: FlashStage; progress: number }
	| { status: "done"; mac: string }
	| { status: "failed"; stage: FlashStage; failure: FlashFailure; detail: string }
	| { status: "cancelled"; stage: FlashStage };

/** `flash.rs` `FlashStatus`: the current or last job. `revision` orders pushes and pulls. */
type FlashStatus = FlashEvent & { revision: number; port: string; targetMac: string | null };

export class TauriFlasher implements Flasher {
	state = $state<FlashState>({ status: "idle" });
	firmwareVersion = $state<string | null>(null);

	/** The newest shell status applied, so a late pull never overwrites a newer push. */
	#revision = 0;

	/**
	 * Ask the shell which firmware this build bundles, start listening for progress, then pull the
	 * job's state: an install that is running, or that failed or was stopped, before this webview
	 * (re)started is picked up rather than lost.
	 */
	async init(): Promise<void> {
		const info = await invoke<{ version: string } | null>("firmware_info");
		this.firmwareVersion = info?.version ?? null;
		await listen<FlashStatus>("flash", (e) => this.#onStatus(e.payload));
		const status = await invoke<FlashStatus | null>("flash_status");
		if (status) this.#onStatus(status, true);
	}

	start(target: FlashTarget): void {
		if (!canStart(this.state)) return;
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
		if (canReset(this.state)) this.state = { status: "idle" };
	}

	#onStatus(s: FlashStatus, pulled = false): void {
		if (s.revision <= this.#revision) return;
		const { revision, port, targetMac, ...event } = s;
		let target: FlashTarget;
		if (this.state.status === "running") {
			// The job this driver started: keep the target it picked.
			target = this.state.target;
		} else if (pulled && event.status !== "done") {
			// A job this webview didn't see start (it reloaded): adopt it, so a running install shows
			// its progress and a failed or stopped one is still reported. An old success isn't news.
			target = targetMac === null ? { kind: "blank", port } : { kind: "light", mac: targetMac, label: shortMac(targetMac), port };
		} else {
			return; // after a reset, a push about the finished job is stale
		}
		this.#revision = revision;
		this.state = { ...event, target } as FlashState;
	}
}
