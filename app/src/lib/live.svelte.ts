// The live backend (under Tauri): the sidecar connection ($lib/ipc.svelte), the shell's health,
// espflash in the shell and the Tauri updater plugin. The mock is $lib/mock/board.svelte.ts.
import type { AppState, TransportMode } from "$ipc";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Backend, EngineControls } from "$lib/backend";
import { autostart, sidecar } from "$lib/ipc.svelte";
import { TauriFlasher } from "$lib/flasher/tauri.svelte";
import { TauriUpdater } from "$lib/updater/tauri.svelte";

// What the board shows before the first snapshot lands: an unconfigured source.
const EMPTY_STATE: AppState = {
	source: { kind: "atem", ip: null, connection: "disconnected" },
	inputs: [],
	devices: [],
	programGate: { active: false, source: null },
	faults: [],
};

export class LiveBackend implements Backend {
	readonly flasher = new TauriFlasher();
	readonly updater = new TauriUpdater();

	get state(): AppState {
		return sidecar.state ?? EMPTY_STATE;
	}
	get health() {
		return sidecar.health;
	}
	get unflashedPorts() {
		return sidecar.health.unflashedPorts;
	}
	get blankLights() {
		return sidecar.health.blankLights;
	}
	get engineDown() {
		return sidecar.stale;
	}
	get notices() {
		return sidecar.notices;
	}
	dismissNotice(id: number) {
		sidecar.dismissNotice(id);
	}
	readonly engine: EngineControls = {
		get source() {
			return sidecar.state?.source ?? EMPTY_STATE.source;
		},
		get scan() {
			return sidecar.scan;
		},
		restart: () => sidecar.restart(),
		scanSources: () => sidecar.scanSources(),
		autostart,
	};

	start(): () => void {
		void sidecar.start();
		void this.updater.init();
		void this.flasher.init();
		return () => sidecar.stop();
	}

	portOf(mac: string): string | null {
		return sidecar.health.lightPorts.find((l) => l.mac === mac)?.port ?? null;
	}
	assign(mac: string, inputId: number) {
		sidecar.assignDevice(mac, inputId);
	}
	unassign(mac: string) {
		sidecar.unassignDevice(mac);
	}
	identify(mac: string) {
		sidecar.identifyDevice(mac);
	}
	setBrightness(mac: string, brightness: number) {
		sidecar.setBrightness(mac, brightness);
	}
	provisionWifi(mac: string, ssid: string, password: string) {
		sidecar.provisionWifi(mac, ssid, password);
	}
	setTransport(mac: string, mode: TransportMode) {
		sidecar.setTransport(mac, mode);
	}
	setBridge(mac: string | null) {
		sidecar.setBridge(mac);
	}
	setSource(ip: string) {
		sidecar.setSource(ip);
	}
	setProgram(inputId: number) {
		sidecar.setProgram(inputId);
	}
	openExternal(url: string) {
		void openUrl(url);
	}
}
