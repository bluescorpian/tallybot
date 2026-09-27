<script lang="ts">
	// Settings content (DESIGN.md → "Settings"). Standard shadcn (Luma) surface —
	// flat, not neumorphic; the bespoke/neumorphic language is the canvas only.
	// Single scrolling pane, three settled groups: Source / General / About, over a
	// shared dirty-gated SAVE footer.
	//
	// This is the re-hostable PANEL: scrolling cards + footer, no title bar — the
	// host supplies the chrome (SettingsSheet hosts it in the slide-out drawer with
	// its own header).
	//
	// Commit model: one shared, dirty-gated SAVE (not per-field) — so it scales as
	// more savable settings arrive (e.g. OBS) without each growing its own button.
	// Setting *values* (IP, launch-on-startup, future OBS) are pending until Save;
	// Cancel reverts them. Actions stay immediate (Scan-pick fills the field,
	// Restart, links).
	//
	// Behaviour:
	//   • Save starts the connection — no connect/disconnect/forget buttons. Reconnect
	//     lives on the board's SourceChip, not here. A committed IP change goes to the
	//     host via `onsave(ip)`; the connecting → connected feedback under the field
	//     then follows the live `source` the host passes back.
	//   • Scan fills the IP field (a pending change), it does NOT connect; Save connects.
	//   • Scan states: idle · scanning (~20s) · results · none/failed.
	//   • Every host hook is optional: without one (the /preview design workflow, a
	//     plain browser) the panel mocks that behaviour locally.
	import Search from "@lucide/svelte/icons/search";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";
	import RotateCw from "@lucide/svelte/icons/rotate-cw";
	import Scale from "@lucide/svelte/icons/scale";
	import ExternalLink from "@lucide/svelte/icons/external-link";
	import Info from "@lucide/svelte/icons/info";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";

	import { onMount, untrack } from "svelte";
	import type { Source, SourceScanEvent } from "$ipc";
	import { PROTOCOL_VERSION } from "$protocol";
	import { version as APP_VERSION } from "../../../../package.json";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Switch } from "$lib/components/ui/switch";
	import { Badge } from "$lib/components/ui/badge";

	// Host hooks:
	//  • onsave  — fired after Save commits a *changed* IP, so a host can mirror the
	//    connection start (the board mock; real IPC in Phase 5).
	//  • onclose — Cancel is "discard & close": it reverts pending edits and asks the
	//    host to dismiss. It's the explicit, always-safe exit while there are unsaved
	//    changes (the drawer blocks click-outside / Escape when dirty so edits aren't
	//    lost by accident).
	//  • dirty   — bindable mirror of the unsaved-changes state, so the host (drawer)
	//    can guard dismissal on it.
	//  • source    — the live source: seeds the IP field and drives the post-Save
	//    connection feedback.
	//  • onrestart — restart the engine; resolves once it's back.
	//  • autostart — read / set the OS login item behind "Launch on system startup".
	let {
		source = null,
		onsave,
		onclose,
		onrestart,
		autostart,
		onscan,
		scanResult = null,
		dirty = $bindable(false),
	}: {
		source?: Source | null;
		onsave?: (ip: string) => void;
		onclose?: () => void;
		onrestart?: () => Promise<void>;
		autostart?: {
			isEnabled: () => Promise<boolean>;
			set: (enabled: boolean) => Promise<void>;
		};
		// Real scan hookup (Tauri). When `onscan` is set, the Scan button asks the
		// sidecar to sweep the subnet and results arrive via `scanResult`; when it's
		// absent (the /preview design workflow) the mock sweep below runs instead.
		onscan?: () => void;
		scanResult?: SourceScanEvent | null;
		dirty?: boolean;
	} = $props();

	// ── Form state: draft (editing) vs committed (last saved) ────────────────────
	// The panel mounts each time the drawer opens, so it seeds from the live values then.
	let savedIp = $state(untrack(() => source?.ip ?? "")); // committed
	let ip = $state(untrack(() => savedIp)); // draft
	let launch = $state(false); // draft
	let savedLaunch = $state(false); // committed
	let launchError = $state<string | null>(null);

	onMount(() => {
		autostart?.isEnabled().then(
			(on) => (launch = savedLaunch = on),
			(e: unknown) => (launchError = String(e)),
		);
	});

	const ipTrim = $derived(ip.trim());
	const ipChanged = $derived(ipTrim !== savedIp);
	const launchChanged = $derived(launch !== savedLaunch);
	const isDirty = $derived(ipChanged || launchChanged);
	// keep the bindable `dirty` prop in sync so the host can guard dismissal on it
	$effect(() => {
		dirty = isDirty;
	});
	// only flag a bad IP once something's typed; empty isn't "invalid", just not savable
	const ipValid = $derived(
		ipTrim === "" ? true : /^(\d{1,3}\.){3}\d{1,3}$/.test(ipTrim),
	);
	const ipError = $derived(ipChanged && ipTrim !== "" && !ipValid);
	// savable only if there's a change AND any IP change is a valid, non-empty IP
	const canSave = $derived(
		isDirty && (ipChanged ? ipValid && ipTrim !== "" : true),
	);

	// Connection feedback after a Save that changed the IP: the live source's state
	// once it reports the saved IP (the engine starts connecting on commit). Mocked
	// with a timer when there's no host source.
	let savedThisSession = $state(false);
	let mockConnection = $state<"connecting" | "connected">("connecting");
	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	const connection = $derived(
		!savedThisSession
			? "idle"
			: !source
				? mockConnection
				: source.ip === savedIp && source.connection === "connected"
					? "connected"
					: "connecting",
	);

	async function save() {
		if (!canSave) return;
		const ipWasChanged = ipChanged;
		savedIp = ipTrim;
		ip = ipTrim; // normalise the field to the committed value
		if (ipWasChanged) {
			savedThisSession = true;
			onsave?.(savedIp);
			if (!source) {
				mockConnection = "connecting";
				clearTimeout(connectTimer);
				connectTimer = setTimeout(() => (mockConnection = "connected"), 1600);
			}
		}
		if (launchChanged) {
			const want = launch;
			launchError = null;
			try {
				await autostart?.set(want);
				savedLaunch = want;
			} catch (e) {
				launch = savedLaunch; // the OS refused: show what's actually set
				launchError = String(e);
			}
		}
	}

	function cancel() {
		// discard pending edits and ask the host to dismiss the drawer
		ip = savedIp;
		launch = savedLaunch;
		onclose?.();
	}

	// ── Scan (assistive secondary path) ──────────────────────────────────────────
	type Hit = { ip: string; product: string | null };
	let scan = $state<"idle" | "scanning" | "results" | "none">("idle");
	let hits = $state<Hit[]>([]);
	let picked = $state<string | null>(null);
	let scanTimer: ReturnType<typeof setTimeout> | undefined;

	function runScan() {
		picked = null;
		scan = "scanning";
		if (onscan) {
			// real sweep: the sidecar probes every host on each local /24 (~20s);
			// results land in `scanResult`, handled by the effect below.
			onscan();
			return;
		}
		// mock sweep (no sidecar — the /preview workflow)
		clearTimeout(scanTimer);
		scanTimer = setTimeout(() => {
			hits = [
				{ ip: "192.168.10.240", product: "ATEM Mini Pro" },
				{ ip: "192.168.10.12", product: "ATEM Mini" },
			];
			scan = hits.length ? "results" : "none";
		}, 1800);
	}

	// Drive the scan state machine from the sidecar's events (real mode only). Only
	// applies a "done" result to a sweep we actually started (scan === "scanning"),
	// so a stale result from a prior session doesn't pop up when the drawer reopens.
	$effect(() => {
		if (!onscan || !scanResult) return;
		if (scanResult.status === "scanning") {
			scan = "scanning";
			return;
		}
		if (scan !== "scanning") return;
		hits = scanResult.found.map((h) => ({ ip: h.ip, product: h.product }));
		scan = !scanResult.error && hits.length ? "results" : "none";
	});

	function pick(hit: Hit) {
		// fills the field only — a pending change; Save still connects
		picked = hit.ip;
		ip = hit.ip;
	}

	// ── Restart (an action, not a saved value) ───────────────────────────────────
	let restarting = $state(false);
	async function restartEngine() {
		if (restarting) return;
		restarting = true;
		try {
			await (onrestart?.() ?? new Promise((r) => setTimeout(r, 1700)));
		} finally {
			restarting = false;
		}
	}
