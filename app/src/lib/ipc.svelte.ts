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
// Guarded by `isTauri`: in a plain browser (`pnpm dev`, previewed through its `?demo=` states)
// there's no shell, so `start()` is a no-op and the page falls back to the mock board.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
	parseEvent,
	serializeMessage,
	type AppState,
	type NoticeEvent,
	type SourceScanEvent,
	type TransportMode,
	type UiCommand,
	type WifiScanEvent,
} from "$ipc";

/**
 * Shell-side health (`src-tauri/src/health.rs`): what the operator must see but the
 * sidecar can't say — the sidecar itself being down, a USB port the shell can't open, or
 * a board on USB with no TallyBot firmware.
 * Pushed as `"health"` events; pulled once on start via `shell_health`.
 */
export interface ShellHealth {
	/** Orders pushed vs pulled snapshots; the higher one wins. */
	revision: number;
	/** Why the sidecar died, while it's down and being restarted; null while it's up. */
	sidecarDown: string | null;
	/** Ports that keep failing to open, with operator-facing messages. */
	usbPortErrors: { port: string; message: string }[];
	/** Ports holding a board with no TallyBot firmware; the shell has released each one. */
	unflashedPorts: string[];
	/** Lights on USB and the port each is on (what the flasher targets). */
	lightPorts: { mac: string; port: string }[];
	/**
	 * Unflashed ports holding a known light that an interrupted install left without firmware: it
	 * sends no HELLO, so this is the only record of which light it is.
	 */
	blankLights: { mac: string; port: string }[];
	/** Why the OS settings folder couldn't be used (state and the shell log fall back), or null. */
	configDirMissing: string | null;
}

/** A sidecar notice as the page lists it: `id` tells two apart, so one can be dismissed alone. */
export type Notice = NoticeEvent & { id: number };

/** `sidecarDown` while the engine is down because we asked (`sidecar.rs`, the restart path). */
const RESTART_REASON = "restart requested";

/** Notices kept at once; an older one past this is dropped (they're one-shot refusals). */
const MAX_NOTICES = 4;

const HEALTHY: ShellHealth = {
	revision: 0,
	sidecarDown: null,
	usbPortErrors: [],
	unflashedPorts: [],
	lightPorts: [],
	blankLights: [],
	configDirMissing: null,
};

/** True when running inside the Tauri webview; false in a plain browser (`pnpm dev`). */
export const isTauri =
	typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Reactive mirror of the sidecar, plus the command senders. A single shared instance
 * (`sidecar` below) is the app's one connection to the engine.
 */
class SidecarStore {
	/** Latest full snapshot, or null until the first `state` event arrives. */
	state = $state<AppState | null>(null);
	/**
	 * Out-of-band notices (firmware-outdated, offline-flash, …), oldest first, until dismissed. A
	 * list, so a second one (two outdated lights) doesn't replace the first unseen.
	 */
	notices = $state<Notice[]>([]);
	#noticeSeq = 0;
	/** Latest scan progress/result, for the settings "Scan" UI. */
	scan = $state<SourceScanEvent | null>(null);
	/** Latest ESP-NOW channel scan progress/result. */
	wifiScan = $state<WifiScanEvent | null>(null);
	/** Shell-side health (sidecar down, USB ports that won't open). */
	health = $state<ShellHealth>(HEALTHY);
	/**
	 * True from the moment the sidecar dies until its replacement sends a fresh snapshot.
	 * `state` is then the dead process's last word, so the board must not present it as
	 * live. Outlasts `health.sidecarDown`, which clears as soon as the new process speaks.
	 */
	stale = $state(false);

	#unlisten: UnlistenFn[] = [];
	/** Resolvers waiting for the first snapshot from a restarted sidecar. */
	#awaitingFresh: (() => void)[] = [];

