<script lang="ts">
	// The settings drawer (DESIGN.md → "Settings (slide-out drawer)"). A right-side
	// shadcn Sheet that slides in over the board — the board stays visible behind, so
	// you type the ATEM IP, Save, and watch the SourceChip go connecting → connected
	// without leaving the screen. It re-hosts the built SettingsPanel; it doesn't
	// rebuild the content. Opened by the corner gear and the SourceChip "Set up your
	// ATEM →" link (which lands on Source — the first group).
	//
	// Dismissal model (no X button — Cancel + the backdrop are the exits):
	//  • Clean (no unsaved edits): click-outside / Escape close it — nothing to lose.
	//  • Dirty (unsaved edits): click-outside / Escape are BLOCKED so a stray click
	//    can't silently discard your edits; Cancel ("discard & close") is the explicit
	//    way out, and Save commits. This is why we guard onInteractOutside/onEscapeKeydown
	//    on `dirty` rather than just letting the Sheet close freely.
	import SettingsIcon from "@lucide/svelte/icons/settings";
	import * as Sheet from "$lib/components/ui/sheet";
	import SettingsPanel from "./SettingsPanel.svelte";

	let {
		open = $bindable(false),
		onsave,
	}: { open?: boolean; onsave?: (ip: string) => void } = $props();

	// mirrors the panel's unsaved-changes state; guards accidental dismissal
	let dirty = $state(false);
</script>

<Sheet.Root bind:open>
	<!-- showCloseButton={false}: no X — Cancel and the backdrop are the exits.
	     Block backdrop-click / Escape while dirty so edits aren't lost by accident. -->
	<Sheet.Content
		side="right"
		showCloseButton={false}
		onInteractOutside={(e) => {
			if (dirty) e.preventDefault();
		}}
		onEscapeKeydown={(e) => {
			if (dirty) e.preventDefault();
		}}
		class="w-full gap-0 p-0 sm:max-w-[400px]"
	>
		<Sheet.Header class="flex-row items-center gap-2.5 border-b px-5 py-3.5">
			<SettingsIcon class="size-[18px] text-muted-foreground" />
			<Sheet.Title class="text-[0.95rem] font-semibold tracking-tight"
				>Settings</Sheet.Title
			>
		</Sheet.Header>

		<!-- min-h-0 lets the panel's internal scroll area shrink within the flex column -->
		<div class="min-h-0 flex-1">
			<SettingsPanel {onsave} bind:dirty onclose={() => (open = false)} />
		</div>
	</Sheet.Content>
</Sheet.Root>
