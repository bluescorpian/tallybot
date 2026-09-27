<script lang="ts">
	// Board (DESIGN.md → "Concept", "Layout") — the assembled PCB-schematic canvas.
	//
	// Layout (top → bottom):
	//   SourceChip → source bus → input pins (column headers)
	//   converge collector bus ↘↙ → ◯ ProgramGate (single pinch) → ↙↘ diverge bus
	//   TallyLightPcb columns, each seated in a recessed slot lane
	//   ──────────────────────────────────────────────
	//   BoardDock: unassigned lights (setup colour)
	//
	// This is the locked assembly: appearance + geometry are fixed here; it is
	// purely presentational and driven by an already-resolved view-model (see
	// $lib/components/board/types.ts + the $lib/boardState.ts mapper, which is
	// where the "all states" interpretation lives). The board itself only derives
	// presentation/geometry — which trace halves are hot, the gate mode, layout.
	//
	// Trace rules: PCB-authentic — segments are vertical / horizontal / 45° only,
	// bends are 45° chamfers, and every run stops short of its endpoint by GAPT so
	// a small gap reads between a trace and the thing it connects to.
	import SourceChip from "$lib/components/board/SourceChip.svelte";
	import type { SourceStatus } from "$lib/components/board/SourceChip.svelte";
	import InputKey from "$lib/components/board/InputKey.svelte";
	import LightPicker from "$lib/components/board/LightPicker.svelte";
	import Trace from "$lib/components/board/Trace.svelte";
	import ProgramGate from "$lib/components/board/ProgramGate.svelte";
	import BoardDock from "$lib/components/board/BoardDock.svelte";
	import type {
		BoardInput,
		BoardLight,
		LightState,
	} from "$lib/components/board/types";
	import type { PickerInput } from "$lib/components/board/LightPicker.svelte";

	interface Props {
		inputs: BoardInput[];
		lights: BoardLight[];
		/** Source lifecycle for the chip (connected / connecting / reconnecting / setup). */
		sourceStatus?: SourceStatus;
		/** Source (ATEM) reachable — drives gate-inert + trace dimming. */
		sourceConnected?: boolean;
		sourceIp?: string | null;
		/** Whether lights can be wired to inputs; false hides the picker's assign list. */
		assignable?: boolean;
		/** "Set up your ATEM →" link target (opens Settings). */
		onsetup?: () => void;
		/** Program-output override (OBS) active — gate cuts, lights idle. */
		override?: boolean;
		/** Override-source label; null in v1 (the source element stays hidden). */
		overrideSource?: string | null;
		onassign?: (mac: string, inputId: string) => void;
		onunassign?: (mac: string) => void;
		onflash?: (mac: string) => void;
		/** Set a device's LED brightness (protocol byte, 0–255). */
		onbrightness?: (mac: string, value: number) => void;
		/** Provision a device's Wi-Fi (persist creds; save-only — no live join). */
		onprovisionwifi?: (mac: string, ssid: string, pass: string) => void;
		/** Set a device's unplugged transport mode. */
		onsettransport?: (mac: string, mode: "wifi" | "notx" | "espnow") => void;
		/** Designate (mac) / un-designate (null) the ESP-NOW bridge device. */
		onsetbridge?: (mac: string | null) => void;
		/**
		 * Dev mode only: clicking an input key takes it to program on the fake ATEM.
		 * When omitted (production / real ATEM) the keys stay non-interactive.
		 */
		oninputclick?: (inputId: string) => void;
	}
	let {
		inputs,
		lights,
		sourceStatus = "connected",
		sourceConnected = true,
		sourceIp = null,
		assignable = true,
		override = false,
		overrideSource = null,
		onassign,
		onunassign,
		onflash,
		onbrightness,
		onprovisionwifi,
		onsettransport,
		onsetbridge,
		onsetup,
		oninputclick,
	}: Props = $props();

	// Partition lights so the union of columns + dock covers EVERY light — none can
	// fall through. A light seats in its column when its inputId matches a real
	// input; otherwise (unassigned, or an orphan assigned to a now-missing input) it
	// drops to the dock. (The mapper already nulls orphans; this is the structural
	// guarantee for the locked primitive, including hand-built /preview props.)
	const inputIds = $derived(new Set(inputs.map((i) => i.id)));
	const lightsFor = (id: string) => lights.filter((l) => l.inputId === id);
	const unassigned = $derived(
		lights.filter((l) => l.inputId === null || !inputIds.has(l.inputId)),
	);

	const pickerInputs = $derived<PickerInput[]>(
		inputs.map((i) => ({ id: i.id, label: i.label, state: i.state })),
	);
	// What the pickers offer as assign targets — empty when assignment is off
	// (no real source), which flips LightPicker into its flash-only mode.
	const offerInputs = $derived<PickerInput[]>(assignable ? pickerInputs : []);
	// No inputs at all → a connected source reporting none (anomaly): Board shows
	// an honest notice instead of the schematic. (The no-source case is scaffolded
	// upstream in boardState.ts, so it arrives here with 4 keys, not zero.)
	const hasInputs = $derived(inputs.length > 0);

	// ── Geometry (computed → deterministic, 45°-clean trace anchors) ──────────
	const GAPT = 9; // gap between a trace end and the thing it connects to
	const CW = 80; // column cell (pitch unit)
	const GAP = 14; // gap between cells (tight — keys nearly touch)
	const PADX = 54;
	const SRC_W = 300,
		SRC_H = 60;
	const IN_W = 88,
		IN_H = Math.round((IN_W * 10) / 16); // input key, ≈16:10 (big, tight row)
	const BUS_DROP = 44; // source bottom → bus
	const BUS_TO_IN = 30; // bus → input top
	const BUS_CH = 16; // 45° chamfer at the bus ends
	const COLLECT = 24; // column drop onto the converge/diverge collector bus
	const TRUNK = 16; // centre stub between a collector bus and the gate
	const GATE_R = 24; // gate circle radius
	// 138×185 = the PCB primitive's full box (138×163 board + USB-C headroom).
	const LT_W = 72,
		LT_H = Math.round((LT_W * 185) / 138);
	const ROW_GAP = 16;
	const SLOT_PAD = 7; // recessed lane padding around a light
	const DOCK_GAP = 50;
	const DOCK_TOP = 16,
		DOCK_HEADER = 26,
		DOCK_HEAD_GAP = 8, // header → lights; the PCB carries its own USB headroom
		DOCK_BOTTOM = 18;
	const PADTOP = 32,
		PADBOTTOM = 36;

	const COLS = $derived(inputs.length);
	// Floor the width at the source chip when there are no columns, so the empty
	// board stays valid (no negative width, no colCx(-1) garbage geometry).
	const contentW = $derived(hasInputs ? COLS * CW + (COLS - 1) * GAP : SRC_W);
	const boardW = $derived(contentW + 2 * PADX);
	const boardCx = $derived(boardW / 2);
	const colCx = (i: number) => PADX + i * (CW + GAP) + CW / 2;

	// Vertical bands
	const srcY = PADTOP;
	const srcBottom = srcY + SRC_H;
	const yBus = srcBottom + BUS_DROP;
	const inY = yBus + BUS_TO_IN;
	const inBottom = inY + IN_H;
	// Converge + diverge are collector busses (same shape as the source bus), so
	// the section stays short. COLLECT = the column drop, TRUNK = the centre stub.
	const convTopY = inBottom + GAPT;
	const yConvBus = convTopY + COLLECT;
	const gateTop = yConvBus + TRUNK + GAPT;
	const gateCY = gateTop + GATE_R;
	const gateBottom = gateCY + GATE_R;
	const yDivBus = gateBottom + GAPT + TRUNK;
	const lightsY = yDivBus + COLLECT + GAPT;

	const maxRows = $derived(
		Math.max(1, ...inputs.map((i) => lightsFor(i.id).length)),
	);
	const columnsBottom = $derived(
		lightsY + maxRows * LT_H + (maxRows - 1) * ROW_GAP,
	);
	const laneH = $derived(columnsBottom - lightsY + 2 * SLOT_PAD);
	const dockH = DOCK_TOP + DOCK_HEADER + DOCK_HEAD_GAP + LT_H + DOCK_BOTTOM;
	// Empty-state notice (connected source, no inputs): a panel where the
	// schematic would be. The dock hangs off whichever body is shown.
	const NOTICE_TOP = srcBottom + 60;
	const NOTICE_H = 92;
	const noticeBottom = NOTICE_TOP + NOTICE_H;
	const bodyBottom = $derived(hasInputs ? columnsBottom : noticeBottom);
	// The dock is shown only when it holds lights; when empty it's hidden and
	// reserves no height (the board shrinks to fit the body). With no lights at all
	// (first run), a hint takes the dock's place: otherwise nothing on the board
	// says how lights get here.
	const hasDock = $derived(unassigned.length > 0);
	const noLights = $derived(lights.length === 0);
	const HINT_H = 64;
	const dockY = $derived(bodyBottom + DOCK_GAP);
	const boardH = $derived(
		(hasDock ? dockY + dockH : noLights ? dockY + HINT_H : bodyBottom) + PADBOTTOM,
	);

	const place = (cx: number, y: number, w: number) =>
		`left:${cx - w / 2}px; top:${y}px; width:${w}px;`;

	// ── Trace paths — vertical / horizontal / 45° only, with end gaps ─────────
	// Source bus: centre drop + horizontal bus, straight taps to inner inputs, 45°
	// chamfers to the outer inputs. (A distribution bus is PCB-authentic.)
	const srcDrop = $derived(`M ${boardCx} ${srcBottom + GAPT} L ${boardCx} ${yBus}`);
	const busMain = $derived(
		`M ${colCx(0) + BUS_CH} ${yBus} L ${colCx(COLS - 1) - BUS_CH} ${yBus}`,
	);
	const tap = (i: number) => {
		const x = colCx(i);
		const inTop = inY - GAPT;
		if (i === 0)
			return `M ${x + BUS_CH} ${yBus} L ${x} ${yBus + BUS_CH} L ${x} ${inTop}`;
		if (i === COLS - 1)
			return `M ${x - BUS_CH} ${yBus} L ${x} ${yBus + BUS_CH} L ${x} ${inTop}`;
		return `M ${x} ${yBus} L ${x} ${inTop}`;
	};
	// Converge (input → gate): a collector bus, the mirror of the source bus.
	// Columns drop onto a horizontal bus; a centre trunk stubs into the gate.
	const convDrop = (i: number) => {
		const x = colCx(i);
		if (i === 0)
			return `M ${x} ${convTopY} L ${x} ${yConvBus - BUS_CH} L ${x + BUS_CH} ${yConvBus}`;
		if (i === COLS - 1)
			return `M ${x} ${convTopY} L ${x} ${yConvBus - BUS_CH} L ${x - BUS_CH} ${yConvBus}`;
		return `M ${x} ${convTopY} L ${x} ${yConvBus}`;
	};
	// Split the bus at the centre trunk so each half lights only when a live input
	// feeds it — signal from one side never crosses to the other.
	const convBusL = $derived(
		`M ${colCx(0) + BUS_CH} ${yConvBus} L ${boardCx} ${yConvBus}`,
	);
	const convBusR = $derived(
		`M ${boardCx} ${yConvBus} L ${colCx(COLS - 1) - BUS_CH} ${yConvBus}`,
	);
	const convTrunk = $derived(`M ${boardCx} ${yConvBus} L ${boardCx} ${gateTop - GAPT}`);
	// Diverge (gate → columns): the same bus shape, flipped — centre trunk out of
	// the gate, horizontal bus, a drop into EVERY column (occupied or not).
	const divTrunk = $derived(`M ${boardCx} ${gateBottom + GAPT} L ${boardCx} ${yDivBus}`);
	const divBusL = $derived(
		`M ${colCx(0) + BUS_CH} ${yDivBus} L ${boardCx} ${yDivBus}`,
	);
	const divBusR = $derived(
		`M ${boardCx} ${yDivBus} L ${colCx(COLS - 1) - BUS_CH} ${yDivBus}`,
	);
	const divTap = (i: number) => {
		const x = colCx(i);
		const end = lightsY - GAPT;
		if (i === 0)
			return `M ${x + BUS_CH} ${yDivBus} L ${x} ${yDivBus + BUS_CH} L ${x} ${end}`;
		if (i === COLS - 1)
			return `M ${x - BUS_CH} ${yDivBus} L ${x} ${yDivBus + BUS_CH} L ${x} ${end}`;
		return `M ${x} ${yDivBus} L ${x} ${end}`;
	};
	// Override (OBS) wire-in from the right — v1 shows it only when active.
	const overrideWire = $derived(
		`M ${boardW - 8} ${gateCY} L ${boardCx + GATE_R + GAPT} ${gateCY}`,
	);

	// ── State derivations (presentation only, from resolved input states) ─────
	const isLive = (i: number) => inputs[i]?.state === "live";
	const convActive = (i: number) => isLive(i);
	const divActive = (i: number) => isLive(i) && !override;
	const anyLive = $derived(inputs.some((i) => i.state === "live"));
	// A collector-bus half lights only from the centre out to the OUTERMOST live
	// input on that side: signal taps onto the bus at a live input's column and
	// flows inward to the trunk, so any stretch further out stays grey. Returns
	// the outer x of the lit span (chamfered at an edge column), or null when no
	// live input feeds that side. (With an odd input count the centre column sits
	// exactly on boardCx — it feeds the trunk directly and lights no bus half.)
	const outerLiveX = (side: "L" | "R"): number | null => {
		const idx = inputs
			.map((_, i) => i)
			.filter((i) =>
				isLive(i) && (side === "L" ? colCx(i) < boardCx : colCx(i) > boardCx),
			);
		if (!idx.length) return null;
		const i = side === "L" ? Math.min(...idx) : Math.max(...idx);
		const edge = side === "L" ? 0 : COLS - 1;
		return i === edge ? colCx(i) + (side === "L" ? BUS_CH : -BUS_CH) : colCx(i);
	};
	const leftActiveX = $derived(outerLiveX("L"));
	const rightActiveX = $derived(outerLiveX("R"));
	// Cyan overlays drawn on top of the grey base bus — the lit span only.
	const convBusLActive = $derived(
		leftActiveX !== null ? `M ${leftActiveX} ${yConvBus} L ${boardCx} ${yConvBus}` : null,
	);
	const convBusRActive = $derived(
		rightActiveX !== null ? `M ${boardCx} ${yConvBus} L ${rightActiveX} ${yConvBus}` : null,
	);
	const divBusLActive = $derived(
		leftActiveX !== null ? `M ${leftActiveX} ${yDivBus} L ${boardCx} ${yDivBus}` : null,
	);
	const divBusRActive = $derived(
		rightActiveX !== null ? `M ${boardCx} ${yDivBus} L ${rightActiveX} ${yDivBus}` : null,
	);
	const gateMode = $derived(
		!sourceConnected ? "inert" : override ? "cut" : anyLive ? "hot" : "rest",
	);

	// ── Flash-to-identify: a local blink that echoes the IDENTIFY command ─────
	let flashingMac = $state<string | null>(null);
	let flashOn = $state(true);
	const displayState = (l: BoardLight): LightState =>
		flashingMac === l.mac && !flashOn ? "idle" : l.state;

	function flash(mac: string) {
		// Guard against spamming: ignore while a flash is already in flight.
		if (flashingMac !== null) return;
		onflash?.(mac);
		flashingMac = mac;
		flashOn = true;
		let n = 0;
		const t = setInterval(() => {
			flashOn = !flashOn;
			if (++n >= 8) {
				clearInterval(t);
				flashingMac = null;
				flashOn = true;
			}
		}, 180);
	}

	const dockLights = $derived(
		unassigned.map((l) => ({ ...l, state: displayState(l) })),
	);
