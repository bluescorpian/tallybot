/**
 * ATEM simulator — a stub of the `atem-connection` library.
 *
 * It exposes the slice of that library's API the sidecar actually uses, backed by
 * configurable in-memory state instead of a real switcher, so the sidecar and UI
 * (Phases 2 and 4) can be built and tested without an ATEM Mini on the bench. The
 * sidecar swaps the real `Atem` for this `FakeAtem` and is otherwise unchanged.
 *
 * Mirrored surface (verified against the library):
 *   - `connect(address?, port?)` / `disconnect()` returning promises
 *   - events `connected`, `disconnected`, `stateChanged(state, pathsChanged[])`, `error`
 *   - `state.video.mixEffects[me].programInput` / `.previewInput`
 *   - `state.inputs[id].longName` / `.shortName`
 *   - `changeProgramInput(input, me?)` / `changePreviewInput(input, me?)`
 *
 * Deliberate simplifications: `state` is populated from construction (the real
 * library leaves it undefined until connected), `connect`/`disconnect` don't touch
 * a network, and `state` is the minimal shape above rather than the full AtemState.
 * Input changes are applied immediately (no command→ack latency).
 *
 * `setInputName` and `cut` are convenience controls for driving the sim; they
 * stand in for an operator renaming an input or pressing CUT on the panel.
 */

import { EventEmitter } from "node:events";

export interface InputChannel {
  inputId: number;
  longName: string;
  shortName: string;
}

export interface MixEffect {
  index: number;
  programInput: number;
  previewInput: number;
}

/** The subset of `AtemState` the sidecar reads. */
export interface FakeAtemState {
  info: { model: string };
  video: { mixEffects: MixEffect[] };
  inputs: Record<number, InputChannel>;
}

export interface FakeAtemOptions {
  /** How many camera inputs to seed (an ATEM Mini has 4). */
  inputCount?: number;
  /** Override the default "Camera N" long names, keyed by input id. */
  inputNames?: Record<number, string>;
  /** Initial program input (default 1). */
  programInput?: number;
  /** Initial preview input (default 2). */
  previewInput?: number;
  /** Model string reported in `state.info` (cosmetic). */
  model?: string;
}

const DEFAULT_INPUT_COUNT = 4;

function seedInputs(count: number, overrides: Record<number, string> = {}): Record<number, InputChannel> {
  const inputs: Record<number, InputChannel> = {};
  for (let id = 1; id <= count; id++) {
    const override = overrides[id];
    const longName = override ?? `Camera ${id}`;
    inputs[id] = { inputId: id, longName, shortName: override ? override.slice(0, 4) : `Cam${id}` };
  }
  return inputs;
}

// Typed events (the interface merges with the class and is erased at build).
export interface FakeAtem {
  on(event: "connected", listener: () => void): this;
  on(event: "disconnected", listener: () => void): this;
  on(event: "stateChanged", listener: (state: FakeAtemState, pathsChanged: string[]) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  emit(event: "connected"): boolean;
  emit(event: "disconnected"): boolean;
  emit(event: "stateChanged", state: FakeAtemState, pathsChanged: string[]): boolean;
  emit(event: "error", err: Error): boolean;
}

export class FakeAtem extends EventEmitter {
  state: FakeAtemState;
  #connected = false;

  constructor(options: FakeAtemOptions = {}) {
    super();
    const count = options.inputCount ?? DEFAULT_INPUT_COUNT;
    this.state = {
      info: { model: options.model ?? "ATEM Mini (simulated)" },
      video: {
        mixEffects: [
          {
            index: 0,
            programInput: options.programInput ?? 1,
            previewInput: options.previewInput ?? 2,
          },
        ],
      },
      inputs: seedInputs(count, options.inputNames),
    };
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** Mirrors `atem.connect()`. Resolves immediately; `connected` fires on a microtask. */
  connect(_address?: string, _port?: number): Promise<void> {
    this.#connected = true;
    queueMicrotask(() => this.emit("connected"));
    return Promise.resolve();
  }

  /** Mirrors `atem.disconnect()`. State is retained so a reconnect resumes the scene. */
  disconnect(): Promise<void> {
    this.#connected = false;
    queueMicrotask(() => this.emit("disconnected"));
    return Promise.resolve();
  }

  // The command methods are async so a bad input/ME surfaces as a rejected
  // promise (as the real library's commands do), not a synchronous throw.

  /** Put `input` on program output for mix-effect `me`. */
  async changeProgramInput(input: number, me = 0): Promise<void> {
    const mixEffect = this.#mixEffect(me);
    this.#assertInput(input);
    mixEffect.programInput = input;
    this.#emitChange([`video.mixEffects.${me}.programInput`]);
  }

  /** Put `input` on preview for mix-effect `me`. */
  async changePreviewInput(input: number, me = 0): Promise<void> {
    const mixEffect = this.#mixEffect(me);
    this.#assertInput(input);
    mixEffect.previewInput = input;
    this.#emitChange([`video.mixEffects.${me}.previewInput`]);
  }

  /** Take preview to air: program and preview swap, as on a real ME cut. */
  async cut(me = 0): Promise<void> {
    const mixEffect = this.#mixEffect(me);
    const previousProgram = mixEffect.programInput;
    mixEffect.programInput = mixEffect.previewInput;
    mixEffect.previewInput = previousProgram;
    this.#emitChange([
      `video.mixEffects.${me}.programInput`,
      `video.mixEffects.${me}.previewInput`,
    ]);
  }

  /** Sim-only control: rename an input, standing in for the ATEM's own input labels. */
  setInputName(inputId: number, longName: string, shortName?: string): void {
    const input = this.state.inputs[inputId];
    if (!input) throw new RangeError(`no input ${inputId}`);
    input.longName = longName;
    input.shortName = shortName ?? longName.slice(0, 4);
    this.#emitChange([`inputs.${inputId}.longName`, `inputs.${inputId}.shortName`]);
  }

  #mixEffect(me: number): MixEffect {
    const mixEffect = this.state.video.mixEffects[me];
    if (!mixEffect) {
      throw new RangeError(`no mix effect ${me} (this device has ${this.state.video.mixEffects.length})`);
    }
    return mixEffect;
  }

  #assertInput(input: number): void {
    if (!this.state.inputs[input]) {
      throw new RangeError(`unknown input ${input}; known inputs: ${Object.keys(this.state.inputs).join(", ")}`);
    }
  }

  #emitChange(pathsChanged: string[]): void {
    this.emit("stateChanged", this.state, pathsChanged);
  }
}
