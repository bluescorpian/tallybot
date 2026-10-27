// The flasher session: what the flasher drawer is working on and the rules around it, for the
// page to compose. It turns a request ("this light", "that blank board", "whatever's on USB")
// into the `FlashJob` the dialog shows, resolved from live state so a wireless light gains its
// port the moment it's plugged in; lists the boards the titlebar entry offers; decides which
// lights are offered an update; applies the Settings step once the light is back; and parks a
// job behind "Update TallyBot first".
//
// It runs against either backend (the sidecar and the shell, or the mock board) through
// `FlashBackend`, and either driver through `Flasher` and `Updater`.
import type { AppState, Device, DeviceFirmware, TransportMode } from "$ipc";
import type { FlashCandidate, FlashJob, LightSettings } from "$lib/components/flasher/FlasherDialog.svelte";
import type { InstallPill } from "$lib/components/chrome/TitleBar.svelte";
import { shortMac } from "$lib/boardState";
import { FLASH_STAGES, firmwareOutdated, type FlashStage, type Flasher } from "./flasher";
import { newerFirmwareUpdate, type Updater } from "../updater/updater";

/** What the operator asked to flash. "any" = opened from the titlebar: the dialog lists what's on USB. */
export type FlashRequest = { kind: "any" } | { kind: "blank"; port: string } | { kind: "light"; mac: string };

/** What the session reads from, and sends through, the engine and the shell. */
export interface FlashBackend {
	readonly state: AppState;
	/** Ports holding a board with no TallyBot firmware (the shell's health). */
	readonly unflashedPorts: readonly string[];
	/** The USB port a light is on, or null when it isn't plugged in. */
	portOf(mac: string): string | null;
	/** A different light that turned up on USB while waiting for another (its label), if known. */
	readonly wrongLight?: string | null;
	assign(mac: string, inputId: number): void;
	unassign(mac: string): void;
	setBrightness(mac: string, brightness: number): void;
	provisionWifi(mac: string, ssid: string, password: string): void;
	setTransport(mac: string, mode: TransportMode): void;
	setBridge(mac: string | null): void;
	/**
	 * Called before the Settings step is applied: resolves once the light is ready for them, and
	 * says whether it takes the bridge role. Optional: the live engine's commands are
	 * fire-and-forget, so it has nothing to wait for and no way to tell.
	 */
	prepareSettings?(s: LightSettings): Promise<{ bridgeTakes: boolean }>;
}

/** How much of an install each stage is, for the titlebar pill's progress. */
const STAGE_WEIGHT = {
	connect: 0.05,
	erase: 0.1,
	write: 0.65,
	verify: 0.07,
	restart: 0.05,
	rejoin: 0.08,
} satisfies Record<FlashStage, number>;

export class FlashSession {
	/** What the drawer is working on; kept after it closes so a running install can be reopened. */
	request = $state<FlashRequest | null>(null);
	open = $state(false);
	/** A job parked by "Update TallyBot first", offered again once the app is updated. */
	resume = $state<FlashRequest | null>(null);

	readonly #flasher: Flasher;
	readonly #updater: Updater;
	readonly #backend: FlashBackend;
	readonly #openUpdater: () => void;

	/** `openUpdater` opens the app-update dialog (for "Update TallyBot first" with nothing downloaded). */
	constructor(flasher: Flasher, updater: Updater, backend: FlashBackend, openUpdater: () => void) {
		this.#flasher = flasher;
		this.#updater = updater;
		this.#backend = backend;
		this.#openUpdater = openUpdater;
	}

	/**
	 * A build that bundles no firmware (a dev build without `pnpm firmware:stage`) offers no
	 * flasher: blank boards point at the web flasher, as before the in-app one existed.
	 */
	get ready(): boolean {
		return this.#flasher.firmwareVersion !== null;
	}

	/** One install at a time: while one runs, anything that would restart the engine waits. */
	get running(): boolean {
		return this.#flasher.state.status === "running";
	}

	/** What firmware a light runs, and the version it reported, if any. */
	firmware(d: Device): { firmware: DeviceFirmware; version: string | null } {
		return { firmware: d.firmware, version: d.firmware.kind === "reported" ? d.firmware.version : null };
	}

