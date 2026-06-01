<script lang="ts">
	// Design surface: the simplified ESP32-C3 PCB tally light, dialled to the real
	// board photos — portrait 138×163, clean protruding USB-C, 5 gold pads/side,
	// 45° SoC, WS2812 at its true lower-left spot. Shown across every state.
	// /preview — throwaway canvas, not shipped UI.
	import TallyLightPcb, {
		type LightState,
	} from "$lib/components/board/TallyLightPcb.svelte";

	const states: LightState[] = [
		"live",
		"preview",
		"idle",
		"setup",
		"offline",
		"fault",
	];
	const stateName: Record<LightState, string> = {
		live: "Live",
		preview: "Preview",
		idle: "Idle",
		setup: "Setup",
		offline: "Offline",
		fault: "Fault",
	};
	const macs = ["A1:B2", "C3:D4", "E5:F6", "07:8A", "9B:0C", "AA:01"];
</script>

<div class="page">
	<header class="intro">
		<h1>Tally light — ESP32-C3 PCB</h1>
		<p>
			Simplified board: clean protruding USB-C (no cavity box), 5 gold
			castellated pads per edge, the SoC rotated 45°, and the onboard WS2812 at
			its true lower-left spot. Device-true LED colours; a soft board-edge glow
			keeps the state glanceable.
		</p>
	</header>

	<div class="board">
		<div class="row">
			{#each states as state, si}
				<div class="cell">
					<div class="holder">
						<TallyLightPcb mac={macs[si]} {state} />
					</div>
					<span class="cell-label">{stateName[state]}</span>
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
	}
</style>
