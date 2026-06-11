// The UI side of the Tauri ↔ sidecar bridge.
//
// The Rust shell spawns the sidecar and forwards its NDJSON stdout lines to the webview
// as `"sidecar"` events; it also exposes a `send_to_sidecar` command we `invoke` to push
// a `UiCommand` to the sidecar's stdin (see `src-tauri/src/lib.rs`, `app/sidecar/SIDECAR.md`).
//
// This module owns that wiring: a reactive store fed by the event stream, plus typed
// senders for every command. It reuses the shared `$ipc` contract for parsing/serializing
// — the same code the sidecar runs — so the framing can't drift between the two ends.
//
// Guarded by `isTauri`: in a plain browser (`pnpm dev`, the /preview design workflow)
// there's no shell, so `start()` is a no-op and the page falls back to mock data.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
	parseEvent,
	serializeMessage,
	type AppState,
	type NoticeEvent,
	type SourceScanEvent,
	type UiCommand,
} from "$ipc";

/** True when running inside the Tauri webview (mirrors `TitleBar.svelte`). */
export const isTauri =
	typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Reactive mirror of the sidecar, plus the command senders. A single shared instance
 * (`sidecar` below) is the app's one connection to the engine.
 */
class SidecarStore {
	/** Latest full snapshot, or null until the first `state` event arrives. */
	state = $state<AppState | null>(null);
	/** Most recent out-of-band notice (firmware-outdated, offline-flash, …). */
	notice = $state<NoticeEvent | null>(null);
	/** Latest scan progress/result, for the settings "Scan" UI. */
	scan = $state<SourceScanEvent | null>(null);

	#unlisten: UnlistenFn | null = null;

	/** Begin listening for sidecar events. Safe to call once on mount; no-op off Tauri. */
	async start(): Promise<void> {
		if (!isTauri || this.#unlisten) return;
		this.#unlisten = await listen<string>("sidecar", ({ payload }) => {
			const event = parseEvent(payload);
			if (!event) return;
			switch (event.type) {
				case "state":
					this.state = event.state;
					break;
				case "notice":
					this.notice = event;
					break;
				case "sourceScan":
					this.scan = event;
					break;
			}
		});
		// The listener is live now — ask the sidecar to replay current state. Without
		// this, any snapshot it emitted during start-up (before this listener existed)
		// is lost, and the board sits on empty state until the next change. Tauri does
		// not buffer events for not-yet-registered listeners.
		this.#send({ type: "requestState" });
	}

	/** Stop listening (call on destroy). */
	stop(): void {
		this.#unlisten?.();
		this.#unlisten = null;
	}

	#send(command: UiCommand): void {
		if (!isTauri) return;
		void invoke("send_to_sidecar", { line: serializeMessage(command) });
	}

	assignDevice(mac: string, inputId: number): void {
		this.#send({ type: "assignDevice", mac, inputId });
	}
	unassignDevice(mac: string): void {
		this.#send({ type: "unassignDevice", mac });
	}
	identifyDevice(mac: string): void {
		this.#send({ type: "identifyDevice", mac });
	}
	setBrightness(mac: string, brightness: number): void {
		this.#send({ type: "setBrightness", mac, brightness });
	}
	/** Provision a USB device's WiFi creds + kick off the validating join (v1.2). */
	provisionWifi(mac: string, ssid: string, password: string): void {
		this.#send({ type: "provisionWifi", mac, ssid, password });
	}
	/**
	 * Set what a USB device does when unplugged: join WiFi, stay dark (No-TX), or
	 * receive tally from a bridge over ESP-NOW (v1.3, devices reporting version ≥ 3).
	 */
	setTransport(mac: string, mode: "wifi" | "notx" | "espnow"): void {
		this.#send({ type: "setTransport", mac, mode });
	}
	/**
	 * Designate a USB device as *the* ESP-NOW bridge (`mac`), or un-designate the
	 * current one (`null`). One bridge per session — designating a new MAC replaces
	 * the old. Only offered for devices reporting protocol version ≥ 3.
	 */
	setBridge(mac: string | null): void {
		this.#send({ type: "setBridge", mac });
	}
	setSource(ip: string): void {
		this.#send({ type: "setSource", ip });
	}
	scanSources(): void {
		this.#send({ type: "scanSources" });
	}
	/** Dev mode only: take an input to program on the fake ATEM (see AppState.dev). */
	setProgram(inputId: number): void {
		this.#send({ type: "setProgram", inputId });
	}
}

/** The app's single sidecar connection. */
export const sidecar = new SidecarStore();
