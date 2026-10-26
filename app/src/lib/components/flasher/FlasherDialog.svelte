<script lang="ts" module>
	/**
	 * One flash the operator asked for, resolved by the page from live state so it updates as
	 * things change (a wireless light gains a `port` once it's plugged in).
	 */
	export interface FlashJob {
		kind: "blank" | "light";
		/** The USB port, or null while a wireless light still has to be plugged in. */
		port: string | null;
		/** The light's full MAC and its MAC tail (lights only). */
		mac: string | null;
		label: string | null;
		/** Firmware the light runs now, when known (null for a blank board, or unreported). */
		fromVersion: string | null;
		/** A known light with no firmware (an install was interrupted): this is a reinstall. */
		missing: boolean;
		/** A different light turned up on USB while waiting for this one (its label). */
		wrongLight: string | null;
		/** The input the light is assigned to, if any — flashing takes it dark. */
		input: { label: string; live: boolean } | null;
	}

	/**
	 * What the light should be set to once it's back. Device-side (sent over USB once it
	 * connects): transport (+ Wi-Fi credentials) and the bridge role. Server-side (keyed by
	 * MAC, which the bootloader reports even for a blank board): input and brightness.
	 */
	export interface LightSettings {
		transport: "wifi" | "notx" | "espnow";
		ssid: string;
		password: string;
		bridge: boolean;
		inputId: string | null;
		brightness: number;
	}

	/** A board on USB the flasher can work on, offered when it's opened from the titlebar. */
	export interface FlashCandidate {
		kind: "blank" | "light";
		port: string;
		/** Full MAC (lights only). */
		mac: string | null;
		/** The board's label for a light (MAC tail), null for a blank board. */
		label: string | null;
		/** Firmware a light runs, when known. */
		version: string | null;
		/** Older than this app's firmware (or missing). */
		outdated: boolean;
	}
</script>

