<script lang="ts">
	// Main view — the assembled board (docs/design.md). The locked <Board> is driven by a
	// view-model produced from an IPC `AppState` (sidecar/src/ipc.ts) via the $lib/boardState.ts
	// mapper, exactly as the real engine feeds it.
	//
	// The page talks to one `Backend` ($lib/backend.ts), picked once: under Tauri the live one
	// (the sidecar's snapshot stream, the shell's health, espflash and the updater plugin); in a
	// plain browser (`pnpm dev`) the mock board ($lib/mock/board.svelte.ts, whose `?demo=`,
	// `?fail=` and `?wifi=` params are documented there), so the board still renders and design
	// iteration works. The flasher's rules live in `FlashSession`; this page keeps the layout,
	// the notices and the dialogs' wiring.
	import { onMount, untrack } from "svelte";
	import type { LogLevelName } from "$ipc";
	import Board from "$lib/components/board/Board.svelte";
	import { FLASHER_URL } from "$lib/links";
	import { sidecarLost, toBoardProps } from "$lib/boardState";
	import { isTauri } from "$lib/ipc.svelte";
	import type { Backend } from "$lib/backend";
	import { LiveBackend } from "$lib/live.svelte";
	import { MockBoard } from "$lib/mock/board.svelte";
	import { fly } from "svelte/transition";
	import Info from "@lucide/svelte/icons/info";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import CircleAlert from "@lucide/svelte/icons/circle-alert";
	import X from "@lucide/svelte/icons/x";
	import SettingsSheet from "$lib/components/settings/SettingsSheet.svelte";
	import TitleBar from "$lib/components/chrome/TitleBar.svelte";
	import Credit from "$lib/components/chrome/Credit.svelte";
	import FlasherDialog from "$lib/components/flasher/FlasherDialog.svelte";
	import UpdateDialog from "$lib/components/updates/UpdateDialog.svelte";
	import type { UpdatePill } from "$lib/components/chrome/TitleBar.svelte";
	import { FlashSession } from "$lib/flasher/session.svelte";
	import { downloadProgress } from "$lib/updater/updater";
	import LoaderCircle from "@lucide/svelte/icons/loader-circle";

	const mock = isTauri ? null : new MockBoard(new URLSearchParams(location.search));
	const backend: Backend = mock ?? new LiveBackend();
	const { flasher, updater } = backend;
	onMount(() => backend.start());

	let settingsOpen = $state(false); // settings drawer (Sheet) open?
	let updateOpen = $state(false);
	const session = new FlashSession(flasher, updater, backend, () => (updateOpen = true));
	if (mock) onMount(() => mock.simulate(session));

	const appState = $derived(backend.state);
	const health = $derived(backend.health);
	// The rig's inputs, for the flasher's Settings step and the notices.
	const inputs = $derived(appState.inputs);

	// Dev mode (fake ATEM): the sidecar marks its snapshots `dev`. Only then are the
	// board's input keys interactive; otherwise they stay plain, non-clickable keys.
	const devMode = $derived(appState.dev === true);

	// Engine down (crashed, being restarted): the snapshot is stale, so the board shows
	// the rig with every light offline and the source reconnecting — never old tally.
	const engineDown = $derived(backend.engineDown);
	const props = $derived(toBoardProps(engineDown ? sidecarLost(appState) : appState));
	// Each light's firmware against the firmware THIS app ships, so an app update re-badges lights.
	const lights = $derived(
		props.lights.map((l) => {
			const d = appState.devices.find((x) => x.mac === l.mac);
			if (!d) return l;
			return {
				...l,
				firmwareVersion: session.firmware(d).version,
				firmwareOutdated: session.outdated(d),
				firmwareAvailable: flasher.firmwareVersion,
			};
		}),
	);

	// Titlebar pill: only once there's something to act on, and never as a popup.
	const updatePill = $derived.by<UpdatePill | null>(() => {
		const s = updater.state;
		// A failed check (offline at launch) stays quiet: it's only news once an update is known.
		if (s.status === "available") return { kind: "available", version: s.update.version };
		if (s.status === "error" && s.update) return { kind: "available", version: s.update.version };
		if (s.status === "downloading") return { kind: "downloading", progress: downloadProgress(s.received, s.update) };
		if (s.status === "ready") return { kind: "ready" };
		return null;
	});
	const restarting = $derived(updater.state.status === "restarting");

	// While an install runs, anything that restarts the engine is refused, since that would cut
	// the install off mid-write.
	const installBlocked = $derived(
		session.running ? "A light's firmware is being installed. Restart once it's finished." : null,
	);

	// Bring a light into view on the board with a one-off highlight; `pick` opens its picker.
	// After a beat, so the flasher dialog that asked for it is out of the way first.
	let reveal = $state<{ mac: string; pick: boolean; seq: number } | null>(null);
	let revealSeq = 0;
	function revealLight(mac: string, pick: boolean) {
		setTimeout(() => (reveal = { mac, pick, seq: ++revealSeq }), 250);
	}

	// ── Notices — compact cards floating in the board's bottom-right corner ─────
	// The board is left-aligned, so that corner is empty dot-grid at any width; a card there
	// keeps its action and × next to the text and never pushes the board down.
	// The engine being down is an error that stays until it's back (not dismissible:
	// it's the reason the board is dark). USB port errors (from the shell) and the engine's
	// faults are dismissible and return only if their message changes; a sidecar notice (firmware-outdated,
	// offline-flash, …) is dismissed as that one event, so a later notice shows again.
	// An unflashed board (shell health) points at the web flasher until it's unplugged.
	interface Banner {
		key: string;
		level: LogLevelName;
		message: string;
		dismissible: boolean;
		/** The banner's next step, as a button after the message. */
		action?: { label: string; run: () => void };
	}

	// A saved ATEM that never answers leaves the chip spinning forever, which reads as "wait"
	// when the fix is on the user's side (a wrong IP, or this PC on another network). After a
	// grace period long enough to ride out a normal connect or a brief drop, say so. The engine
	// keeps retrying either way, so this is presentation only. `reaching` is a primitive so
	// the timer restarts only when the attempt does, not on every snapshot.
	const UNREACHABLE_AFTER_MS = 12_000;
	const reaching = $derived(
		!engineDown &&
			props.sourceIp !== null &&
			(props.sourceStatus === "connecting" || props.sourceStatus === "disconnected")
			? props.sourceIp
			: null,
	);
	let unreachableIp = $state<string | null>(null);
	$effect(() => {
		const ip = reaching;
		unreachableIp = null;
		if (ip === null) return;
		const timer = setTimeout(() => (unreachableIp = ip), UNREACHABLE_AFTER_MS);
		return () => clearTimeout(timer);
	});
	const openWebFlasher = () => backend.openExternal(FLASHER_URL);
	// The engine's faults (sidecar/src/faults.ts). Not while it's down: they're the dead process's.
	const faults = $derived(engineDown ? [] : (appState.faults ?? []));
	let dismissed = $state<Record<string, string>>({});
	let dismissedNotice = $state<unknown>(null);
	const banners = $derived.by<Banner[]>(() => {
		const list: Banner[] = [];
		if (engineDown) {
			const why = health.sidecarDown;
			list.push({
				key: "engine",
				level: "error",
				message: why
					? `TallyBot's engine stopped (${why}) and is restarting. The board and lights aren't live until it's back.`
					: "TallyBot's engine is restarting. The board and lights aren't live until it's back.",
				dismissible: false,
			});
		}
		// Like the USB port errors: dismissible, and back only if the message changes. The ATEM's
		// own reason, when it gave one, replaces the timed guess below.
		for (const f of faults) {
			list.push({
				key: `fault:${f.key}`,
				level: f.level,
				message: f.message,
				dismissible: true,
				action: f.key === "atem" ? { label: "Settings", run: () => (settingsOpen = true) } : undefined,
			});
		}
		if (unreachableIp !== null && !faults.some((f) => f.key === "atem")) {
			list.push({
				key: "unreachable",
				level: "warn",
				message: `Can't reach the ATEM at ${unreachableIp}. Check the IP address, and that this PC is on the same network as the switcher.`,
				dismissible: true,
				action: { label: "Settings", run: () => (settingsOpen = true) },
			});
		}
		for (const e of health.usbPortErrors) {
			list.push({ key: `usb:${e.port}`, level: "warn", message: e.message, dismissible: true });
		}
		for (const port of health.unflashedPorts) {
			if (session.ready) {
				// the drawer already says everything while it's working on this board
				// one install at a time: no other board is offered while one runs
				if (session.running) continue;
				if (session.open && session.request?.kind === "blank" && session.request.port === port) continue;
				// Dismissible: the titlebar's firmware button is always a way back in. A dismissal
				// lasts while the board stays plugged in (cleared when its port goes away).
				list.push({
					key: `unflashed:${port}`,
					level: "info",
					message: "A new tally light is plugged in but isn't set up yet.",
					dismissible: true,
					action: { label: "Set up as a light", run: () => session.openFlasher({ kind: "blank", port }) },
				});
				continue;
			}
			list.push({
				key: `unflashed:${port}`,
				level: "info",
				message: `The board on ${port} doesn't have TallyBot firmware yet. Flash it with the web flasher (TallyBot can stay open), then unplug it and plug it back in.`,
				dismissible: true,
				action: { label: "Open flasher", run: openWebFlasher },
			});
		}
		const justUpdated = updater.state.status === "current" ? updater.state.justUpdated : undefined;
		if (justUpdated) {
			const n = lights.filter((l) => l.firmwareOutdated).length;
			const resume = session.resume;
			list.push({
				key: "updated",
				level: "info",
				message:
					`TallyBot is updated to ${justUpdated}.` +
					(n && !resume
						? ` ${n} ${n === 1 ? "light has" : "lights have"} newer firmware available: click a light marked ↑ to update it.`
						: ""),
				dismissible: true,
				action: resume
					? {
							label: resume.kind === "blank" ? "Continue setting up the new light" : "Continue updating the light",
							run: session.resumeParked,
						}
					: undefined,
			});
		}
		const n = backend.notice;
		if (n && n !== dismissedNotice) {
			list.push({ key: "notice", level: n.level, message: n.message, dismissible: true });
		}
		return list.filter((b) => dismissed[b.key] !== b.message);
	});
	// A blank board unplugged and plugged back in is news again: forget its dismissal.
	$effect(() => {
		const ports = new Set(health.unflashedPorts);
		const stale = Object.keys(untrack(() => dismissed)).filter(
			(k) => k.startsWith("unflashed:") && !ports.has(k.slice("unflashed:".length)),
		);
		if (stale.length) {
			const next = { ...untrack(() => dismissed) };
			for (const k of stale) delete next[k];
			dismissed = next;
		}
	});
	function dismiss(banner: Banner) {
		if (banner.key === "notice") dismissedNotice = backend.notice;
		else dismissed = { ...dismissed, [banner.key]: banner.message };
	}
