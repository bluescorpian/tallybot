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
		/** The input the light is assigned to, if any — flashing takes it dark. */
		input: { label: string; live: boolean } | null;
	}
</script>

<script lang="ts">
	// The flasher drawer: sets up a blank board, or updates a light's firmware. A right-side
	// Sheet like Settings, for the same reason (DESIGN.md → "Why a drawer"): the board stays
	// visible beside it, so you watch the light drop off, then come back into the dock or its
	// column when it's done.
	//
	// Flow: [plug in, wireless lights only] → review → flashing → done | failed | stopped.
	// Review is where a deliberate choice is made: it says what goes dark, and, if a newer
	// TallyBot ships newer firmware, offers "update TallyBot first" beside "install anyway".
	// While flashing the drawer can't be dismissed by a stray click; Stop asks first.
	//
	// It drives a `Flasher` (start / cancel / reset + reactive state); the page decides
	// whether that's the mock or the real espflash driver.
	import * as Sheet from "$lib/components/ui/sheet";
	import { Button } from "$lib/components/ui/button";
	import { Progress } from "$lib/components/ui/progress";
	import type { Flasher, FlashStage, FlashTarget } from "$lib/mock/flasher.svelte";
	import { FLASH_STAGES } from "$lib/mock/flasher.svelte";
	import type { AppUpdate } from "$lib/mock/updater.svelte";
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
	import Radio from "@lucide/svelte/icons/radio";
	import Lightbulb from "@lucide/svelte/icons/lightbulb";

	interface Props {
		open?: boolean;
		job: FlashJob | null;
		flasher: Flasher;
		/** A newer TallyBot release whose firmware is newer than this app's, if one is known. */
		newerUpdate?: AppUpdate | null;
		/** "Update TallyBot first" — the host closes this and opens the app updater. */
		onupdateapp?: () => void;
	}
	let { open = $bindable(false), job, flasher, newerUpdate = null, onupdateapp }: Props = $props();

	const fw = $derived(flasher.firmwareVersion);
	const st = $derived(flasher.state);
	const running = $derived(st.status === "running");
	let confirmStop = $state(false);

	type View = "plug" | "review" | "running" | "done" | "failed" | "cancelled";
	const view = $derived<View>(
		st.status === "idle" ? (job && job.port === null ? "plug" : "review") : st.status,
	);
	$effect(() => {
		if (!running) confirmStop = false;
	});

	// Closing (not possible mid-flash) clears the outcome so the next open starts fresh.
	$effect(() => {
		if (!open && !running && st.status !== "idle") flasher.reset();
	});

	const name = $derived(job?.kind === "light" ? job.label : null);
	const title = $derived(job?.kind === "blank" ? "Set up a new light" : "Update light firmware");

	function target(): FlashTarget | null {
		if (!job || job.port === null) return null;
		return job.kind === "blank"
			? { kind: "blank", port: job.port }
			: { kind: "light", mac: job.mac ?? "", label: job.label ?? "", port: job.port };
	}
	// The version the light had when flashing began: the job is live state, so once the light
	// comes back its reported version is already the new one.
	let fromAtStart = $state<string | null>(null);
	const fromVersion = $derived(view === "plug" || view === "review" ? (job?.fromVersion ?? null) : fromAtStart);
	function start() {
		const t = target();
		if (!t) return;
		fromAtStart = job?.fromVersion ?? null;
		flasher.start(t);
	}
	function retry() {
		flasher.reset();
		start();
	}
	function stop() {
		flasher.cancel();
		confirmStop = false;
	}

	function stageLabel(s: FlashStage): string {
		switch (s) {
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
	const stageIndex = $derived(
		st.status === "running" || st.status === "failed" || st.status === "cancelled"
			? FLASH_STAGES.indexOf(st.stage)
			: st.status === "done"
				? FLASH_STAGES.length
				: -1,
	);
	const pct = $derived(st.status === "running" && st.stage === "write" ? Math.round(st.progress * 100) : 0);
	// the board's own label for the light: the last two octets of its MAC
	const newTail = $derived(st.status === "done" ? st.mac.split(":").slice(-2).join(":") : null);
	const portName = $derived(job?.port ?? "the USB port");
</script>

<Sheet.Root bind:open>
	<Sheet.Content
		side="right"
		showCloseButton={false}
		overlayClass="bg-black/10 supports-backdrop-filter:backdrop-blur-none"
		onInteractOutside={(e) => {
			if (running) e.preventDefault();
		}}
		onEscapeKeydown={(e) => {
			if (running) e.preventDefault();
		}}
		class="w-full gap-0 p-0 sm:max-w-[400px]"
	>
		<Sheet.Header class="flex-row items-center gap-2.5 border-b px-5 py-3.5">
			<Cpu class="text-muted-foreground size-[18px]" />
			<Sheet.Title class="text-[0.95rem] font-semibold tracking-tight">{title}</Sheet.Title>
		</Sheet.Header>

		<div class="body">
			{#if job}
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
								<span class="text-muted-foreground">· wireless</span>
							{/if}
						</span>
					</span>
					<span class="versions" title="Firmware">
						{#if fromVersion}
							<span class="ver old">{fromVersion}</span>
						{:else if job.kind === "blank"}
							<span class="ver old">none</span>
						{/if}
						<ArrowRight class="text-muted-foreground size-3" />
						<span class="ver new">{fw}</span>
					</span>
				</div>

				{#if view === "plug"}
					<div class="plug">
						<span class="plug-icon"><Usb class="size-7" /></span>
						<h3>Plug {name} into this PC</h3>
						<p>
							Firmware can only be installed over a USB cable. Use a USB-C cable that carries
							data (some charge-only cables don't).
						</p>
						<p class="waiting"><LoaderCircle class="size-3.5 animate-spin" /> Waiting for {name}…</p>
					</div>
				{:else if view === "review"}
					<p class="lead">
						{#if job.kind === "blank"}
							This installs TallyBot firmware so the board can work as a tally light. It takes about
							a minute.
						{:else}
							{name} runs firmware {job.fromVersion ?? "older than this app's"}. Updating installs
							{fw}, the version made for this copy of TallyBot. It takes about a minute.
						{/if}
					</p>

					{#if job.input}
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

					<ul class="facts">
						<li><Usb class="size-4 shrink-0" /> Keep the cable plugged in until it's finished.</li>
						<li>
							<Radio class="size-4 shrink-0" />
							{job.kind === "blank" ? "Your lights" : "Your other lights"} stay live the whole time.
						</li>
					</ul>

					{#if newerUpdate}
						<!-- Product rule: if a newer TallyBot ships newer firmware, say so here, before
						     anything is written — a choice, not a block. -->
						<div class="newer">
							<div class="newer-head">
								<CircleArrowUp class="text-primary size-4 shrink-0" />
								<span>Newer firmware comes with TallyBot {newerUpdate.version}</span>
							</div>
							<p>
								This copy of TallyBot installs firmware {fw}. TallyBot {newerUpdate.version}
								installs {newerUpdate.firmwareVersion}. Either works: update TallyBot first to get the
								newer firmware, or install {fw} now and update later.
							</p>
							<Button variant="outline" size="sm" onclick={() => onupdateapp?.()}>
								<CircleArrowUp /> Update TallyBot first
							</Button>
						</div>
					{/if}
				{:else if view === "running" || view === "done"}
					<ol class="steps">
						{#each FLASH_STAGES as s, i (s)}
							{@const state = i < stageIndex ? "done" : i === stageIndex ? "now" : "todo"}
							<li class="step {state}">
								<span class="mark">
									{#if state === "done"}
										<Check class="size-3" strokeWidth={3} />
									{:else if state === "now"}
										<LoaderCircle class="size-4 animate-spin" />
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

					{#if view === "done"}
						<div class="outcome ok">
							<CircleCheck class="size-5 shrink-0" />
							<div>
								{#if job.kind === "blank"}
									<h3>New light <span class="font-mono">{newTail}</span> is ready</h3>
									<p>
										It's waiting in the <strong>Unassigned</strong> tray at the bottom of the board.
										Click it there to choose its input.
									</p>
								{:else}
									<h3>{name} is up to date</h3>
									<p>
										Running firmware {fw}{job.input ? `, and back on ${job.input.label}` : ""}.
									</p>
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
							{:else}
								<h3>The cable came out</h3>
								<p>
									The board was unplugged partway through, so it's blank for now. Nothing is damaged:
									plug it back in and try again.
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
							<h3>Stopped</h3>
							<p>
								{job.kind === "light" ? name : "The board"} has no firmware now, so it stays dark until
								it's flashed again. Nothing is damaged.
							</p>
						</div>
					</div>
				{/if}
			{/if}
		</div>

		<footer class="footer">
			{#if view === "running"}
				{#if confirmStop}
					<span class="foot-msg warn">Leave the board blank?</span>
					<div class="foot-actions">
						<Button variant="ghost" onclick={() => (confirmStop = false)}>Keep going</Button>
						<Button variant="destructive" onclick={stop}>Stop</Button>
					</div>
				{:else}
					<span class="foot-msg"><Usb class="size-3.5" /> Don't unplug the board</span>
					<div class="foot-actions">
						<Button variant="ghost" onclick={() => (confirmStop = true)}>Stop</Button>
					</div>
				{/if}
			{:else if view === "review"}
				<span></span>
				<div class="foot-actions">
					<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
					<Button onclick={start}>
						{job?.kind === "blank" ? `Install firmware ${fw}` : `Update to ${fw}`}
					</Button>
				</div>
			{:else if view === "plug"}
				<span></span>
				<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
			{:else if view === "done"}
				<span></span>
				<div class="foot-actions">
					<Button onclick={() => (open = false)}>Done</Button>
				</div>
			{:else}
				<span></span>
				<div class="foot-actions">
					<Button variant="ghost" onclick={() => (open = false)}>Close</Button>
					<Button onclick={retry} disabled={job?.port == null}>
						{view === "cancelled" ? "Flash again" : "Try again"}
					</Button>
				</div>
			{/if}
		</footer>
	</Sheet.Content>
</Sheet.Root>

<style>
	.body {
		flex: 1;
		min-height: 0;
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

	.facts {
		list-style: none;
		margin: 0;
		padding: 0 2px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 0.8rem;
		color: var(--muted-foreground);
	}
	.facts li {
		display: flex;
		align-items: center;
		gap: 9px;
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
