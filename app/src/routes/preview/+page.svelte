<script lang="ts">
	// /preview — throwaway design canvas (not shipped UI).
	// Prototyping the assign / flash picker popover (DESIGN.md → Interaction):
	// plain-click a light → popover lists the source's inputs (current marked),
	// plus flash-to-identify and unassign.
	import LightPicker, {
		type PickerInput,
	} from "$lib/components/board/LightPicker.svelte";
	import type { LightState } from "$lib/components/board/TallyLightPcb.svelte";
	import { page } from "$app/state";

	// Dev-only: ?open=<mac> auto-opens that light's picker (for screenshots).
	const openMac = $derived(page.url.searchParams.get("open"));

	// Mock source inputs (labels come from the ATEM). One live, one preview.
	const inputs: PickerInput[] = [
		{ id: "1", label: "CAM 1 — Wide", state: "live" },
		{ id: "2", label: "CAM 2 — Close", state: "preview" },
		{ id: "3", label: "CAM 3 — Floor", state: "idle" },
		{ id: "4", label: "Laptop / Slides", state: "idle" },
		{ id: "5", label: "Overhead", state: "idle" },
	];
	const inputById = (id: string | null) =>
		inputs.find((i) => i.id === id) ?? null;

	// Mock connected lights, each bound to an input (or unassigned = in the dock).
	let lights = $state([
		{ mac: "A1:B2", inputId: "1" as string | null },
		{ mac: "C3:D4", inputId: "2" as string | null },
		{ mac: "E5:F6", inputId: "1" as string | null },
		{ mac: "07:8A", inputId: null as string | null },
	]);

	// A light shows its input's tally state; unassigned shows the setup colour.
	function displayState(inputId: string | null): LightState {
		if (inputId === null) return "setup";
		return (inputById(inputId)?.state ?? "idle") as LightState;
	}

	// Flash-to-identify: blink the board edge a few times so the operator can
	// spot the physical unit. (Real devices get an IDENTIFY command.)
	let flashing = $state<string | null>(null);
	let flashOff = $state(false);
	function flash(mac: string) {
		flashing = mac;
		let n = 0;
		flashOff = false;
		const t = setInterval(() => {
			flashOff = !flashOff;
			if (++n >= 6) {
				clearInterval(t);
				flashing = null;
				flashOff = false;
			}
		}, 180);
	}

	function effectiveState(l: { mac: string; inputId: string | null }): LightState {
		if (flashing === l.mac && flashOff) return "idle";
		return displayState(l.inputId);
	}

	let lastAction = $state("");
	function assign(mac: string, inputId: string) {
		const l = lights.find((x) => x.mac === mac);
		if (l) l.inputId = inputId;
		lastAction = `Assigned ${mac} → ${inputById(inputId)?.label}`;
	}
	function unassign(mac: string) {
		const l = lights.find((x) => x.mac === mac);
		if (l) l.inputId = null;
		lastAction = `Unassigned ${mac}`;
	}
</script>

<div class="page">
	<header class="intro">
		<h1>Assign / flash picker popover</h1>
		<p>
			Plain-click a light to open the picker: choose an input (the current one
			is marked), flash-to-identify, or unassign. Inputs carry a tally dot so
			the picker reads as a monitor too. Try the unassigned light at the end —
			it has no current input and no unassign action.
		</p>
		{#if lastAction}
			<p class="action">{lastAction}</p>
		{/if}
	</header>

	<div class="board">
		<div class="row">
			{#each lights as l (l.mac)}
				<div class="cell">
					<div class="holder">
						<LightPicker
							mac={l.mac}
							state={effectiveState(l)}
							open={openMac === l.mac}
							{inputs}
							currentInputId={l.inputId}
							onassign={(id) => assign(l.mac, id)}
							onunassign={() => unassign(l.mac)}
							onflash={() => flash(l.mac)}
						/>
					</div>
					<span class="cell-label">
						{l.inputId ? inputById(l.inputId)?.label : "Unassigned"}
					</span>
				</div>
			{/each}
		</div>
	</div>
</div>

<style>
	.page {
		max-width: 860px;
		margin: 0 auto;
		padding: 48px 24px 72px;
	}
	.intro h1 {
		font-size: 1.35rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--foreground);
	}
	.intro p {
		margin-top: 8px;
		max-width: 64ch;
		color: var(--muted-foreground);
		font-size: 0.9rem;
		line-height: 1.55;
	}
	.intro p.action {
		color: var(--primary);
		font-weight: 500;
	}

	.board {
		margin-top: 32px;
		padding: 44px 32px 40px;
		border: 1px solid var(--border);
		border-radius: 18px;
		background-color: oklch(0.993 0.001 286);
		background-image: radial-gradient(
			oklch(0.55 0.01 286 / 0.18) 1px,
			transparent 1.5px
		);
		background-size: 22px 22px;
		background-position: -6px -6px;
		box-shadow:
			inset 0 1px 0 oklch(1 0 0 / 0.6),
			0 1px 2px oklch(0 0 0 / 0.04);
	}
	.row {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		gap: 26px;
		align-items: start;
	}
	.cell {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
	}
	.holder {
		width: 84px;
	}
	.cell-label {
		font-size: 0.74rem;
		color: var(--muted-foreground);
		text-align: center;
	}
</style>
