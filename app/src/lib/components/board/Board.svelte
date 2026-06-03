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
		/** Source (ATEM) connection — drives the chip, gate-inert, trace dimming. */
		sourceConnected?: boolean;
		sourceIp?: string | null;
		/** Program-output override (OBS) active — gate cuts, lights idle. */
		override?: boolean;
		/** Override-source label; null in v1 (the source element stays hidden). */
		overrideSource?: string | null;
		onassign?: (mac: string, inputId: string) => void;
		onunassign?: (mac: string) => void;
		onflash?: (mac: string) => void;
	}
	let {
		inputs,
		lights,
		sourceConnected = true,
		sourceIp = null,
		override = false,
		overrideSource = null,
		onassign,
		onunassign,
		onflash,
	}: Props = $props();

	const lightsFor = (id: string) => lights.filter((l) => l.inputId === id);
	const unassigned = $derived(lights.filter((l) => l.inputId === null));

	const pickerInputs = $derived<PickerInput[]>(
		inputs.map((i) => ({ id: i.id, label: i.label, state: i.state })),
	);

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
	const contentW = $derived(COLS * CW + (COLS - 1) * GAP);
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
	const dockY = $derived(columnsBottom + DOCK_GAP);
	const boardH = $derived(dockY + dockH + PADBOTTOM);

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
	// Which half of the collector bus carries signal (relative to the centre trunk).
	const leftLive = $derived(
		inputs.some((_, i) => isLive(i) && colCx(i) < boardCx),
	);
	const rightLive = $derived(
		inputs.some((_, i) => isLive(i) && colCx(i) > boardCx),
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
			<!-- source bus: structural, rest grey -->
			<Trace d={srcDrop} />
			<Trace d={busMain} />
			{#each inputs as _, i (i)}<Trace d={tap(i)} />{/each}
			<!-- converge: inputs collect onto a bus, trunk into the gate -->
			{#each inputs as _, i (i)}<Trace d={convDrop(i)} active={convActive(i)} />{/each}
			<Trace d={convBusL} active={leftLive} />
			<Trace d={convBusR} active={rightLive} />
			<Trace d={convTrunk} active={anyLive} />
			<!-- diverge: trunk out of the gate, bus, drop into every column -->
			<Trace d={divTrunk} active={anyLive && !override} />
			<Trace d={divBusL} active={leftLive && !override} />
			<Trace d={divBusR} active={rightLive && !override} />
			{#each inputs as _, i (i)}<Trace d={divTap(i)} active={divActive(i)} />{/each}
			<!-- override wire-in (v1: only when active) -->
			{#if override}<Trace d={overrideWire} active={true} />{/if}
		</svg>

		<!-- Source -->
		<div class="abs" style={place(boardCx, srcY, SRC_W)}>
			<SourceChip connected={sourceConnected} ip={sourceIp ?? ""} />
		</div>

		<!-- Inputs -->
		{#each inputs as inp, i (inp.id)}
			<div class="abs" style={place(colCx(i), inY, IN_W)}>
				<InputKey
					n={inp.n}
					state={inp.state}
					ariaLabel={`Input ${inp.n}: ${inp.label}`}
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
						state={displayState(light)}
						inputs={pickerInputs}
						currentInputId={inp.id}
						onassign={(id) => onassign?.(light.mac, id)}
						onunassign={() => onunassign?.(light.mac)}
						onflash={() => flash(light.mac)}
					/>
				</div>
			{/each}
		{/each}

		<!-- Dock: unassigned lights -->
		<div
			class="abs"
			style="left:{PADX}px; top:{dockY}px; width:{contentW}px; height:{dockH}px;"
		>
			<BoardDock
				lights={dockLights}
				{pickerInputs}
				lightWidth={LT_W}
				onassign={(mac, id) => onassign?.(mac, id)}
				onflash={(mac) => flash(mac)}
			/>
		</div>
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
</style>
