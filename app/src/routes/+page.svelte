<script lang="ts">
	// Main view — the assembled board (DESIGN.md). The locked <Board> is driven by
	// a view-model produced from an IPC `AppState` (sidecar/src/ipc.ts) via the
	// $lib/boardState.ts mapper, exactly as the real engine will feed it.
	//
	// PHASE-4 MOCK: the AppState here is local mock data, so the board renders
	// without a running sidecar. It defaults to the connected case; `onSettingsSave`
	// still nudges `sourceMode` to animate connecting → connected behind the drawer.
	// Phase 5 replaces the mock with the real Tauri/IPC snapshot stream.
	import type { AppState, Device, Input, Tally } from "$ipc";
	import Board from "$lib/components/board/Board.svelte";
	import { toBoardProps } from "$lib/boardState";
	import SettingsSheet from "$lib/components/settings/SettingsSheet.svelte";
	import TitleBar from "$lib/components/chrome/TitleBar.svelte";
	import Credit from "$lib/components/chrome/Credit.svelte";

	// ── Mock source state ─────────────────────────────────────────────────────
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
	let devices = $state<Device[]>([
		mock("a4:f2:01:00:11:22", "A4:F2", "assigned", 1),
		mock("7b:1c:01:00:33:44", "7B:1C", "assigned", 1),
		mock("3e:90:01:00:55:66", "3E:90", "assigned", 2),
		mock("c1:08:01:00:77:88", "C1:08", "offline", 3),
		mock("d2:44:01:00:99:aa", "D2:44", "unassigned", null),
		mock("9f:31:01:00:bb:cc", "9F:31", "unassigned", null),
	]);

	function mock(
		mac: string,
		macTail: string,
		state: Device["state"],
		inputId: number | null,
	): Device {
		return {
			mac,
			macTail,
			state,
			inputId,
			brightness: 128,
			protocolVersion: 1,
			firmwareOutdated: false,
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
	const appState = $derived<AppState>({
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

	const props = $derived(toBoardProps(appState));

	// Mock command handlers — mutate the device list the engine would otherwise own.
	function assign(mac: string, inputId: string) {
		const d = devices.find((x) => x.mac === mac || x.macTail === mac);
		if (d) {
			d.inputId = Number(inputId);
			d.state = "assigned";
		}
	}
	function unassign(mac: string) {
		const d = devices.find((x) => x.mac === mac || x.macTail === mac);
		if (d) {
			d.inputId = null;
			d.state = "unassigned";
		}
	}
	function flash(mac: string) {
		// real path sends IDENTIFY; the board echoes with a local blink already
		void mac;
	}
	function setBrightness(mac: string, brightness: number) {
		// real path sends SET_COLOR with this byte (Phase 5: setBrightness command)
		const d = devices.find((x) => x.mac === mac || x.macTail === mac);
		if (d) d.brightness = brightness;
	}
	function setup() {
		// the SourceChip "Set up your ATEM →" link — opens the settings drawer on
		// Source (the first group). Real IPC stays Phase 5.
		settingsOpen = true;
	}

	// Mock: Save in the drawer nudges the board's source mode so the SourceChip
	// animates connecting → connected behind the open panel. Phase 5 replaces this
	// with the real IPC snapshot stream reacting to the committed source.
	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	function onSettingsSave(_ip: string) {
		sourceMode = "connecting";
		clearTimeout(connectTimer);
		connectTimer = setTimeout(() => (sourceMode = "connected"), 1600);
	}
</script>

<div class="page">
	<!-- custom frameless titlebar — the gear opens the settings drawer (DESIGN.md) -->
	<TitleBar onsettings={() => (settingsOpen = true)} />

	<SettingsSheet bind:open={settingsOpen} onsave={onSettingsSave} />

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
			onsetup={setup}
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
</style>
