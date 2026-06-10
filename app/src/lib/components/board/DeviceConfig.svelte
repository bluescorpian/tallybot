<script lang="ts">
	// The "Configure" pane — the second view inside the light popover (DESIGN.md →
	// v1.2 device configuration). It mirrors the picker's own language: flat sections
	// divided by hairlines, and a LIST (like "Assign to input") rather than bordered
	// cards. The home for per-device settings; for v1.2 its one section is CONNECTION
	// — what the device does when unplugged. The modes are a list, so v1.3 appends
	// "ESP-NOW" with no rework. Wi-Fi needs credentials, so picking it opens its OWN
	// page (DeviceWifi) rather than expanding inline — keeping this pane short.
	//
	// Flat shadcn surface (the popover is flat, not the neumorphic board). Cyan
	// `--signal` is activity (the wired chip), never a tally state.
	import type { DeviceTransport } from "$ipc";
	import type { ProvisionedMode } from "$lib/components/board/types";
	import PopoverPageHeader from "$lib/components/board/PopoverPageHeader.svelte";
	import ChevronRight from "@lucide/svelte/icons/chevron-right";
	import Wifi from "@lucide/svelte/icons/wifi";
	import WifiOff from "@lucide/svelte/icons/wifi-off";
	import Radio from "@lucide/svelte/icons/radio";
	import Usb from "@lucide/svelte/icons/usb";
	import Check from "@lucide/svelte/icons/check";

	interface Props {
		label: string;
		transport: DeviceTransport;
		provisionedMode: ProvisionedMode;
		ssid: string | null;
		/** Open the Wi-Fi credentials page. */
		onwifi?: () => void;
		/** Set the unplugged transport mode inline (No transmit has no config). */
		onsettransport?: (mode: "wifi" | "notx") => void;
		/** Return to the compact picker. */
		onback?: () => void;
	}
	let { label, transport, provisionedMode, ssid, onwifi, onsettransport, onback }: Props =
		$props();

	const wired = $derived(transport === "usb");

	// Mode list — data-driven so v1.3 appends a row, not a button. `page: true` rows
	// navigate to their own setup page; others commit inline.
	const MODES = $derived([
		{
			id: "wifi" as const,
			label: "Wi-Fi",
			desc: "Join a network wirelessly",
			page: true,
			disabled: false,
		},
		{
			id: "notx" as const,
			label: "No transmit",
			desc: "USB only — dark when unplugged",
			page: false,
			disabled: false,
		},
		{
			id: "espnow" as const,
			label: "ESP-NOW",
			desc: "Direct radio link, no network",
			page: false,
			disabled: true,
		},
	]);

	function pick(m: (typeof MODES)[number]) {
		if (m.disabled) return;
		if (m.id === "wifi") onwifi?.();
		else if (m.id === "notx") onsettransport?.("notx");
	}
</script>

<!-- Header: back to the picker, plus which light + its wired state -->
<PopoverPageHeader title="Configure" {onback}>
	{#snippet subtitle()}
		<span class="text-muted-foreground flex items-center gap-1.5 text-[0.68rem] leading-tight">
			<span class="font-mono">{label}</span>
			{#if wired}
				<span class="text-signal inline-flex items-center gap-0.5"><Usb class="size-3" /> wired</span>
			{/if}
		</span>
	{/snippet}
</PopoverPageHeader>

<div class="bg-border h-px"></div>

<!-- CONNECTION: a flat list of transport modes (current marked, like the assign list) -->
<div class="px-1.5 py-1.5">
	<p class="text-muted-foreground px-1.5 pt-1 pb-1.5 text-[0.68rem]">When unplugged, this light…</p>
	{#each MODES as m (m.id)}
		{@const current = !m.disabled && provisionedMode === m.id}
		<button
			type="button"
			class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors
				{m.disabled
				? 'cursor-default opacity-55'
				: 'hover:bg-accent focus-visible:bg-accent cursor-pointer'}"
			aria-current={current}
			disabled={m.disabled}
			onclick={() => pick(m)}
		>
			{#if m.id === "wifi"}<Wifi class="text-muted-foreground size-4 shrink-0" />{/if}
			{#if m.id === "notx"}<WifiOff class="text-muted-foreground size-4 shrink-0" />{/if}
			{#if m.id === "espnow"}<Radio class="text-muted-foreground size-4 shrink-0" />{/if}
			<span class="min-w-0 flex-1">
				<span class="flex items-center gap-1.5 text-sm leading-tight {current ? 'font-medium' : ''}">
					<span class="shrink-0">{m.label}</span>
					{#if m.disabled}
						<span
							class="text-muted-foreground border-border rounded-full border px-1.5 py-px text-[0.58rem] font-normal"
							>Soon</span
						>
					{:else if m.id === "wifi" && provisionedMode === "wifi" && ssid}
						<!-- The configured network, shown as a pill beside "Wi-Fi" so it reads at a
						     glance; long SSIDs truncate with the full name on hover. -->
						<span
							class="text-muted-foreground border-border max-w-[6.5rem] truncate rounded-full border px-1.5 py-px font-mono text-[0.58rem] font-normal"
							title={ssid}>{ssid}</span
						>
					{/if}
				</span>
				<span class="text-muted-foreground block truncate text-[0.68rem] leading-tight">{m.desc}</span>
			</span>
			{#if current}
				<Check class="text-primary size-4 shrink-0" />
			{:else if m.page && !m.disabled}
				<ChevronRight class="text-muted-foreground size-4 shrink-0" />
			{/if}
		</button>
	{/each}
</div>

<div class="bg-border h-px"></div>

<p class="text-muted-foreground flex items-start gap-1.5 px-3 py-2.5 text-[0.68rem] leading-snug">
	<Usb class="mt-px size-3 shrink-0" />
	<span>While it’s plugged in, this light always runs over USB.</span>
</p>
