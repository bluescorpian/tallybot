// The mock backend: a stand-in for the engine (sidecar) and the Rust shell in a plain browser
// (`pnpm dev`, the design preview and the `?demo=` states), so the board renders and every flow
// can be walked without hardware. Same `Backend` contract as `LiveBackend` ($lib/live.svelte.ts).
//
// Built from the page's URL params:
// `?demo=` presets put the mock board in a state worth previewing without hardware:
//   hero        — the README screenshot (see HERO_DEVICES below)
//   firstrun    — no ATEM saved, no lights: the scaffold + the "No lights yet" hint
//   unreachable — a saved ATEM that never answers: the banner lands after the real delay
//   unflashed   — a blank board (no TallyBot firmware) on USB: the notice whose
//                 "Set up as a light" opens the in-app flasher drawer
//   outdated    — two lights on older firmware (1.0.1): A4:F2 (11:22) wired + live on Cam 1 (the
//                 "goes dark while live" warning), B2:5A (ee:ff) wireless on Cam 4 (plug-in step);
//                 each shows the update badge, and an "Update firmware" row in its menu
//   update      — a newer TallyBot (the next minor) is out: the titlebar pill, the update dialog
//                 (download → restart now / later), and Settings → About → Updates
//   newerfw     — unflashed + outdated + update together: the flasher's review step says that
//                 TallyBot ships newer firmware and offers "Update TallyBot first"
//   enginedown  — the sidecar crashed and is restarting: the error notice + dimmed board
// `?fail=noresponse|busy|unplugged|wrongchip|rejoin` makes the next flash fail that way (a retry
// succeeds);
// `?fail=bridge` makes the flasher's "Apply settings" stage fail once when the light was set
// to be the bridge;
// `?fail=download` makes the app-update download fail once; `?fail=wronglight` plugs the
// wrong light in first while the flasher waits for a wireless one.
// `?wifi=connected|weak|joining|failed` sets the wired A4:F2 light's live join state,
// shown on its Configure → Wi-Fi page.
import { untrack } from "svelte";
import type { AppState, Device, DeviceFirmware, Input, Tally, TransportMode } from "$ipc";
import type { Backend, BoardHealth } from "$lib/backend";
import type { FlashSession } from "$lib/flasher/session.svelte";
import type { LightSettings } from "$lib/components/flasher/FlasherDialog.svelte";
import type { FlashFailure } from "$lib/flasher/flasher";
import { MockFlasher } from "./flasher.svelte";
import { MockUpdater } from "./updater.svelte";

type SourceMode = "connected" | "connecting" | "disconnected" | "unconfigured" | "no-inputs";

/**
 * A mock board on USB with no TallyBot firmware, and the light it used to be (null for a
 * brand-new board). As under Tauri, a light an interrupted install left blank isn't a light on
 * USB any more: it's a blank board (its light stays on the board, offline, assignment kept).
 */
type MockBlank = { port: string; mac: string | null };

// The firmware a mock light starts on when the demo shows outdated lights. A mock light with
// no version given starts on the bundled firmware (set in the constructor).
const MOCK_OLD_FIRMWARE: DeviceFirmware = { kind: "reported", version: "1.0.1" };

function mock(
	mac: string,
	macTail: string,
	state: Device["state"],
	inputId: number | null,
	opts: Partial<
		Pick<
			Device,
			"transport" | "provisionedMode" | "ssid" | "wifiState" | "rssi" | "protocolVersion" | "bridge" | "firmware"
		>
	> = {},
): Device {
	return {
		mac,
		macTail,
		state,
		inputId,
		brightness: 128,
		protocolVersion: opts.protocolVersion ?? (opts.transport === "usb" ? 2 : 1),
		firmware: opts.firmware ?? { kind: "unknown" },
		transport: opts.transport ?? "wifi",
		provisionedMode: opts.provisionedMode ?? null,
		ssid: opts.ssid ?? null,
		wifiState: opts.wifiState ?? null,
		rssi: opts.rssi ?? null,
		bridge: opts.bridge ?? false,
	};
}

// `?demo=hero`: one Wi-Fi light per input and nothing unassigned, the README screenshot
// (scripts/readme-screenshot.sh) captures that board.
const HERO_DEVICES = (): Device[] => [
	mock("7b:1c:01:00:33:44", "7B:1C", "assigned", 1),
	mock("3e:90:01:00:55:66", "3E:90", "assigned", 2),
	mock("c1:08:01:00:77:88", "C1:08", "assigned", 3),
	mock("b2:5a:01:00:ee:ff", "B2:5A", "assigned", 4),
];

