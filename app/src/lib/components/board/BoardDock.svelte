<script lang="ts">
	// Dock (DESIGN.md → "Dock"): the recessed tray of unassigned lights along the
	// bottom of the board. Unassigned devices show the setup colour and sit here
	// until wired into a column; clicking one opens the same picker as a seated
	// light. Presentational — Board owns the data and the flash blink, and places
	// this tray (the tray just fills its positioned wrapper).
	import LightPicker from "$lib/components/board/LightPicker.svelte";
	import type { BoardLight } from "$lib/components/board/types";
	import type { PickerInput } from "$lib/components/board/LightPicker.svelte";

	interface Props {
		/** Unassigned lights, with display state already resolved by Board. */
		lights: BoardLight[];
		/** Inputs to offer in the picker (so a dock light can be assigned). */
		pickerInputs: PickerInput[];
		/** Light width in px — keeps dock pucks sized to the column pucks. */
		lightWidth: number;
		onassign?: (mac: string, inputId: string) => void;
		onflash?: (mac: string) => void;
		/** Set a device's LED brightness (protocol byte, 0–255). */
		onbrightness?: (mac: string, value: number) => void;
	}
	let {
		lights,
		pickerInputs,
		lightWidth,
		onassign,
		onflash,
		onbrightness,
	}: Props = $props();
</script>

<div class="dock">
	<div class="dock-head">
		Unassigned
		<span class="count">{lights.length}</span>
	</div>
	<div class="dock-row">
		{#each lights as light (light.mac)}
			<div class="dock-slot" style="width:{lightWidth}px">
				<LightPicker
					mac={light.mac}
					label={light.label}
					state={light.state}
					inputs={pickerInputs}
					currentInputId={null}
					brightness={light.brightness}
					onassign={(id) => onassign?.(light.mac, id)}
					onflash={() => onflash?.(light.mac)}
					onbrightness={(v) => onbrightness?.(light.mac, v)}
				/>
			</div>
		{/each}
	</div>
</div>

<style>
	/* recessed tray pressed into the board; surfaces track the board's warm hue */
	.dock {
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		border-radius: 16px;
		padding: 16px 22px 18px;
		background: color-mix(in oklch, var(--board), black 5.5%);
		box-shadow:
			inset 2px 3px 6px oklch(0.5 0.01 286 / 0.22),
			inset -2px -2px 5px oklch(1 0 0 / 0.85),
			0 1px 0 oklch(1 0 0 / 0.6);
	}
	.dock-head {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 26px;
		font-size: 0.7rem;
		font-weight: 500;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted-foreground);
		user-select: none;
	}
	.dock-head .count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: 9999px;
		background: color-mix(in oklch, var(--board), black 16%);
		color: var(--muted-foreground);
		font-family: var(--font-mono);
		font-size: 0.66rem;
	}
	.dock-row {
		display: flex;
		align-items: flex-start;
		gap: 18px;
		/* header → lights breathing room; the PCB reserves its own USB headroom */
		margin-top: 8px;
		/* With no source every light lands here, so the row can outrun the tray —
		   scroll horizontally rather than clip. Padding keeps focus rings off the
		   edge. (Multi-row staging stays a future refinement.) */
		overflow-x: auto;
		padding: 2px 2px 4px;
	}
	.dock-slot {
		flex: none;
	}
</style>
