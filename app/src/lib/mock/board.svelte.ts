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
// `?espnow=` sets up Settings → ESP-NOW (by default the wired A4:F2 light runs firmware that can
// scan, so Scan runs on it):
//   bridge — only the bridge (F0:0D) can scan: the "rig may blink" warning before the click
//   noscan — nothing on USB can scan: Scan is disabled, with the reason
//   legacy — the rig is on channel 6; B2:5A runs firmware that can't follow a channel change and
//            C1:08 hasn't been seen since the update (both named when the channel changes), and
//            the wired D2:44 light is set up for ESP-NOW but stored channel 1 (its menu flags it)
import { untrack } from "svelte";
import type {
	AppState,
	BridgeTxPower,
	ChannelCongestion,
	Device,
	DeviceFirmware,
	Input,
	Tally,
	TransportMode,
	WifiAccessPoint,
	WifiScanEvent,
	WifiScanner,
} from "$ipc";
import { ESPNOW_CHANNEL, supportsChannelSelection } from "$protocol";
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
			| "transport"
			| "provisionedMode"
			| "ssid"
			| "wifiState"
			| "rssi"
			| "protocolVersion"
			| "bridge"
			| "firmware"
			| "espnowChannel"
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
		espnowChannel: opts.espnowChannel ?? null,
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
function rigDevices(showOutdated: boolean, wifiDemo: string | null, espnowDemo: string | null): Device[] {
	return [
		mock("a4:f2:01:00:11:22", "A4:F2", "assigned", 1, {
			transport: "usb",
			// firmware new enough to scan for a quiet ESP-NOW channel, unless the demo says otherwise
			protocolVersion: espnowDemo === "bridge" || espnowDemo === "noscan" ? 2 : 4,
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
		espnowDemo === "legacy"
			? mock("d2:44:01:00:99:aa", "D2:44", "unassigned", null, {
					transport: "usb",
					provisionedMode: "espnow",
					protocolVersion: 4,
					espnowChannel: ESPNOW_CHANNEL,
				})
			: mock("d2:44:01:00:99:aa", "D2:44", "unassigned", null, { transport: "usb", wifiState: "idle" }),
		mock("f0:0d:01:00:bb:cc", "F0:0D", "unassigned", null, {
			transport: "usb",
			provisionedMode: "notx",
			protocolVersion: espnowDemo === "bridge" ? 4 : 3,
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

/** What the mock's channel scan "hears": a busy low band, a quieter top. */
const MOCK_ACCESS_POINTS: WifiAccessPoint[] = [
	{ channel: 1, rssi: -48, ssid: "GreenRoom" },
	{ channel: 1, rssi: -63, ssid: "Venue-Guest" },
	{ channel: 3, rssi: -71, ssid: "" },
	{ channel: 6, rssi: -55, ssid: "GreenRoom-5G" },
	{ channel: 6, rssi: -80, ssid: "Bar POS" },
	{ channel: 11, rssi: -77, ssid: "Production" },
	{ channel: 9, rssi: -88, ssid: "DIRECT-printer" },
].sort((a, b) => b.rssi - a.rssi);
/**
 * What the sidecar's scorer (`channel-scan.ts`) makes of those access points, as [channel, score,
 * access points counted]. Copied rather than imported: that module's `.ts` import paths don't
 * type-check under the app's tsconfig.
 */
const MOCK_CONGESTION: ChannelCongestion[] = (
	[
		[1, 1.69, 3],
		[2, 2.61, 5],
		[3, 2.61, 5],
		[4, 2.61, 5],
		[5, 2.79, 6],
		[6, 1.51, 4],
		[7, 1.84, 5],
		[8, 1.43, 4],
		[9, 1.43, 4],
		[10, 1.43, 4],
		[11, 0.5, 2],
		[12, 0.5, 2],
		[13, 0.5, 2],
	] as const
).map(([channel, score, accessPoints]) => ({
	channel,
	score,
	accessPoints,
	candidate: [1, 6, 11, 13].includes(channel),
}));
/** The scorer's pick from {@link MOCK_CONGESTION}: the quietest of 1, 6, 11 and 13. */
const MOCK_SUGGESTED = 11;

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
	#scanTimer: ReturnType<typeof setTimeout> | undefined;

	/** Settings → ESP-NOW: the rig's channel and the bridge's power, as the engine would hold them. */
	espnowChannel = $state(ESPNOW_CHANNEL);
	bridgeTxPower = $state<BridgeTxPower>("full");
	#legacyLights: string[] = [];
	#unseenLights: string[] = [];
	wifiScan = $state<WifiScanEvent | null>(null);

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
					: rigDevices(demo === "outdated" || demo === "newerfw", params.get("wifi"), params.get("espnow"));
		// Mock lights with no version given run the bundled firmware (unknown when none is bundled).
		for (const d of devices) {
			if (d.firmware.kind !== "reported") d.firmware = this.#bundledFirmware();
		}
		this.devices = devices;
		if (params.get("espnow") === "legacy" && demo !== "hero" && demo !== "firstrun") {
			this.espnowChannel = 6;
			this.#legacyLights = ["b2:5a:01:00:ee:ff"];
			this.#unseenLights = ["c1:08:01:00:77:88"];
		}
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
			espnow: {
				channel: this.espnowChannel,
				bridgeTxPower: this.bridgeTxPower,
				legacyLights: this.#legacyLights,
				unseenLights: this.#unseenLights,
				scanner: this.#scanner,
			},
		};
	});

	// Chosen as the engine chooses: a cabled light new enough to scan that isn't the bridge, else
	// the bridge if it is cabled and new enough, else none.
	readonly #scanner = $derived.by<WifiScanner | null>(() => {
		const able = this.devices.filter(
			(d) => d.transport === "usb" && d.protocolVersion !== null && supportsChannelSelection(d.protocolVersion),
		);
		const light = able.find((d) => !d.bridge);
		if (light) return { mac: light.mac, bridge: false };
		const bridge = able.find((d) => d.bridge);
		return bridge ? { mac: bridge.mac, bridge: true } : null;
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
		return () => {
			clearTimeout(this.#connectTimer);
			clearTimeout(this.#scanTimer);
		};
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
		// the engine gives every light it sets up for ESP-NOW the rig's channel
		if (mode === "espnow") d.espnowChannel = this.espnowChannel;
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
	setEspNowChannel(channel: number) {
		this.espnowChannel = channel;
	}
	setBridgeTxPower(txPower: BridgeTxPower) {
		this.bridgeTxPower = txPower;
	}
	/** A scan takes a few seconds on the device; the mock answers with a fixed set of access points. */
	scanWifi() {
		if (this.wifiScan?.status === "scanning") return;
		const empty = { accessPoints: [], congestion: [], suggestedChannel: null };
		const scanner = this.#scanner;
		if (scanner === null) {
			this.wifiScan = {
				type: "wifiScan",
				status: "done",
				scanner,
				...empty,
				error: "The tally light on USB runs firmware too old to scan. Update its firmware, or plug in another light.",
			};
			return;
		}
		this.wifiScan = { type: "wifiScan", status: "scanning", scanner, ...empty, error: null };
		this.#scanTimer = setTimeout(() => {
			this.wifiScan = {
				type: "wifiScan",
				status: "done",
				scanner,
				accessPoints: MOCK_ACCESS_POINTS,
				congestion: MOCK_CONGESTION,
				suggestedChannel: MOCK_SUGGESTED,
				error: null,
			};
		}, 3000);
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
