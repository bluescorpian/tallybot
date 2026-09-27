<script lang="ts">
	// Main view — the assembled board (DESIGN.md). The locked <Board> is driven by
	// a view-model produced from an IPC `AppState` (sidecar/src/ipc.ts) via the
	// $lib/boardState.ts mapper, exactly as the real engine feeds it.
	//
	// Under Tauri the AppState is the LIVE snapshot stream from the sidecar (via
	// $lib/ipc.svelte); in a plain browser (pnpm dev, the /preview design workflow)
	// there's no sidecar, so the page falls back to the Phase-4 MOCK below — same
	// shape, local data — so the board still renders and design iteration works.
	import { onMount, onDestroy } from "svelte";
	import type { AppState, Device, Input, Tally } from "$ipc";
	import Board from "$lib/components/board/Board.svelte";
	import { sidecarLost, toBoardProps } from "$lib/boardState";
	import { autostart, sidecar, isTauri } from "$lib/ipc.svelte";
	import { openUrl } from "@tauri-apps/plugin-opener";
	import SettingsSheet from "$lib/components/settings/SettingsSheet.svelte";
	import TitleBar from "$lib/components/chrome/TitleBar.svelte";
	import Credit from "$lib/components/chrome/Credit.svelte";

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
	let sourceMode = $state<SourceMode>("connected"); // ATEM source lifecycle
	let override = $state(false); // OBS override active? (hidden source in v1)
	let settingsOpen = $state(false); // settings drawer (Sheet) open?

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
	const heroDemo = new URLSearchParams(location.search).get("demo") === "hero";
	let devices = $state<Device[]>(heroDemo ? HERO_DEVICES : [
		mock("a4:f2:01:00:11:22", "A4:F2", "assigned", 1, {
			transport: "usb",
			provisionedMode: "wifi",
			ssid: "GreenRoom-5G",
			rssi: -61,
		}),
		mock("7b:1c:01:00:33:44", "7B:1C", "assigned", 1),
		mock("3e:90:01:00:55:66", "3E:90", "assigned", 2),
		mock("c1:08:01:00:77:88", "C1:08", "offline", 3),
		mock("b2:5a:01:00:ee:ff", "B2:5A", "assigned", 4, {
			transport: "espnow",
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
			firmwareOutdated: false,
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
	const engineDown = $derived(isTauri && sidecar.stale);
	const props = $derived(toBoardProps(engineDown ? sidecarLost(appState) : appState));

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

	// ── Banners — thin strips above the board ─────────────────────────────────
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
	let dismissed = $state<Record<string, string>>({});
	let dismissedNotice = $state<unknown>(null);
	const banners = $derived.by<Banner[]>(() => {
		if (!isTauri) return [];
		const list: Banner[] = [];
		if (engineDown) {
			const why = sidecar.health.sidecarDown;
			list.push({
				key: "engine",
				level: "error",
				message: why
					? `TallyBot's engine stopped (${why}) and is restarting. The board and lights aren't live until it's back.`
					: "TallyBot's engine is restarting. The board and lights aren't live until it's back.",
				dismissible: false,
			});
		}
		for (const e of sidecar.health.usbPortErrors) {
			list.push({ key: `usb:${e.port}`, level: "warn", message: e.message, dismissible: true });
		}
		for (const port of sidecar.health.unflashedPorts) {
			list.push({
				key: `unflashed:${port}`,
				level: "info",
				message: `The board on ${port} doesn't have TallyBot firmware yet. Flash it with the web flasher (TallyBot can stay open), then unplug it and plug it back in.`,
				dismissible: true,
				action: { label: "Open flasher", run: () => void openUrl(FLASHER_URL) },
			});
		}
		const n = sidecar.notice;
		if (n && n !== dismissedNotice) {
			list.push({ key: "notice", level: n.level, message: n.message, dismissible: true });
		}
		return list.filter((b) => dismissed[b.key] !== b.message);
	});
	function dismiss(banner: Banner) {
		if (banner.key === "notice") dismissedNotice = sidecar.notice;
		else dismissed = { ...dismissed, [banner.key]: banner.message };
	}
</script>

<div class="page">
	<!-- custom frameless titlebar — the gear opens the settings drawer (DESIGN.md) -->
	<TitleBar onsettings={() => (settingsOpen = true)} />

	<SettingsSheet
		bind:open={settingsOpen}
		source={isTauri ? appState.source : null}
		onsave={onSettingsSave}
		onrestart={isTauri ? () => sidecar.restart() : undefined}
		autostart={isTauri ? autostart : undefined}
		onscan={isTauri ? () => sidecar.scanSources() : undefined}
		scanResult={isTauri ? sidecar.scan : null}
	/>

	{#each banners as banner (banner.key)}
		<div
			class="notice"
			class:warn={banner.level === "warn"}
			class:error={banner.level === "error"}
			role={banner.level === "error" ? "alert" : "status"}
		>
			<!-- selectable: an error is worth copying into a report or a search -->
			<span class="select-text">{banner.message}</span>
			{#if banner.action}
				<button type="button" class="action" onclick={banner.action.run}
					>{banner.action.label}</button
				>
			{/if}
			{#if banner.dismissible}
				<button
					type="button"
					onclick={() => dismiss(banner)}
					aria-label="Dismiss">×</button
				>
			{/if}
		</div>
	{/each}

	<div class="stage">
		<Board
			inputs={props.inputs}
			lights={props.lights}
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
			onsetup={setup}
			oninputclick={devMode ? onInputClick : undefined}
		/>
	</div>

	<Credit />
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

	/* Banner — a thin strip under the titlebar (sidecar notices, USB port errors, engine
	   down). Info by default; warn/error tint it. Non-intrusive: it sits above the board,
	   doesn't cover it. Stacked banners keep a small gap. */
	.notice {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 0 10px;
		padding: 8px 12px;
		font-size: 0.8rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--muted);
		color: var(--foreground);
	}
	.notice + .notice {
		margin-top: 6px;
	}
	.notice.warn {
		border-color: color-mix(in oklch, var(--primary), transparent 50%);
		background: color-mix(in oklch, var(--primary), transparent 92%);
	}
	.notice.error {
		border-color: color-mix(in oklch, var(--destructive), transparent 40%);
		background: color-mix(in oklch, var(--destructive), transparent 90%);
		color: var(--destructive);
	}
	.notice button.action {
		flex: none;
		margin-left: auto;
		padding: 3px 10px;
		font-size: 0.78rem;
		font-weight: 500;
		white-space: nowrap;
		color: var(--foreground);
		background: var(--background);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.notice button.action:hover {
		background: var(--accent);
	}
	.notice button.action + button {
		margin-left: 0;
	}
	.notice button:not(.action) {
		margin-left: auto;
		font-size: 1.1rem;
		line-height: 1;
		color: var(--muted-foreground);
		background: none;
		border: none;
		cursor: pointer;
	}
	.notice button:not(.action):hover {
		color: var(--foreground);
	}
</style>
