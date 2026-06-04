<script lang="ts">
	import { Dialog as SheetPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: SheetPrimitive.OverlayProps = $props();
</script>

<SheetPrimitive.Overlay
	bind:ref
	data-slot="sheet-overlay"
	class={cn("bg-black/30 supports-backdrop-filter:backdrop-blur-sm fixed inset-x-0 bottom-0 top-[var(--titlebar-h,0px)] z-50", className)}
	{...restProps}
/>
