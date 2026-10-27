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
	// The assign / flash picker popover (docs/design.md → "Interaction").
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
	import TallyLightPcb from "$lib/components/board/TallyLightPcb.svelte";
	import BrightnessBar from "$lib/components/board/BrightnessBar.svelte";
	import DeviceConfig from "$lib/components/board/DeviceConfig.svelte";
	import DeviceWifi from "$lib/components/board/DeviceWifi.svelte";
	import type { BoardLight, LightActions } from "$lib/components/board/types";
	import Zap from "@lucide/svelte/icons/zap";
	import Check from "@lucide/svelte/icons/check";
	import Unplug from "@lucide/svelte/icons/unplug";
	import Usb from "@lucide/svelte/icons/usb";
	import Settings2 from "@lucide/svelte/icons/settings-2";
	import Network from "@lucide/svelte/icons/network";
	import CircleArrowUp from "@lucide/svelte/icons/circle-arrow-up";
	import ArrowUp from "@lucide/svelte/icons/arrow-up";
	import ChevronRight from "@lucide/svelte/icons/chevron-right";

	interface Props {
		/** The light, with its display state and current input already resolved by the board. */
		light: BoardLight;
		/** All selectable inputs, in switcher order. */
		inputs: PickerInput[];
		actions?: LightActions;
		open?: boolean;
		/**
		 * Bring this light into view with a one-off highlight (`pick` also opens its menu). A new
		 * `seq` replays it, e.g. the flasher pointing at the same light twice.
		 */
		reveal?: { pick: boolean; seq: number } | null;
	}
	let { light, inputs, actions = {}, open = $bindable(false), reveal = null }: Props = $props();
	const currentInputId = $derived(light.inputId);

	let trigger = $state<HTMLButtonElement | null>(null);
	let revealing = $state(false);
	$effect(() => {
		if (!reveal || !trigger) return;
		const { pick } = reveal;
		trigger.scrollIntoView({ block: "center", behavior: "smooth" });
		revealing = true;
		const done = setTimeout(() => (revealing = false), 2400);
		const opener = pick ? setTimeout(() => (open = true), 450) : undefined;
		return () => {
			clearTimeout(done);
			clearTimeout(opener);
			revealing = false;
		};
	});

	// Multi-page popover: the compact menu (assign / flash / brightness), the
	// Configure pane (transport mode list), and the Wi-Fi credentials page. Only a
	// wired (USB) device can be configured — provisioning rides the cable — so the
	// entry only appears then. Back to the menu once closed: after the exit animation, so the
	// page being dismissed doesn't swap to the menu while it fades out.
	let view = $state<"menu" | "config" | "wifi">("menu");
	const wired = $derived(light.transport === "usb");
	function onclosed(isOpen: boolean) {
		if (!isOpen) view = "menu";
	}

	// Width per page: compact menu, a slightly roomier mode list, and the Wi-Fi form.
	const contentClass = $derived(
		`${view === "wifi" ? "w-[15rem]" : view === "config" ? "w-[14rem]" : "w-[12.8rem]"} gap-0 overflow-hidden p-0`,
	);

	const dotColor: Record<PickerInput["state"], string> = {
		live: "var(--live)",
		preview: "var(--preview)",
		idle: "var(--idle)",
	};

	function assign(id: string) {
		if (id !== currentInputId) actions.assign?.(light.mac, id);
		open = false;
	}
	function updateFirmware() {
		open = false;
		actions.updateFirmware?.(light.mac);
	}
	function unassign() {
		actions.unassign?.(light.mac);
		open = false;
	}
</script>

