<script lang="ts">
	// Design surface: source chip (Wide Pill) + input buttons.
	// /preview — throwaway canvas, not shipped UI.
	import InputKey, {
		type InputState,
	} from "$lib/components/board/InputKey.svelte";
	import SourceChip from "$lib/components/board/SourceChip.svelte";

	type State = InputState;
	const cycleOrder: State[] = ["idle", "preview", "live"];
	const stateName: Record<State, string> = {
		live: "Live · on air",
		preview: "Preview",
		idle: "Idle",
	};

	let inputs = $state<{ n: number; label: string; state: State }[]>([
		{ n: 1, label: "Camera 1", state: "live" },
		{ n: 2, label: "Camera 2", state: "preview" },
		{ n: 3, label: "Stage Wide", state: "idle" },
		{ n: 4, label: "Lectern", state: "idle" },
	]);

	function cycle(i: number) {
		const cur = inputs[i].state;
		inputs[i].state =
			cycleOrder[(cycleOrder.indexOf(cur) + 1) % cycleOrder.length];
	}
</script>

<div class="page">
	<header class="intro">
		<h1>Material study — source chip &amp; input buttons</h1>
		<p>
			Source chip (Wide Pill) over the board. No pins — traces connect
			later. Click keys to cycle <em>idle → preview → live</em>.
		</p>
	</header>

	<!-- ── BOARD ─────────────────────────────────────────────────── -->
	<section class="board" style="--cols: {inputs.length}">
		<!-- SOURCE CHIP · Wide Pill -->
		<SourceChip connected ip="192.168.1.240" />

		<!-- INPUT KEYS -->
		<div class="inputs">
			{#each inputs as input, i}
				<div class="slot">
					<InputKey
						n={input.n}
						state={input.state}
						onclick={() => cycle(i)}
						ariaLabel="Input {input.n}, {input.label} — {stateName[
							input.state
						]}"
					/>
					<span class="slot-label">{input.label}</span>
					<span class="slot-state">{stateName[input.state]}</span>
				</div>
			{/each}
		</div>
	</section>

	<footer class="legend">
		<span class="swatch live"></span> Live
		<span class="swatch preview"></span> Preview
		<span class="swatch idle"></span> Idle
	</footer>
</div>

<style>
	/* ── page shell ───────────────────────────────────────────────── */
	.page {
		max-width: 900px;
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
		max-width: 62ch;
		color: var(--muted-foreground);
		font-size: 0.9rem;
		line-height: 1.55;
	}
	.intro em {
		font-style: normal;
		font-weight: 500;
		color: var(--foreground);
	}

	/* ── board surface: off-white dot-grid ────────────────────────── */
	.board {
		margin-top: 32px;
		padding: 40px 40px 48px;
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

	/* ── input keys ───────────────────────────────────────────────── */
	.inputs {
		margin-top: 40px;
		display: grid;
		grid-template-columns: repeat(var(--cols), 1fr);
		gap: 28px;
	}
	.slot {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
	}
	.slot-label {
		font-size: 0.86rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--foreground);
	}
	.slot-state {
		margin-top: -4px;
		font-size: 0.72rem;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}

	/* ── legend ───────────────────────────────────────────────────── */
	.legend {
		margin-top: 28px;
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.78rem;
		color: var(--muted-foreground);
	}
	.legend .swatch {
		width: 11px;
		height: 11px;
		border-radius: 3px;
		margin-left: 12px;
		box-shadow: inset 0 0 0 1px oklch(0 0 0 / 0.12);
	}
	.legend .swatch:first-of-type {
		margin-left: 0;
	}
	.swatch.live {
		background: var(--live);
	}
	.swatch.preview {
		background: var(--preview);
	}
	.swatch.idle {
		background: var(--idle);
	}
</style>