</script>

<!-- Outer board = the full-width dotted canvas (tokens from layout.css); the
     fixed-geometry content is pinned to the left, so widening the board just
     adds dot-grid breathing room to the right. -->
<div class="board" class:src-down={!sourceConnected}>
	<div class="board-content" style="width:{boardW}px; height:{boardH}px;">
		{#if hasInputs}
			<!-- Recessed slot lanes (one per input column) so lights read as seated -->
			{#each inputs as _inp, i (inputs[i].id)}
				<div
					class="lane"
					style={place(colCx(i), lightsY - SLOT_PAD, LT_W + 2 * SLOT_PAD) +
						`height:${laneH}px;`}
				></div>
			{/each}

			<!-- Trace overlay: one SVG, behind components, in board coordinates -->
			<svg
				class="traces"
				viewBox="0 0 {boardW} {boardH}"
				width={boardW}
				height={boardH}
				aria-hidden="true"
			>
				<!-- Two-layer paint: every wire is drawn once at rest (grey) here,
				     then the energised segments are redrawn glowing on top below. So
				     a resting wire never sits over a live one, and each glow (the
				     trace's own drop-shadow) bleeds beneath its bright core. -->
				<!-- Resting layer — the full schematic in grey -->
				<Trace d={srcDrop} />
				<Trace d={busMain} />
				{#each inputs as _, i (i)}<Trace d={tap(i)} />{/each}
				{#each inputs as _, i (i)}<Trace d={convDrop(i)} />{/each}
				<Trace d={convBusL} />
				<Trace d={convBusR} />
				<Trace d={convTrunk} />
				<Trace d={divTrunk} />
				<Trace d={divBusL} />
				<Trace d={divBusR} />
				{#each inputs as _, i (i)}<Trace d={divTap(i)} />{/each}
				<!-- Live layer — only the energised segments, cyan + glowing, on top.
				     Converge bus halves light only from centre out to the outermost
				     live input on each side; the diverge mirror goes dark on override. -->
				{#each inputs as _, i (i)}{#if convActive(i)}<Trace d={convDrop(i)} active />{/if}{/each}
				{#if convBusLActive}<Trace d={convBusLActive} active />{/if}
				{#if convBusRActive}<Trace d={convBusRActive} active />{/if}
				{#if anyLive}<Trace d={convTrunk} active />{/if}
				{#if anyLive && !override}<Trace d={divTrunk} active />{/if}
				{#if divBusLActive && !override}<Trace d={divBusLActive} active />{/if}
				{#if divBusRActive && !override}<Trace d={divBusRActive} active />{/if}
				{#each inputs as _, i (i)}{#if divActive(i)}<Trace d={divTap(i)} active />{/if}{/each}
				<!-- override wire-in (v1: only when active) -->
				{#if override}<Trace d={overrideWire} active />{/if}
			</svg>
		{/if}

		<!-- Source (always present) -->
		<div class="abs" style={place(boardCx, srcY, SRC_W)}>
			<SourceChip status={sourceStatus} ip={sourceIp ?? ""} {onsetup} />
		</div>

		{#if hasInputs}
			<!-- Inputs -->
			{#each inputs as inp, i (inp.id)}
				<div class="abs" style={place(colCx(i), inY, IN_W)}>
					<InputKey
						n={inp.n}
						state={inp.state}
						ariaLabel={`Input ${inp.n}: ${inp.label}`}
						onclick={oninputclick ? () => oninputclick(inp.id) : undefined}
					/>
				</div>
			{/each}

			<!-- Program-output gate: a circular node on the trace path -->
			<div class="abs" style={place(boardCx, gateTop, 2 * GATE_R)}>
				<ProgramGate mode={gateMode} ariaLabel="Program output gate" />
			</div>

			<!-- Light columns -->
			{#each inputs as inp, i (inp.id)}
				{#each lightsFor(inp.id) as light, r (light.mac)}
					<div
						class="abs"
						style={place(colCx(i), lightsY + r * (LT_H + ROW_GAP), LT_W)}
					>
						<LightPicker
							mac={light.mac}
							label={light.label}
							state={displayState(light)}
							inputs={offerInputs}
							currentInputId={inp.id}
							brightness={light.brightness}
							transport={light.transport}
							provisionedMode={light.provisionedMode}
							ssid={light.ssid}
							wifiState={light.wifiState}
							rssi={light.rssi}
							protocolVersion={light.protocolVersion}
							bridge={light.bridge}
							onassign={(id) => onassign?.(light.mac, id)}
							onunassign={() => onunassign?.(light.mac)}
							onflash={() => flash(light.mac)}
							onbrightness={(v) => onbrightness?.(light.mac, v)}
							onprovisionwifi={(s, p) => onprovisionwifi?.(light.mac, s, p)}
							onsettransport={(m) => onsettransport?.(light.mac, m)}
							onsetbridge={(enabled) => onsetbridge?.(enabled ? light.mac : null)}
						/>
					</div>
				{/each}
			{/each}
		{:else}
			<!-- No inputs to show (a connected source reporting none) -->
			<div class="abs board-empty" style={place(boardCx, NOTICE_TOP, contentW)}>
				<p class="board-empty-title">No inputs detected</p>
				<p class="board-empty-sub">
					The source is connected but reported no inputs.
				</p>
			</div>
		{/if}

		<!-- Dock: unassigned lights — shown only when it holds lights -->
		{#if hasDock}
			<div
				class="abs"
				style="left:{PADX}px; top:{dockY}px; width:{contentW}px; height:{dockH}px;"
			>
				<BoardDock
					lights={dockLights}
					pickerInputs={offerInputs}
					lightWidth={LT_W}
					onassign={(mac, id) => onassign?.(mac, id)}
					onflash={(mac) => flash(mac)}
					onbrightness={(mac, v) => onbrightness?.(mac, v)}
					onprovisionwifi={(mac, s, p) => onprovisionwifi?.(mac, s, p)}
					onsettransport={(mac, m) => onsettransport?.(mac, m)}
					onsetbridge={(mac) => onsetbridge?.(mac)}
				/>
			</div>
		{:else if noLights}
			<div
				class="abs no-lights"
				style="left:{PADX}px; top:{dockY}px; width:{contentW}px; height:{HINT_H}px;"
			>
				<p class="board-empty-title">No lights yet</p>
				<p class="board-empty-sub">Plug a light into this PC by USB to add it.</p>
			</div>
		{/if}
	</div>
</div>

<style>
	/* full-width dotted canvas; content is pinned to the left, so widening the
	   board just adds dot-grid breathing room. Surface + dot-grid come from the
	   locked tokens in layout.css (--board / --board-dot*). */
	.board {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		justify-content: flex-start;
		align-items: flex-start;
		border-radius: 22px;
		background-color: var(--board);
		background-image: radial-gradient(
			var(--board-dot) var(--board-dot-size, 1.5px),
			transparent calc(var(--board-dot-size, 1.5px) + 0.6px)
		);
		background-size: var(--board-dot-space, 32px) var(--board-dot-space, 32px);
		background-position: calc(var(--board-dot-space, 32px) / 2)
			calc(var(--board-dot-space, 32px) / 2);
		box-shadow:
			inset 2px 3px 10px oklch(0 0 0 / 0.20),
			inset 1px 1px 3px oklch(0 0 0 / 0.12),
			inset 0 0 0 1px oklch(0 0 0 / 0.10),
			inset -1px -1px 0 oklch(1 0 0 / 0.30);
		transition: filter 0.25s ease;
	}
	/* the fixed-geometry coordinate space all the absolute children live in */
	.board-content {
		position: relative;
		flex: none;
	}
	.board.src-down .traces {
		opacity: 0.45;
	}

	.traces {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: visible;
	}

	.abs {
		position: absolute;
	}

	/* Recessed column lane — pressed into the board so lights read as slotted */
	.lane {
		position: absolute;
		border-radius: 14px;
		/* recessed: a hair darker than the board, and follows its warm hue */
		background: color-mix(in oklch, var(--board), black 4%);
		box-shadow:
			inset 1px 2px 4px oklch(0.5 0.01 286 / 0.16),
			inset -1px -1px 3px oklch(1 0 0 / 0.8),
			0 1px 0 oklch(1 0 0 / 0.5);
	}

	/* First-run hint in the dock's place: the dock's recessed tray, dashed because
	   it's a slot waiting to be filled, not a container. */
	.no-lights {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 3px;
		box-sizing: border-box;
		padding: 0 22px;
		border-radius: 16px;
		border: 1.5px dashed color-mix(in oklch, var(--board), black 18%);
		background: color-mix(in oklch, var(--board), black 3%);
	}

	/* Empty-state notice where the schematic would be (connected, no inputs) */
	.board-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		text-align: center;
	}
	.board-empty-title {
		margin: 0;
		font-size: 0.92rem;
		font-weight: 500;
		color: var(--foreground);
	}
	.board-empty-sub {
		margin: 0;
		font-size: 0.78rem;
		color: var(--muted-foreground);
	}
</style>
