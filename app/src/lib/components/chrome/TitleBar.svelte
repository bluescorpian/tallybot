<script lang="ts">
	// Custom frameless titlebar (DESIGN.md → "App chrome"). The native OS titlebar
	// is off (`decorations: false` in tauri.conf.json); this bar replaces it.
	// Flat UI language (zinc / Inter), not the neumorphic board surface.
	//
	// Left: the TallyBot wordmark. Right: settings gear, then the window controls
	// (minimize / maximize-restore / close). The bar itself is the drag region;
	// the interactive cluster is excluded so its buttons stay clickable.
	import { getCurrentWindow } from "@tauri-apps/api/window";
	import { onMount, onDestroy } from "svelte";
	import Wordmark from "./Wordmark.svelte";
	import SettingsIcon from "@lucide/svelte/icons/settings";
	import MinusIcon from "@lucide/svelte/icons/minus";
	import SquareIcon from "@lucide/svelte/icons/square";
	import CopyIcon from "@lucide/svelte/icons/copy";
	import XIcon from "@lucide/svelte/icons/x";

	let { onsettings }: { onsettings: () => void } = $props();

	// Window controls only work inside the Tauri webview. Under `pnpm dev` in a
	// plain browser (e.g. screenshot verification) the bar still renders fully, but
	// the OS actions no-op instead of throwing.
	const isTauri =
		typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

	let maximized = $state(false);
	let unlisten: (() => void) | undefined;

	onMount(async () => {
		if (!isTauri) return;
		const w = getCurrentWindow();
		maximized = await w.isMaximized();
		// `onResized` is the reliable signal — toggleMaximize() returns nothing and
		// the user can also maximize/snap via the compositor.
		unlisten = await w.onResized(async () => {
			maximized = await w.isMaximized();
		});
	});
	onDestroy(() => unlisten?.());

	const minimize = () => isTauri && getCurrentWindow().minimize();
	const toggleMaximize = () => isTauri && getCurrentWindow().toggleMaximize();
	const close = () => isTauri && getCurrentWindow().close();
</script>

<div class="titlebar" data-tauri-drag-region>
	<Wordmark />

	<div class="controls">
		<button
			class="tb-btn"
			onclick={onsettings}
			aria-label="Settings"
			title="Settings"
		>
			<SettingsIcon class="size-[16px]" />
		</button>
		<button
			class="tb-btn"
			onclick={minimize}
			aria-label="Minimize"
			title="Minimize"
		>
			<MinusIcon class="size-[16px]" />
		</button>
		<button
			class="tb-btn"
			onclick={toggleMaximize}
			aria-label={maximized ? "Restore" : "Maximize"}
			title={maximized ? "Restore" : "Maximize"}
		>
			{#if maximized}
				<CopyIcon class="size-[14px]" />
			{:else}
				<SquareIcon class="size-[14px]" />
			{/if}
		</button>
		<button
			class="tb-btn tb-close"
			onclick={close}
			aria-label="Close"
			title="Close"
		>
			<XIcon class="size-[16px]" />
		</button>
	</div>
</div>

<style>
	.titlebar {
		/* Always on top: the settings sheet (z-50) and everything else stay behind it,
		   so the window controls are never covered. No bottom border and no cream band:
		   the large wordmark + the top-anchored controls float over the board so the bar
		   doesn't read as a chunky header (DESIGN.md "deliberately thin chrome"). */
		position: relative;
		z-index: 60;
		display: flex;
		/* anchor both clusters to the true top edge so the controls sit in the window
		   corner, not vertically centred in a tall band */
		align-items: flex-start;
		justify-content: space-between;
		flex-shrink: 0;
		height: var(--titlebar-h, 36px);
		padding: 4px 6px 0 14px;
		background: transparent;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	/* shared button recipe (mirrors the old corner gear) */
	.tb-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 26px;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		transition:
			color 0.14s ease,
			background 0.14s ease,
			border-color 0.14s ease;
	}
	.tb-btn:hover {
		color: var(--foreground);
		background: color-mix(in oklch, var(--foreground), transparent 94%);
		border-color: var(--border);
	}
	.tb-btn:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}

	.tb-close:hover {
		color: var(--destructive-foreground, #fff);
		background: var(--destructive);
		border-color: var(--destructive);
	}
</style>
