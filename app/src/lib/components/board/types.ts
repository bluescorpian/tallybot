// Board view-model — the vocabulary the locked <Board> renders.
//
// The board is purely presentational: it knows nothing about the sidecar wire
// format. The app layer maps the IPC `AppState` (sidecar/src/ipc.ts) onto these
// types in `$lib/boardState.ts`, which is where the "all states" interpretation
// (unknown→idle on keys, unknown→fault on lights, override, offline/setup) lives.
import type { InputState } from "./InputKey.svelte";
import type { LightState } from "./TallyLightPcb.svelte";

export type { InputState, LightState };

/** An input column header — already resolved to a key state by the mapper. */
export interface BoardInput {
	/** Stable input id (the ATEM input number, as a string). */
	id: string;
	/** Number shown on the key face. */
	n: number | string;
	/** Source-provided label — used for a11y and the picker, not drawn on the key. */
	label: string;
	/** Resolved key state (live / preview / idle). */
	state: InputState;
}

/** A tally light — already resolved to a device LED state by the mapper. */
export interface BoardLight {
	/** Short MAC tail shown on the light. */
	mac: string;
	/** The input column this light sits in, or null when unassigned (dock). */
	inputId: string | null;
	/** Resolved LED state (live / preview / idle / setup / offline / fault). */
	state: LightState;
}