	/** Begin listening for sidecar events. Safe to call once on mount; no-op off Tauri. */
	async start(): Promise<void> {
		if (!isTauri || this.#unlisten.length) return;
		this.#unlisten.push(await listen<string>("sidecar", ({ payload }) => {
			const event = parseEvent(payload);
			if (!event) return;
			switch (event.type) {
				case "state":
					this.state = event.state;
					this.stale = false;
					for (const resolve of this.#awaitingFresh.splice(0)) resolve();
					break;
				case "notice": {
					// the same message again is one notice, moved to the end, not two
					const rest = this.notices.filter((n) => n.message !== event.message);
					this.notices = [...rest, { ...event, id: ++this.#noticeSeq }].slice(-MAX_NOTICES);
					break;
				}
				case "sourceScan":
					this.scan = event;
					break;
				case "wifiScan":
					this.wifiScan = event;
					break;
				case "deviceLog":
					// Every line is in the engine's log file; the ones the operator must see arrive as
					// faults in the snapshot.
					break;
				default: {
					// A new event type must be handled above, not dropped here.
					const unhandled: never = event;
					console.warn("unhandled sidecar event", unhandled);
				}
			}
		}));
		// Listen before pulling, so no change falls between the two; `revision` keeps a
		// late pull from overwriting a newer push.
		this.#unlisten.push(await listen<ShellHealth>("health", ({ payload }) => this.#applyHealth(payload)));
		void invoke<ShellHealth>("shell_health").then((h) => this.#applyHealth(h));
		// The listener is live now — ask the sidecar to replay current state. Without
		// this, any snapshot it emitted during start-up (before this listener existed)
		// is lost, and the board sits on empty state until the next change. Tauri does
		// not buffer events for not-yet-registered listeners.
		this.#send({ type: "requestState" });
	}

	/** Stop listening (call on destroy). */
	stop(): void {
		for (const unlisten of this.#unlisten) unlisten();
		this.#unlisten = [];
	}

	dismissNotice(id: number): void {
		this.notices = this.notices.filter((n) => n.id !== id);
	}

	#applyHealth(health: ShellHealth): void {
		if (health.revision < this.health.revision) return;
		this.health = health;
		if (health.sidecarDown !== null) this.stale = true;
		// The restarted engine died before its first snapshot (the shell names any other reason
		// than our own request): stop waiting for one. The "engine stopped" banner says why.
		if (health.sidecarDown !== null && health.sidecarDown !== RESTART_REASON) {
			for (const resolve of this.#awaitingFresh.splice(0)) resolve();
		}
	}

	#send(command: UiCommand): void {
		if (!isTauri) return;
		// Rejects only while the sidecar is down — which the health banner already says.
		invoke("send_to_sidecar", { line: serializeMessage(command) }).catch((err: unknown) =>
			console.warn("send_to_sidecar:", err),
		);
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
	setTransport(mac: string, mode: TransportMode): void {
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
	/**
	 * Replace the running sidecar with a fresh one (Settings → Restart). Resolves once the
	 * new process has sent its first snapshot, or has died before sending one; while it's down
	 * the health banner says so (and why).
	 */
	async restart(): Promise<void> {
		if (!isTauri) return;
		// Wait only after the kill, so a last snapshot from the old process can't count;
		// a new process takes far longer to start than this round trip.
		await invoke("restart_sidecar");
		// Its last snapshot is still on screen: mark it stale now rather than waiting for
		// the shell's health push.
		this.stale = true;
		await new Promise<void>((resolve) => this.#awaitingFresh.push(resolve));
	}
	/** Dev mode only: take an input to program on the fake ATEM (see AppState.dev). */
	setProgram(inputId: number): void {
		this.#send({ type: "setProgram", inputId });
	}
}

/**
 * Launch on system startup, via the shell's autostart plugin (an OS login item: the
 * registry Run key on Windows, an XDG autostart entry on Linux). Invoked directly rather
 * than through `@tauri-apps/plugin-autostart`, which is only these three calls.
 */
export const autostart = {
	isEnabled: () => invoke<boolean>("plugin:autostart|is_enabled"),
	set: (enabled: boolean) => invoke<void>(enabled ? "plugin:autostart|enable" : "plugin:autostart|disable"),
};

/** The app's single sidecar connection. */
export const sidecar = new SidecarStore();
