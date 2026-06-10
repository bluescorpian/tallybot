<script lang="ts">
	// The Wi-Fi credentials page — the third view in the light popover, reached from the
	// Configure pane's "Wi-Fi" row. Kept on its own page (not inline) so the Configure list
	// stays short. Flat sections, no bordered boxes — same language as the picker.
	//
	// SAVE-ONLY provisioning (v1.2 product decision): SET_WIFI persists the credentials and the
	// device confirms immediately — there is NO live/validating join GATE, so you can provision from
	// anywhere, not just in range of the target network. The creds apply when the device is
	// unplugged and deployed. So this page has exactly two states: the form, and a saved
	// confirmation — no joining spinner, no failure, no RSSI. (The device does keep a warm WiFi
	// association while cabled and streams live wifiState/rssi, but by product choice we don't gate
	// or display it here — a future iteration could show "connected · −55 dBm" as confirmation.)
	import { untrack } from "svelte";
	import PopoverPageHeader from "$lib/components/board/PopoverPageHeader.svelte";
	import Eye from "@lucide/svelte/icons/eye";
	import EyeOff from "@lucide/svelte/icons/eye-off";
	import Check from "@lucide/svelte/icons/check";

	interface Props {
		mac: string;
		/** SSID the device is already provisioned to join, or null — opens straight on the form. */
		ssid: string | null;
		/** Persist creds on the device (save-only; no join). */
		onprovisionwifi?: (ssid: string, pass: string) => void;
		/** Return to the Configure pane. */
		onback?: () => void;
	}
	let { mac, ssid, onprovisionwifi, onback }: Props = $props();

	// SSID seeds from the stored network (for reconfigure); password is never read back off a
	// device, so it always starts blank. A device with stored creds opens on its summary; a fresh
	// one (or "Change network") opens on the form. `editing` is the sole view driver — it flips to
	// the summary the instant we save, without waiting on the snapshot's `ssid` to round-trip.
	let ssidInput = $state(untrack(() => ssid) ?? "");
	let password = $state("");
	let reveal = $state(false);
	let editing = $state(untrack(() => !ssid));

	function save() {
		if (!ssidInput.trim()) return;
		editing = false;
		onprovisionwifi?.(ssidInput.trim(), password);
	}
</script>

<!-- Header: back to Configure -->
<PopoverPageHeader title="Wi-Fi" {onback}>
	{#snippet subtitle()}
		<span class="text-muted-foreground text-[0.68rem] leading-tight">Joins when unplugged</span>
	{/snippet}
</PopoverPageHeader>

<div class="bg-border h-px"></div>

<div class="px-3 py-3">
	{#if !editing}
		<div class="flex items-start gap-2 text-[0.82rem]">
			<Check class="mt-0.5 size-4 shrink-0 text-[var(--preview)]" />
			<div class="min-w-0 flex-1">
				<p class="font-medium">Saved</p>
				<p class="text-muted-foreground mt-0.5 truncate text-[0.72rem]">
					Joins “{ssidInput}” when unplugged.
				</p>
				<p class="text-muted-foreground mt-0.5 text-[0.72rem]">Safe to unplug.</p>
			</div>
		</div>
		<button
			type="button"
			class="btn-ghost mt-3 w-full"
			onclick={() => ((editing = true), (password = ""))}
		>
			Change network
		</button>
	{:else}
		<label class="text-muted-foreground block text-[0.7rem]" for="wifi-ssid-{mac}">Network (SSID)</label>
		<input
			id="wifi-ssid-{mac}"
			class="cfg-input mt-1 font-mono"
			type="text"
			autocomplete="off"
			spellcheck="false"
			placeholder="Network name"
			bind:value={ssidInput}
		/>
		<label class="text-muted-foreground mt-2.5 block text-[0.7rem]" for="wifi-pass-{mac}">Password</label>
		<div class="relative mt-1">
			<input
				id="wifi-pass-{mac}"
				class="cfg-input pr-8"
				type={reveal ? "text" : "password"}
				autocomplete="off"
				placeholder="Password"
				bind:value={password}
			/>
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground absolute inset-y-0 right-1.5 inline-flex items-center"
				aria-label={reveal ? "Hide password" : "Show password"}
				onclick={() => (reveal = !reveal)}
			>
				{#if reveal}<EyeOff class="size-3.5" />{:else}<Eye class="size-3.5" />{/if}
			</button>
		</div>
		<p class="text-muted-foreground mt-2 text-[0.68rem] leading-snug">
			Stored on the device — it joins this network when unplugged. No need to be in range now.
		</p>
		<button type="button" class="btn-primary mt-3 w-full" disabled={!ssidInput.trim()} onclick={save}>
			Save network
		</button>
	{/if}
</div>

<style>
	/* flat inputs/buttons matching the picker's existing affordances. */
	.cfg-input {
		width: 100%;
		height: 1.95rem;
		padding: 0 0.5rem;
		font-size: 0.8rem;
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		background: var(--background);
		color: var(--foreground);
		outline: none;
		transition: border-color 0.12s ease, box-shadow 0.12s ease;
	}
	.cfg-input:focus-visible {
		border-color: var(--ring);
		box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring), transparent 70%);
	}
	.btn-primary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 1.95rem;
		padding: 0 0.75rem;
		font-size: 0.8rem;
		font-weight: 500;
		border-radius: 0.5rem;
		background: var(--primary);
		color: var(--primary-foreground, oklch(1 0 0));
		cursor: pointer;
		transition: opacity 0.12s ease, filter 0.12s ease;
	}
	.btn-primary:hover:not(:disabled) {
		filter: brightness(1.05);
	}
	.btn-primary:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.btn-ghost {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 1.8rem;
		padding: 0 0.6rem;
		font-size: 0.78rem;
		font-weight: 500;
		border-radius: 0.5rem;
		border: 1px solid var(--border);
		background: var(--background);
		color: var(--foreground);
		cursor: pointer;
		transition: background-color 0.12s ease;
	}
	.btn-ghost:hover {
		background: var(--accent);
	}
</style>
