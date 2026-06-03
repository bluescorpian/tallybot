<script lang="ts" module>
	export type InputState = "live" | "preview" | "idle";
</script>

<script lang="ts">
	// A single ATEM-style input key: center-lit, always-backlit, moulded number.
	// Appearance is locked; size is container-driven (set the parent's width).
	interface Props {
		/** Number shown centered on the key face. */
		n: number | string;
		/** Tally state — drives the backlight colour and strength. */
		state?: InputState;
		/** When provided, the key renders as a clickable button. */
		onclick?: (event: MouseEvent) => void;
		class?: string;
		ariaLabel?: string;
	}

	let {
		n,
		state = "idle",
		onclick,
		class: className = "",
		ariaLabel,
	}: Props = $props();
</script>

{#if onclick}
	<button
		type="button"
		class="key {state} {className}"
		{onclick}
		aria-label={ariaLabel}
	>
		<span class="key-num">{n}</span>
	</button>
{:else}
	<div
		class="key {state} {className}"
		role={ariaLabel ? "img" : undefined}
		aria-label={ariaLabel}
	>
		<span class="key-num">{n}</span>
	</div>
{/if}

<style>
	.key {
		--state: var(--idle);
		--glow-pct: 60%; /* backlight strength, always on */
		position: relative;
		width: 100%;
		aspect-ratio: 16 / 10;
		border: none;
		/* Radius scales with the key so it reads the same at any size. The
		   asymmetric % keeps the corners visually circular on the 16:10 box
		   (h% · width ≈ v% · height). container-type lets the numeral scale too. */
		container-type: size;
		border-radius: 16% / 26%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: oklch(
			0.13 0 0 / 0.88
		); /* near-solid black numeral, like the moulded key */
		font: inherit;
		/* center-lit: brightest in the middle, never a top white band */
		background: radial-gradient(
			115% 115% at 50% 42%,
			color-mix(in oklch, var(--state), white 30%) 0%,
			var(--state) 52%,
			color-mix(in oklch, var(--state), black 13%) 100%
		);
		/* last two shadows are the persistent backlight bloom */
		box-shadow:
			inset 0 1px 1px color-mix(in oklch, var(--state), white 35%),
			inset 0 -3px 7px color-mix(in oklch, var(--state), black 28%),
			0 2px 3px oklch(0 0 0 / 0.16),
			0 7px 16px -9px oklch(0 0 0 / 0.4),
			0 0 9px -1px color-mix(in oklch, var(--state) var(--glow-pct), transparent),
			0 0 26px 1px
				color-mix(
					in oklch,
					var(--state) calc(var(--glow-pct) * 0.55),
					transparent
				);
		transition:
			transform 0.08s ease,
			box-shadow 0.25s ease,
			background 0.25s ease;
	}
	button.key {
		cursor: pointer;
	}
	button.key:active {
		transform: translateY(1px);
		/* press deepens the body but keeps the backlight glowing */
		box-shadow:
			inset 0 1px 2px color-mix(in oklch, var(--state), black 22%),
			inset 0 -1px 3px color-mix(in oklch, var(--state), black 28%),
			0 1px 2px oklch(0 0 0 / 0.18),
			0 0 9px -1px color-mix(in oklch, var(--state) var(--glow-pct), transparent),
			0 0 26px 1px
				color-mix(
					in oklch,
					var(--state) calc(var(--glow-pct) * 0.55),
					transparent
				);
	}
	button.key:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 3px;
	}

	.key.live {
		--state: var(--live);
		--glow-pct: 80%;
	}
	.key.preview {
		--state: var(--preview);
		--glow-pct: 100%;
	}
	.key.idle {
		--state: var(--idle);
		--glow-pct: 80%;
	}

	.key-num {
		font-family: var(--font-mono);
		font-size: 46cqh; /* scales with the key height (container-driven) */
		font-weight: 500;
		line-height: 1;
		letter-spacing: -0.02em;
		/* embossed cutout: dark glyph with a faint light underside */
		text-shadow: 0 1px 0 color-mix(in oklch, var(--state), white 40%);
	}
</style>