<script lang="ts">
	// The flasher: sets up a blank board, or updates or reinstalls a light's firmware. A centred
	// dialog sized to its content (a drawer put its buttons a screen away from its few lines on
	// a large monitor), over a light, unblurred backdrop so the board stays visible: you watch
	// the light drop off, then come back into the dock or its column when it's done.
	//
	// Flow: [choose a board, when opened from the titlebar] → [plug in, wireless lights only] →
	// review → installing → done | failed | stopped.
	// Review is where a deliberate choice is made: it says what goes dark, and, if a newer
	// TallyBot ships newer firmware, offers "update TallyBot first" beside "install anyway".
	// Closing mid-install keeps it going (the titlebar pill reopens it); Stop asks first.
	//
	// It drives a `Flasher` (start / cancel / reset + reactive state); the page decides
	// whether that's the mock or the real espflash driver.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Progress } from "$lib/components/ui/progress";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Switch } from "$lib/components/ui/switch";
	import * as Select from "$lib/components/ui/select";
	import * as RadioGroup from "$lib/components/ui/radio-group";
	import BrightnessBar, { toLevel, LEVELS } from "$lib/components/board/BrightnessBar.svelte";
	import { TRANSPORT_MODES, BRIDGE_LABEL, BRIDGE_DESC, type TransportMode } from "$lib/components/board/transportModes";
	import type { Flasher, FlashStage, FlashTarget } from "$lib/flasher/flasher";
	import { FLASH_STAGES, leavesBlank } from "$lib/flasher/flasher";
	import type { AppUpdate } from "$lib/updater/updater";
	import Cpu from "@lucide/svelte/icons/cpu";
	import Usb from "@lucide/svelte/icons/usb";
	import Check from "@lucide/svelte/icons/check";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import CircleX from "@lucide/svelte/icons/circle-x";
	import CircleSlash from "@lucide/svelte/icons/circle-slash";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import ArrowRight from "@lucide/svelte/icons/arrow-right";
	import CircleArrowUp from "@lucide/svelte/icons/circle-arrow-up";
	import Zap from "@lucide/svelte/icons/zap";
	import Lightbulb from "@lucide/svelte/icons/lightbulb";

	interface Props {
		open?: boolean;
		job: FlashJob | null;
		flasher: Flasher;
		/** A newer TallyBot release whose firmware is newer than this app's, if one is known. */
		newerUpdate?: AppUpdate | null;
		/** That update is already downloaded, so "update first" is just a restart. */
		newerReady?: boolean;
		/** "Update TallyBot first" — the host closes this and opens the app updater. */
		onupdateapp?: () => void;
		/** Show the light on the board (scroll + one-off highlight); `pick` also opens its picker. */
		onreveal?: (mac: string, pick: boolean) => void;
		/** Flash-to-identify a light (to find which physical unit to plug in). */
		onidentify?: (mac: string) => void;
		/** Boards on USB to choose from when there's no job yet (opened from the titlebar). */
		candidates?: FlashCandidate[];
		onpick?: (c: FlashCandidate) => void;
		/** Inputs a light can be assigned to, for the Settings step. */
		inputs?: { id: string; label: string }[];
		/** The light's current settings (prefill for an existing light; null for a blank board). */
		currentSettings?: LightSettings | null;
		/** Apply settings to the light once it's back; resolves to an error message, or null. */
		onapply?: (mac: string, s: LightSettings) => Promise<string | null>;
	}
	let {
		open = $bindable(false),
		job,
		flasher,
		newerUpdate = null,
		newerReady = false,
		onupdateapp,
		onreveal,
		onidentify,
		candidates = [],
		onpick,
		inputs = [],
		currentSettings = null,
		onapply,
	}: Props = $props();

	// ── Settings step (after review, before the install) ──
	// A reinstall keeps the light's saved settings (the shell writes around them), so "keep as
	// is" (the default) applies nothing afterwards; "change" applies the new choices once the
	// light is back. A blank board gets the user's choices, or nothing when skipped (set it up
	// later from its menu).
	const DEFAULTS: LightSettings = {
		transport: "notx",
		ssid: "",
		password: "",
		bridge: false,
		inputId: null,
		brightness: 128,
	};
	let step = $state<"review" | "settings" | "summary">("review");
	/** What the summary shows and the install applies: null = set up later. */
	let chosen = $state<LightSettings | null>(null);
	function toSummary(settings: LightSettings | null) {
		chosen = settings;
		step = "summary";
	}
	let keep = $state(true);
	let form = $state<LightSettings>({ ...DEFAULTS });
	/** Settings waiting to be applied once the install is done (null = skipped). */
	let pending = $state<LightSettings | null>(null);
	let apply = $state<"idle" | "running" | "ok" | "failed">("idle");
	let applyError = $state<string | null>(null);
	function toSettings() {
		step = "settings";
		keep = true;
		form = { ...(currentSettings ?? DEFAULTS) };
	}
	async function runApply() {
		const mac = st.status === "done" ? st.mac : null;
		if (!mac || !pending) return;
		apply = "running";
		applyError = (await onapply?.(mac, pending)) ?? null;
		apply = applyError ? "failed" : "ok";
	}
	$effect(() => {
		if (st.status === "done" && pending && apply === "idle") void runApply();
	});
	$effect(() => {
		if (st.status === "idle") {
			apply = "idle";
			applyError = null;
		}
	});

	// The page only offers the flasher when the build bundles firmware, so this is set here.
	const fw = $derived(flasher.firmwareVersion ?? "");
	const st = $derived(flasher.state);
	const running = $derived(st.status === "running");
	let confirmStop = $state(false);

	// "Found it" beat: when the awaited board shows up on USB, confirm it for a moment before
	// moving on to review, so the jump doesn't feel like the drawer changed on its own.
	let found = $state(false);
	let lastPort: string | null | undefined;
	$effect(() => {
		if (!job) {
			lastPort = undefined; // a fresh job, not an arrival
			return;
		}
		const port = job.port;
		if (lastPort === null && port !== null) {
			found = true;
			setTimeout(() => (found = false), 1400);
		}
		lastPort = port;
	});

	type View =
		| "waiting"
		| "choose"
		| "plug"
		| "found"
		| "review"
		| "settings"
		| "summary"
		| "running"
		| "done"
		| "failed"
		| "cancelled";
	// the install is done but its settings are still being applied
	const applying = $derived(st.status === "done" && !!pending && (apply === "idle" || apply === "running"));
	const view = $derived<View>(
		applying
			? "running"
			: st.status !== "idle"
			? st.status
			: !job
				? candidates.length
					? "choose"
					: "waiting"
				: job.port === null
					? "plug"
					: found
						? "found"
						: step,
	);
	$effect(() => {
		if (!running) confirmStop = false;
	});

	// Closing mid-install leaves it running (the titlebar pill reopens the dialog); closing
	// after it clears the outcome so the next open starts fresh. The reset waits for the exit
	// animation: clearing the outcome while it still fades out swaps the dialog to the review step.
	function onclosed(isOpen: boolean) {
		if (isOpen) return;
		step = "review";
		wasWireless = false;
		replug = false;
		if (!running && st.status !== "idle") flasher.reset();
	}

	const name = $derived(job?.kind === "light" ? job.label : null);
	// a light already on this app's firmware: installing again is a reinstall, not an update
	const current = $derived(job?.kind === "light" && !job.missing && job.fromVersion === fw);
	const title = $derived(
		!job
			? "Install light firmware"
			: job.kind === "blank"
				? "Set up a new light"
				: job.missing || current
					? "Reinstall light firmware"
					: "Update light firmware",
	);
	// A wireless light plugged in just for the update can be unplugged again afterwards.
	let wasWireless = $state(false);
	// Asked to plug the board back in (the cable came out) rather than plug it in for the first time.
	let replug = $state(false);
	$effect(() => {
		if (open && view === "plug" && !replug) wasWireless = true;
	});

	function target(): FlashTarget | null {
		if (!job || job.port === null) return null;
		return job.kind === "blank"
			? { kind: "blank", port: job.port }
			: { kind: "light", mac: job.mac ?? "", label: job.label ?? "", port: job.port };
	}
	// The version the light had when flashing began: the job is live state, so once the light
	// comes back its reported version is already the new one.
	let fromAtStart = $state<string | null>(null);
	const fromVersion = $derived(view === "plug" || view === "found" || view === "review" || view === "settings" || view === "summary" ? (job?.fromVersion ?? null) : fromAtStart);
	function start(settings: LightSettings | null) {
		const t = target();
		if (!t) return;
		pending = settings;
		fromAtStart = job?.fromVersion ?? null;
		flasher.start(t);
	}
	function retry() {
		flasher.reset();
		// no port (the cable came out): the drawer goes back to "plug it in", then review
		if (job?.port == null) replug = true;
		else start(pending);
	}
	const leanUpdateFirst = $derived(!!newerUpdate && job?.kind === "light" && !job.missing && !current);
	function finish(pick: boolean) {
		const mac = newMac;
		open = false;
		if (mac) onreveal?.(mac, pick);
	}
	function stop() {
		flasher.cancel();
		confirmStop = false;
	}

	function stageLabel(s: FlashStage | "apply"): string {
		switch (s) {
			case "apply":
				return "Apply settings";
			case "connect":
				return "Connect to the board";
			case "erase":
				return job?.kind === "light" ? "Clear the old firmware" : "Clear the board";
			case "write":
				return `Install firmware ${fw}`;
			case "verify":
				return "Check the install";
			case "restart":
				return "Restart the board";
			case "rejoin":
				return job?.kind === "light" ? `Wait for ${name} to reconnect` : "Wait for it to show up as a light";
		}
	}
	// "Apply settings" is the stepper's last stage when there are settings to apply
	const stages = $derived<(FlashStage | "apply")[]>(pending ? [...FLASH_STAGES, "apply"] : [...FLASH_STAGES]);
	const stageIndex = $derived(
		st.status === "running" || st.status === "failed" || st.status === "cancelled"
			? FLASH_STAGES.indexOf(st.stage)
			: st.status === "done"
				? applying || apply === "failed"
					? FLASH_STAGES.length
					: stages.length
				: -1,
	);
	const pct = $derived(st.status === "running" && st.stage === "write" ? Math.round(st.progress * 100) : 0);
	const newMac = $derived(st.status === "done" ? st.mac : null);
	// the board's own label for the light: the last two octets of its MAC
	const newTail = $derived(st.status === "done" ? st.mac.split(":").slice(-2).join(":") : null);
	// the input the light ended up on: the applied setting when there was one, else the one it kept
	const landedOn = $derived(
		pending && apply === "ok"
			? (inputs.find((i) => i.id === pending?.inputId)?.label ?? null)
			: (job?.input?.label ?? null),
	);
	const portName = $derived(job?.port ?? "the USB port");
