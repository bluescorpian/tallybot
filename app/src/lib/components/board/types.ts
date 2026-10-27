// Board view-model — the vocabulary the locked <Board> renders.
//
// The board is purely presentational: it knows nothing about the sidecar wire
// format. The app layer maps the IPC `AppState` (sidecar/src/ipc.ts) onto these
// types in `$lib/boardState.ts`, which is where the "all states" interpretation
// (unknown→idle on keys, unknown→fault on lights, override, offline/setup) lives.
import type { InputState } from "./InputKey.svelte";
import type { LightState } from "./TallyLightPcb.svelte";
import type { DeviceTransport, DeviceWifiState, TransportMode } from "$ipc";

export type { InputState, LightState };

/** An input column header — already resolved to a key state by the mapper. */
export interface BoardInput {
	/** Stable input id (the ATEM input number, as a string). */
	id: string;
	/** Number shown on the key face. */
	n: number | string;
	/** Source-provided label — used for a11y and the picker, not drawn on the key. */
	label: string;
	/** Resolved key state (live / preview / idle). */
	state: InputState;
}

/** A tally light — already resolved to a device LED state by the mapper. */
export interface BoardLight {
	/** Full MAC — identity for commands & keys. */
	mac: string;
	/** Short 2-octet MAC shown on the light. */
	label: string;
	/** The input column this light sits in, or null when unassigned (dock). */
	inputId: string | null;
	/** Resolved LED state (live / preview / idle / setup / offline / fault). */
	state: LightState;
	/** Per-device LED brightness as the protocol byte (0–255). */
	brightness: number;
	/** Transport currently carrying the device — `"usb"` shows the wired indicator. */
	transport: DeviceTransport;
	/** Persisted "when unplugged" mode; null until the device is provisioned. */
	provisionedMode: TransportMode | null;
	/** SSID the device is provisioned to join, or null. */
	ssid: string | null;
	/** Live WiFi join progress while provisioning over USB, or null. */
	wifiState: DeviceWifiState | null;
	/** Last reported RSSI (dBm) while provisioning over USB, or null. */
	rssi: number | null;
	/**
	 * Protocol version from the device's HELLO, or null if it has never connected.
	 * Gates the v1.3 affordances (the ESP-NOW transport row + bridge designation only
	 * appear for firmware reporting ≥ 3).
	 */
	protocolVersion: number | null;
	/** True while this device is the designated, device-confirmed ESP-NOW bridge. */
	bridge: boolean;
	/**
	 * The light's firmware is older than the firmware this app ships, so its menu offers an
	 * update. Decided by `firmwareOutdated` in `$lib/flasher/flasher.ts` from the device's
	 * `firmware` against the bundled version.
	 */
	firmwareOutdated: boolean;
	/**
	 * The firmware version the light reported, or null when it hasn't reported one (firmware
	 * older than 1.1 never does, and a light not heard from yet hasn't).
	 */
	firmwareVersion: string | null;
	/** The firmware version an update would install (this app's), when known. */
	firmwareAvailable: string | null;
}

/**
 * What a light's menu can do, keyed by the light's MAC. The board hands one of these to every
 * light's picker, so each rule (e.g. the bridge toggle's mac-or-null) is written once.
 */
export interface LightActions {
	assign?: (mac: string, inputId: string) => void;
	unassign?: (mac: string) => void;
	/** Flash-to-identify. */
	flash?: (mac: string) => void;
	/** Set a device's LED brightness (protocol byte, 0–255). */
	setBrightness?: (mac: string, value: number) => void;
	/** Provision a device's Wi-Fi (persist creds; save-only — no live join). */
	provisionWifi?: (mac: string, ssid: string, pass: string) => void;
	/** Set a device's unplugged transport mode. */
	setTransport?: (mac: string, mode: TransportMode) => void;
	/** Designate (mac) / un-designate (null) the ESP-NOW bridge device. */
	setBridge?: (mac: string | null) => void;
	/** Open the firmware updater for this light (the flasher drawer). */
	updateFirmware?: (mac: string) => void;
}
