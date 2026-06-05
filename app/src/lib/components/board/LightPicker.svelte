<script lang="ts" module>
	export interface PickerInput {
		/** Stable input id (ATEM input number, as a string). */
		id: string;
		/** Display label — comes from the source (ATEM's own input names). */
		label: string;
		/** Live tally state of the input, so the picker doubles as a monitor. */
		state: "live" | "preview" | "idle";
	}
</script>

<script lang="ts">
	// The assign / flash picker popover (DESIGN.md → "Interaction").
	//
	// A plain click on any light opens this popover. It lists the source's
	// inputs (by their labels) with the current one marked, and offers the two
	// other actions that have to live somewhere off the bare light: flash-to-
	// identify and unassign. It is deliberately a *flat shadcn* surface, not a
	// bespoke neumorphic board element — standard UI sits on top of the canvas.
	//
	// The light itself (TallyLightPcb, a locked primitive) is the trigger/anchor:
	// we render it inside the trigger button via bits-ui's `child` snippet so the
	// button carries all the a11y + positioning, and the PCB stays a plain <div>
	// (no nested <button>).
	import {
		Popover,
		PopoverContent,
		PopoverTrigger,
	} from "$lib/components/ui/popover/index.js";
	import TallyLightPcb, {
		type LightState,
	} from "$lib/components/board/TallyLightPcb.svelte";
	import BrightnessBar from "$lib/components/board/BrightnessBar.svelte";
	import Zap from "@lucide/svelte/icons/zap";
	import Check from "@lucide/svelte/icons/check";
	import Unplug from "@lucide/svelte/icons/unplug";

	interface Props {
		mac: string;
		/** Short 2-octet form shown on the light and in the header. */
		label: string;
		state?: LightState;
		/** All selectable inputs, in switcher order. */
		inputs: PickerInput[];
		/** Currently assigned input id, or null when the light is unassigned. */
		currentInputId?: string | null;
		/** This device's LED brightness as the protocol byte (0–255). */
		brightness?: number;
		onassign?: (inputId: string) => void;
		onunassign?: () => void;
		onflash?: () => void;
		/** Emits the new brightness byte (0–255) when the level changes. */
		onbrightness?: (value: number) => void;
		open?: boolean;
	}
	let {
		mac,
		label,
		state = "idle",
		inputs,
		currentInputId = null,
		brightness = 128,
		onassign,
		onunassign,
		onflash,
		onbrightness,
		open = $bindable(false),
	}: Props = $props();

	const dotColor: Record<PickerInput["state"], string> = {
		live: "var(--live)",
		preview: "var(--preview)",
		idle: "var(--idle)",
	};

	function assign(id: string) {
		if (id !== currentInputId) onassign?.(id);
		open = false;
	}
	function unassign() {
		onunassign?.();
		open = false;
	}
</script>

<Popover bind:open>
	<PopoverTrigger>
		{#snippet child({ props })}
			<button {...props} class="light-trigger" aria-label={`Light ${mac} — assign or flash`}>
				<TallyLightPcb {mac} {label} {state} />
			</button>
		{/snippet}
	</PopoverTrigger>

	<PopoverContent align="center" sideOffset={10} class="w-[12.8rem] gap-0 overflow-hidden p-0">
		<!-- Header: which light, plus flash-to-identify -->
		<div class="bg-muted/70 flex items-center justify-between gap-2 px-3 pt-3 pb-2.5">
			<div class="flex flex-col">
				<span class="text-muted-foreground text-[0.68rem] leading-tight">Tally light</span>
				<span class="font-mono text-sm font-medium tracking-wide">{label}</span>
			</div>
			<button
				type="button"
				class="text-foreground border-border bg-background hover:bg-accent focus-visible:ring-ring inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium shadow-sm transition-colors outline-none focus-visible:ring-2"
				onclick={() => onflash?.()}
			>
				<Zap class="size-3.5" />
				Flash
			</button>
		</div>

		<div class="bg-border h-px"></div>

		<!-- Brightness: per-device LED level (0–10, 0 = off). Always shown — applies
		     whether the light is assigned or sitting in the dock. -->
		<div class="px-3 py-2.5">
			<p class="text-muted-foreground pb-1.5 text-[0.68rem]">Brightness</p>
			<BrightnessBar value={brightness} onchange={(v) => onbrightness?.(v)} />
		</div>

		<div class="bg-border h-px"></div>

		<!-- Input list: current marked; click to (re)assign. With no inputs to offer
		     (no source connected) the list gives way to a note — flash still works. -->
		{#if inputs.length === 0}
			<div class="px-3 py-3">
				<p class="text-muted-foreground text-[0.72rem] leading-snug">
					Connect a source to assign this light to an input.
				</p>
			</div>
		{:else}
			<div class="px-1.5 py-1.5">
				<p class="text-muted-foreground px-1.5 pt-1 pb-1.5 text-[0.68rem]">Assign to input</p>
					<div class="-mx-0.5 max-h-60 overflow-y-auto px-0.5">
					{#each inputs as input (input.id)}
						{@const current = input.id === currentInputId}
						<button
							type="button"
							class="hover:bg-accent focus-visible:bg-accent flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm outline-none transition-colors"
							aria-current={current}
							onclick={() => assign(input.id)}
						>
							<span
								class="size-2.5 shrink-0 rounded-full ring-1 ring-black/5"
								style:background-color={dotColor[input.state]}
							></span>
							<span class="flex-1 truncate {current ? 'font-medium' : ''}">{input.label}</span>
							{#if current}
								<Check class="text-primary size-4 shrink-0" />
							{/if}
						</button>
					{/each}
				</div>
			</div>
		{/if}

		{#if currentInputId !== null}
			<div class="bg-border h-px"></div>
			<div class="bg-muted/70 p-1.5">
				<button
					type="button"
					class="text-destructive/85 hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm outline-none transition-colors"
					onclick={unassign}
				>
					<Unplug class="size-4 shrink-0" />
					Unassign
				</button>
			</div>
		{/if}
	</PopoverContent>
</Popover>

<style>
	/* Trigger wraps the locked PCB primitive; keep it a clean reset that
	   preserves the light's press + focus affordance. */
	.light-trigger {
		display: block;
		width: 100%;
		padding: 0;
		border: none;
		background: none;
		border-radius: 12px;
		cursor: pointer;
		transition: transform 0.08s ease;
	}
	.light-trigger:active {
		transform: translateY(1px);
	}
	.light-trigger:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 3px;
	}
</style>
