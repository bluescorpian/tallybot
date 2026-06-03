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
	override: boolean;
	overrideSource: string | null;
}

export function toBoardProps(state: AppState): BoardProps {
	const override = state.programGate.active;
	return {
		inputs: state.inputs.map(inputToBoard),
		lights: state.devices.map((d) => deviceToBoard(d, state.inputs, override)),
		sourceStatus: sourceStatus(state.source),
		sourceConnected: state.source.connection === "connected",
		sourceIp: state.source.ip,
		override,
		overrideSource: state.programGate.source,
	};
}

/** The picker's input list derives straight from the board inputs (same shape). */
export function pickerInputs(inputs: BoardInput[]): PickerInput[] {
	return inputs.map((i) => ({ id: i.id, label: i.label, state: i.state }));
}
