<script lang="ts">
	// Main view — the assembled board (DESIGN.md). The locked <Board> is driven by
	// a view-model produced from an IPC `AppState` (sidecar/src/ipc.ts) via the
	// $lib/boardState.ts mapper, exactly as the real engine feeds it.
	//
	// Under Tauri the AppState is the LIVE snapshot stream from the sidecar (via
	// $lib/ipc.svelte); in a plain browser (pnpm dev, the /preview design workflow)
	// there's no sidecar, so the page falls back to the Phase-4 MOCK below — same
	// shape, local data — so the board still renders and design iteration works.
	import { onMount, onDestroy, untrack } from "svelte";
	import type { AppState, Device, Input, Tally } from "$ipc";
	import Board from "$lib/components/board/Board.svelte";
	import { sidecarLost, toBoardProps } from "$lib/boardState";
	import { autostart, sidecar, isTauri } from "$lib/ipc.svelte";
	import { openUrl } from "@tauri-apps/plugin-opener";
	import { fly } from "svelte/transition";
	import Info from "@lucide/svelte/icons/info";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import X from "@lucide/svelte/icons/x";
	import SettingsSheet from "$lib/components/settings/SettingsSheet.svelte";
	import TitleBar from "$lib/components/chrome/TitleBar.svelte";
	import Credit from "$lib/components/chrome/Credit.svelte";
	import FlasherDialog, {
		type FlashCandidate,
		type FlashJob,
		type LightSettings,
	} from "$lib/components/flasher/FlasherDialog.svelte";
	import UpdateDialog from "$lib/components/updates/UpdateDialog.svelte";
	import type { InstallPill, UpdatePill } from "$lib/components/chrome/TitleBar.svelte";
	import { MockFlasher } from "$lib/mock/flasher.svelte";
	import { TauriFlasher } from "$lib/flasher/tauri.svelte";
	import { leavesBlank, type FlashFailure, type Flasher } from "$lib/flasher/flasher";
	import { MockUpdater } from "$lib/mock/updater.svelte";
	import { TauriUpdater } from "$lib/updater/tauri.svelte";
	import { downloadProgress, isNewer, newerFirmwareUpdate, type Updater } from "$lib/updater/updater";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";

	// ── Live wiring (Tauri) ────────────────────────────────────────────────────
	onMount(() => void sidecar.start());
	onDestroy(() => sidecar.stop());

	// What the board shows before the first snapshot lands: an unconfigured source.
	const EMPTY_STATE: AppState = {
		source: { kind: "atem", ip: null, connection: "disconnected" },
		inputs: [],
		devices: [],
		programGate: { active: false, source: null },
	};

	// ── Mock source state (non-Tauri fallback) ─────────────────────────────────
	type SourceMode =
		| "connected"
		| "connecting"
		| "disconnected"
		| "unconfigured"
		| "no-inputs";
	// `?demo=` presets put the mock board in a state worth previewing without hardware:
	//   hero        — the README screenshot (see HERO_DEVICES below)
	//   firstrun    — no ATEM saved, no lights: the scaffold + the "No lights yet" hint
	//   unreachable — a saved ATEM that never answers: the banner lands after the real delay
	//   unflashed   — a blank board (no TallyBot firmware) on USB: the notice whose
	//                 "Set up as a light" opens the in-app flasher drawer
	//   outdated    — two lights on older firmware (1.0.1): A4:F2 (11:22) wired + live on Cam 1 (the
	//                 "goes dark while live" warning), B2:5A (ee:ff) wireless on Cam 4 (plug-in step);
	//                 each shows the update badge, and an "Update firmware" row in its menu
	//   update      — a newer TallyBot (1.1.0) is out: the titlebar pill, the update dialog
	//                 (download → restart now / later), and Settings → About → Updates
	//   newerfw     — unflashed + outdated + update together: the flasher's review step says
	//                 TallyBot 1.1.0 ships newer firmware and offers "Update TallyBot first"
	//   enginedown  — the sidecar crashed and is restarting: the error notice + dimmed board
	// `?fail=noresponse|busy|unplugged` makes the next flash fail that way (a retry succeeds);
	// `?fail=bridge` makes the flasher's "Apply settings" stage fail once when the light was set
	// to be the bridge;
	// `?fail=download` makes the app-update download fail once; `?fail=wronglight` plugs the
	// wrong light in first while the flasher waits for a wireless one.
	// `?wifi=connected|weak|joining|failed` sets the wired A4:F2 light's live join state,
	// shown on its Configure → Wi-Fi page.
	const params = new URLSearchParams(location.search);
	const demo = params.get("demo");
	let sourceMode = $state<SourceMode>(
		demo === "firstrun" ? "unconfigured" : demo === "unreachable" ? "disconnected" : "connected",
	); // ATEM source lifecycle
	let override = $state(false); // OBS override active? (hidden source in v1)
	let settingsOpen = $state(false); // settings drawer (Sheet) open?
	const showOutdated = demo === "outdated" || demo === "newerfw";
	const fail = params.get("fail");

	// Only a fully connected source can be trusted; everything else greys the
	// board (keys idle, gate inert, assigned lights flash fault).
	const connected = $derived(sourceMode === "connected");

	// Mock devices — mutable so assign / unassign stay interactive. Covers every
	// light state: assigned-to-live, assigned-to-preview, assigned-to-idle,
	// offline, and unassigned (dock → setup). When the source drops, the assigned
	// lights flash FAULT (their input tally goes `unknown`), not idle.
	// Wired over USB (transport "usb") to exercise v1.2 + v1.3 configuration:
	//   A4:F2 — assigned + already provisioned for Wi-Fi (the reconfigure path)
	//   D2:44 — docked + never provisioned (the first-time Configure path)
	//   F0:0D — docked v3 device designated as the ESP-NOW bridge (the bridge toggle)
	// And one ESP-NOW light (transport "espnow") relayed through that bridge.
	// `?demo=hero` swaps in one Wi-Fi light per input and nothing unassigned: the
	// README screenshot (scripts/readme-screenshot.sh) captures that board.
	const HERO_DEVICES: Device[] = [
		mock("7b:1c:01:00:33:44", "7B:1C", "assigned", 1),
		mock("3e:90:01:00:55:66", "3E:90", "assigned", 2),
		mock("c1:08:01:00:77:88", "C1:08", "assigned", 3),
		mock("b2:5a:01:00:ee:ff", "B2:5A", "assigned", 4),
	];
	const wifiDemo = params.get("wifi");
	let devices = $state<Device[]>(demo === "hero" ? HERO_DEVICES : demo === "firstrun" ? [] : [
		mock("a4:f2:01:00:11:22", "A4:F2", "assigned", 1, {
			transport: "usb",
			firmwareOutdated: showOutdated,
			provisionedMode: "wifi",
			ssid: "GreenRoom-5G",
			wifiState:
				wifiDemo === "weak" ? "connected" : (wifiDemo as Device["wifiState"]) ?? null,
			rssi: wifiDemo === "weak" ? -76 : -61,
		}),
		mock("7b:1c:01:00:33:44", "7B:1C", "assigned", 1),
		mock("3e:90:01:00:55:66", "3E:90", "assigned", 2),
		mock("c1:08:01:00:77:88", "C1:08", "offline", 3),
		mock("b2:5a:01:00:ee:ff", "B2:5A", "assigned", 4, {
			transport: "espnow",
			firmwareOutdated: showOutdated,
			provisionedMode: "espnow",
			protocolVersion: 3,
		}),
		mock("d2:44:01:00:99:aa", "D2:44", "unassigned", null, {
			transport: "usb",
			wifiState: "idle",
		}),
		mock("f0:0d:01:00:bb:cc", "F0:0D", "unassigned", null, {
			transport: "usb",
			provisionedMode: "notx",
			protocolVersion: 3,
			bridge: true,
		}),
		mock("9f:31:01:00:bb:cc", "9F:31", "unassigned", null),
	]);

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
				| "firmwareOutdated"
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
			firmwareOutdated: opts.firmwareOutdated ?? false,
			transport: opts.transport ?? "wifi",
			provisionedMode: opts.provisionedMode ?? null,
			ssid: opts.ssid ?? null,
			wifiState: opts.wifiState ?? null,
			rssi: opts.rssi ?? null,
			bridge: opts.bridge ?? false,
		};
	}

	// Inputs come from the source. When the source is down the sidecar can't trust
	// any of them → tally `unknown` (the mapper turns that into idle keys + fault
	// lights). When up, a representative live / preview / idle spread.
	// First run (unconfigured) and the connected-but-no-inputs anomaly have NO
	// inputs; every other mode has the rig's inputs (retained, so connecting /
	// disconnected keep the layout with tally `unknown` → fault lights).
	const noInputs = $derived(
		sourceMode === "unconfigured" || sourceMode === "no-inputs",
	);
	const liveTallies: Tally[] = ["live", "preview", "idle", "idle"];
	const inputs = $derived<Input[]>(
		noInputs
			? []
			: [
					{ id: 1, label: "Cam 1 — Wide" },
					{ id: 2, label: "Cam 2 — Close" },
					{ id: 3, label: "Cam 3 — Floor" },
					{ id: 4, label: "Laptop" },
				].map((i, idx) => ({
					...i,
					tally: connected ? liveTallies[idx] : "unknown",
				})),
	);

	// Unconfigured = no IP saved yet (first run); every other mode keeps the IP so
	// the chip can show "Reconnecting…" against a known source.
	const mockState = $derived<AppState>({
		source: {
			kind: "atem",
			ip: sourceMode === "unconfigured" ? null : "192.168.10.240",
			connection:
				sourceMode === "connected" || sourceMode === "no-inputs"
					? "connected"
					: sourceMode === "connecting"
						? "connecting"
						: "disconnected",
		},
		inputs,
		devices,
		programGate: { active: override, source: null },
	});

	// Live snapshot under Tauri (EMPTY_STATE until the first arrives); mock otherwise.
	const appState = $derived<AppState>(
		isTauri ? (sidecar.state ?? EMPTY_STATE) : mockState,
	);

	// Dev mode (fake ATEM): the sidecar marks its snapshots `dev`. Only then are the
	// board's input keys interactive; otherwise they stay plain, non-clickable keys.
	const devMode = $derived(appState.dev === true);

	// Sidecar down (crashed, being restarted): the snapshot is stale, so the board shows
	// the rig with every light offline and the source reconnecting — never old tally.
	const engineDown = $derived(isTauri ? sidecar.stale : demo === "enginedown");
	const props = $derived(toBoardProps(engineDown ? sidecarLost(appState) : appState));
	// Each light's firmware against the firmware THIS app ships, so an app update re-badges lights.
	const lights = $derived(
		props.lights.map((l) => {
			const d = appState.devices.find((x) => x.mac === l.mac);
			if (!d) return l;
			const f = lightFirmware(d);
			return {
				...l,
				firmwareVersion: f.version,
				firmwareMissing: f.missing,
				// the engine also flags firmware below its protocol minimum; the mock's flag is only
				// the demo's starting point, which `mockFirmware` already carries
				firmwareOutdated: (isTauri && l.firmwareOutdated) || isOutdated(f),
				firmwareAvailable: flasher.firmwareVersion,
			};
		}),
	);

	// Command handlers: under Tauri they send the real UiCommand; otherwise they
	// mutate the mock device list the engine would normally own.
	function assign(mac: string, inputId: string) {
		if (isTauri) return sidecar.assignDevice(mac, Number(inputId));
		const d = devices.find((x) => x.mac === mac || x.macTail === mac);
		if (d) {
			d.inputId = Number(inputId);
			d.state = "assigned";
		}
	}
	function unassign(mac: string) {
		if (isTauri) return sidecar.unassignDevice(mac);
		const d = devices.find((x) => x.mac === mac || x.macTail === mac);
		if (d) {
			d.inputId = null;
			d.state = "unassigned";
		}
	}
	function flash(mac: string) {
		// the board already echoes a local blink; this streams the real locate flash too
		if (isTauri) sidecar.identifyDevice(mac);
	}
	function setBrightness(mac: string, brightness: number) {
		if (isTauri) return sidecar.setBrightness(mac, brightness);
		const d = devices.find((x) => x.mac === mac || x.macTail === mac);
		if (d) d.brightness = brightness;
	}

	// ── v1.2 device provisioning ───────────────────────────────────────────────
	// Save-only: SET_WIFI persists the credentials and the device confirms at once — there's
	// no live join, so it works from anywhere (the creds apply when the device is unplugged).
	// Under Tauri these send the real UiCommand; the device's STATUS streams the provisioned
	// mode back. Off Tauri (pnpm dev) they mutate the mock device so the pane stays interactive.
	function provisionWifi(mac: string, ssid: string, pass: string) {
		if (isTauri) return sidecar.provisionWifi(mac, ssid, pass);
		const d = devices.find((x) => x.mac === mac || x.macTail === mac);
		if (!d) return;
		d.provisionedMode = "wifi";
		d.ssid = ssid;
	}
	function setTransport(mac: string, mode: "wifi" | "notx" | "espnow") {
		if (isTauri) return sidecar.setTransport(mac, mode);
		const d = devices.find((x) => x.mac === mac || x.macTail === mac);
		if (!d) return;
		if (mode === "wifi") {
			d.provisionedMode = "wifi";
		} else {
			// No-TX and ESP-NOW both commit inline with no credentials (ESP-NOW gets
			// tally from a bridge, not a network), so neither carries an SSID.
			d.provisionedMode = mode;
			d.ssid = null;
		}
	}
	// One bridge per session: designating a new MAC clears the previous one (the
	// sidecar enforces this; the mock mirrors it so the marker moves as expected).
	function setBridge(mac: string | null) {
		if (isTauri) return sidecar.setBridge(mac);
		for (const d of devices) d.bridge = d.mac === mac || d.macTail === mac;
	}
	function setup() {
		// the SourceChip "Set up your ATEM →" link — opens the settings drawer on
		// Source (the first group).
		settingsOpen = true;
	}

	// Dev mode (fake ATEM) only: clicking an input key takes it to program. Gated on
	// the live `dev` flag the sidecar sets, so real-ATEM sessions leave keys inert.
	function onInputClick(inputId: string) {
		if (isTauri && sidecar.state?.dev) sidecar.setProgram(Number(inputId));
	}

	// Save in the drawer commits the source IP. Live: send setSource and let the
	// real connecting → connected arrive as snapshots. Mock: animate it locally.
	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	function onSettingsSave(ip: string) {
		if (isTauri) return sidecar.setSource(ip);
		sourceMode = "connecting";
		clearTimeout(connectTimer);
		connectTimer = setTimeout(() => (sourceMode = "connected"), 1600);
	}

	// ── Firmware flasher + app updater ─────────────────────────────────────────
	// Real drivers under Tauri (espflash in the shell; the Tauri updater plugin), fake ones in
	// a plain browser (the design preview and the `?demo=` states). The mock-only effects below
	// stand in for the engine and the shell, which do this for real under Tauri.
	const mockOnly = !isTauri;
	const updater: Updater = isTauri
		? new TauriUpdater()
		: new MockUpdater({
				available: demo === "update" || demo === "newerfw",
				failDownload: fail === "download",
			});
	if (updater instanceof TauriUpdater) void updater.init();
	// The flasher ships the firmware released with this app (the mock's follows a mock update).
	const flasher: Flasher = isTauri
		? new TauriFlasher()
		: new MockFlasher({
				failOnce: ({ noresponse: "no-response", busy: "port-busy", unplugged: "unplugged" } as const)[
					fail as "noresponse" | "busy" | "unplugged"
				] as FlashFailure | undefined,
				bundled: () => updater.currentVersion,
			});
	if (flasher instanceof TauriFlasher) void flasher.init();
	// A build that bundles no firmware (a dev build without `pnpm firmware:stage`) offers no
	// flasher: blank boards point at the web flasher, as before the in-app one existed.
	const flasherReady = $derived(flasher.firmwareVersion !== null);

	/**
	 * What firmware a light runs. `version` is null when unknown; `known` says whether "unknown"
	 * means old firmware (it connected this session and reported none: older than 1.1) or just
	 * not heard from. The mock also models a light left blank by an interrupted install, which
	 * under Tauri shows up as a blank board instead.
	 */
	function lightFirmware(d: Device): { version: string | null; missing: boolean; known: boolean } {
		if (isTauri) {
			const version = d.firmwareVersion ?? null;
			return { version, missing: false, known: version !== null || d.protocolVersion !== null };
		}
		const version = d.mac in mockFirmware ? mockFirmware[d.mac] : flasher.firmwareVersion;
		return { version, missing: version === null, known: true };
	}
	function isOutdated(f: ReturnType<typeof lightFirmware>): boolean {
		const bundled = flasher.firmwareVersion;
		return bundled !== null && f.known && (f.version === null || isNewer(bundled, f.version));
	}
	/** The USB port a light is on, or null when it isn't plugged in. */
	function portOf(d: Device): string | null {
		if (isTauri) return health.lightPorts.find((l) => l.mac === d.mac)?.port ?? null;
		return d.transport === "usb" && !mockUnplugged ? mockPort(d.mac) : null;
	}
	let updateOpen = $state(false);

	/**
	 * Firmware each mock light runs (MAC → version; null = blank, left so by an interrupted
	 * install). Everything not flagged outdated by the demo starts current.
	 */
	let mockFirmware = $state<Record<string, string | null>>(
		Object.fromEntries(
			devices.map((d) => [d.mac, d.firmwareOutdated ? "1.0.1" : flasher.firmwareVersion]),
		),
	);
	let mockUnflashed = $state<string[]>(demo === "unflashed" || demo === "newerfw" ? ["COM5"] : []);
	// The cable came out mid-install: the board is off USB until the mock "replugs" it.
	let mockUnplugged = $state(false);
	// `?fail=wronglight`: the label of a different light plugged in while waiting for another.
	let mockWrong = $state<string | null>(null);
	let wrongOnce = fail === "wronglight";
	// Off Tauri there's no shell; `?demo=unflashed` stands in for its health snapshot.
	const health = $derived(
		isTauri
			? sidecar.health
			: {
					sidecarDown: demo === "enginedown" ? "exit code 1" : null,
					usbPortErrors: [],
					unflashedPorts: mockUnflashed,
					lightPorts: [],
				},
	);

	// What the flasher drawer is working on. Resolved from live state each time, so a wireless
	// light gains its port the moment it's plugged in.
	// "any" = opened from the titlebar: the dialog lists what's on USB (or waits for a board).
	type FlashRequest = { kind: "any" } | { kind: "blank"; port: string } | { kind: "light"; mac: string };
	let flashRequest = $state<FlashRequest | null>(null);
	let flashOpen = $state(false);
	const flashJob = $derived.by<FlashJob | null>(() => {
		const r = flashRequest;
		if (!r || r.kind === "any") return null;
		if (r.kind === "blank")
			return {
				kind: "blank",
				port: isTauri ? (health.unflashedPorts.includes(r.port) ? r.port : null) : mockUnplugged ? null : r.port,
				mac: null,
				label: null,
				fromVersion: null,
				missing: false,
				wrongLight: null,
				input: null,
			};
		const d = appState.devices.find((x) => x.mac === r.mac);
		if (!d) return null;
		const input = appState.inputs.find((i) => i.id === d.inputId);
		const f = lightFirmware(d);
		return {
			kind: "light",
			port: portOf(d),
			mac: d.mac,
			// the board labels a light by the last two octets of its MAC
			label: d.mac.split(":").slice(-2).join(":"),
			fromVersion: f.version,
			missing: f.missing,
			wrongLight: mockWrong,
			input: input ? { label: input.label, live: input.tally === "live" } : null,
		};
	});
	// While an install runs its target is fixed: every entry point just reopens its progress.
	function openFlasher(r: FlashRequest) {
		if (flasher.state.status !== "running") flashRequest = r;
		flashOpen = true;
	}
	const newerUpdate = $derived(newerFirmwareUpdate(updater.state, flasher.firmwareVersion));

	// The shell would know each cabled light's port; the mock numbers them from COM7.
	function mockPort(mac: string): string {
		const wired = devices.filter((d) => d.transport === "usb");
		return `COM${7 + Math.max(0, wired.findIndex((d) => d.mac === mac))}`;
	}
	// What's on USB for the titlebar entry to choose from: blank boards, then cabled lights.
	const flashCandidates = $derived<FlashCandidate[]>([
		...health.unflashedPorts.map((port) => ({
			kind: "blank" as const,
			port,
			mac: null,
			label: null,
			version: null,
			outdated: false,
		})),
		...appState.devices.flatMap((d) => {
			const port = portOf(d);
			if (port === null) return [];
			const f = lightFirmware(d);
			return [
				{
					kind: "light" as const,
					port,
					mac: d.mac,
					label: d.mac.split(":").slice(-2).join(":"),
					version: f.version,
					outdated: isOutdated(f),
				},
			];
		}),
	]);
	function pickCandidate(c: FlashCandidate) {
		openFlasher(c.kind === "blank" || !c.mac ? { kind: "blank", port: c.port } : { kind: "light", mac: c.mac });
	}
	// Mock: opened with nothing plugged in, a blank board "arrives" after a few seconds.
	$effect(() => {
		if (!mockOnly || !flashOpen || flashRequest?.kind !== "any" || flashCandidates.length) return;
		const t = setTimeout(() => (mockUnflashed = [...mockUnflashed, "COM6"]), 3500);
		return () => clearTimeout(t);
	});

	// Mock: a board the user was asked to plug in (a wireless light, or one whose cable came
	// out) "arrives" over USB after a moment.
	$effect(() => {
		const job = flashJob;
		// only while the drawer is asking for it, not on the failure screen
		if (!mockOnly || !flashOpen || !job || job.port !== null || flasher.state.status !== "idle") return;
		const mac = job.mac;
		const plugIn = () => {
			mockUnplugged = false;
			mockWrong = null;
			const d = devices.find((x) => x.mac === mac);
			if (d) d.transport = "usb";
		};
		if (wrongOnce && job.kind === "light") {
			// `?fail=wronglight`: someone grabs the wrong unit first, then the right one
			wrongOnce = false;
			const t1 = setTimeout(() => (mockWrong = "77:88"), 2500);
			const t2 = setTimeout(plugIn, 6500);
			return () => (clearTimeout(t1), clearTimeout(t2));
		}
		const t = setTimeout(plugIn, 3500);
		return () => clearTimeout(t);
	});

	// Mock: mirror what the engine would report while a light is installed — it drops offline
	// once the board starts erasing, and comes back (current firmware) when it rejoins. A blank
	// board leaves the unflashed list and lands in the dock as a new, unassigned light. An
	// install stopped or broken mid-erase/write leaves a known light blank (still offline, its
	// assignment kept); one stopped after the write already has its new firmware.
	$effect(() => {
		const s = flasher.state;
		if (!mockOnly) return;
		untrack(() => {
			if (s.status === "idle") return;
			const t = s.target;
			const d = t.kind === "light" ? devices.find((x) => x.mac === t.mac) : undefined;
			const back = () => {
				if (d) d.state = d.inputId !== null ? "assigned" : "unassigned";
			};
			if (s.status === "running" && d && s.stage !== "connect" && d.state !== "offline") {
				d.state = "offline";
			} else if (s.status === "done") {
				back();
				if (t.kind === "blank" && !devices.some((x) => x.mac === s.mac)) {
					mockUnflashed = mockUnflashed.filter((p) => p !== t.port);
					devices.push(mock(s.mac, "E7:5B", "unassigned", null, { transport: "usb", protocolVersion: 3 }));
				}
				mockFirmware[s.mac] = flasher.firmwareVersion;
			} else if (s.status === "failed" || s.status === "cancelled") {
				if (s.status === "failed" && s.failure === "unplugged") mockUnplugged = true;
				if (!d) return;
				if (leavesBlank(s.stage)) mockFirmware[d.mac] = null;
				else if (s.stage !== "connect") {
					mockFirmware[d.mac] = flasher.firmwareVersion;
					back();
				}
			}
		});
	});

	// The Settings step's prefill: the light's settings as they are now (null for a blank board).
	const flashCurrentSettings = $derived.by<LightSettings | null>(() => {
		const r = flashRequest;
		const d = r?.kind === "light" ? appState.devices.find((x) => x.mac === r.mac) : undefined;
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
	// Apply the Settings step once the light is back, through the same handlers its Configure
	// pane uses. Mock: it takes a moment, and `?fail=bridge` makes the bridge role not take
	// once (the light never reports `bridging`); a retry succeeds.
	let bridgeFailOnce = mockOnly && fail === "bridge";
	async function applySettings(mac: string, s: LightSettings): Promise<string | null> {
		if (mockOnly) await new Promise((r) => setTimeout(r, 1600));
		if (s.inputId === null) unassign(mac);
		else assign(mac, s.inputId);
		setBrightness(mac, s.brightness);
		if (s.transport === "wifi" && s.ssid) provisionWifi(mac, s.ssid, s.password);
		else setTransport(mac, s.transport);
		if (s.bridge && bridgeFailOnce) {
			bridgeFailOnce = false;
			const tail = mac.split(":").slice(-2).join(":").toUpperCase();
			return `${tail} didn't start bridging, so no-Wi-Fi lights have no bridge. Its other settings are applied.`;
		}
		if (s.bridge) setBridge(mac);
		return null;
	}

	// "Update TallyBot first" parks the job; the "updated" notice offers to pick it back up.
	let resumeFlash = $state<FlashRequest | null>(null);
	function updateAppFirst() {
		resumeFlash = flashRequest;
		flashOpen = false;
		if (updater.state.status === "ready") updater.restart();
		else updateOpen = true;
	}

	// Titlebar pill: only once there's something to act on, and never as a popup.
	const updatePill = $derived.by<UpdatePill | null>(() => {
		const s = updater.state;
		// A failed check (offline at launch) stays quiet: it's only news once an update is known.
		if (s.status === "available") return { kind: "available", version: s.update.version };
		if (s.status === "error" && s.update) return { kind: "available", version: s.update.version };
		if (s.status === "downloading") return { kind: "downloading", progress: downloadProgress(s.received, s.update) };
		if (s.status === "ready") return { kind: "ready" };
		return null;
	});
	const restarting = $derived(updater.state.status === "restarting");

	// An install keeps going with its drawer hidden: a titlebar pill shows its progress and
	// reopens the drawer. While one runs, anything that restarts the engine is refused, since
	// that would cut the install off mid-write.
	const STAGE_WEIGHT = { connect: 0.05, erase: 0.1, write: 0.65, verify: 0.07, restart: 0.05, rejoin: 0.08 };
	const installRunning = $derived(flasher.state.status === "running");
	const installPill = $derived.by<InstallPill | null>(() => {
		const s = flasher.state;
		if (s.status !== "running" || flashOpen) return null;
		let progress = 0;
		for (const [stage, w] of Object.entries(STAGE_WEIGHT)) {
			if (stage === s.stage) {
				progress += stage === "write" ? w * s.progress : 0;
				break;
			}
			progress += w;
		}
		const label = s.target.kind === "blank" ? "Setting up light" : `Updating ${s.target.label}`;
		return { label, progress };
	});
	const installBlocked = $derived(
		installRunning ? "A light's firmware is being installed. Restart once it's finished." : null,
	);

	// Bring a light into view on the board with a one-off highlight; `pick` opens its picker.
	// (Mock-level DOM reach-in; the real build would give Board a prop for this.)
	function revealLight(mac: string, pick: boolean) {
		setTimeout(() => {
			const el = document.querySelector<HTMLElement>(`[aria-label="Light ${mac} — assign or flash"]`);
			if (!el) return;
			el.scrollIntoView({ block: "center", behavior: "smooth" });
			el.classList.remove("reveal");
			void el.offsetWidth;
			el.classList.add("reveal");
			setTimeout(() => el.classList.remove("reveal"), 2400);
			if (pick) setTimeout(() => el.click(), 450);
		}, 250);
	}

	// ── Notices — compact cards floating in the board's bottom-right corner ─────
	// The board is left-aligned, so that corner is empty dot-grid at any width; a card there
	// keeps its action and × next to the text and never pushes the board down.
	// The engine being down is an error that stays until it's back (not dismissible:
	// it's the reason the board is dark). USB port errors (from the shell) are dismissible
	// and return only if their message changes; a sidecar notice (firmware-outdated,
	// offline-flash, …) is dismissed as that one event, so a later notice shows again.
	// An unflashed board (shell health) points at the web flasher until it's unplugged.
	interface Banner {
		key: string;
		level: "info" | "warn" | "error";
		message: string;
		dismissible: boolean;
		/** The banner's next step, as a button after the message. */
		action?: { label: string; run: () => void };
	}
	const FLASHER_URL = "https://tally.hrry.sh";

	// A saved ATEM that never answers leaves the chip spinning forever, which reads as "wait"
	// when the fix is on the user's side (a wrong IP, or this PC on another network). After a
	// grace period long enough to ride out a normal connect or a brief drop, say so. The engine
	// keeps retrying either way, so this is presentation only. `reaching` is a primitive so
	// the timer restarts only when the attempt does, not on every snapshot.
	const UNREACHABLE_AFTER_MS = 12_000;
	const reaching = $derived(
		!engineDown &&
			props.sourceIp !== null &&
			(props.sourceStatus === "connecting" || props.sourceStatus === "disconnected")
			? props.sourceIp
			: null,
	);
	let unreachableIp = $state<string | null>(null);
	$effect(() => {
		const ip = reaching;
		unreachableIp = null;
		if (ip === null) return;
		const timer = setTimeout(() => (unreachableIp = ip), UNREACHABLE_AFTER_MS);
		return () => clearTimeout(timer);
	});
	const openWebFlasher = () =>
		isTauri ? void openUrl(FLASHER_URL) : void window.open(FLASHER_URL, "_blank");
	let dismissed = $state<Record<string, string>>({});
	let dismissedNotice = $state<unknown>(null);
	const banners = $derived.by<Banner[]>(() => {
		const list: Banner[] = [];
		if (engineDown) {
			const why = health.sidecarDown;
			list.push({
				key: "engine",
				level: "error",
				message: why
					? `TallyBot's engine stopped (${why}) and is restarting. The board and lights aren't live until it's back.`
					: "TallyBot's engine is restarting. The board and lights aren't live until it's back.",
				dismissible: false,
			});
		}
		if (unreachableIp !== null) {
			list.push({
				key: "unreachable",
				level: "warn",
				message: `Can't reach the ATEM at ${unreachableIp}. Check the IP address, and that this PC is on the same network as the switcher.`,
				dismissible: true,
				action: { label: "Settings", run: () => (settingsOpen = true) },
			});
		}
		for (const e of health.usbPortErrors) {
			list.push({ key: `usb:${e.port}`, level: "warn", message: e.message, dismissible: true });
		}
		for (const port of health.unflashedPorts) {
			if (flasherReady) {
				// the drawer already says everything while it's working on this board
				// one install at a time: no other board is offered while one runs
				if (installRunning) continue;
				if (flashOpen && flashRequest?.kind === "blank" && flashRequest.port === port) continue;
				// Dismissible: the titlebar's firmware button is always a way back in. A dismissal
				// lasts while the board stays plugged in (cleared when its port goes away).
				list.push({
					key: `unflashed:${port}`,
					level: "info",
					message: "A new tally light is plugged in but isn't set up yet.",
					dismissible: true,
					action: { label: "Set up as a light", run: () => openFlasher({ kind: "blank", port }) },
				});
				continue;
			}
			list.push({
				key: `unflashed:${port}`,
				level: "info",
				message: `The board on ${port} doesn't have TallyBot firmware yet. Flash it with the web flasher (TallyBot can stay open), then unplug it and plug it back in.`,
				dismissible: true,
				action: { label: "Open flasher", run: openWebFlasher },
			});
		}
		// A known light left blank by an interrupted install. Its MAC is known (the bootloader
		// reports it even with no firmware), so it keeps its name and assignment.
		for (const d of devices) {
			if (!mockOnly || mockFirmware[d.mac] !== null) continue;
			if ((flashOpen || installRunning) && flashRequest?.kind === "light" && flashRequest.mac === d.mac) continue;
			const label = d.mac.split(":").slice(-2).join(":");
			const input = inputs.find((i) => i.id === d.inputId);
			list.push({
				key: `blank:${d.mac}`,
				level: "warn",
				message: `${label} needs its firmware reinstalled: an install was interrupted, so it stays dark${input ? ` instead of showing ${input.label}` : ""}.`,
				dismissible: false,
				action: { label: "Reinstall firmware", run: () => openFlasher({ kind: "light", mac: d.mac }) },
			});
		}
		const justUpdated = updater.state.status === "current" ? updater.state.justUpdated : undefined;
		if (justUpdated) {
			const n = lights.filter((l) => l.firmwareOutdated).length;
			const resume = resumeFlash;
			list.push({
				key: "updated",
				level: "info",
				message:
					`TallyBot is updated to ${justUpdated}.` +
					(n && !resume
						? ` ${n} ${n === 1 ? "light has" : "lights have"} newer firmware available: click a light marked ↑ to update it.`
						: ""),
				dismissible: true,
				action: resume
					? {
							label: resume.kind === "blank" ? "Continue setting up the new light" : "Continue updating the light",
							run: () => {
								resumeFlash = null;
								openFlasher(resume);
							},
						}
					: undefined,
			});
		}
		const n = sidecar.notice;
		if (n && n !== dismissedNotice) {
			list.push({ key: "notice", level: n.level, message: n.message, dismissible: true });
		}
		return list.filter((b) => dismissed[b.key] !== b.message);
	});
	// A blank board unplugged and plugged back in is news again: forget its dismissal.
	$effect(() => {
		const ports = new Set(health.unflashedPorts);
		const stale = Object.keys(untrack(() => dismissed)).filter(
			(k) => k.startsWith("unflashed:") && !ports.has(k.slice("unflashed:".length)),
		);
		if (stale.length) {
			const next = { ...untrack(() => dismissed) };
			for (const k of stale) delete next[k];
			dismissed = next;
		}
	});
	function dismiss(banner: Banner) {
		if (banner.key === "notice") dismissedNotice = sidecar.notice;
		else dismissed = { ...dismissed, [banner.key]: banner.message };
	}
</script>

<div class="page">
	<!-- custom frameless titlebar — the gear opens the settings drawer (DESIGN.md) -->
	<TitleBar
		onsettings={() => (settingsOpen = true)}
		update={updatePill}
		onupdate={() => (updateOpen = true)}
		install={installPill}
		oninstall={() => (flashOpen = true)}
		onfirmware={flasherReady ? () => openFlasher({ kind: "any" }) : undefined}
	/>

	<SettingsSheet
		bind:open={settingsOpen}
		source={isTauri ? appState.source : null}
		onsave={onSettingsSave}
		onrestart={isTauri ? () => sidecar.restart() : undefined}
		autostart={isTauri ? autostart : undefined}
		onscan={isTauri ? () => sidecar.scanSources() : undefined}
		scanResult={isTauri ? sidecar.scan : null}
		{updater}
		restartBlocked={installBlocked}
		onviewupdate={() => {
			settingsOpen = false;
			updateOpen = true;
		}}
	/>

	<FlasherDialog
		candidates={flashCandidates}
		onpick={pickCandidate}
		bind:open={flashOpen}
		job={flashJob}
		{flasher}
		{newerUpdate}
		newerReady={updater.state.status === "ready"}
		onupdateapp={updateAppFirst}
		inputs={inputs.map((i) => ({ id: String(i.id), label: i.label }))}
		currentSettings={flashCurrentSettings}
		onapply={applySettings}
		onreveal={revealLight}
		onidentify={(mac) => {
			flash(mac);
			revealLight(mac, false);
		}}
	/>

	<UpdateDialog bind:open={updateOpen} {updater} blocked={installBlocked} />

	<div class="stage">
		<Board
			inputs={props.inputs}
			{lights}
			sourceStatus={props.sourceStatus}
			sourceConnected={props.sourceConnected}
			sourceIp={props.sourceIp}
			assignable={props.assignable}
			override={props.override}
			overrideSource={props.overrideSource}
			onassign={assign}
			onunassign={unassign}
			onflash={flash}
			onbrightness={setBrightness}
			onprovisionwifi={provisionWifi}
			onsettransport={setTransport}
			onsetbridge={setBridge}
			onupdatefirmware={flasherReady ? (mac) => openFlasher({ kind: "light", mac }) : undefined}
			onsetup={setup}
			oninputclick={devMode ? onInputClick : undefined}
		/>
	</div>

	{#if banners.length}
		<div class="notices">
			{#each banners as banner (banner.key)}
				<div
					class="notice"
					class:warn={banner.level === "warn"}
					class:error={banner.level === "error"}
					role={banner.level === "error" ? "alert" : "status"}
					transition:fly={{ x: 24, duration: 180 }}
				>
					{#if banner.level === "error"}
						<CircleAlert class="icon" />
					{:else if banner.level === "warn"}
						<TriangleAlert class="icon" />
					{:else}
						<Info class="icon" />
					{/if}
					<div class="body">
						<!-- selectable: an error is worth copying into a report or a search -->
						<p class="select-text">{banner.message}</p>
						{#if banner.action}
							<button type="button" class="action" onclick={banner.action.run}
								>{banner.action.label}</button
							>
						{/if}
					</div>
					{#if banner.dismissible}
						<button
							type="button"
							class="close"
							onclick={() => dismiss(banner)}
							aria-label="Dismiss"><X class="size-3.5" /></button
						>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<Credit />

	{#if restarting}
		<!-- Installing an update: the app (and engine) restart. Over everything but the titlebar,
		     so it's unmistakable why the board went quiet. -->
		<div class="restarting" role="status" transition:fly={{ y: 8, duration: 160 }}>
			<LoaderCircle class="size-6 animate-spin" />
			<p class="restarting-title">Restarting TallyBot to finish the update…</p>
			<p class="restarting-sub">Lights reconnect by themselves in a few seconds.</p>
		</div>
	{/if}
</div>

<style>
	/* Full-height column: titlebar (fixed) above a board that fills the rest. The
	   credit is absolutely positioned over the board's bottom margin (see Credit). */
	.page {
		height: 100%;
		display: flex;
		flex-direction: column;
		position: relative;
		/* warm taupe desk; the titlebar paints its own cream over the top band */
		background: var(--workspace);
	}

	/* Canvas behaviour (DESIGN.md): no zoom; scroll when content exceeds the window.
	   The board surface fills the window with a small uniform margin all round; the
	   schematic content stays left-aligned and extra width becomes dot-grid margin. */
	.stage {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		display: flex;
		padding: 10px;
	}

	/* Notices — a stack of compact cards over the board's empty bottom-right corner (sidecar
	   notices, USB port errors, an unflashed board, an unreachable ATEM, engine down). Flat
	   popover surface, like the light picker; the level shows in the icon, and an error also
	   tints the card. Above the board and credit, below the settings sheet (z-50). */
	.notices {
		position: absolute;
		right: 32px;
		bottom: 32px;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: min(320px, calc(100% - 64px));
	}
	.notice {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 10px 12px 12px;
		font-size: 0.8rem;
		line-height: 1.4;
		border-radius: 14px;
		background: var(--popover);
		color: var(--popover-foreground);
		box-shadow:
			0 0 0 1px color-mix(in oklch, var(--foreground), transparent 92%),
			0 8px 24px oklch(0 0 0 / 0.12),
			0 2px 6px oklch(0 0 0 / 0.08);
	}
	.notice :global(.icon) {
		flex: none;
		width: 16px;
		height: 16px;
		margin-top: 1px;
		color: var(--muted-foreground);
	}
	.notice.warn :global(.icon) {
		color: var(--foreground);
	}
	.notice.error {
		background: color-mix(in oklch, var(--destructive), var(--popover) 94%);
	}
	.notice.error :global(.icon),
	.notice.error p {
		color: var(--destructive);
	}
	.body {
		flex: 1 1 auto;
		min-width: 0;
	}
	.body p {
		margin: 0;
	}
	.action {
		margin-top: 8px;
		padding: 3px 10px;
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--foreground);
		background: var(--background);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.action:hover {
		background: var(--accent);
	}
	.close {
		flex: none;
		display: inline-flex;
		padding: 2px;
		color: var(--muted-foreground);
		background: none;
		border: none;
		border-radius: 6px;
		cursor: pointer;
	}
	/* one-off "here it is" ring on a light the flasher just brought back (or is asking for) */
	:global(.light-trigger.reveal) {
		animation: reveal 2.4s ease-out;
	}
	@keyframes reveal {
		0%,
		60% {
			box-shadow: 0 0 0 4px color-mix(in oklab, var(--primary), transparent 35%);
		}
		100% {
			box-shadow: 0 0 0 4px transparent;
		}
	}
	.restarting {
		position: absolute;
		inset: var(--titlebar-h) 0 0 0;
		z-index: 55;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		color: var(--foreground);
		background: color-mix(in oklch, var(--board), transparent 12%);
		backdrop-filter: blur(4px);
	}
	.restarting-title {
		margin-top: 8px;
		font-size: 0.95rem;
		font-weight: 600;
	}
	.restarting-sub {
		font-size: 0.8rem;
		color: var(--muted-foreground);
	}
	.close:hover {
		color: var(--foreground);
		background: var(--accent);
	}
</style>
