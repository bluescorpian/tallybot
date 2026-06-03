<script lang="ts" module>
	// The program-output gate's visual modes:
	//   rest  — connected, nothing live: grey node on the trace path
	//   hot   — live signal passing through: cyan, glowing (--signal)
	//   cut   — override active: shows the cut (ZapOff, muted red)
	//   inert — source disconnected: dimmed (no signal to gate)
	export type GateMode = "hot" | "rest" | "cut" | "inert";
</script>

<script lang="ts">
	// Program-output gate (DESIGN.md → "Program-output gate"): a single circular
	// node every trace pinches through, between the inputs and the lights. It is
	// coloured like the traces — grey at rest, cyan when live signal passes — so it
	// reads as part of the wiring, not a separate control. On override it shows the
	// cut; an override-source wire-in from the right exists in the board but the
	// source element itself is hidden until one is configured (v1 shows none).
	//
	// Appearance is locked; size is container-driven (set the parent wrapper's
	// width — the node fills it as a circle).
	import Zap from "@lucide/svelte/icons/zap";
	import ZapOff from "@lucide/svelte/icons/zap-off";

	interface Props {
		mode?: GateMode;
		class?: string;
		ariaLabel?: string;
	}
	let { mode = "rest", class: className = "", ariaLabel }: Props = $props();
</script>

<div
	class="gate {mode} {className}"
	role={ariaLabel ? "img" : undefined}
	aria-label={ariaLabel}
>
	{#if mode === "cut"}<ZapOff class="gi" />{:else}<Zap class="gi" />{/if}
</div>

<style>
	.gate {
		/* rest grey — keep in sync with Trace.svelte's resting stroke */
		--trace-rest: oklch(0.82 0.004 286);
		width: 100%;
		aspect-ratio: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		background: var(--board);
		border: 2px solid var(--trace-rest);
		color: var(--trace-rest);
		box-shadow:
			inset 0 0 0 3px var(--board),
			inset 0 1px 2px oklch(0.5 0.01 286 / 0.15);
		transition:
			color 0.2s ease,
			border-color 0.2s ease,
			box-shadow 0.2s ease;
	}
	.gate :global(.gi) {
		width: 46%;
		height: 46%;
	}
	.gate.hot {
		border-color: var(--signal);
		color: var(--signal);
		box-shadow:
			inset 0 0 0 3px var(--board),
			0 0 11px 1px color-mix(in oklch, var(--signal), transparent 45%);
	}
	.gate.cut {
		border-color: color-mix(
			in oklch,
			var(--destructive),
			oklch(0.6 0.01 286) 30%
		);
		color: color-mix(in oklch, var(--destructive), oklch(0.6 0.01 286) 25%);
	}
	.gate.inert {
		opacity: 0.55;
	}
</style>