</script>

<div class="panel">
	<div class="scroll">
		<div class="pane">
			<!-- ════════════════ SOURCE ════════════════ -->
			<section>
				<div class="sec-head">
					<h2>Source</h2>
				</div>

				<div class="card">
					<!-- ATEM IP + Scan -->
					<div class="field">
						<div class="label-col">
							<span class="lbl">ATEM switcher</span>
							<span class="hint">
								The IP address of your ATEM Mini. Saving commits
								it and the engine starts connecting.
							</span>
						</div>

						<div class="field-controls">
							<Input
								bind:value={ip}
								placeholder="192.168.10.240"
								inputmode="decimal"
								spellcheck={false}
								autocomplete="off"
								aria-invalid={ipError}
								class="font-mono tracking-tight"
							/>
							<Button
								variant="outline"
								onclick={runScan}
								disabled={scan === "scanning"}
							>
								{#if scan === "scanning"}
									<LoaderCircle class="animate-spin" />
								{:else}
									<Search />
								{/if}
								Scan
							</Button>
						</div>

						{#if ipError}
							<div class="field-msg error">
								<TriangleAlert class="size-3.5" />
								<span>Enter a valid IPv4 address.</span>
							</div>
						{/if}

						<!-- scan states: scanning / results / none -->
						{#if scan === "scanning"}
							<div class="field-msg">
								<LoaderCircle class="size-3.5 animate-spin" />
								<span
									>Scanning the local subnet… <em>~20s</em
									></span
								>
							</div>
						{:else if scan === "results"}
							<div class="scan-results">
								<div class="field-msg">
									Found {hits.length} — select one to fill the
									field.
								</div>
								<ul>
									{#each hits as hit (hit.ip)}
										<li>
											<button
												type="button"
												class="hit"
												class:selected={picked ===
													hit.ip}
												onclick={() => pick(hit)}
											>
												<span
													class="radio"
													class:on={picked === hit.ip}
													aria-hidden="true"
												></span>
												<span class="hit-ip"
													>{hit.ip}</span
												>
												{#if hit.product}
													<span class="hit-sep">·</span>
													<span class="hit-product"
														>{hit.product}</span
													>
												{/if}
											</button>
										</li>
									{/each}
								</ul>
							</div>
						{:else if scan === "none"}
							<div class="field-msg muted">
								No switchers found on the local subnet.
							</div>
						{/if}

						<!-- post-save connection feedback (engine begins connecting) -->
						{#if !ipChanged && connection === "connecting" && savedIp}
							<div class="field-msg">
								<LoaderCircle class="size-3.5 animate-spin" />
								<span
									>Saved — engine connecting to <code
										>{savedIp}</code
									>…</span
								>
							</div>
						{:else if !ipChanged && connection === "connected" && savedIp}
							<div class="field-msg ok">
								<CircleCheck class="size-3.5" />
								<span
									>Engine connected to <code>{savedIp}</code
									>.</span
								>
							</div>
						{/if}
					</div>

					<!-- OBS override — designed-for, built-later -->
					<div class="row disabled">
						<div class="label-col">
							<span class="lbl">
								OBS override
								<Badge
									variant="secondary"
									class="ml-1.5 align-middle"
								>
									Coming soon
								</Badge>
							</span>
							<span class="hint">
								Block program output from a second source (e.g.
								an OBS scene off the ATEM).
							</span>
						</div>
						<Switch
							disabled
							aria-label="OBS override (coming soon)"
						/>
					</div>
				</div>
			</section>

			<!-- ════════════════ GENERAL ════════════════ -->
			<section>
				<div class="sec-head">
					<h2>General</h2>
				</div>

				<div class="card">
					<div class="row">
						<div class="label-col">
							<span class="lbl">Launch on system startup</span>
							<span class="hint">
								Start TallyBot when you log in.
							</span>
						</div>
						<Switch
							bind:checked={launch}
							aria-label="Launch on system startup"
						/>
					</div>
					{#if launchError}
						<div class="row-msg error">
							<TriangleAlert class="size-3.5 shrink-0" />
							<span class="select-text"
								>Couldn't change the startup setting: {launchError}</span
							>
						</div>
					{/if}

					<div class="row">
						<div class="label-col">
							<span class="lbl">Restart TallyBot Engine</span>
							<span class="hint">
								Reconnect the switcher and all devices if
								something gets stuck.
							</span>
						</div>
						<Button
							variant="outline"
							onclick={restartEngine}
							disabled={restarting}
						>
							{#if restarting}
								<RotateCw class="animate-spin" />
								Restarting…
							{:else}
								<RotateCw />
								Restart
							{/if}
						</Button>
					</div>
				</div>
			</section>

			<!-- ════════════════ ABOUT ════════════════ -->
			<section>
				<div class="sec-head">
					<h2>About</h2>
				</div>

				<div class="card">
					<div class="row">
						<span class="lbl">Version</span>
						<!-- the device protocol is support detail, not something a user acts on,
						     so it rides on the version as a tooltip rather than its own row -->
						<span
							class="mono-val select-text"
							title="Device protocol v{PROTOCOL_VERSION.CURRENT} (supports v{PROTOCOL_VERSION.MIN_SUPPORTED} and up)"
							>{APP_VERSION}</span
						>
					</div>

					<!-- same-subnet limitation explainer -->
					<div class="note">
						<Info class="size-4 shrink-0 text-muted-foreground" />
						<p>
							TallyBot and your tally lights must be on the <strong
							>
								same network subnet
							</strong>.
						</p>
					</div>

					<!-- links (the README on GitHub is the user documentation) -->
					<a
						class="link-row"
						href="https://github.com/bluescorpian/tallybot"
						target="_blank"
						rel="noreferrer"
					>
						<svg
							class="size-4 fill-muted-foreground"
							viewBox="0 0 16 16"
							aria-hidden="true"
						>
							<path
								d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
							/>
						</svg>
						<span>GitHub</span>
						<ExternalLink
							class="ml-auto size-3.5 text-muted-foreground"
						/>
					</a>
					<a
						class="link-row"
						href="https://github.com/bluescorpian/tallybot/blob/main/LICENSE.md"
						target="_blank"
						rel="noreferrer"
					>
						<Scale class="size-4 text-muted-foreground" />
						<span
							>License <span class="mono-dim"
								>· PolyForm Noncommercial</span
							></span
						>
						<ExternalLink
							class="ml-auto size-3.5 text-muted-foreground"
						/>
					</a>
				</div>
			</section>
		</div>
	</div>

	<!-- shared commit footer — scales as more savable settings arrive -->
	<footer class="footer" class:dirty={isDirty}>
		<span class="footer-status">
			{#if isDirty}
				<span class="dot" aria-hidden="true"></span>
				Unsaved changes
			{:else}
				All changes saved
			{/if}
		</span>
		<div class="footer-actions">
			<!-- always enabled: it's also the drawer's close affordance (no X) —
			     discard & close when dirty, just close when clean -->
			<Button variant="ghost" onclick={cancel}>Cancel</Button>
			<Button onclick={save} disabled={!canSave}>Save</Button>
		</div>
	</footer>
</div>

<style>
	/* The panel fills its host (drawer or standalone shell): scrolling cards over a
	   pinned footer. Off-white surface, white cards. */
	.panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--muted);
		color: var(--foreground);
	}

	.scroll {
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}
	.pane {
		max-width: 560px;
		margin: 0 auto;
		padding: 28px 20px 40px;
		display: flex;
		flex-direction: column;
		gap: 30px;
	}

	/* section heading */
	.sec-head {
		margin: 0 2px 10px;
	}
	.sec-head h2 {
		font-size: 0.82rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted-foreground);
	}

	/* grouped card of rows */
	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--background);
		overflow: hidden;
		box-shadow: 0 1px 2px oklch(0 0 0 / 0.04);
	}
	.row,
	.field {
		padding: 14px 16px;
	}
	.row + .row,
	.row-msg + .row,
	.field + .row {
		border-top: 1px solid var(--border);
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}
	.row.disabled {
		opacity: 0.6;
	}

	.label-col {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}
	.lbl {
		font-size: 0.875rem;
		font-weight: 500;
		line-height: 1.3;
	}
	.hint {
		font-size: 0.78rem;
		line-height: 1.45;
		color: var(--muted-foreground);
		max-width: 42ch;
	}

	/* a message attached to the row above it (no divider between them) */
	.row-msg {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 0 16px 12px;
		margin-top: -4px;
		font-size: 0.78rem;
	}
	.row-msg.error {
		color: var(--destructive);
	}

	/* ATEM field block */
	.field .label-col {
		margin-bottom: 10px;
	}
	.field-controls {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.field-controls :global(input) {
		flex: 1;
		min-width: 0;
	}

	/* inline messages under the field: validation / scan / save feedback */
	.field-msg {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-top: 11px;
		font-size: 0.78rem;
		color: var(--muted-foreground);
	}
	.field-msg em {
		font-style: normal;
		font-family: var(--font-mono);
		font-size: 0.72rem;
	}
	.field-msg code {
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--foreground);
	}
	.field-msg.error {
		color: var(--destructive);
	}
	.field-msg.ok {
		color: oklch(0.55 0.13 150);
	}

	/* scan results */
	.scan-results ul {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.hit {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 9px 11px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--background);
		cursor: pointer;
		text-align: left;
		transition:
			border-color 0.12s ease,
			background 0.12s ease;
	}
	.hit:hover {
		background: var(--muted);
	}
	.hit.selected {
		border-color: var(--primary);
		background: color-mix(in oklch, var(--primary), transparent 94%);
	}
	.radio {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 1.5px solid var(--border);
		flex-shrink: 0;
		transition: border-color 0.12s ease;
	}
	.radio.on {
		border-color: var(--primary);
		border-width: 4px;
	}
	.hit-ip {
		font-family: var(--font-mono);
		font-size: 0.78rem;
		letter-spacing: -0.01em;
	}
	.hit-sep {
		color: var(--muted-foreground);
	}
	.hit-product {
		font-size: 0.8rem;
		color: var(--muted-foreground);
	}

	/* About — mono values */
	.mono-val {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--foreground);
		white-space: nowrap;
	}
	.mono-dim {
		color: var(--muted-foreground);
	}

	/* same-subnet note */
	.note {
		display: flex;
		gap: 9px;
		padding: 12px 16px;
		border-top: 1px solid var(--border);
		background: var(--muted);
	}
	.note p {
		font-size: 0.78rem;
		line-height: 1.5;
		color: var(--muted-foreground);
	}
	.note strong {
		color: var(--foreground);
		font-weight: 600;
	}

	/* link rows */
	.link-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 16px;
		border-top: 1px solid var(--border);
		font-size: 0.85rem;
		color: var(--foreground);
		text-decoration: none;
		transition: background 0.12s ease;
	}
	.link-row:hover {
		background: var(--muted);
	}

	/* shared commit footer */
	.footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 20px;
		border-top: 1px solid var(--border);
		background: color-mix(in oklch, var(--background), transparent 4%);
		backdrop-filter: blur(6px);
		flex-shrink: 0;
	}
	.footer-status {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.8rem;
		color: var(--muted-foreground);
	}
	.footer.dirty .footer-status {
		color: var(--foreground);
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--primary);
	}
	.footer-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
</style>
