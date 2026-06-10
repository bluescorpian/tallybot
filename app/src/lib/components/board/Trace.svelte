<script lang="ts">
	// A single PCB-style signal trace: one stroked path, grey at rest, `--signal` cyan
	// when active. Square ends, round joins (for clean 45° corners). Renders a bare
	// <path>, so it must sit inside a parent <svg> — the board draws all traces in one
	// overlay and feeds each its measured `d`. Appearance locked; width is in the parent
	// SVG's user units (default 5).
	interface Props {
		/** SVG path data, e.g. "M x0 y0 L x1 y1 …" (orthogonal runs, 45° chamfers). */
		d: string;
		/** Energised (signal reaching the lights) → cyan; otherwise rest grey. */
		active?: boolean;
		/** Stroke width in the parent SVG's user units. */
		width?: number;
	}
	let { d, active = false, width = 5 }: Props = $props();
</script>

<path class="trace" class:active {d} stroke-width={width} />

<style>
	.trace {
		fill: none;
		stroke: oklch(0.82 0.004 286); /* rest: grey */
		stroke-linecap: butt;
		stroke-linejoin: round;
		transition:
			stroke 0.2s ease,
			filter 0.2s ease;
	}
	.trace.active {
		stroke: var(--signal); /* cyan */
		/* Glow: a soft halo around the live wire, echoing the gate's --signal
		   bloom. drop-shadow renders the blur beneath this path's own stroke, so
		   the bright core stays crisp while the halo bleeds onto the board. Two
		   stacked shadows — a tight inner + a wider outer — give a fuller bloom. */
		filter: drop-shadow(
				0 0 2px color-mix(in oklch, var(--signal), transparent 30%)
			)
			drop-shadow(0 0 6px color-mix(in oklch, var(--signal), transparent 55%));
	}
</style>
