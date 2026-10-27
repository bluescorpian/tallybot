<script lang="ts">
	// The app-update dialog. Opened from the titlebar's update pill or Settings → About —
	// never by itself: an operator mid-service shouldn't have a modal appear on them.
	//
	// Two deliberate steps, because they cost different things:
	//   Download   — harmless mid-show (the board and lights carry on); the dialog can be
	//                closed and the download continues, with the titlebar pill showing progress.
	//   Restart    — installs the update, which restarts TallyBot and its engine, so every
	//                light drops for a few seconds. "Later" keeps the download; the titlebar
	//                pill stays until it's installed.
	// An install that can't update itself (portable zip, .deb, .rpm) gets the release page instead.
	// A centred dialog rather than a drawer: this is a short decision, not a task you watch
	// play out on the board.
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Progress } from "$lib/components/ui/progress";
	import { downloadProgress, type Updater } from "$lib/updater/updater";
	import { formatReleaseDate } from "$lib/format/time";
	import { openUrl } from "@tauri-apps/plugin-opener";
	import CircleArrowUp from "@lucide/svelte/icons/circle-arrow-up";
	import CircleCheck from "@lucide/svelte/icons/circle-check";
	import CircleX from "@lucide/svelte/icons/circle-x";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import Cpu from "@lucide/svelte/icons/cpu";
	import RotateCw from "@lucide/svelte/icons/rotate-cw";

	let {
		open = $bindable(false),
		updater,
		blocked = null,
	}: {
		open?: boolean;
		updater: Updater;
		/** Why restarting is refused right now (e.g. a firmware install is running), or null. */
		blocked?: string | null;
	} = $props();

	const st = $derived(updater.state);
	const update = $derived("update" in st ? st.update : null);
	const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);
	const pct = $derived(st.status === "downloading" ? Math.round(downloadProgress(st.received, st.update) * 100) : 0);
	const date = $derived(update ? formatReleaseDate(update.date) : null);

	// Restart once the dialog has closed: starting it first flips the status to "restarting",
	// which this dialog doesn't render, so its body would blank out while it fades.
	let restartOnClose = false;
	function restart() {
		restartOnClose = true;
		open = false;
	}
	function onclosed(isOpen: boolean) {
		if (isOpen || !restartOnClose) return;
		restartOnClose = false;
		updater.restart();
	}
</script>

