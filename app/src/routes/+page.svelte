<script lang="ts">
	// Main view — the assembled board (DESIGN.md). The locked <Board> is driven by
	// a view-model produced from an IPC `AppState` (sidecar/src/ipc.ts) via the
	// $lib/boardState.ts mapper, exactly as the real engine will feed it.
	//
	// PHASE-4 MOCK: the AppState here is local mock data + two dev toggles, so the
	// whole state matrix is visible without a running sidecar. Phase 5 replaces the
	// mock with the real Tauri/IPC snapshot stream (and drops the toggles).
	import type { AppState, Device, Input, Tally } from "$ipc";
	import Board from "$lib/components/board/Board.svelte";
	import { toBoardProps } from "$lib/boardState";

	// ── Dev toggles (mock only) ───────────────────────────────────────────────
	let connected = $state(true); // ATEM source reachable?
	let override = $state(false); // OBS override active? (hidden source in v1)

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
	const liveTallies: Tally[] = ["live", "preview", "idle", "idle"];
	const inputs = $derived<Input[]>(
		[
			{ id: 1, label: "Cam 1 — Wide" },
			{ id: 2, label: "Cam 2 — Close" },
			{ id: 3, label: "Cam 3 — Floor" },
			{ id: 4, label: "Laptop" },
		].map((i, idx) => ({
			...i,
			tally: connected ? liveTallies[idx] : "unknown",
		})),
	);

	const appState = $derived<AppState>({
		source: {
			kind: "atem",
			ip: "192.168.10.240",
			connection: connected ? "connected" : "disconnected",
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
</script>

<div class="page">
	<!-- PHASE-4 MOCK dev strip — remove when real IPC lands (Phase 5) -->
	<div class="mock-controls">
		<label><input type="checkbox" bind:checked={connected} /> source connected</label>
		<label
			><input type="checkbox" bind:checked={override} /> OBS override (demo — hidden in v1)</label
		>
	</div>

	<div class="stage">
		<Board
			inputs={props.inputs}
			lights={props.lights}
			sourceConnected={props.sourceConnected}
			sourceIp={props.sourceIp}
			override={props.override}
			overrideSource={props.overrideSource}
			onassign={assign}
			onunassign={unassign}
			onflash={flash}
		/>
	</div>
</div>

<style>
	.page {
		min-height: 100%;
		display: flex;
		flex-direction: column;
	}

	/* mock-only; not part of the real chrome */
	.mock-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 22px;
		padding: 12px 20px;
		font-family: var(--font-mono);
		font-size: 0.76rem;
		color: var(--foreground);
	}
	.mock-controls label {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
		user-select: none;
	}

	/* Canvas behaviour (DESIGN.md): no zoom; scroll when content exceeds the window. */
	.stage {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		display: flex;
		padding: 8px 8px 24px;
	}
</style>
