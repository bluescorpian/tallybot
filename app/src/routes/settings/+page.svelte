<script lang="ts">
	// Standalone settings route — kept as a preview/iteration surface for the settings
	// content. The real entry point in the app is the slide-out drawer (SettingsSheet)
	// over the board; both host the same SettingsPanel, so the content lives in one
	// place (DESIGN.md → "Settings (slide-out drawer)").
	import SettingsIcon from "@lucide/svelte/icons/settings";
	import SettingsPanel from "$lib/components/settings/SettingsPanel.svelte";
</script>

<div class="shell">
	<header class="bar">
		<SettingsIcon class="size-[18px] text-muted-foreground" />
		<h1>Settings</h1>
	</header>

	<!-- min-h-0 flex-1 constrains the panel's height so its internal area scrolls -->
	<div class="body">
		<SettingsPanel />
	</div>
</div>

<style>
	/* Window shell — a calm, flat settings surface. The panel supplies the cards +
	   footer; this just frames it with a title bar and fills the viewport. */
	.shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
		min-height: 0;
		background: var(--muted);
		color: var(--foreground);
	}

	/* title bar */
	.bar {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 14px 20px;
		border-bottom: 1px solid var(--border);
		background: color-mix(in oklch, var(--background), transparent 8%);
		backdrop-filter: blur(6px);
		flex-shrink: 0;
	}
	.bar h1 {
		font-size: 0.95rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.body {
		flex: 1;
		min-height: 0;
	}
</style>