<Dialog.Root bind:open onOpenChangeComplete={onclosed}>
	<!-- light, unblurred backdrop, like the flasher drawer's: the tally monitor stays readable -->
	<Dialog.Content
		showCloseButton={false}
		overlayClass="bg-black/10 supports-backdrop-filter:backdrop-blur-none"
		class="gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-[420px]">
		{#if st.status === "checking"}
			<div class="center">
				<LoaderCircle class="text-muted-foreground size-6 animate-spin" />
				<Dialog.Title class="text-base font-semibold">Checking for updates…</Dialog.Title>
			</div>
		{:else if st.status === "current" || st.status === "idle"}
			<div class="center">
				<CircleCheck class="size-7 text-[oklch(0.6_0.15_150)]" />
				<Dialog.Title class="text-base font-semibold">TallyBot is up to date</Dialog.Title>
				<Dialog.Description>You have the latest version, {updater.currentVersion}.</Dialog.Description>
			</div>
			<div class="foot">
				<Button onclick={() => (open = false)}>OK</Button>
			</div>
		{:else if st.status === "error" && !update}
			<div class="center">
				<CircleX class="text-destructive size-7" />
				<Dialog.Title class="text-base font-semibold">Couldn't check for updates</Dialog.Title>
				<Dialog.Description class="select-text">{st.message}</Dialog.Description>
			</div>
			<div class="foot">
				<Button variant="ghost" onclick={() => (open = false)}>Close</Button>
				<Button onclick={() => updater.check()}>Try again</Button>
			</div>
		{:else if update}
			<div class="head">
				<span class="badge"><CircleArrowUp class="size-5" /></span>
				<div>
					<Dialog.Title class="text-base leading-tight font-semibold">
						{st.status === "ready"
							? `TallyBot ${update.version} is ready to install`
							: st.status === "error"
								? `Couldn't download TallyBot ${update.version}`
								: `TallyBot ${update.version} is available`}
					</Dialog.Title>
					<Dialog.Description class="text-[0.8rem]">
						You have {updater.currentVersion}{date ? ` · released ${date}` : ""}
					</Dialog.Description>
				</div>
			</div>

			<div class="content">
				{#if st.status === "available" || st.status === "downloading" || st.status === "error"}
					<div>
						<p class="label">What's new</p>
						<ul class="notes">
							{#each update.notes as note (note)}<li>{note}</li>{/each}
						</ul>
					</div>
					<p class="fw">
						<Cpu class="size-4 shrink-0" />
						<span>Comes with light firmware <span class="font-mono">{update.firmwareVersion}</span>.</span>
					</p>
				{/if}

				{#if st.status === "downloading"}
					<div class="dl">
						<Progress value={pct} class="bg-foreground/10 h-1.5" />
						<span class="dl-meta">
							<span>Downloading…</span>
							<span class="font-mono"
								>{mb(st.received)}{#if update.sizeBytes} / {mb(update.sizeBytes)}{/if} MB</span
							>
						</span>
					</div>
				{:else if st.status === "error"}
					<p class="err"><CircleX class="size-4 shrink-0" /> <span class="select-text">{st.message}</span></p>
				{:else if st.status === "ready"}
					<div class="warn">
						<TriangleAlert class="size-4 shrink-0" />
						<p>
							<strong>Restarting takes every light offline for a few seconds</strong> while TallyBot
							restarts. Do it between services, not during one.
						</p>
					</div>
				{/if}
			</div>

			<div class="foot">
				{#if st.status === "available"}
					<Button variant="ghost" onclick={() => (open = false)}>Not now</Button>
					{#if update.installable}
						<Button onclick={() => updater.download()}
							>Download{#if update.sizeBytes} · {mb(update.sizeBytes)} MB{/if}</Button
						>
					{:else}
						<!-- this install can't replace itself: the new build comes from the release page -->
						<Button onclick={() => void openUrl(update.releaseUrl)}>Get it from GitHub</Button>
					{/if}
				{:else if st.status === "downloading"}
					<Button variant="ghost" onclick={() => (open = false)}>Hide</Button>
				{:else if st.status === "error"}
					<Button variant="ghost" onclick={() => (open = false)}>Close</Button>
					<Button onclick={() => updater.download()}>Try again</Button>
				{:else if st.status === "ready"}
					{#if blocked}<span class="foot-note">{blocked}</span>{/if}
					<Button variant="ghost" onclick={() => (open = false)}>Later</Button>
					<Button onclick={restart} disabled={!!blocked}><RotateCw /> Restart now</Button>
				{/if}
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	.center {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 32px 24px 22px;
		text-align: center;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 20px 22px 16px;
		border-bottom: 1px solid var(--border);
	}
	.badge {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		flex: none;
		border-radius: 12px;
		color: var(--primary);
		background: color-mix(in oklab, var(--primary), var(--background) 90%);
	}
	.content {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 16px 22px 18px;
		background: var(--muted);
	}
	.label {
		font-size: 0.72rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted-foreground);
		margin-bottom: 6px;
	}
	.notes {
		list-style: disc;
		margin: 0;
		padding-left: 18px;
		font-size: 0.84rem;
		line-height: 1.6;
	}
	.fw {
		display: flex;
		gap: 9px;
		font-size: 0.8rem;
		line-height: 1.45;
		color: var(--muted-foreground);
	}
	.fw :global(svg) {
		margin-top: 1px;
	}
	.dl {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}
	.dl-meta {
		display: flex;
		justify-content: space-between;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}
	.err {
		display: flex;
		gap: 8px;
		font-size: 0.8rem;
		color: var(--destructive);
	}
	.warn {
		display: flex;
		gap: 10px;
		padding: 11px 13px;
		border-radius: var(--radius-lg);
		border: 1px solid var(--border);
		background: var(--background);
		font-size: 0.8rem;
		line-height: 1.45;
	}
	.warn :global(svg) {
		margin-top: 1px;
	}
	.warn p {
		margin: 0;
	}
	.warn strong {
		font-weight: 600;
	}
	.foot {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		padding: 12px 18px;
		border-top: 1px solid var(--border);
	}
	.foot-note {
		margin-right: auto;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}
</style>
