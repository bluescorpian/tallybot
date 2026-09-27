<script lang="ts">
	// Subtle attribution line (DESIGN.md → "App chrome"). Absolutely positioned and
	// non-interactive so it floats in the board's bottom margin without taking a row
	// — the board fills the whole stage behind it.
	import HeartIcon from "@lucide/svelte/icons/heart";
</script>

<div class="credit">
	<span>Made with</span>
	<HeartIcon class="size-[11px]" fill="currentColor" stroke="none" />
	<span>by Harry</span>
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
</style>
