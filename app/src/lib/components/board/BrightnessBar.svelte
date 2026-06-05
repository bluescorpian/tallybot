<script lang="ts" module>
	/** Discrete brightness levels shown to the operator (0 = off). */
	export const LEVELS = 10;

	// The level↔byte mapping is intentionally *linear*. The protocol byte is a
	// perceptual value (ARCHITECTURE.md → SET_COLOR), and the gamma correction that
	// makes equal levels look equally spaced lives in the *firmware* (FastLED), not
	// here — so don't add a gamma curve to these two functions. Level 5 ≈ the default
	// byte 128 by design; a curve here would desync that and double-correct the LED.

	/** Protocol byte (0–255) → display level (0–LEVELS). */
	export function toLevel(byte: number): number {
		return Math.round((byte / 255) * LEVELS);
	}
	/** Display level (0–LEVELS) → protocol byte (0–255). */
	export function toByte(level: number): number {
		return Math.round((level / LEVELS) * 255);
	}
</script>

<script lang="ts">
	// Per-device brightness control for the light picker (DESIGN.md → "Interaction").
	//
	// A flat, rounded amber bar that animates smoothly between 10 levels, flanked by
	// a − and a + button, with the exact level read out in the middle of the bar.
	// 0 = off (the LED goes dark). It's a *flat* control (the picker is a flat shadcn
	// surface, not the neumorphic board) but uses the warm --brightness amber so the
	// "light level" reads as its own axis, distinct from the tally/signal colours.
	//
	// The public API speaks the protocol byte (0–255, as Device.brightness) so it
	// drops straight into the byte-based model; level↔byte conversion is internal.
	import Minus from "@lucide/svelte/icons/minus";
	import Plus from "@lucide/svelte/icons/plus";

	interface Props {
		/** Current brightness as the protocol byte (0–255). */
		value: number;
		/** Emits the new protocol byte (0–255) when the level changes. */
		onchange?: (value: number) => void;
	}
	let { value, onchange }: Props = $props();

	const level = $derived(toLevel(value));
	const pct = $derived((level / LEVELS) * 100);

	function set(next: number) {
		const clamped = Math.max(0, Math.min(LEVELS, next));
		if (clamped !== level) onchange?.(toByte(clamped));
	}

	function onkeydown(e: KeyboardEvent) {
		switch (e.key) {
			case "ArrowRight":
			case "ArrowUp":
				e.preventDefault();
				set(level + 1);
				break;
			case "ArrowLeft":
			case "ArrowDown":
				e.preventDefault();
				set(level - 1);
				break;
			case "Home":
				e.preventDefault();
				set(0);
				break;
			case "End":
				e.preventDefault();
				set(LEVELS);
				break;
		}
	}
</script>

<div class="flex items-center gap-2">
	<button
		type="button"
		class="step"
		aria-label="Decrease brightness"
		disabled={level <= 0}
		onclick={() => set(level - 1)}
	>
		<Minus class="size-3.5" />
	</button>

	<div
		class="bar"
		role="slider"
		tabindex="0"
		aria-label="Brightness"
		aria-valuemin={0}
		aria-valuemax={LEVELS}
		aria-valuenow={level}
		aria-valuetext={level === 0 ? "Off" : `Level ${level} of ${LEVELS}`}
		{onkeydown}
	>
		<div class="fill" style:width="{pct}%"></div>
		<span class="readout">{level}</span>
	</div>

	<button
		type="button"
		class="step"
		aria-label="Increase brightness"
		disabled={level >= LEVELS}
		onclick={() => set(level + 1)}
	>
		<Plus class="size-3.5" />
	</button>
</div>

<style>
	/* − / + buttons: same flat affordance as the picker's Flash button. */
	.step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		background: var(--background);
		color: var(--foreground);
		box-shadow: 0 1px 2px 0 oklch(0 0 0 / 0.05);
		cursor: pointer;
		transition:
			background-color 0.12s ease,
			opacity 0.12s ease;
	}
	.step:hover:not(:disabled) {
		background: var(--accent);
	}
	.step:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.step:disabled {
		opacity: 0.4;
		cursor: default;
	}

	/* The bar: a recessed rounded track with a smooth amber fill and the level
	   read out centred on top. */
	.bar {
		position: relative;
		flex: 1;
		height: 1.75rem;
		border-radius: 9999px;
		background: var(--muted);
		box-shadow: inset 0 1px 2px 0 oklch(0 0 0 / 0.08);
		overflow: hidden;
		cursor: default;
	}
	.bar:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.fill {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: 9999px;
		background: var(--brightness);
		/* the "smoothly animates between levels" part */
		transition: width 0.25s cubic-bezier(0.22, 1, 0.36, 1);
	}
	.readout {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.8rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		/* dark text reads over both the amber fill and the empty track; a faint
		   light halo keeps it legible right at the fill edge. */
		color: var(--foreground);
		text-shadow: 0 0 2px oklch(1 0 0 / 0.5);
		pointer-events: none;
	}
</style>
