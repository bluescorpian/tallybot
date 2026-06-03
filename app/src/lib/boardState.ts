// AppState → board view-model. The single home for the board's "all states"
// interpretation: it turns the sidecar snapshot (sidecar/src/ipc.ts, imported
// type-only via the $ipc alias so it's erased from the bundle) into the props
// the locked <Board> renders. Phase 5 feeds it the real snapshot; for now the
// main route builds a mock AppState and runs it through here.
import type { AppState, Device, Input } from "$ipc";
import type {
	BoardInput,
	BoardLight,
	InputState,
	LightState,
} from "$lib/components/board/types";
import type { PickerInput } from "$lib/components/board/LightPicker.svelte";
import type { SourceStatus } from "$lib/components/board/SourceChip.svelte";

/**
 * Input key state. `unknown` (the source can't be trusted) maps to `idle`: an
 * input key is a physical ATEM button, and a powered-off ATEM just shows unlit
 * buttons — there's no separate "unknown" look on the key. (The *lights* still
 * fault — see `lightState` — because a connected light must not be told the
 * source is safely idle when it isn't.)
 */
function inputState(tally: Input["tally"]): InputState {
	return tally === "unknown" ? "idle" : tally;
}

export function inputToBoard(i: Input): BoardInput {
	return { id: String(i.id), n: i.id, label: i.label, state: inputState(i.tally) };
}

/**
 * No-source scaffold: before the first successful connection there are no real
 * inputs, so the board falls back to a default ATEM Mini (4 idle keys) rather
 * than collapsing. Keys are pure context — assignment is disabled (no real
 * source), so the labels are only cosmetic. Used only when `noSource` (below);
 * a *connected* source reporting zero inputs is a different case (it keeps its
 * empty input list, so the board shows an honest "no inputs" notice instead).
 */
const DEFAULT_INPUTS: BoardInput[] = [1, 2, 3, 4].map((n) => ({
	id: String(n),
	n,
	label: `Camera ${n}`,
	state: "idle",
}));

/**
 * A light with no source to assign against: it sits in the dock (unassigned),
 * viewable and — when online — flashable, but cannot be wired to an input.
 * Offline keeps its device-blue; everything else shows the setup colour.
 */
function dockLight(d: Device): BoardLight {
	return {
		mac: d.macTail,
		inputId: null,
		state: d.state === "offline" ? "offline" : "setup",
	};
}

/**
 * Device LED state, resolving every case the primitive can show:
 *   offline               → offline (steady blue, device-local)
 *   unassigned            → setup   (magenta, sits in the dock)
 *   assigned + override   → idle    (the gate blocks program — every light idles)
 *   assigned + tally      → that tally, with `unknown` → fault (flashing blue:
 *                           the sidecar drives connected lights to fault when it
 *                           can't trust the source — never a confident idle)
 */
export function deviceToBoard(
	d: Device,
	inputs: Input[],
	override: boolean,
): BoardLight {
	const inputId = d.inputId === null ? null : String(d.inputId);
	let state: LightState;
	if (d.state === "offline") state = "offline";
	else if (d.state === "unassigned" || d.inputId === null) state = "setup";
	else if (override) state = "idle";
	else {
		const tally = inputs.find((i) => i.id === d.inputId)?.tally ?? "unknown";
		state = tally === "unknown" ? "fault" : tally;
	}
	return { mac: d.macTail, inputId, state };
}

/**
 * Source lifecycle for the chip. The schema carries more than a boolean:
 * `connection` is three-valued and `ip === null` means *never configured*. We
 * keep all four apart so the chip can spin while reconnecting and prompt setup
 * when there's nothing to connect to yet:
 *   connected               → connected
 *   connecting              → connecting
 *   disconnected + ip set   → disconnected (lost a known source; auto-reconnect)
 *   disconnected + ip null  → unconfigured (first run — go set one up)
 */
function sourceStatus(source: AppState["source"]): SourceStatus {
	if (source.connection === "connected") return "connected";
	if (source.connection === "connecting") return "connecting";
	return source.ip === null ? "unconfigured" : "disconnected";
}

export interface BoardProps {
	inputs: BoardInput[];
	lights: BoardLight[];
	/** Full source lifecycle for the chip (spinner / IP / setup link). */
	sourceStatus: SourceStatus;
	/** True only when reachable — drives gate-inert + trace dimming. */
	sourceConnected: boolean;
	sourceIp: string | null;
	/** Whether lights can be wired to inputs (false when there are no real inputs). */
	assignable: boolean;
	override: boolean;
	overrideSource: string | null;
}

export function toBoardProps(state: AppState): BoardProps {
	const override = state.programGate.active;
	const connected = state.source.connection === "connected";
	const real = state.inputs;

	// No real inputs and no live source → scaffold a default ATEM Mini so the
	// board keeps its shape (the chip says why). A *connected* source with zero
	// inputs is the anomaly case: keep its empty list so Board shows the notice.
	const noSource = !connected && real.length === 0;
	// Assignment needs a real input list to target — true even while a known
	// source is briefly disconnected (its inputs are retained), false for the
	// scaffold and the zero-inputs anomaly.
	const assignable = real.length > 0;

	return {
		inputs: noSource ? DEFAULT_INPUTS : real.map(inputToBoard),
		lights: state.devices.map((d) =>
			assignable ? deviceToBoard(d, real, override) : dockLight(d),
		),
		sourceStatus: sourceStatus(state.source),
		sourceConnected: connected,
		sourceIp: state.source.ip,
		assignable,
		override,
		overrideSource: state.programGate.source,
	};
}

/** The picker's input list derives straight from the board inputs (same shape). */
export function pickerInputs(inputs: BoardInput[]): PickerInput[] {
	return inputs.map((i) => ({ id: i.id, label: i.label, state: i.state }));
}
