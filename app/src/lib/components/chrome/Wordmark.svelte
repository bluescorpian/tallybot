<script lang="ts">
	// The TallyBot wordmark for the titlebar (DESIGN.md → "App chrome"). A two-segment
	// lockup: "Tally" in an opinionated italic serif rendered as an *outline* (no fill,
	// drawn-on-the-glass), and "BOT" in heavy blue Inter — the flat UI language, not the
	// board surface. Non-interactive so the titlebar drag region still works over it.
	//
	// Single home for tuning: the design knobs live as CSS custom properties at the top of
	// the <style> block — retune the overall size, each segment's size (--wm-tally-size /
	// --wm-bot-size, relative to the overall size), the "Tally" outline stroke width/colour,
	// the "BOT" blue, and the inter-segment gap there.
</script>

<span class="wordmark" aria-label="TallyBot">
	<span class="seg-tally" aria-hidden="true">Tally</span><span
		class="seg-bot"
		aria-hidden="true">BOT</span
	>
</span>

<style>
	.wordmark {
		/* ── Design knobs ─────────────────────────────────────────────── */
		--wm-size: 3.5rem; /* overall wordmark size — both segments scale off this */
		--wm-tally-size: 1em; /* "Tally" size, relative to --wm-size */
		--wm-bot-size: 0.7em; /* "BOT" size, relative to --wm-size */
		--wm-stroke: 1.7px; /* "Tally" outline thickness */
		--wm-stroke-color: oklch(35.614% 0.00908 268.426); /* outline ink */
		--wm-tally-blur: 0.5px; /* sub-pixel blur to soften outline aliasing (0 = off) */
		--wm-bot-color: var(--primary); /* azure blue */
		--wm-gap: 0.06em; /* optical space after the italic */
		--wm-bot-font: "Space Grotesk Variable"; /* "BOT" face (imported in layout.css) */

		display: inline-flex;
		align-items: baseline;
		line-height: 1;
		font-size: var(--wm-size);
		/* let pointer events fall through to the titlebar drag region */
		pointer-events: none;
		user-select: none;
		-webkit-user-select: none;
	}

	.seg-tally {
		font-family: "DM Serif Display", Georgia, serif;
		font-style: italic;
		font-weight: 400; /* DM Serif Display ships a single weight */
		font-size: var(--wm-tally-size);
		/* outline only: transparent fill + stroked ink */
		color: transparent;
		-webkit-text-stroke: var(--wm-stroke) var(--wm-stroke-color);
		/* smoother edges: precise curve rasterisation + grayscale AA, and paint the
		   stroke under any fill so it stays crisp. (Note: -webkit-text-stroke is
		   miter-joined with no linejoin control — for round serif corners use the SVG
		   variant below.) */
		text-rendering: geometricPrecision;
		paint-order: stroke fill;
		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
		filter: blur(
			var(--wm-tally-blur)
		); /* soften the aliased outline edge */
		margin-right: var(--wm-gap);
	}

	.seg-bot {
		font-family: var(--wm-bot-font), "Inter Variable", system-ui, sans-serif;
		font-style: italic;
		font-weight: 800;
		font-size: var(--wm-bot-size);
		letter-spacing: -0.05em;
		margin-left: -0.2em; /* optically tuck the segments together */
		color: var(--wm-bot-color);
	}
</style>
