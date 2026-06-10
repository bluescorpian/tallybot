<script lang="ts">
	// Shared header for the popover's sub-pages (Configure, Wi-Fi): a back button that returns
	// to the previous view, the page title, and a `subtitle` snippet for whatever each page
	// shows beneath it (a plain caption, or the light label + wired chip). Keeps the back-button
	// styling defined once so a theme/focus tweak lands on every sub-page.
	import type { Snippet } from "svelte";
	import ChevronLeft from "@lucide/svelte/icons/chevron-left";

	interface Props {
		title: string;
		/** Return to the previous view. */
		onback?: () => void;
		/** Content beneath the title (caption, label + status chip, …). */
		subtitle?: Snippet;
	}
	let { title, onback, subtitle }: Props = $props();
</script>

<div class="bg-muted/70 flex items-center gap-1.5 px-2 pt-2 pb-2.5">
	<button
		type="button"
		class="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring inline-flex size-7 cursor-pointer items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2"
		aria-label="Back"
		onclick={() => onback?.()}
	>
		<ChevronLeft class="size-4" />
	</button>
	<div class="flex flex-col">
		<span class="text-sm leading-tight font-medium">{title}</span>
		{#if subtitle}{@render subtitle()}{/if}
	</div>
</div>
