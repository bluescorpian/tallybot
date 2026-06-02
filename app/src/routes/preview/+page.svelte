<script lang="ts">
	// /preview — throwaway canvas. Exercises the locked Trace primitive across a few
	// specimen paths, with an active toggle + width slider.
	import Trace from "$lib/components/board/Trace.svelte";

	type Pt = { x: number; y: number };

	const SPECIMENS: { name: string; points: Pt[] }[] = [
		{ name: "straight", points: [{ x: 70, y: 22 }, { x: 70, y: 158 }] },
		{
			name: "45° jog",
			points: [
				{ x: 48, y: 22 },
				{ x: 48, y: 66 },
				{ x: 92, y: 110 },
				{ x: 92, y: 158 },
			],
		},
		{
			name: "45° elbow",
			points: [
				{ x: 38, y: 22 },
				{ x: 38, y: 92 },
				{ x: 66, y: 120 },
				{ x: 124, y: 120 },
			],
		},
	];
	const dBySpec = SPECIMENS.map((s) =>
		s.points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" "),
	);

	let active = $state(true);
	let width = $state(5);
</script>

<div class="page">
	<header class="intro">
		<h1>Trace</h1>
		<p>Single-colour stroked path. Cyan when active, grey at rest.</p>
		<div class="controls">
			<label><input type="checkbox" bind:checked={active} /> active</label>
			<label class="w">
				width
				<input type="range" min="1" max="14" step="0.5" bind:value={width} />
				<output>{width}</output>
			</label>
		</div>
	</header>

	<div class="tiles">
		{#each SPECIMENS as spec, ti (spec.name)}
			<figure class="tile">
				<div class="board">
					<svg viewBox="0 0 140 180" aria-hidden="true">
						<Trace d={dBySpec[ti]} {active} {width} />
					</svg>
				</div>
				<figcaption>{spec.name}</figcaption>
			</figure>
		{/each}
	</div>
</div>

<style>
	.page {
		max-width: 940px;
		margin: 0 auto;
		padding: 40px 24px 72px;
	}
	.intro h1 {
		font-size: 1.35rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--foreground);
	}
	.intro p {
		margin-top: 8px;
		color: var(--muted-foreground);
		font-size: 0.9rem;
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 24px;
		margin-top: 16px;
		font-family: var(--font-mono);
		font-size: 0.78rem;
		color: var(--foreground);
	}
	.controls label {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
	}
	.controls output {
		color: var(--muted-foreground);
		min-width: 2.5ch;
	}

	.tiles {
		margin-top: 28px;
		display: flex;
		flex-wrap: wrap;
		gap: 24px;
	}
	.tile {
		margin: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
	}
	figcaption {
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--muted-foreground);
	}
	.board {
		width: 200px;
		border: 1px solid var(--border);
		border-radius: 16px;
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
	.board svg {
		display: block;
		width: 100%;
		height: auto;
	}
</style>
