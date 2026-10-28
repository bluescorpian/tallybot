<script lang="ts" module>
	import type { BridgeTxPower, EspNowSettings, WifiScanEvent } from "$ipc";

	export interface EspNowBridge {
		mac: string;
		protocolVersion: number | null;
	}

	/** What the panel needs from the engine for this group: its live state and the commands. */
	export interface EspNowHost {
		/** The snapshot's `espnow`. */
		readonly settings: EspNowSettings;
		/** The latest channel scan event, or null. */
		readonly scan: WifiScanEvent | null;
		/** Whether any light is on USB, to say why nothing can scan. */
		readonly anyCabled: boolean;
		/** The running bridge (its MAC and firmware protocol), to say when the power can't change. */
		readonly bridge: EspNowBridge | null;
		scanWifi(): void;
		setChannel(channel: number): void;
		setTxPower(txPower: BridgeTxPower): void;
	}
</script>

<script lang="ts">
	// Settings → ESP-NOW (docs/design.md → "Settings"; docs/spec/esp-now-channel-selection.md): the
	// rig's channel and the bridge's transmit power. Both are setting *values*: the panel owns
	// their drafts and commits them with its shared Save, so this group only edits them. Scan is
	// an immediate action that fills the channel draft, never commits it.
	//
	// Rendered inside SettingsPanel, whose group styles (.card, .row, .field, .hint, …) it shares.
	import Search from "@lucide/svelte/icons/search";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import Info from "@lucide/svelte/icons/info";

	import { ESPNOW_CHANNEL_MAX, ESPNOW_CHANNEL_MIN, supportsChannelSelection } from "$protocol";
	import { shortMac } from "$lib/boardState";
	import { Button } from "$lib/components/ui/button";
	import * as Select from "$lib/components/ui/select";

	let {
		settings,
		scan,
		anyCabled,
		bridge,
		savedChannel,
		channel = $bindable(),
		txPower = $bindable(),
		onscan,
	}: {
		/** The engine's ESP-NOW settings (the snapshot's `espnow`). */
		settings: EspNowSettings;
		/** The latest channel scan event, or null. */
		scan: WifiScanEvent | null;
		/** Whether any light is on USB, to say why nothing can scan. */
		anyCabled: boolean;
		/** The running bridge, or null. */
		bridge: EspNowBridge | null;
		/** The committed channel, to tell when the draft would move the rig. */
		savedChannel: number;
		/** Draft channel (committed by the panel's Save). */
		channel: number;
		/** Draft bridge transmit power (committed by the panel's Save). */
		txPower: BridgeTxPower;
		onscan: () => void;
	} = $props();

	const CHANNELS = Array.from(
		{ length: ESPNOW_CHANNEL_MAX - ESPNOW_CHANNEL_MIN + 1 },
		(_, i) => ESPNOW_CHANNEL_MIN + i,
	);
	const TX_LABEL: Record<BridgeTxPower, string> = { full: "Full", reduced: "Reduced" };

	// ── Scan ──────────────────────────────────────────────────────────────────────
	// A result is shown only for a scan this panel saw run (clicked here, or already running when
	// the drawer opened), so a result from an earlier visit doesn't reappear. `before` is the event
	// on screen when Scan was clicked: until a different one arrives, the click is still in flight.
	let watching = $state(false);
	let before = $state<WifiScanEvent | null>(null);
	$effect(() => {
		if (scan?.status === "scanning") watching = true;
	});
	const scanning = $derived(scan?.status === "scanning" || (watching && scan === before));
	const result = $derived(watching && !scanning && scan?.status === "done" ? scan : null);

	function runScan() {
		before = scan;
		watching = true;
		onscan();
	}

	// Who the next scan would run on. While one runs, the event says who's actually scanning.
	const scanner = $derived(scanning && scan?.scanner ? scan.scanner : settings.scanner);
	const noScannerReason = $derived(
		anyCabled
			? "No light on USB has firmware new enough to scan. Update one, or plug in another light."
			: "Plug a tally light into this PC by USB to scan for a quiet channel.",
	);

	const congestion = $derived(result && !result.error ? result.congestion : []);
	const maxScore = $derived(Math.max(1, ...congestion.map((c) => c.score)));
	const suggested = $derived(result?.suggestedChannel ?? null);
	const networks = (n: number) => `${n} Wi-Fi ${n === 1 ? "network" : "networks"}`;

	// ── Bridge power ───────────────────────────────────────────────────────────────
	// The engine sends the power only to a running bridge whose firmware takes it (a later one gets
	// it when it starts), so say when the setting has nothing to act on. Save still takes it.
	const txPowerIdle = $derived(
		bridge === null
			? "No bridge is running. The power applies once one with current firmware starts."
			: bridge.protocolVersion !== null && !supportsChannelSelection(bridge.protocolVersion)
				? `Bridge ${shortMac(bridge.mac)} runs firmware too old to change its power, so it stays at Full until it's updated.`
				: null,
	);

	// ── Channel change ─────────────────────────────────────────────────────────────
	const moving = $derived(channel !== savedChannel);