</script>

<div class="page">
	<!-- custom frameless titlebar — the gear opens the settings drawer (docs/design.md) -->
	<TitleBar
		onsettings={() => (settingsOpen = true)}
		update={updatePill}
		onupdate={() => (updateOpen = true)}
		install={session.installPill}
		oninstall={() => (session.open = true)}
		onfirmware={session.ready ? () => session.openFlasher({ kind: "any" }) : undefined}
	/>

	<SettingsSheet
		bind:open={settingsOpen}
		source={backend.engine?.source ?? null}
		onsave={(ip) => backend.setSource(ip)}
		onrestart={backend.engine ? () => backend.engine!.restart() : undefined}
		autostart={backend.engine?.autostart}
		onscan={backend.engine ? () => backend.engine!.scanSources() : undefined}
		scanResult={backend.engine?.scan ?? null}
		{updater}
		restartBlocked={installBlocked}
		onviewupdate={() => {
			settingsOpen = false;
			updateOpen = true;
		}}
	/>

	<FlasherDialog
		candidates={session.candidates}
		onpick={session.pick}
		bind:open={session.open}
		job={session.job}
		{flasher}
		newerUpdate={session.newerUpdate}
		newerReady={updater.state.status === "ready"}
		onupdateapp={session.updateAppFirst}
		inputs={inputs.map((i) => ({ id: String(i.id), label: i.label }))}
		currentSettings={session.currentSettings}
		onapply={session.applySettings}
		onreveal={revealLight}
		onidentify={(mac) => {
			backend.identify(mac);
			revealLight(mac, false);
		}}
	/>

	<UpdateDialog bind:open={updateOpen} {updater} blocked={installBlocked} />

	<div class="stage">
		<Board
			inputs={props.inputs}
			{lights}
			sourceStatus={props.sourceStatus}
			sourceConnected={props.sourceConnected}
			sourceIp={props.sourceIp}
			assignable={props.assignable}
			override={props.override}
			overrideSource={props.overrideSource}
			actions={{
				assign: (mac, inputId) => backend.assign(mac, Number(inputId)),
				unassign: (mac) => backend.unassign(mac),
				// the board already echoes a local blink; this streams the real locate flash too
				flash: (mac) => backend.identify(mac),
				setBrightness: (mac, v) => backend.setBrightness(mac, v),
				provisionWifi: (mac, ssid, pass) => backend.provisionWifi(mac, ssid, pass),
				setTransport: (mac, mode) => backend.setTransport(mac, mode),
				setBridge: (mac) => backend.setBridge(mac),
				updateFirmware: session.ready ? (mac) => session.openFlasher({ kind: "light", mac }) : undefined,
			}}
			{reveal}
			onsetup={() => (settingsOpen = true)}
			oninputclick={devMode ? (inputId) => backend.setProgram(Number(inputId)) : undefined}
		/>
	</div>

	{#if banners.length}
		<div class="notices">
			{#each banners as banner (banner.key)}
				<div
					class="notice"
					class:warn={banner.level === "warn"}
					class:error={banner.level === "error"}
					role={banner.level === "error" ? "alert" : "status"}
					transition:fly={{ x: 24, duration: 180 }}
				>
					{#if banner.level === "error"}
						<CircleAlert class="icon" />
					{:else if banner.level === "warn"}
						<TriangleAlert class="icon" />
					{:else}
						<Info class="icon" />
					{/if}
					<div class="body">
						<!-- selectable: an error is worth copying into a report or a search -->
						<p class="select-text">{banner.message}</p>
						{#if banner.action}
							<button type="button" class="action" onclick={banner.action.run}
								>{banner.action.label}</button
							>
						{/if}
					</div>
					{#if banner.dismissible}
						<button
							type="button"
							class="close"
							onclick={() => dismiss(banner)}
							aria-label="Dismiss"><X class="size-3.5" /></button
						>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<Credit />

	{#if restarting}
		<!-- Installing an update: the app (and engine) restart. Over everything but the titlebar,
		     so it's unmistakable why the board went quiet. -->
		<div class="restarting" role="status" transition:fly={{ y: 8, duration: 160 }}>
			<LoaderCircle class="size-6 animate-spin" />
			<p class="restarting-title">Restarting TallyBot to finish the update…</p>
			<p class="restarting-sub">Lights reconnect by themselves in a few seconds.</p>
		</div>
	{/if}
</div>

<style>
	/* Full-height column: titlebar (fixed) above a board that fills the rest. The
	   credit is absolutely positioned over the board's bottom margin (see Credit). */
	.page {
		height: 100%;
		display: flex;
		flex-direction: column;
		position: relative;
		/* warm taupe desk; the titlebar paints its own cream over the top band */
		background: var(--workspace);
	}

	/* Canvas behaviour (docs/design.md): no zoom; scroll when content exceeds the window.
	   The board surface fills the window with a small uniform margin all round; the
	   schematic content stays left-aligned and extra width becomes dot-grid margin. */
	.stage {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		display: flex;
		padding: 10px;
	}

	/* Notices — a stack of compact cards over the board's empty bottom-right corner (sidecar
	   notices, USB port errors, an unflashed board, an unreachable ATEM, engine down). Flat
	   popover surface, like the light picker; the level shows in the icon, and an error also
	   tints the card. Above the board and credit, below the settings sheet (z-50). */
	.notices {
		position: absolute;
		right: 32px;
		bottom: 32px;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: min(320px, calc(100% - 64px));
	}
	.notice {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 10px 12px 12px;
		font-size: 0.8rem;
		line-height: 1.4;
		border-radius: 14px;
		background: var(--popover);
		color: var(--popover-foreground);
		box-shadow:
			0 0 0 1px color-mix(in oklch, var(--foreground), transparent 92%),
			0 8px 24px oklch(0 0 0 / 0.12),
			0 2px 6px oklch(0 0 0 / 0.08);
	}
	.notice :global(.icon) {
		flex: none;
		width: 16px;
		height: 16px;
		margin-top: 1px;
		color: var(--muted-foreground);
	}
	.notice.warn :global(.icon) {
		color: var(--foreground);
	}
	.notice.error {
		background: color-mix(in oklch, var(--destructive), var(--popover) 94%);
	}
	.notice.error :global(.icon),
	.notice.error p {
		color: var(--destructive);
	}
	.body {
		flex: 1 1 auto;
		min-width: 0;
	}
	.body p {
		margin: 0;
	}
	.action {
		margin-top: 8px;
		padding: 3px 10px;
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--foreground);
		background: var(--background);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.action:hover {
		background: var(--accent);
	}
	.close {
		flex: none;
		display: inline-flex;
		padding: 2px;
		color: var(--muted-foreground);
		background: none;
		border: none;
		border-radius: 6px;
		cursor: pointer;
	}
	.restarting {
		position: absolute;
		inset: var(--titlebar-h) 0 0 0;
		z-index: 55;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		color: var(--foreground);
		background: color-mix(in oklch, var(--board), transparent 12%);
		backdrop-filter: blur(4px);
	}
	.restarting-title {
		margin-top: 8px;
		font-size: 0.95rem;
		font-weight: 600;
	}
	.restarting-sub {
		font-size: 0.8rem;
		color: var(--muted-foreground);
	}
	.close:hover {
		color: var(--foreground);
		background: var(--accent);
	}
</style>