/**
 * The default rig. Covers every light state: assigned-to-live, assigned-to-preview,
 * assigned-to-idle, offline, and unassigned (dock → setup). When the source drops, the assigned
 * lights flash FAULT (their input tally goes `unknown`), not idle.
 * Wired over USB (transport "usb") to exercise v1.2 + v1.3 configuration:
 *   A4:F2 — assigned + already provisioned for Wi-Fi (the reconfigure path)
 *   D2:44 — docked + never provisioned (the first-time Configure path)
 *   F0:0D — docked v3 device designated as the ESP-NOW bridge (the bridge toggle)
 * And one ESP-NOW light (transport "espnow") relayed through that bridge.
 */
function rigDevices(showOutdated: boolean, wifiDemo: string | null): Device[] {
	return [
		mock("a4:f2:01:00:11:22", "A4:F2", "assigned", 1, {
			transport: "usb",
			firmware: showOutdated ? MOCK_OLD_FIRMWARE : undefined,
			provisionedMode: "wifi",
			ssid: "GreenRoom-5G",
			wifiState: wifiDemo === "weak" ? "connected" : ((wifiDemo as Device["wifiState"]) ?? null),
			rssi: wifiDemo === "weak" ? -76 : -61,
		}),
		mock("7b:1c:01:00:33:44", "7B:1C", "assigned", 1),
		mock("3e:90:01:00:55:66", "3E:90", "assigned", 2),
		mock("c1:08:01:00:77:88", "C1:08", "offline", 3),
		mock("b2:5a:01:00:ee:ff", "B2:5A", "assigned", 4, {
			transport: "espnow",
			firmware: showOutdated ? MOCK_OLD_FIRMWARE : undefined,
			provisionedMode: "espnow",
			protocolVersion: 3,
		}),
		mock("d2:44:01:00:99:aa", "D2:44", "unassigned", null, { transport: "usb", wifiState: "idle" }),
		mock("f0:0d:01:00:bb:cc", "F0:0D", "unassigned", null, {
			transport: "usb",
			provisionedMode: "notx",
			protocolVersion: 3,
			bridge: true,
		}),
		mock("9f:31:01:00:bb:cc", "9F:31", "unassigned", null),
	];
}

const RIG_INPUTS = [
	{ id: 1, label: "Cam 1 — Wide" },
	{ id: 2, label: "Cam 2 — Close" },
	{ id: 3, label: "Cam 3 — Floor" },
	{ id: 4, label: "Laptop" },
];
const LIVE_TALLIES: Tally[] = ["live", "preview", "idle", "idle"];

export class MockBoard implements Backend {
	readonly flasher: MockFlasher;
	readonly updater: MockUpdater;
	readonly engine = null;
	readonly notices = [];
	dismissNotice() {}
	readonly engineDown: boolean;