</script>

<section>
	<div class="sec-head">
		<h2>ESP-NOW</h2>
	</div>

	<div class="card">
		<!-- Channel + Scan -->
		<div class="field">
			<div class="label-col">
				<span class="lbl">Channel</span>
				<span class="hint">
					The 2.4 GHz channel the bridge and its wireless lights share.
				</span>
			</div>

			<div class="field-controls">
				<Select.Root
					type="single"
					bind:value={() => String(channel), (v) => (channel = Number(v))}
				>
					<Select.Trigger class="flex-1" aria-label="ESP-NOW channel">
						Channel {channel}
					</Select.Trigger>
					<Select.Content>
						{#each CHANNELS as c (c)}
							<Select.Item
								value={String(c)}
								label={c === suggested ? `Channel ${c} · quietest` : `Channel ${c}`}
							/>
						{/each}
					</Select.Content>
				</Select.Root>
				<Button
					variant="outline"
					onclick={runScan}
					disabled={scanning || scanner === null}
				>
					{#if scanning}
						<LoaderCircle class="animate-spin" />
					{:else}
						<Search />
					{/if}
					Scan
				</Button>
			</div>

			<!-- Before the click: why Scan is off, or that this scan takes the bridge off-channel -->
			{#if scanner === null && !scanning}
				<div class="field-msg muted">{noScannerReason}</div>
			{:else if scanner?.bridge}
				<div class="callout">
					<TriangleAlert class="size-3.5 shrink-0" />
					<p>
						{#if scanning}
							Scanning from the bridge: the rig may blink for a moment.
						{:else}
							Only the bridge can scan, and it leaves its channel to do it, so the rig may
							blink. Don't scan mid-show.
						{/if}
					</p>
				</div>
			{/if}

			{#if scanning}
				<div class="field-msg">
					<LoaderCircle class="size-3.5 animate-spin" />
					<span
						>Scanning from light <span class="mono"
							>{scanner ? shortMac(scanner.mac) : ""}</span
						>… <em>~5s</em></span
					>
				</div>
			{:else if result?.error}
				<div class="field-msg muted" role="alert">
					<span class="select-text">The scan didn't run: {result.error}</span>
				</div>
			{:else if result}
				<!-- Per-channel congestion 1–13: a bar per channel, taller is busier. Any bar fills
				     the picker; the suggestion is one of 1, 6, 11, 13 (the non-overlapping set). -->
				<div class="scan-result">
					<div class="field-msg">
						Heard {networks(result.accessPoints.length)}. Shorter bars are quieter; pick one
						to fill the channel.
					</div>
					<div class="bars" role="group" aria-label="Congestion per channel">
						{#each congestion as c (c.channel)}
							<button
								type="button"
								class="bar"
								class:candidate={c.candidate}
								class:picked={c.channel === channel}
								class:suggested={c.channel === suggested}
								title="Channel {c.channel}: {networks(c.accessPoints)} overlap it"
								aria-label="Channel {c.channel}, {networks(c.accessPoints)} overlap it"
								aria-pressed={c.channel === channel}
								onclick={() => (channel = c.channel)}
							>
								<span class="fill-track">
									<span
										class="fill"
										style:height="{Math.max(4, (c.score / maxScore) * 100)}%"
									></span>
								</span>
								<span class="num">{c.channel}</span>
							</button>
						{/each}
					</div>
					{#if suggested !== null}
						<div class="suggest">
							<span>
								{#if suggested === savedChannel}
									The rig is already on the quietest channel, <strong>{suggested}</strong>.
								{:else}
									Quietest: <strong>channel {suggested}</strong>.
								{/if}
							</span>
							{#if suggested !== channel}
								<Button variant="outline" size="sm" onclick={() => (channel = suggested!)}
									>Use {suggested}</Button
								>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			<!-- What saving this channel does to the rig, and who can't follow. Warns, never refuses. -->
			{#if moving}
				<div class="callout">
					<Info class="size-3.5 shrink-0" />
					<div>
						<p>
							{#if bridge}
								Saving moves the rig to channel {channel}. Wireless lights follow it at once; one
								that is off or out of range finds the rig within about 40 seconds once it can hear
								it.
							{:else}
								Saving moves the rig to channel {channel}. No bridge is running, so wireless lights
								find the rig within about 40 seconds of one starting, once they can hear it.
							{/if}
						</p>
						{#if settings.legacyLights.length}
							<p>
								<strong>Can't follow by themselves:</strong>
								{#each settings.legacyLights as mac, i (mac)}{i ? ", " : ""}<span class="mono"
										>{shortMac(mac)}</span
									>{/each}. Plug each into this PC and move it from its menu, or update its
								firmware.
							</p>
						{/if}
						{#if settings.unseenLights.length}
							<p>
								<strong>Not seen since TallyBot updated, so may not follow:</strong>
								{#each settings.unseenLights as mac, i (mac)}{i ? ", " : ""}<span class="mono"
										>{shortMac(mac)}</span
									>{/each}.
							</p>
						{/if}
					</div>
				</div>
			{/if}
		</div>

		<!-- Bridge transmit power: runtime-only on the engine, so it says it won't stick -->
		<div class="row">
			<div class="label-col">
				<span class="lbl">Bridge transmit power</span>
				<span class="hint">
					Some bridge boards hold the link better at reduced power. Back to Full when TallyBot
					restarts.
				</span>
				{#if txPowerIdle}
					<span class="hint power-idle">
						<Info class="size-3.5 shrink-0" />
						<span>{txPowerIdle}</span>
					</span>
				{/if}
			</div>
			<Select.Root type="single" bind:value={() => txPower, (v) => (txPower = v as BridgeTxPower)}>
				<Select.Trigger class="w-28" aria-label="Bridge transmit power">
					{TX_LABEL[txPower]}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="full" label="Full" />
					<Select.Item value="reduced" label="Reduced" />
				</Select.Content>
			</Select.Root>
		</div>
	</div>
</section>

<style>
	.mono {
		font-family: var(--font-mono);
		font-size: 0.72rem;
	}
	.power-idle {
		display: flex;
		gap: 6px;
		margin-top: 4px;
	}
	.power-idle :global(svg) {
		margin-top: 2px;
	}
	.field-msg.muted {
		line-height: 1.45;
	}

	/* a neutral note inside the field: the scan's bridge warning, the channel-change consequences */
	.callout {
		display: flex;
		gap: 8px;
		margin-top: 11px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--muted);
		font-size: 0.78rem;
		line-height: 1.45;
	}
	.callout :global(svg) {
		margin-top: 2px;
		color: var(--muted-foreground);
	}
	.callout p {
		margin: 0;
	}
	.callout p + p {
		margin-top: 6px;
	}
	.callout strong {
		font-weight: 600;
	}

	/* congestion bars */
	.bars {
		display: grid;
		grid-template-columns: repeat(13, 1fr);
		gap: 3px;
		margin-top: 10px;
	}
	.bar {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 4px;
		padding: 3px 1px 2px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: none;
		cursor: pointer;
		transition: background 0.12s ease;
	}
	.bar:hover {
		background: var(--muted);
	}
	.bar.picked {
		border-color: var(--primary);
		background: color-mix(in oklch, var(--primary), transparent 94%);
	}
	.fill-track {
		position: relative;
		display: block;
		height: 56px;
	}
	.fill {
		position: absolute;
		inset: auto 2px 0;
		border-radius: 2px;
		background: color-mix(in oklch, var(--foreground), transparent 80%);
	}
	.bar.picked .fill {
		background: var(--primary);
	}
	.num {
		font-family: var(--font-mono);
		font-size: 0.66rem;
		text-align: center;
		color: var(--muted-foreground);
	}
	/* the channels a suggestion is picked from read as the main choices */
	.bar.candidate .num {
		color: var(--foreground);
		font-weight: 600;
	}
	.bar.suggested .num {
		color: var(--primary);
	}

	.suggest {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-top: 10px;
		font-size: 0.8rem;
	}
	.suggest strong {
		font-weight: 600;
	}
</style>