</script>

<Dialog.Root bind:open onOpenChangeComplete={onclosed}>
	<Dialog.Content
		showCloseButton={false}
		overlayClass="bg-black/10 supports-backdrop-filter:backdrop-blur-none"
		class="gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-[440px]"
	>
		<div class="head">
			<Cpu class="text-muted-foreground size-[18px]" />
			<Dialog.Title class="text-[0.95rem] font-semibold tracking-tight">{title}</Dialog.Title>
		</div>

		<div class="body">
			{#if !job && view === "choose"}
				<p class="lead">Choose the board to install firmware on.</p>
				<ul class="pick">
					{#each candidates as c (c.port)}
						<li>
							<button type="button" class="pick-row" onclick={() => onpick?.(c)}>
								<span class="target-icon">
									{#if c.kind === "blank"}<Cpu class="size-[18px]" />{:else}<Lightbulb class="size-[18px]" />{/if}
								</span>
								<span class="target-text">
									<span class="target-id">
										{#if c.kind === "blank"}New board{:else}<span class="font-mono font-medium">{c.label}</span>{/if}
										<span class="text-muted-foreground font-mono">· {c.port}</span>
									</span>
								</span>
								<span class="versions">
									{#if c.kind === "blank"}
										<span class="ver old">not set up</span>
									{:else if c.outdated}
										<span class="ver old">{c.version ?? "none"}</span>
										<ArrowRight class="text-muted-foreground size-3" />
										<span class="ver new">{fw}</span>
									{:else}
										<span class="ver old">{c.version ?? fw}</span>
									{/if}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{:else if !job}
				<div class="plug">
					<span class="plug-icon"><Usb class="size-7" /></span>
					<h3>Plug a board into this PC by USB</h3>
					<p>A brand-new board to set up as a light, or an existing light to update or reinstall.</p>
					<p class="waiting"><LoaderCircle class="size-3.5 animate-spin" /> Waiting for a board…</p>
				</div>
			{:else}
				<!-- What's being flashed: the board/light, and the version it goes to. Constant across
				     every step so the drawer always says what it's working on. -->
				<div class="target">
					<span class="target-icon">
						{#if job.kind === "blank"}<Cpu class="size-[18px]" />{:else}<Lightbulb class="size-[18px]" />{/if}
					</span>
					<span class="target-text">
						<span class="target-kind">{job.kind === "blank" ? "Blank board" : "Tally light"}</span>
						<span class="target-id">
							{#if job.kind === "light"}<span class="font-mono font-medium">{name}</span>{/if}
							{#if job.port}
								<span class="text-muted-foreground font-mono">{job.kind === "light" ? "· " : ""}{job.port}</span>
							{:else}
								<span class="text-muted-foreground"
								>{job.kind === "light" ? (replug ? "· unplugged" : "· wireless") : "Unplugged"}</span
							>
							{/if}
						</span>
					</span>
					<span class="versions" title="Firmware">
						{#if fromVersion}
							<span class="ver old">{fromVersion}</span>
						{:else if job.kind === "blank" || job.missing}
							<span class="ver old">none</span>
						{/if}
						<ArrowRight class="text-muted-foreground size-3" />
						<span class="ver new">{fw}</span>
					</span>
				</div>

				{#if view === "plug"}
					<div class="plug">
						<span class="plug-icon"><Usb class="size-7" /></span>
						{#if replug}
							<h3>Plug {name ?? "the board"} back in</h3>
							<p>Then the install starts over from the beginning. Nothing is damaged.</p>
						{:else}
							<h3>Plug {name} into this PC</h3>
						{/if}
						{#if job.wrongLight}
							<p class="wrong">
								<TriangleAlert class="size-3.5 shrink-0" /> That's {job.wrongLight}, not {name}. Unplug it
								and plug in {name}.
							</p>
						{:else}
							<p class="waiting">
								<LoaderCircle class="size-3.5 animate-spin" /> Waiting for {name ?? "the board"}…
							</p>
						{/if}
						{#if job.kind === "light" && job.mac && !replug}
							<!-- lights have no names: blink it so you know which unit to pick up -->
							<Button variant="outline" size="sm" class="mt-2" onclick={() => job.mac && onidentify?.(job.mac)}>
								<Zap /> Flash it to find it
							</Button>
						{/if}
					</div>
				{:else if view === "found"}
					<div class="plug">
						<span class="plug-icon found"><Check class="size-7" /></span>
						<h3>Found {name ?? "the board"} on USB</h3>
					</div>
				{:else if view === "review"}
					<!-- the versions are in the target row above; the lead only adds what it doesn't say -->
					<p class="lead">
						{#if job.missing}
							{name} has no firmware after an interrupted install, so it's dark. Takes about a minute.
						{:else}
							Takes about a minute.
						{/if}
					</p>

					{#if job.input && !job.missing}
						<div class="callout" class:hot={job.input.live}>
							<TriangleAlert class="size-4 shrink-0" />
							<p>
								{#if job.input.live}
									<strong>{name} is on {job.input.label}, which is live right now.</strong> It goes
									dark until the update finishes.
								{:else}
									{name} goes dark while it updates, then comes back on
									<strong>{job.input.label}</strong>.
								{/if}
							</p>
						</div>
					{/if}


					{#if newerUpdate}
						<!-- Product rule: if a newer TallyBot ships newer firmware, say so here, before
						     anything is written — a choice, not a block. -->
						<div class="newer">
							<div class="newer-head">
								<CircleArrowUp class="text-primary size-4 shrink-0" />
								<span>A newer TallyBot ({newerUpdate.version}) comes with improved light firmware</span>
							</div>
							<!-- Each path's cost, and a lean: an existing light would otherwise go dark twice;
							     a blank board isn't in use, so setting it up now costs nothing. The choice
							     itself is the footer's buttons. -->
							{#if job.kind === "light"}
								<p>
									Recommended: update TallyBot first, then {name} gets {newerUpdate.version} in one go. All
									lights blink off for a few seconds.
								</p>
							{:else}
								<p>It works with this TallyBot. Update its firmware later from its menu.</p>
							{/if}
						</div>
					{/if}
				{:else if view === "settings"}
					{#if job.kind === "light"}
						<!-- an existing light: the reinstall leaves its settings alone unless they're changed here -->
						<fieldset class="cfg">
							<legend>{name}'s settings (connection, input, brightness)</legend>
							<RadioGroup.Root
								class="keep"
								bind:value={() => (keep ? "keep" : "change"), (v) => (keep = v === "keep")}
							>
								<label><RadioGroup.Item value="keep" /> Keep its current settings</label>
								<label><RadioGroup.Item value="change" /> Change them</label>
							</RadioGroup.Root>
						</fieldset>
					{/if}
					{#if job.kind === "blank" || !keep}
						<fieldset class="cfg">
							<legend>Where will this light run?</legend>
							<RadioGroup.Root
								class="gap-0"
								bind:value={() => form.transport, (v) => (form.transport = v as TransportMode)}
							>
								{#each TRANSPORT_MODES as m (m.id)}
									<label class="mode">
										<RadioGroup.Item value={m.id} class="mt-0.5" />
										<span>
											<span class="mode-label">{m.label}</span>
											<span class="mode-desc">{m.desc}</span>
										</span>
									</label>
								{/each}
							</RadioGroup.Root>
							{#if form.transport === "wifi"}
								<div class="wifi">
									<Label for="fl-ssid">Network (SSID)</Label>
									<Input id="fl-ssid" placeholder="Network name" bind:value={form.ssid} autocomplete="off" />
									<Label for="fl-pass">Password</Label>
									<Input id="fl-pass" type="password" placeholder="Password" bind:value={form.password} />
								</div>
							{/if}
						</fieldset>
						<div class="cfg row">
							<span>
								<span class="mode-label">{BRIDGE_LABEL}</span>
								<span class="mode-desc">{BRIDGE_DESC}</span>
							</span>
							<Switch bind:checked={form.bridge} aria-label={BRIDGE_LABEL} />
						</div>
						<div class="cfg grid2">
							<Label for="fl-input">Input</Label>
							<!-- "none" stands for unassigned: the select's value is always a string -->
							<Select.Root
								type="single"
								bind:value={() => form.inputId ?? "none", (v) => (form.inputId = v === "none" ? null : v)}
							>
								<Select.Trigger id="fl-input" class="w-full">
									{inputs.find((i) => i.id === form.inputId)?.label ?? "Unassigned"}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="none" label="Unassigned" />
									{#each inputs as i (i.id)}
										<Select.Item value={i.id} label={i.label} />
									{/each}
								</Select.Content>
							</Select.Root>
							<span class="bright-label">Brightness</span>
							<BrightnessBar value={form.brightness} onchange={(v) => (form.brightness = v)} />
						</div>
					{/if}
				{:else if view === "summary"}
					<dl class="summary">
						<dt>Firmware</dt>
						<dd class="font-mono">{fw}</dd>
						{#if chosen}
							<dt>Runs on</dt>
							<dd>
								{TRANSPORT_MODES.find((m) => m.id === chosen?.transport)?.label}{#if chosen.transport === "wifi" && chosen.ssid}<span
										class="text-muted-foreground">{" · "}{chosen.ssid}</span
									>{/if}
							</dd>
							{#if chosen.bridge}
								<dt>Bridge</dt>
								<dd>Yes</dd>
							{/if}
							<dt>Input</dt>
							<dd>{inputs.find((i) => i.id === chosen?.inputId)?.label ?? "Unassigned"}</dd>
							<dt>Brightness</dt>
							<dd>{toLevel(chosen.brightness)} of {LEVELS}</dd>
						{:else}
							<dt>Settings</dt>
							<dd class="text-muted-foreground">Set up later, from the light's menu</dd>
						{/if}
					</dl>
				{:else if view === "running" || view === "done"}
					<ol class="steps">
						{#each stages as s, i (s)}
							{@const state =
								s === "apply" && apply === "failed"
									? "failed"
									: i < stageIndex
										? "done"
										: i === stageIndex
											? "now"
											: "todo"}
							<li class="step {state}" aria-current={state === "now" ? "step" : undefined}>
								<span class="mark">
									{#if state === "done"}
										<Check class="size-3" strokeWidth={3} />
									{:else if state === "now"}
										<LoaderCircle class="size-4 animate-spin" />
									{:else if state === "failed"}
										<CircleX class="text-destructive size-4" />
									{/if}
								</span>
								<span class="step-body">
									<span class="step-label">{stageLabel(s)}</span>
									{#if s === "write" && state === "now"}
										<span class="write">
											<Progress value={pct} class="bg-foreground/10 h-1.5" />
											<span class="pct">{pct}%</span>
										</span>
									{:else if s === "rejoin" && state === "now"}
										<span class="step-hint">The board restarts and reconnects by itself.</span>
									{/if}
								</span>
							</li>
						{/each}
					</ol>

					{#if view === "done" && apply === "failed"}
						<div class="outcome bad">
							<CircleX class="size-5 shrink-0" />
							<div role="status">
								<h3>Firmware installed, settings not applied</h3>
								<p>{applyError}</p>
							</div>
						</div>
					{:else if view === "done"}
						<div class="outcome ok">
							<CircleCheck class="size-5 shrink-0" />
							<div role="status">
								{#if job.kind === "blank"}
									<h3>New light <span class="font-mono">{newTail}</span> is ready</h3>
									<p>
										{#if landedOn}It's on <strong>{landedOn}</strong>.{:else}It's in the <strong
												>Unassigned</strong
											> tray.{/if}
									</p>
								{:else}
									<h3>{job.missing || fromVersion === null ? `${name} is working again` : `${name} is up to date`}</h3>
									<p>
										Running firmware {fw}{landedOn ? `, and back on ${landedOn}` : ""}.
									</p>
									{#if wasWireless}
										<p class="mt-1.5">You can unplug it now. It goes back to running wirelessly.</p>
									{/if}
								{/if}
							</div>
						</div>
					{/if}
				{:else if view === "failed" && st.status === "failed"}
					<div class="outcome bad">
						<CircleX class="size-5 shrink-0" />
						<div>
							{#if st.failure === "no-response"}
								<h3>The board didn't respond</h3>
								<p>It needs a nudge into setup mode:</p>
								<ol class="fix">
									<li>Unplug the board.</li>
									<li>Hold down its <strong>BOOT</strong> button and plug it back in.</li>
									<li>Let go of BOOT, then press <strong>Try again</strong>.</li>
								</ol>
							{:else if st.failure === "port-busy"}
								<h3>{portName} is in use</h3>
								<p>
									Another program is connected to this board. Close any serial monitor, Arduino IDE
									or web flasher tab that's using it, then try again.
								</p>
							{:else if st.failure === "wrong-light"}
								<h3>That's a different light</h3>
								<p>
									The board on {portName} isn't {name ?? "the light you picked"}, so nothing was installed.
									Plug in {name ?? "that light"} and try again.
								</p>
							{:else if st.failure === "error"}
								<h3>The install didn't finish</h3>
								<p>
									Try again. If it keeps failing, unplug the board, plug it back in, and try once more.
								</p>
							{:else}
								<h3>The cable came out</h3>
								<p>
									The board was unplugged before the install finished. Plug it back in and try again.
								</p>
							{/if}
						</div>
					</div>
					<details class="detail">
						<summary>Technical details</summary>
						<code class="select-text">{st.detail}</code>
					</details>
				{:else if view === "cancelled"}
					<div class="outcome muted">
						<CircleSlash class="size-5 shrink-0" />
						<div>
							<!-- What stopping actually did depends on how far it got. -->
							<h3>Stopped</h3>
							{#if st.status === "cancelled" && st.stage === "connect"}
								<p>
									Nothing was changed.
									{#if job.kind === "light" && fromVersion}{name} is still on {fromVersion}.{/if}
								</p>
							{:else if st.status === "cancelled" && !leavesBlank(st.stage)}
								<p>
									The new firmware {fw} was already installed, so {job.kind === "light" ? name : "it"}
									should come back by itself in a moment.
								</p>
							{:else}
								<p>
									{job.kind === "light" ? name : "The board"} has no firmware now, so it stays dark until
									you install it again. Nothing is damaged.
								</p>
							{/if}
						</div>
					</div>
				{/if}
			{/if}
		</div>

		<footer class="footer">
			{#if applying}
				<span></span>
				<Button variant="ghost" onclick={() => (open = false)}>Hide</Button>
			{:else if view === "running"}
				{#if confirmStop}
					<!-- "Keep going" lands where Stop was, so a double-click doesn't stop it -->
					<span></span>
					<div class="foot-actions">
						<Button variant="destructive" onclick={stop}
							>{st.status === "running" && leavesBlank(st.stage) ? "Stop and leave it blank" : "Stop"}</Button
						>
						<Button onclick={() => (confirmStop = false)}>Keep going</Button>
					</div>
				{:else}
					<span class="foot-msg"><Usb class="size-3.5" /> Don't unplug the board</span>
					<div class="foot-actions">
						<!-- Hide keeps it installing; the titlebar pill shows progress and reopens this -->
						<Button variant="ghost" onclick={() => (open = false)}>Hide</Button>
						<Button variant="ghost" onclick={() => (confirmStop = true)}>Stop</Button>
					</div>
				{/if}
			{:else if view === "review"}
				<span></span>
				<div class="foot-actions">
					<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
					<!-- one primary per screen: when the callout recommends updating TallyBot first,
					     installing this app's firmware becomes the secondary choice -->
					{#if newerUpdate}
						<Button variant={leanUpdateFirst ? "default" : "outline"} onclick={() => onupdateapp?.()}>
							{newerReady ? "Restart and update TallyBot" : "Update TallyBot first"}
						</Button>
					{/if}
					<Button variant={leanUpdateFirst ? "outline" : "default"} onclick={toSettings}>
						{leanUpdateFirst ? `Install ${fw} anyway` : "Next"}
					</Button>
				</div>
			{:else if view === "settings"}
				<Button variant="ghost" onclick={() => (step = "review")}>Back</Button>
				<div class="foot-actions">
					{#if job?.kind === "blank"}
						<Button variant="ghost" onclick={() => toSummary(null)}>Later</Button>
					{/if}
					<Button
						onclick={() => toSummary(job?.kind === "light" && keep ? currentSettings : $state.snapshot(form))}
						>Next</Button
					>
				</div>
			{:else if view === "summary"}
				<Button variant="ghost" onclick={() => (step = "settings")}>Back</Button>
				<!-- the summary shows the kept settings, but a reinstall leaves them in place untouched -->
				<Button onclick={() => start(job?.kind === "light" && keep ? null : chosen)}>
					{job?.kind === "light" && (job.missing || current) ? "Reinstall firmware" : `Install ${fw}`}
				</Button>
			{:else if view === "plug" || view === "found" || view === "choose" || view === "waiting"}
				<span></span>
				<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
			{:else if view === "done"}
				<span></span>
				<div class="foot-actions">
					{#if apply === "failed"}
						<Button variant="ghost" onclick={() => finish(false)}>Done</Button>
						<Button onclick={runApply}>Try again</Button>
					{:else if job?.kind === "blank" && newMac && !landedOn}
						<Button variant="ghost" onclick={() => finish(false)}>Done</Button>
						<Button onclick={() => finish(true)}>Choose its input</Button>
					{:else}
						<Button onclick={() => finish(false)}>Done</Button>
					{/if}
				</div>
			{:else}
				<span></span>
				<div class="foot-actions">
					<Button variant="ghost" onclick={() => (open = false)}>Close</Button>
					<Button onclick={retry}>
						{view === "cancelled" ? "Install again" : "Try again"}
					</Button>
				</div>
			{/if}
		</footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	.head {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 16px 22px 14px;
		border-bottom: 1px solid var(--border);
	}
	.body {
		max-height: calc(100vh - 220px);
		overflow-y: auto;
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		background: var(--muted);
	}

	/* the board/light being flashed */
	.target {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--background);
		box-shadow: 0 1px 2px oklch(0 0 0 / 0.04);
	}
	.target-icon {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: 10px;
		background: var(--muted);
		color: var(--muted-foreground);
		flex: none;
	}
	.target-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
	.target-kind {
		font-size: 0.7rem;
		color: var(--muted-foreground);
	}
	.target-id {
		font-size: 0.85rem;
		display: flex;
		gap: 4px;
		white-space: nowrap;
		overflow: hidden;
	}
	.versions {
		display: flex;
		align-items: center;
		gap: 5px;
		flex: none;
	}
	.ver {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		padding: 1px 7px;
		border-radius: 999px;
		border: 1px solid var(--border);
	}
	.ver.old {
		color: var(--muted-foreground);
	}
	.ver.new {
		color: var(--primary);
		border-color: color-mix(in oklch, var(--primary), transparent 65%);
		background: color-mix(in oklch, var(--primary), transparent 93%);
	}

	/* Settings step */
	/* .keep sits on RadioGroup.Root (a component), so it needs :global to reach it */
	:global(.keep) {
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 0.85rem;
	}
	:global(.keep) label,
	.mode {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
	}
	.mode {
		align-items: flex-start;
		padding: 3px 0;
	}
	.cfg {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--background);
		min-width: 0;
	}
	.cfg legend {
		float: left;
		font-size: 0.72rem;
		color: var(--muted-foreground);
		margin-bottom: 2px;
	}
	.cfg.row {
		flex-direction: row;
		align-items: center;
		gap: 12px;
	}
	.cfg.grid2 {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: center;
		gap: 10px 14px;
	}
	.mode-label {
		display: block;
		font-size: 0.85rem;
		line-height: 1.2;
	}
	.mode-desc {
		display: block;
		font-size: 0.7rem;
		line-height: 1.3;
		color: var(--muted-foreground);
	}
	.wifi {
		display: grid;
		gap: 6px;
		padding-left: 22px;
	}
	.bright-label {
		font-size: 0.85rem;
		font-weight: 500;
	}
	.summary {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 8px 16px;
		margin: 0;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--background);
		font-size: 0.85rem;
	}
	.summary dt {
		color: var(--muted-foreground);
	}
	.summary dd {
		margin: 0;
		min-width: 0;
	}
	.lead {
		font-size: 0.85rem;
		line-height: 1.5;
		margin: 0 2px;
	}

	.callout {
		display: flex;
		gap: 10px;
		padding: 11px 13px;
		border-radius: var(--radius-lg);
		border: 1px solid var(--border);
		background: var(--background);
		font-size: 0.8rem;
		line-height: 1.45;
	}
	.callout :global(svg) {
		margin-top: 1px;
		color: var(--muted-foreground);
	}
	.callout.hot {
		border-color: color-mix(in oklch, var(--live), transparent 60%);
		background: color-mix(in oklab, var(--live), var(--background) 93%);
	}
	.callout.hot :global(svg) {
		color: var(--live);
	}
	.callout p {
		margin: 0;
	}

	.pick {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.pick-row {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 10px 14px;
		text-align: left;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--background);
		cursor: pointer;
		transition: border-color 0.12s ease;
	}
	.pick-row:hover {
		border-color: color-mix(in oklab, var(--primary), transparent 50%);
	}

	.newer {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		padding: 13px 14px;
		border-radius: var(--radius-xl);
		border: 1px solid color-mix(in oklch, var(--primary), transparent 70%);
		background: color-mix(in oklab, var(--primary), var(--background) 95%);
	}
	.newer-head {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.85rem;
		font-weight: 600;
	}
	.newer p {
		margin: 0;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--muted-foreground);
	}

	/* wireless light: plug it in first */
	.plug {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 8px;
		padding: 18px 8px 4px;
	}
	.plug-icon {
		display: grid;
		place-items: center;
		width: 64px;
		height: 64px;
		margin-bottom: 6px;
		border-radius: 50%;
		color: var(--primary);
		background: color-mix(in oklab, var(--primary), var(--background) 90%);
		box-shadow: 0 0 0 0 color-mix(in oklch, var(--primary), transparent 60%);
		animation: ping 2.2s ease-out infinite;
	}
	@keyframes ping {
		0% {
			box-shadow: 0 0 0 0 color-mix(in oklch, var(--primary), transparent 55%);
		}
		80%,
		100% {
			box-shadow: 0 0 0 16px color-mix(in oklch, var(--primary), transparent 100%);
		}
	}
	.plug h3 {
		font-size: 0.95rem;
		font-weight: 600;
	}
	.plug p {
		margin: 0;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--muted-foreground);
		max-width: 32ch;
	}
	.plug-icon.found {
		color: oklch(0.6 0.15 150);
		background: color-mix(in oklab, oklch(0.6 0.15 150), var(--background) 88%);
		animation: none;
	}
	.plug .wrong {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-top: 8px;
		max-width: 34ch;
		color: var(--destructive);
		font-size: 0.8rem;
	}
	.plug .waiting {
		display: flex;
		align-items: center;
		gap: 7px;
		margin-top: 8px;
		color: var(--foreground);
	}

	/* progress stepper */
	.steps {
		list-style: none;
		margin: 0;
		padding: 6px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-xl);
		background: var(--background);
	}
	.step {
		display: flex;
		gap: 11px;
		padding: 9px 0;
		font-size: 0.84rem;
	}
	.mark {
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		flex: none;
		margin-top: 1px;
	}
	.step.todo .mark {
		border: 1.5px solid var(--border);
	}
	.step.done .mark {
		background: var(--primary);
		color: var(--primary-foreground);
	}
	.step.now .mark {
		color: var(--primary);
	}
	.step-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
		flex: 1;
		min-width: 0;
	}
	.step.todo .step-label {
		color: var(--muted-foreground);
	}
	.step.done .step-label {
		color: var(--muted-foreground);
	}
	.step.now .step-label {
		font-weight: 500;
	}
	.step-hint {
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}
	.write {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.pct {
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--muted-foreground);
		width: 3.2ch;
		text-align: right;
	}

	/* done / failed / stopped */
	.outcome {
		display: flex;
		gap: 11px;
		padding: 14px;
		border-radius: var(--radius-xl);
		border: 1px solid var(--border);
		background: var(--background);
	}
	.outcome h3 {
		font-size: 0.9rem;
		font-weight: 600;
		margin-bottom: 4px;
	}
	.outcome p {
		margin: 0;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--muted-foreground);
	}
	.outcome strong {
		color: var(--foreground);
		font-weight: 600;
	}
	.outcome.ok :global(svg) {
		color: oklch(0.6 0.15 150);
	}
	.outcome.bad {
		border-color: color-mix(in oklch, var(--destructive), transparent 70%);
	}
	.outcome.bad > :global(svg) {
		color: var(--destructive);
	}
	.outcome.muted > :global(svg) {
		color: var(--muted-foreground);
	}
	.fix {
		list-style: decimal;
		margin: 8px 0 0;
		padding-left: 18px;
		font-size: 0.8rem;
		line-height: 1.6;
		color: var(--muted-foreground);
	}

	.detail {
		font-size: 0.75rem;
		color: var(--muted-foreground);
		margin: 0 2px;
	}
	.detail summary {
		cursor: pointer;
	}
	.detail code {
		display: block;
		margin-top: 6px;
		padding: 8px 10px;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		line-height: 1.5;
		border-radius: var(--radius-md);
		background: var(--background);
		border: 1px solid var(--border);
		word-break: break-word;
	}

	.footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 20px;
		border-top: 1px solid var(--border);
		background: var(--background);
		flex-shrink: 0;
	}
	.foot-msg {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 0.8rem;
		color: var(--muted-foreground);
	}
	.foot-msg.warn {
		color: var(--foreground);
		font-weight: 500;
	}
	.foot-actions {
		display: flex;
		gap: 8px;
	}
</style>