	/** ATEM source lifecycle. */
	sourceMode = $state<SourceMode>("connected");
	/** OBS override active? (hidden source in v1) */
	override = $state(false);
	/** Mutable so assign / unassign and the flasher's effects stay interactive. */
	devices = $state<Device[]>([]);
	#unflashed = $state<MockBlank[]>([]);
	// A board whose cable came out mid-install: off USB until the mock "replugs" it.
	#pulled = $state<MockBlank | null>(null);
	// `?fail=wronglight`: the label of a different light plugged in while waiting for another.
	#wrong = $state<string | null>(null);
	#wrongOnce: boolean;
	#bridgeFailOnce: boolean;
	#connectTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(params: URLSearchParams) {
		const demo = params.get("demo");
		const fail = params.get("fail");
		this.engineDown = demo === "enginedown";
		this.sourceMode = demo === "firstrun" ? "unconfigured" : demo === "unreachable" ? "disconnected" : "connected";
		this.#wrongOnce = fail === "wronglight";
		this.#bridgeFailOnce = fail === "bridge";
		this.updater = new MockUpdater({
			available: demo === "update" || demo === "newerfw",
			failDownload: fail === "download",
		});
		// The flasher ships the firmware bundled with this app, which a mock app update replaces.
		this.flasher = new MockFlasher({
			failOnce: (
				{
					noresponse: "no-response",
					busy: "port-busy",
					unplugged: "unplugged",
					wrongchip: "wrong-chip",
					rejoin: "rejoin",
				} as const
			)[fail as "noresponse" | "busy" | "unplugged" | "wrongchip" | "rejoin"] as FlashFailure | undefined,
			bundled: () => this.updater.bundledFirmware,
			boardMac: (port) => this.#unflashed.find((b) => b.port === port)?.mac ?? null,
		});
		const devices =
			demo === "hero"
				? HERO_DEVICES()
				: demo === "firstrun"
					? []
					: rigDevices(demo === "outdated" || demo === "newerfw", params.get("wifi"));
		// Mock lights with no version given run the bundled firmware (unknown when none is bundled).
		for (const d of devices) {
			if (d.firmware.kind !== "reported") d.firmware = this.#bundledFirmware();
		}
		this.devices = devices;
		if (demo === "unflashed" || demo === "newerfw") this.#unflashed = [{ port: "COM5", mac: null }];
	}

	// Inputs come from the source. When the source is down the sidecar can't trust any of them
	// → tally `unknown` (the mapper turns that into idle keys + fault lights). When up, a
	// representative live / preview / idle spread. First run (unconfigured) and the
	// connected-but-no-inputs anomaly have NO inputs; every other mode has the rig's inputs
	// (retained, so connecting / disconnected keep the layout with tally `unknown` → fault lights).
	readonly #inputs = $derived.by<Input[]>(() => {
		const mode = this.sourceMode;
		if (mode === "unconfigured" || mode === "no-inputs") return [];
		return RIG_INPUTS.map((i, idx) => ({ ...i, tally: mode === "connected" ? LIVE_TALLIES[idx] : "unknown" }));
	});

	// Unconfigured = no IP saved yet (first run); every other mode keeps the IP so the chip can
	// show "Reconnecting…" against a known source.
	readonly state = $derived.by<AppState>(() => {
		const mode = this.sourceMode;
		return {
			source: {
				kind: "atem",
				ip: mode === "unconfigured" ? null : "192.168.10.240",
				connection:
					mode === "connected" || mode === "no-inputs"
						? "connected"
						: mode === "connecting"
							? "connecting"
							: "disconnected",
			},
			inputs: this.#inputs,
			devices: this.devices,
			programGate: { active: this.override, source: null },
			faults: [],
		};
	});

	// Off Tauri there's no shell; the mock's blank boards stand in for its health snapshot.
	readonly health = $derived.by<BoardHealth>(() => ({
		sidecarDown: this.engineDown ? "exit code 1" : null,
		usbPortErrors: [],
		unflashedPorts: this.#unflashed.map((b) => b.port),
		lightPorts: [],
		blankLights: this.#unflashed.flatMap((b) => (b.mac === null ? [] : [{ mac: b.mac, port: b.port }])),
		configDirMissing: null,
	}));
	get unflashedPorts() {
		return this.health.unflashedPorts;
	}
	get blankLights() {
		return this.health.blankLights;
	}
	get wrongLight() {
		return this.#wrong;
	}

	start(): () => void {
		return () => clearTimeout(this.#connectTimer);
	}

	// ── Commands: mutate the mock device list the engine would normally own ──
	#find(mac: string) {
		return this.devices.find((x) => x.mac === mac || x.macTail === mac);
	}
	assign(mac: string, inputId: number) {
		const d = this.#find(mac);
		if (d) {
			d.inputId = inputId;
			d.state = "assigned";
		}
	}
	unassign(mac: string) {
		const d = this.#find(mac);
		if (d) {
			d.inputId = null;
			d.state = "unassigned";
		}
	}
	/** The board already echoes a local blink; there's no light to stream to. */
	identify() {}
	setBrightness(mac: string, brightness: number) {
		const d = this.#find(mac);
		if (d) d.brightness = brightness;
	}
	// Save-only, as on the device: SET_WIFI persists the credentials and the device confirms at
	// once (no live join), so the provisioned mode shows straight away.
	provisionWifi(mac: string, ssid: string) {
		const d = this.#find(mac);
		if (!d) return;
		d.provisionedMode = "wifi";
		d.ssid = ssid;
	}
	setTransport(mac: string, mode: TransportMode) {
		const d = this.#find(mac);
		if (!d) return;
		if (mode === "wifi") {
			d.provisionedMode = "wifi";
		} else {
			// No-TX and ESP-NOW both commit inline with no credentials (ESP-NOW gets tally from a
			// bridge, not a network), so neither carries an SSID.
			d.provisionedMode = mode;
			d.ssid = null;
		}
	}
	// One bridge per session: designating a new MAC clears the previous one (the sidecar enforces
	// this; the mock mirrors it so the marker moves as expected).
	setBridge(mac: string | null) {
		for (const d of this.devices) d.bridge = d.mac === mac || d.macTail === mac;
	}
	/** Saving a source animates the connect locally. */
	setSource() {
		this.sourceMode = "connecting";
		clearTimeout(this.#connectTimer);
		this.#connectTimer = setTimeout(() => (this.sourceMode = "connected"), 1600);
	}
	/** The mock source has no dev mode. */
	setProgram() {}
	openExternal(url: string) {
		window.open(url, "_blank");
	}

	/** The shell would know each cabled light's port; the mock numbers them from COM7. */
	portOf(mac: string): string | null {
		const wired = this.devices.filter((d) => d.transport === "usb");
		const i = wired.findIndex((d) => d.mac === mac);
		return i < 0 ? null : `COM${7 + i}`;
	}

	/** Applying the Settings step takes a moment; `?fail=bridge` makes the bridge role not take once. */
	async prepareSettings(s: LightSettings): Promise<{ bridgeTakes: boolean }> {
		await new Promise((r) => setTimeout(r, 1600));
		if (!s.bridge || !this.#bridgeFailOnce) return { bridgeTakes: true };
		this.#bridgeFailOnce = false;
		return { bridgeTakes: false };
	}

	/**
	 * Stand in for the engine and the shell while the flasher works: boards arriving on USB and
	 * lights dropping off and coming back. Returns the cleanup.
	 */
	simulate(session: FlashSession): () => void {
		return $effect.root(() => {
			// Opened with nothing plugged in, a blank board "arrives" after a few seconds.
			$effect(() => {
				if (!session.open || session.request?.kind !== "any" || session.candidates.length) return;
				const t = setTimeout(() => (this.#unflashed = [...this.#unflashed, { port: "COM6", mac: null }]), 3500);
				return () => clearTimeout(t);
			});

			// A board the user was asked to plug in (a wireless light, or one whose cable came out)
			// "arrives" over USB after a moment.
			$effect(() => {
				const job = session.job;
				// only while the drawer is asking for it, not on the failure screen
				if (!session.open || !job || job.port !== null || this.flasher.state.status !== "idle") return;
				const mac = job.mac;
				const plugIn = () => {
					this.#wrong = null;
					if (this.#pulled) {
						this.#unflashed = [...this.#unflashed, this.#pulled];
						this.#pulled = null;
						return;
					}
					// a light left blank comes back as a blank board, never as the light (as under Tauri)
					if (this.#unflashed.some((b) => b.mac === mac)) return;
					const d = this.devices.find((x) => x.mac === mac);
					if (d) d.transport = "usb";
				};
				if (this.#wrongOnce && job.kind === "light") {
					// `?fail=wronglight`: someone grabs the wrong unit first, then the right one
					this.#wrongOnce = false;
					const t1 = setTimeout(() => (this.#wrong = "77:88"), 2500);
					const t2 = setTimeout(plugIn, 6500);
					return () => (clearTimeout(t1), clearTimeout(t2));
				}
				const t = setTimeout(plugIn, 3500);
				return () => clearTimeout(t);
			});

			// Mirror what the engine and the shell would report while a board is installed. A light
			// drops offline once its board starts erasing, and comes back (current firmware) when it
			// rejoins; a blank board leaves the unflashed list and lands in the dock as a new,
			// unassigned light, or as the light it used to be. An install stopped or broken
			// mid-erase/write leaves the board blank: a light's board leaves USB and turns up as an
			// unflashed port (the light stays offline, its assignment kept), or, if the cable came
			// out, once it's plugged back in. One stopped after the write already has its new firmware.
			$effect(() => {
				const s = this.flasher.state;
				untrack(() => this.#follow(s));
			});
		});
	}

	#bundledFirmware(): DeviceFirmware {
		const version = this.flasher.firmwareVersion;
		return version === null ? { kind: "unknown" } : { kind: "reported", version };
	}

	#follow(s: MockFlasher["state"]) {
		if (s.status === "idle") return;
		const t = s.target;
		const d = t.kind === "light" ? this.devices.find((x) => x.mac === t.mac) : undefined;
		const back = (x: Device | undefined) => {
			if (x) x.state = x.inputId !== null ? "assigned" : "unassigned";
		};
		if (s.status === "running" && d && s.stage !== "connect" && d.state !== "offline") {
			d.state = "offline";
		} else if (s.status === "done") {
			back(d);
			if (t.kind === "blank") {
				this.#unflashed = this.#unflashed.filter((b) => b.port !== t.port);
				const was = this.devices.find((x) => x.mac === s.mac);
				if (was) {
					was.transport = "usb";
					back(was);
				} else this.devices.push(mock(s.mac, "E7:5B", "unassigned", null, { transport: "usb", protocolVersion: 3 }));
			}
			const done = this.devices.find((x) => x.mac === s.mac);
			if (done) done.firmware = this.#bundledFirmware();
		} else if (s.status === "failed" || s.status === "cancelled") {
			const pulled = s.status === "failed" && s.failure === "unplugged";
			if (t.kind === "blank") {
				if (pulled) {
					this.#pulled = this.#unflashed.find((b) => b.port === t.port) ?? { port: t.port, mac: null };
					this.#unflashed = this.#unflashed.filter((b) => b.port !== t.port);
				}
				return;
			}
			if (!d) return;
			if (s.leavesBlank) {
				const blank = { port: t.port, mac: d.mac };
				d.transport = "wifi"; // what the engine reports for a light it can't reach
				if (pulled) this.#pulled = blank;
				else this.#unflashed = [...this.#unflashed, blank];
			} else if (s.stage !== "connect") {
				d.firmware = this.#bundledFirmware();
				back(d);
			}
		}
	}
}
