// Everything outside the webview the main page talks to: the engine (sidecar), the Rust shell's
// health, and the flasher and updater drivers. Two implementations: `LiveBackend`
// ($lib/live.svelte.ts, under Tauri) and `MockBoard` ($lib/mock/board.svelte.ts, in a plain
// browser: the design preview and the `?demo=` states). The page picks one once.
import type { AppState, BridgeTxPower, SourceScanEvent, WifiScanEvent } from "$ipc";
import type { FlashBackend } from "$lib/flasher/session.svelte";
import type { Flasher } from "$lib/flasher/flasher";
import type { Updater } from "$lib/updater/updater";
import type { autostart, Notice, ShellHealth } from "$lib/ipc.svelte";

/** The shell-side health the page shows (see `ShellHealth`), without its ordering counter. */
export type BoardHealth = Omit<ShellHealth, "revision">;

/** Engine controls only the live app has (Settings → Source, Restart, Scan, launch at login). */
export interface EngineControls {
	readonly source: AppState["source"];
	readonly scan: SourceScanEvent | null;
	restart(): Promise<void>;
	scanSources(): void;
	readonly autostart: typeof autostart;
}

export interface Backend extends FlashBackend {
	/** The engine's snapshot (an empty, unconfigured one until the first arrives). */
	readonly state: AppState;
	readonly health: BoardHealth;
	/** The engine is down and restarting: `state` is stale and mustn't be shown as live. */
	readonly engineDown: boolean;
	/** The engine's out-of-band notices (firmware-outdated, offline-flash, …), oldest first. */
	readonly notices: readonly Notice[];
	dismissNotice(id: number): void;
	readonly flasher: Flasher;
	readonly updater: Updater;
	/** Null when there's no real engine to control (the mock). */
	readonly engine: EngineControls | null;

	/** Flash-to-identify: stream the locate flash to a light. */
	identify(mac: string): void;
	setSource(ip: string): void;
	/** Settings → ESP-NOW: the rig's channel (1–13). */
	setEspNowChannel(channel: number): void;
	/** Settings → ESP-NOW: the bridge's transmit power, for this session only. */
	setBridgeTxPower(txPower: BridgeTxPower): void;
	/** Settings → ESP-NOW → Scan: scan for access points from a cabled light (on `state.espnow.scanner`). */
	scanWifi(): void;
	/** The latest channel scan's progress or result, or null before the first. */
	readonly wifiScan: WifiScanEvent | null;
	/** Dev mode (fake ATEM, `state.dev`) only: take an input to program. */
	setProgram(inputId: number): void;
	/** Open a link in the user's browser. */
	openExternal(url: string): void;
	/** Start listening (on mount); returns the matching stop (on destroy). */
	start(): () => void;
}
