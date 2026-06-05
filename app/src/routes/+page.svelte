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
	import { toBoardProps } from "$lib/boardState";
	import { sidecar, isTauri } from "$lib/ipc.svelte";
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

	const props = $derived(toBoardProps(appState));

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
		// the board already echoes a local blink; this fires the real IDENTIFY too
		if (isTauri) sidecar.identifyDevice(mac);
	}
	function setBrightness(mac: string, brightness: number) {
		if (isTauri) return sidecar.setBrightness(mac, brightness);
		const d = devices.find((x) => x.mac === mac || x.macTail === mac);
		if (d) d.brightness = brightness;
	}
	function setup() {
		// the SourceChip "Set up your ATEM →" link — opens the settings drawer on
		// Source (the first group).
		settingsOpen = true;
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

	// ── Notices (firmware-outdated, offline-flash, …) — a dismissible banner ────
	let dismissed = $state<unknown>(null);
	const notice = $derived(
		isTauri && sidecar.notice !== dismissed ? sidecar.notice : null,
	);
</script>

<div class="page">
	<!-- custom frameless titlebar — the gear opens the settings drawer (DESIGN.md) -->
	<TitleBar onsettings={() => (settingsOpen = true)} />

	<SettingsSheet
		bind:open={settingsOpen}
		onsave={onSettingsSave}
		onscan={isTauri ? () => sidecar.scanSources() : undefined}
		scanResult={isTauri ? sidecar.scan : null}
	/>

	{#if notice}
		<div class="notice" class:warn={notice.level === "warn"} class:error={notice.level === "error"} role="status">
			<span>{notice.message}</span>
			<button type="button" onclick={() => (dismissed = sidecar.notice)} aria-label="Dismiss">×</button>
		</div>
	{/if}

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

	/* Sidecar notice — a thin dismissible banner under the titlebar. Info by default;
	   warn/error tint it. Non-intrusive: it sits above the board, doesn't cover it. */
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
	.notice.warn {
		border-color: color-mix(in oklch, var(--primary), transparent 50%);
		background: color-mix(in oklch, var(--primary), transparent 92%);
	}
	.notice.error {
		border-color: color-mix(in oklch, var(--destructive), transparent 40%);
		background: color-mix(in oklch, var(--destructive), transparent 90%);
		color: var(--destructive);
	}
	.notice button {
		margin-left: auto;
		font-size: 1.1rem;
		line-height: 1;
		color: var(--muted-foreground);
		background: none;
		border: none;
		cursor: pointer;
	}
	.notice button:hover {
		color: var(--foreground);
	}
</style>
