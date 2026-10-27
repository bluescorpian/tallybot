<script module lang="ts">
	import { wifiCredentialsProblem } from "$protocol";

	/** The SSID to send: what was typed, trimmed. Empty means no network was entered. */
	export function cleanSsid(raw: string): string {
		return raw.trim();
	}

	/**
	 * Why a light can't take what was typed (too long for it), or null. The engine refuses the
	 * same credentials, so a form that sends them anyway gets a notice, never a silent drop.
	 */
	export function credentialsProblem(ssid: string, password: string): string | null {
		return wifiCredentialsProblem(cleanSsid(ssid), password);
	}
</script>

<script lang="ts">
	// A light's Wi-Fi credential fields: network name and password, with a show/hide toggle.
	// Shared by the Configure pane's Wi-Fi page (DeviceWifi) and the flasher's Settings step,
	// so credential handling changes in one place. Read the SSID through `cleanSsid`.
	//
	// The password is never read back off a device (the firmware doesn't report it), so callers
	// always start it blank; the SSID may be seeded from the one the device reports.
	import Eye from "@lucide/svelte/icons/eye";
	import EyeOff from "@lucide/svelte/icons/eye-off";

	interface Props {
		/** Prefix for the inputs' ids, unique on the page. */
		id: string;
		ssid: string;
		password: string;
	}
	let { id, ssid = $bindable(), password = $bindable() }: Props = $props();

	let reveal = $state(false);
	const problem = $derived(credentialsProblem(ssid, password));
</script>

<label class="text-muted-foreground block text-[0.7rem]" for="{id}-ssid">Network (SSID)</label>
<input
	id="{id}-ssid"
	class="cfg-input mt-1 font-mono"
	type="text"
	autocomplete="off"
	spellcheck="false"
	placeholder="Network name"
	bind:value={ssid}
/>
<label class="text-muted-foreground mt-2.5 block text-[0.7rem]" for="{id}-pass">Password</label>
<div class="relative mt-1">
	<input
		id="{id}-pass"
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
{#if problem}
	<p class="text-destructive mt-1.5 text-[0.7rem] leading-snug" role="alert">{problem}</p>
{/if}

<style>
	/* flat inputs matching the picker's existing affordances. */
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
		transition:
			border-color 0.12s ease,
			box-shadow 0.12s ease;
	}
	.cfg-input:focus-visible {
		border-color: var(--ring);
		box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring), transparent 70%);
	}
</style>