<Popover bind:open onOpenChangeComplete={onclosed}>
	<PopoverTrigger>
		{#snippet child({ props })}
			<button
				{...props}
				bind:this={trigger}
				class="light-trigger"
				class:reveal={revealing}
				aria-label={`Light ${light.mac} — assign or flash`}
			>
				<TallyLightPcb mac={light.mac} label={light.label} state={light.state} {wired} />
				{#if light.firmwareOutdated}
					<!-- Static badge on the corner, like an app-icon badge: findable at a glance,
					     never animated, so it doesn't pull focus mid-show. Drawn on the trigger so
					     the locked PCB primitive stays untouched. -->
					<span class="fw-badge" title="Firmware update available"
						><ArrowUp class="size-2.5" strokeWidth={3} /></span
					>
				{/if}
			</button>
		{/snippet}
	</PopoverTrigger>

	<PopoverContent align="center" sideOffset={10} class={contentClass}>
		{#if view === "config"}
			<DeviceConfig {light} {actions} onwifi={() => (view = "wifi")} onback={() => (view = "menu")} />
		{:else if view === "wifi"}
			<DeviceWifi
				mac={light.mac}
				ssid={light.ssid}
				live={wired}
				wifiState={light.wifiState}
				rssi={light.rssi}
				onprovisionwifi={(ssid, pass) => actions.provisionWifi?.(light.mac, ssid, pass)}
				onback={() => (view = "config")}
			/>
		{:else}
			<!-- Header: which light, plus flash-to-identify -->
		<div class="bg-muted/70 flex items-center justify-between gap-2 px-3 pt-3 pb-2.5">
			<div class="flex flex-col">
				<span class="text-muted-foreground flex items-center gap-1.5 text-[0.68rem] leading-tight">
					Tally light
					{#if wired}
						<span class="text-signal inline-flex" title="Connected over USB" aria-label="Connected over USB">
							<Usb class="size-3.5" />
						</span>
					{/if}
				</span>
				<span class="flex items-center gap-1.5">
					<span class="font-mono text-sm font-medium tracking-wide">{light.label}</span>
					{#if light.bridge}
						<!-- Bridge marker: this device relays tally to ESP-NOW lights. Flat
						     cyan chip, matching the wired indicator's "activity, not state"
						     language (blue/cyan = a live signal path, never a tally colour). -->
						<span
							class="text-signal border-signal/40 inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[0.55rem] font-medium tracking-wide uppercase"
							title="Relays tally to ESP-NOW lights"
						>
							<Network class="size-2.5" /> Bridge
						</span>
					{/if}
				</span>
			</div>
			<div class="flex items-center gap-1.5">
				{#if wired}
					<!-- Configure: per-device settings (v1.2: connection / transport). Icon-only,
					     beside Flash; only a wired (USB) device can be provisioned. -->
					<button
						type="button"
						aria-label="Configure"
						title="Configure"
						class="text-foreground border-border bg-background hover:bg-accent focus-visible:ring-ring inline-flex size-[1.875rem] cursor-pointer items-center justify-center rounded-lg border shadow-sm transition-colors outline-none focus-visible:ring-2"
						onclick={() => (view = "config")}
					>
						<Settings2 class="size-4" />
					</button>
				{/if}
				<button
					type="button"
					aria-label="Flash to identify"
					title="Flash to identify"
					class="text-foreground border-border bg-background hover:bg-accent focus-visible:ring-ring inline-flex size-[1.875rem] cursor-pointer items-center justify-center rounded-lg border shadow-sm transition-colors outline-none focus-visible:ring-2"
					onclick={() => actions.flash?.(light.mac)}
				>
					<Zap class="size-4" />
				</button>
			</div>
		</div>

		<div class="bg-border h-px"></div>

		{#if light.firmwareOutdated}
			<!-- Firmware update: first under the header, since it's the one thing on this light
			     that wants attention. Opens the flasher drawer; a wireless light is walked
			     through plugging in there, so the row is always clickable. -->
			<button
				type="button"
				class="bg-primary/5 hover:bg-primary/10 focus-visible:bg-primary/10 flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left outline-none transition-colors"
				onclick={updateFirmware}
			>
				<CircleArrowUp class="text-primary size-4 shrink-0" />
				<span class="min-w-0 flex-1">
					<span class="block text-sm leading-tight font-medium"
						>Update firmware</span
					>
					<span class="text-muted-foreground block text-[0.68rem] leading-tight">
						{#if !wired}
							Plug into PC
						{:else if light.firmwareVersion && light.firmwareAvailable}
							<span class="font-mono">{light.firmwareVersion} → {light.firmwareAvailable}</span>
						{:else}
							About a minute, over USB
						{/if}
					</span>
				</span>
				<ChevronRight class="text-muted-foreground size-4 shrink-0" />
			</button>
			<div class="bg-border h-px"></div>
		{/if}

		<!-- Brightness: per-device LED level (0–10, 0 = off). Always shown — applies
		     whether the light is assigned or sitting in the dock. -->
		<div class="px-3 py-2.5">
			<p class="text-muted-foreground pb-1.5 text-[0.68rem]">Brightness</p>
			<BrightnessBar value={light.brightness} onchange={(v) => actions.setBrightness?.(light.mac, v)} />
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
		{/if}
	</PopoverContent>
</Popover>

<style>
	/* one-off "here it is" ring on a light the flasher just brought back (or is asking for) */
	.light-trigger.reveal {
		animation: reveal 2.4s ease-out;
	}
	@keyframes reveal {
		0%,
		60% {
			box-shadow: 0 0 0 4px color-mix(in oklab, var(--primary), transparent 35%);
		}
		100% {
			box-shadow: 0 0 0 4px transparent;
		}
	}
	/* Trigger wraps the locked PCB primitive; keep it a clean reset that
	   preserves the light's press + focus affordance. */
	.light-trigger {
		position: relative;
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
	/* firmware-update badge: the UI accent (never a tally colour), ringed in the board
	   colour so it reads as sitting on top of the light */
	.fw-badge {
		position: absolute;
		top: -5px;
		right: -5px;
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--primary);
		color: var(--primary-foreground);
		box-shadow: 0 0 0 2px var(--board);
		pointer-events: none;
	}
	.light-trigger:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 3px;
	}
</style>