	/** Whether a light runs older firmware than this app ships, so an app update re-badges lights. */
	outdated(d: Device): boolean {
		return firmwareOutdated(this.#flasher.firmwareVersion, d.firmware);
	}

	readonly job = $derived.by<FlashJob | null>(() => {
		const r = this.request;
		const b = this.#backend;
		if (!r || r.kind === "any") return null;
		if (r.kind === "blank")
			return {
				kind: "blank",
				port: b.unflashedPorts.includes(r.port) ? r.port : null,
				mac: null,
				label: null,
				fromVersion: null,
				wrongLight: null,
				input: null,
			};
		const d = b.state.devices.find((x) => x.mac === r.mac);
		if (!d) return null;
		const input = b.state.inputs.find((i) => i.id === d.inputId);
		return {
			kind: "light",
			port: b.portOf(d.mac),
			mac: d.mac,
			label: shortMac(d.mac),
			fromVersion: this.firmware(d).version,
			wrongLight: b.wrongLight ?? null,
			input: input ? { label: input.label, live: input.tally === "live" } : null,
		};
	});

	/** What's on USB for the titlebar entry to choose from: blank boards, then cabled lights. */
	readonly candidates = $derived.by<FlashCandidate[]>(() => [
		...this.#backend.unflashedPorts.map((port) => ({
			kind: "blank" as const,
			port,
			mac: null,
			label: null,
			version: null,
			outdated: false,
		})),
		...this.#backend.state.devices.flatMap((d) => {
			const port = this.#backend.portOf(d.mac);
			if (port === null) return [];
			return [
				{
					kind: "light" as const,
					port,
					mac: d.mac,
					label: shortMac(d.mac),
					version: this.firmware(d).version,
					outdated: this.outdated(d),
				},
			];
		}),
	]);

	/** The Settings step's prefill: the light's settings as they are now (null for a blank board). */
	readonly currentSettings = $derived.by<LightSettings | null>(() => {
		const r = this.request;
		const d = r?.kind === "light" ? this.#backend.state.devices.find((x) => x.mac === r.mac) : undefined;
		if (!d) return null;
		return {
			transport: d.provisionedMode ?? "notx",
			ssid: d.ssid ?? "",
			password: "",
			bridge: d.bridge ?? false,
			inputId: d.inputId === null ? null : String(d.inputId),
			brightness: d.brightness,
		};
	});

	/** A newer TallyBot whose firmware is newer than this app's, for the review's "update first". */
	readonly newerUpdate = $derived.by(() => newerFirmwareUpdate(this.#updater.state, this.#flasher.firmwareVersion));

	/**
	 * An install keeps going with its drawer hidden: a titlebar pill shows its progress and
	 * reopens the drawer.
	 */
	readonly installPill = $derived.by<InstallPill | null>(() => {
		const s = this.#flasher.state;
		if (s.status !== "running" || this.open) return null;
		let progress = 0;
		for (const stage of FLASH_STAGES) {
			if (stage === s.stage) {
				if (stage === "write") progress += STAGE_WEIGHT.write * s.progress;
				break;
			}
			progress += STAGE_WEIGHT[stage];
		}
		const label = s.target.kind === "blank" ? "Setting up light" : `Updating ${s.target.label}`;
		return { label, progress };
	});

	/** Open the drawer on `r`. While an install runs its target is fixed: this just reopens its progress. */
	openFlasher = (r: FlashRequest): void => {
		if (!this.running) this.request = r;
		this.open = true;
	};

	pick = (c: FlashCandidate): void => {
		this.openFlasher(c.kind === "blank" || !c.mac ? { kind: "blank", port: c.port } : { kind: "light", mac: c.mac });
	};

	/**
	 * Apply the Settings step once the light is back, through the same commands its Configure
	 * pane sends, in this order: input, brightness, Wi-Fi or transport, bridge. Resolves to an
	 * error message, or null.
	 */
	applySettings = async (mac: string, s: LightSettings): Promise<string | null> => {
		const b = this.#backend;
		const { bridgeTakes } = (await b.prepareSettings?.(s)) ?? { bridgeTakes: true };
		if (s.inputId === null) b.unassign(mac);
		else b.assign(mac, Number(s.inputId));
		b.setBrightness(mac, s.brightness);
		if (s.transport === "wifi" && s.ssid) b.provisionWifi(mac, s.ssid, s.password);
		else b.setTransport(mac, s.transport);
		if (!s.bridge) return null;
		if (!bridgeTakes)
			return `${shortMac(mac).toUpperCase()} didn't start bridging, so no-Wi-Fi lights have no bridge. Its other settings are applied.`;
		b.setBridge(mac);
		return null;
	};

	/** "Update TallyBot first" parks the job; the "updated" notice offers to pick it back up. */
	updateAppFirst = (): void => {
		this.resume = this.request;
		this.open = false;
		if (this.#updater.state.status === "ready") this.#updater.restart();
		else this.#openUpdater();
	};

	/** Pick the parked job back up. */
	resumeParked = (): void => {
		const r = this.resume;
		this.resume = null;
		if (r) this.openFlasher(r);
	};
}
