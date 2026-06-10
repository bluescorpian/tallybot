<script lang="ts" module>
	export type LightState =
		| "live"
		| "preview"
		| "idle"
		| "setup"
		| "offline"
		| "fault";
</script>

<script lang="ts">
	// VARIANT C — simplified ESP32-C3 SuperMini tally light, dialled to the real
	// board photos: portrait 138×163, true-black soldermask, large silver USB-C
	// protruding from the top centre, 5 gold castellated pads per edge, the QFN
	// SoC rotated 45° (diamond), and the onboard WS2812 at its true lower-left
	// spot. The LED shows DEVICE-TRUE colours (magenta setup, steady blue offline,
	// flashing blue fault) as the firmware drives it; a soft board-edge glow makes
	// the state glanceable.
	interface Props {
		mac: string;
		/** Short 2-octet form shown on the board silkscreen. */
		label: string;
		state?: LightState;
		/**
		 * Device is talking over the USB-C cable (transport `"usb"`). Lights a cyan
		 * signal cuff around the port — blue/cyan is "activity" (a live wire), never
		 * a tally state, so it reads independently of the LED colour above.
		 */
		wired?: boolean;
		onclick?: (event: MouseEvent) => void;
		class?: string;
		ariaLabel?: string;
	}
	let {
		mac,
		label,
		state = "idle",
		wired = false,
		onclick,
		class: className = "",
		ariaLabel,
	}: Props = $props();

	const pads = Array.from({ length: 5 });
</script>

<svelte:element
	this={onclick ? "button" : "div"}
	type={onclick ? "button" : undefined}
	class="pcb {state} {className}"
	class:wired
	{onclick}
	role={!onclick && ariaLabel ? "img" : undefined}
	aria-label={ariaLabel ?? `Light ${mac}`}
