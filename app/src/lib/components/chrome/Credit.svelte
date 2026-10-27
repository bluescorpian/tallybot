<script lang="ts">
	// Subtle attribution line (docs/design.md → "App chrome"). Absolutely positioned so it
	// floats in the board's bottom margin without taking a row — the board fills the whole
	// stage behind it. Only the link itself takes pointer events; hovering it turns the
	// heart red and beating.
	import HeartIcon from "@lucide/svelte/icons/heart";
</script>

<div class="credit">
	<a href="https://hrry.sh" target="_blank" rel="noreferrer">
		<span>Made with</span>
		<HeartIcon class="heart size-[11px]" fill="currentColor" stroke="none" />
		<span>by Harry</span>
	</a>
</div>

<style>
	.credit {
		position: absolute;
		bottom: 10px;
		left: 0;
		right: 0;
		z-index: 5;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		padding: 7px 0 9px;
		font-size: 0.7rem;
		color: var(--muted-foreground);
		opacity: 0.7;
		pointer-events: none;
	}

	a {
		display: flex;
		align-items: center;
		gap: 4px;
		color: inherit;
		text-decoration: none;
		pointer-events: auto;
	}

	a :global(.heart) {
		transition: color 0.2s;
	}

	a:hover :global(.heart),
	a:focus-visible :global(.heart) {
		color: #ef4444;
		animation: beat 0.9s ease-in-out infinite;
	}

	@keyframes beat {
		0%, 40%, 100% { transform: scale(1); }
		15% { transform: scale(1.3); }
		30% { transform: scale(1.1); }
	}

	@media (prefers-reduced-motion: reduce) {
		a:hover :global(.heart),
		a:focus-visible :global(.heart) {
			animation: none;
		}
	}
</style>
