<script lang="ts">
	// The Wi-Fi credentials page — the third view in the light popover, reached from the
	// Configure pane's "Wi-Fi" row. Kept on its own page (not inline) so the Configure list
	// stays short. Flat sections, no bordered boxes — same language as the picker.
	//
	// SAVE-ONLY provisioning (v1.2 product decision): SET_WIFI persists the credentials and the
	// device confirms immediately — there is NO live/validating join GATE, so you can provision from
	// anywhere, not just in range of the target network. The creds apply when the device is
	// unplugged and deployed. So this page has exactly two states: the form, and a saved
	// confirmation.
	//
	// While cabled, the device also tries the network and streams wifiState/rssi. The saved view
	// shows that as a status line under the confirmation — never a gate: it catches a typo'd
	// password when the network is in range, and "can't join from here" is a normal answer when
	// it isn't, so it is worded as information, not an error.
	import { untrack } from "svelte";
	import type { DeviceWifiState } from "$ipc";
	import PopoverPageHeader from "$lib/components/board/PopoverPageHeader.svelte";
	import Eye from "@lucide/svelte/icons/eye";
	import EyeOff from "@lucide/svelte/icons/eye-off";
	import Check from "@lucide/svelte/icons/check";

	interface Props {
		mac: string;
		/** SSID the device is already provisioned to join, or null — opens straight on the form. */
		ssid: string | null;
		/** True while the device is cabled, so `wifiState`/`rssi` are live from its STATUS. */
		live?: boolean;
		/** The device's current join attempt, as it reports it. */
		wifiState?: DeviceWifiState | null;
		/** RSSI in dBm while joined, else null. */
		rssi?: number | null;
		/** Persist creds on the device (save-only; no join). */
		onprovisionwifi?: (ssid: string, pass: string) => void;
		/** Return to the Configure pane. */
		onback?: () => void;
	}
	let {
		mac,
		ssid,
		live = false,
		wifiState = null,
		rssi = null,
		onprovisionwifi,
		onback,
	}: Props = $props();

	// Signal in words, not dBm. Weak is flagged because a light that barely joins at the desk
	// is the one a venue AP drops once it's placed further away (docs/wifi-troubleshooting.md).
	function signal(dbm: number | null): { word: string; weak: boolean } {
		if (dbm === null) return { word: "", weak: false };
		if (dbm >= -60) return { word: "strong signal", weak: false };
		if (dbm >= -70) return { word: "good signal", weak: false };
		return { word: "weak signal", weak: true };
	}
	const joinStatus = $derived(live ? wifiState : null);
	const strength = $derived(signal(rssi));

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
		{#if joinStatus === "connected" || joinStatus === "joining" || joinStatus === "failed"}
			<div class="bg-border my-2.5 h-px"></div>
			<div class="flex items-start gap-2 text-[0.72rem]" role="status">
				<span
					class="mt-1 size-2 shrink-0 rounded-full"
					class:dot-ok={joinStatus === "connected" && !strength.weak}
					class:dot-warn={joinStatus === "failed" || strength.weak}
					class:dot-busy={joinStatus === "joining"}
				></span>
				<div class="min-w-0 flex-1">
					{#if joinStatus === "connected"}
						<p>Connected now{strength.word ? ` · ${strength.word}` : ""}</p>
						{#if strength.weak}
							<p class="text-muted-foreground mt-0.5">
								It may drop out if the light ends up further from the router.
							</p>
						{/if}
					{:else if joinStatus === "joining"}
						<p class="text-muted-foreground">Trying the network from here…</p>
					{:else}
						<p>Can't join it from here</p>
						<p class="text-muted-foreground mt-0.5">
							Fine if the network is out of range. If it isn't, check the password.
						</p>
					{/if}
				</div>
			</div>
		{/if}
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
	/* live join status dot: green is "fine" (as the Saved check above); "look at this" is a
	   hollow ring rather than a new colour, since the palette has no neutral warning hue. */
	.dot-ok {
		background: var(--preview);
	}
	.dot-warn {
		box-shadow: inset 0 0 0 1.5px var(--foreground);
	}
	.dot-busy {
		background: var(--muted-foreground);
		animation: pulse 1.2s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}

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