>
	<!-- .board is the soldermask body; .pcb is the bounding box, taller by the
	     USB-C headroom so the protruding port stays inside the component bounds. -->
	<span class="board">
		<span class="usb" aria-hidden="true"></span>

		<span class="pads left" aria-hidden="true">
			{#each pads as _}<span class="pad"></span>{/each}
		</span>
		<span class="pads right" aria-hidden="true">
			{#each pads as _}<span class="pad"></span>{/each}
		</span>

		<span class="ic" aria-hidden="true">
			<span class="legs top"></span>
			<span class="legs bottom"></span>
			<span class="legs left"></span>
			<span class="legs right"></span>
			<span class="body"></span>
		</span>
		<span class="led" aria-hidden="true"></span>
		<span class="mac">{label}</span>
	</span>
</svelte:element>

<style>
	.pcb {
		--led: oklch(0.7 0.02 286);
		--bloom: 50%;
		position: relative;
		width: 100%;
		/* 138×185 = board (138×163) + the USB-C headroom that protrudes off the
		   top, so the port stays within the component's box and never overlaps
		   what sits above it. */
		aspect-ratio: 138 / 185;
		border: none;
		padding: 0;
		background: none;
		font: inherit;
		transition: transform 0.08s ease;
	}

	/* the soldermask body — pinned to the bottom of the box, leaving the top
	   headroom for the USB. All inner detail positions relative to this. */
	.board {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		aspect-ratio: 138 / 163;
		border-radius: 12px;
		/* true-black soldermask, faint top-left sheen */
		background: linear-gradient(
			150deg,
			oklch(0.245 0.004 260),
			oklch(0.175 0.003 260)
		);
		box-shadow:
			inset 1px 1px 0 oklch(0.44 0.004 260 / 0.55),
			inset -1px -1px 0 oklch(0.08 0.002 260),
			5px 6px 12px oklch(0.12 0.01 260 / 0.5),
			-3px -3px 8px oklch(1 0 0 / 0.4),
			/* soft state glow at the board edge — glanceable */ 0 0 14px 0
				color-mix(
					in oklch,
					var(--led) calc(var(--bloom) * 0.5),
					transparent
				);
		transition: box-shadow 0.25s ease;
	}
	button.pcb {
		cursor: pointer;
	}
	button.pcb:active {
		transform: translateY(1px);
	}
	button.pcb:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 3px;
	}

	/* large silver USB-C, top-centre, protruding — clean shell, no dark cavity */
	.usb {
		position: absolute;
		top: -13%;
		left: 50%;
		transform: translateX(-50%);
		width: 40%;
		height: 30%;
		border-radius: 4px 4px 3px 3px;
		background: linear-gradient(
			95deg,
			oklch(0.55 0.003 260),
			oklch(0.87 0.003 260) 18%,
			oklch(0.72 0.003 260) 50%,
			oklch(0.87 0.003 260) 82%,
			oklch(0.55 0.003 260)
		);
		box-shadow:
			inset 0 1px 0 oklch(1 0 0 / 0.65),
			inset 0 -2px 3px oklch(0 0 0 / 0.3),
			0 1px 2px oklch(0 0 0 / 0.4);
	}

	/* wired: a cyan signal cuff hugging the USB-C port — "a live cable is seated".
	   Cyan = activity/signal (never a tally state), so it reads independently of the
	   LED colour: a wired LIVE light shows red LED glow AND this cuff at once. */
	.pcb.wired .usb {
		box-shadow:
			inset 0 1px 0 oklch(1 0 0 / 0.65),
			inset 0 -2px 3px oklch(0 0 0 / 0.3),
			0 1px 2px oklch(0 0 0 / 0.4),
			0 0 0 1.5px color-mix(in oklch, var(--signal), transparent 20%),
			0 0 11px 1px color-mix(in oklch, var(--signal), transparent 45%);
	}
	/* a short accent bar at the cable mouth, just below the shell */
	.pcb.wired .usb::after {
		content: "";
		position: absolute;
		left: 50%;
		bottom: -3px;
		transform: translateX(-50%);
		width: 58%;
		height: 3px;
		border-radius: 2px;
		background: var(--signal);
		box-shadow: 0 0 6px 1px color-mix(in oklch, var(--signal), transparent 35%);
	}

	/* 5 gold castellated pads down each edge — run edge-to-edge, flanking the USB */
	.pads {
		position: absolute;
		top: 10%;
		bottom: 10%;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		align-items: center;
	}
	.pads.left {
		left: 0px;
	}
	.pads.right {
		right: 0px;
	}
	.pad {
		width: 11px;
		height: 9px;
		border-radius: 2px;
		background: linear-gradient(
			180deg,
			oklch(0.87 0.12 90),
			oklch(0.64 0.12 82)
		);
		box-shadow:
			inset 0 0.5px 0 oklch(1 0.06 95 / 0.6),
			0 0.5px 1px oklch(0 0 0 / 0.4);
	}

	/* the SoC, rotated 45° (diamond), sitting in the bottom half.
	   .ic is just the rotation/positioning box; the body + legs draw inside it. */
	.ic {
		--leg: oklch(58.982% 0.00475 271.339);
		position: absolute;
		top: 45%;
		left: 50%;
		transform: translateX(-50%) rotate(45deg);
		width: 33%;
		aspect-ratio: 1;
	}

	/* metallic gull-wing leads — a comb of stubs on each of the four sides */
	.ic .legs {
		position: absolute;
	}
	.ic .legs.top,
	.ic .legs.bottom {
		left: 4px;
		right: 4px;
		height: 4px;
		background: repeating-linear-gradient(
			to right,
			var(--leg) 0 2px,
			transparent 2px 4px
		);
	}
	.ic .legs.top {
		top: 0;
	}
	.ic .legs.bottom {
		bottom: 0;
	}
	.ic .legs.left,
	.ic .legs.right {
		top: 4px;
		bottom: 4px;
		width: 4px;
		background: repeating-linear-gradient(
			to bottom,
			var(--leg) 0 2px,
			transparent 2px 4px
		);
	}
	.ic .legs.left {
		left: 0;
	}
	.ic .legs.right {
		right: 0;
	}

	/* the body — a sharp-edged, matte black plastic square */
	.ic .body {
		position: absolute;
		inset: 3px;
		border-radius: 0;
		background: linear-gradient(
			150deg,
			oklch(0.175 0.003 260),
			oklch(0.135 0.003 260)
		);
		box-shadow:
			inset 0 1px 0 oklch(0.32 0.003 260 / 0.5),
			inset 0 -1px 0 oklch(0.04 0.002 260),
			0 1px 2px oklch(0 0 0 / 0.55);
	}
	/* pin-1 dot */
	.ic .body::after {
		content: "";
		position: absolute;
		top: 2.5px;
		left: 2.5px;
		width: 2px;
		height: 2px;
		border-radius: 50%;
		background: oklch(0.42 0.003 260);
	}

	/* onboard WS2812 — small SMD dot at the SoC's top-right corner (simulation
	   detail, not the primary read; the board-edge glow carries the state) */
	.led {
		position: absolute;
		top: 40%;
		left: 65%;
		width: 12%;
		aspect-ratio: 5/3;
		border-radius: 2px;
		background: radial-gradient(
			circle at 42% 35%,
			color-mix(in oklch, var(--led), white 65%),
			var(--led) 62%,
			color-mix(in oklch, var(--led), black 20%) 100%
		);
		box-shadow:
			0 0 6px 0 color-mix(in oklch, var(--led) var(--bloom), transparent),
			0 0 13px 1px
				color-mix(
					in oklch,
					var(--led) calc(var(--bloom) * 0.6),
					transparent
				);
	}

	.mac {
		position: absolute;
		bottom: 5%;
		left: 0;
		right: 0;
		text-align: center;
		font-family: var(--font-mono);
		font-size: 0.62rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		color: oklch(0.9 0.01 260 / 0.8);
	}

	/* device-true LED colours (ARCHITECTURE.md) */
	.pcb.live {
		--led: oklch(61.8% 0.246 23.6);
		--bloom: 95%;
	}
	.pcb.preview {
		--led: oklch(77.2% 0.246 144.5);
		--bloom: 95%;
	}
	.pcb.idle {
		--led: oklch(0.5 0 0);
		--bloom: 25%;
	}
	.pcb.setup {
		--led: oklch(0.7 0.32 328);
		--bloom: 90%;
	}
	.pcb.offline {
		--led: oklch(0.5 0.29 264);
		--bloom: 85%;
	}
	.pcb.fault {
		--led: oklch(0.5 0.29 264);
		--bloom: 95%;
	}
	.pcb.fault .led {
		animation: led-flash 0.9s steps(1, end) infinite;
	}
	@keyframes led-flash {
		0%,
		49% {
			opacity: 1;
		}
		50%,
		100% {
			opacity: 0.18;
		}
	}
</style>
